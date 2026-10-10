// Proof approval (FR-PR-01..06): every custom line gets a versioned proof; the approved
// version is locked (also enforced by a database trigger) and production uses only it.
const { Op } = require("sequelize");
const { sequelize, Proof, ProofApproval, OrderItem, Order, DesignVersion, CompanyMember, Product, ArtworkAsset } = require("../Models");
const ApiError = require("../Utils/ApiError");
const settingsService = require("./settingsService");
const notificationService = require("./notificationService");
const shippingEstimator = require("./shippingEstimator");
const assetService = require("./assetService");
const designService = require("./designService");

function orderService() {
  return require("./orderService");
}

async function nextVersionNo(itemId, transaction) {
  return ((await Proof.max("version_no", { where: { order_item_id: itemId }, transaction })) || 0) + 1;
}

async function requiredApprovals(order, transaction) {
  // B2B: every company approver signs off when the company has more than one (FR-PR-06).
  if (!order.company_id) return 1;
  const approvers = await CompanyMember.count({ where: { company_id: order.company_id, member_role: { [Op.in]: ["admin", "approver"] }, status: "active" }, transaction });
  return Math.max(1, Math.min(approvers, 2));
}

async function send(item, { designVersionId, previewAssetId, printFileAssetId, notes, source, actorId, transaction }) {
  const order = await Order.findByPk(item.order_id, { transaction });
  const { free_revisions: freeRevisions } = await settingsService.get("proofs");
  // Earlier unapproved proofs are superseded by the new version.
  await Proof.update(
    { status: "superseded" },
    { where: { order_item_id: item.id, status: { [Op.in]: ["sent", "changes_requested", "draft"] }, locked: false }, transaction }
  );
  const versionNo = await nextVersionNo(item.id, transaction);
  const proof = await Proof.create(
    {
      order_item_id: item.id,
      design_version_id: designVersionId || item.design_version_id || null,
      version_no: versionNo,
      status: "sent",
      preview_asset_id: previewAssetId,
      print_file_asset_id: printFileAssetId || null,
      source,
      notes: notes || null,
      required_approvals: await requiredApprovals(order, transaction),
      // v1 is the original; revisions beyond the free allowance are chargeable (FR-PR-05).
      is_chargeable: versionNo - 1 > freeRevisions,
      sent_at: new Date(),
      created_by: actorId || null,
    },
    { transaction }
  );
  if (item.state === "artwork_pending") {
    await orderService().transitionItem(item, "proof_sent", { actorId, note: `Proof v${versionNo} sent`, transaction });
  }
  await notificationService.notify(
    order.user_id,
    {
      type: "proof_ready",
      title: `Proof ready for ${order.order_number}`,
      body: `Proof v${versionNo} for ${item.product_snapshot.name} is ready. Approve it to start production.`,
      link: `/orders/${order.id}`,
    },
    { transaction }
  );
  return proof;
}

/** Automatic proof from the customer's saved design (preview rendered by the studio). */
async function autoCreate(item, { transaction }) {
  const version = await DesignVersion.findByPk(item.design_version_id, { transaction });
  if (!version || !version.preview_asset_id) return null;
  return send(item, {
    designVersionId: version.id,
    previewAssetId: version.preview_asset_id,
    notes: (version.warnings || []).map((w) => w.message).join(" ") || null,
    source: "auto",
    transaction,
  });
}

/** Designer-made proof uploaded by staff. */
async function create(auth, { orderItemId, previewAssetId, printFileAssetId, notes }) {
  return sequelize.transaction(async (transaction) => {
    const item = await OrderItem.findByPk(orderItemId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!item) throw ApiError.notFound("Order line not found");
    if (!["artwork_pending", "proof_sent"].includes(item.state)) {
      throw ApiError.conflict(`A proof cannot be sent while the line is "${item.state.replace(/_/g, " ")}"`, "PROOF_NOT_ALLOWED");
    }
    await assetService.assertUsable(auth, [previewAssetId, printFileAssetId].filter(Boolean));
    if (item.state === "proof_sent") {
      // Re-sending while one is outstanding: move back so the new version is the active one.
      await orderService().transitionItem(item, "artwork_pending", { actorId: auth.user.id, note: "Proof replaced by designer", transaction, visible: false });
    }
    return send(item, { previewAssetId, printFileAssetId, notes, source: "designer", actorId: auth.user.id, transaction });
  });
}

async function loadForBuyer(auth, proofId, transaction) {
  const proof = await Proof.findByPk(proofId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!proof) throw ApiError.notFound("Proof not found");
  const item = await OrderItem.findByPk(proof.order_item_id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  const order = await Order.findByPk(item.order_id, { transaction });
  const isOwner = order.user_id === auth.user.id;
  const isApprover = order.company_id && order.company_id === auth.companyId && auth.permissions.has("company.orders.approve");
  if (!isOwner && !isApprover) throw ApiError.notFound("Proof not found");
  return { proof, item, order };
}

async function approve(auth, proofId, { comment } = {}) {
  return sequelize.transaction(async (transaction) => {
    const { proof, item, order } = await loadForBuyer(auth, proofId, transaction);
    if (proof.status !== "sent") throw ApiError.conflict("This proof is no longer awaiting approval", "PROOF_NOT_PENDING");
    if (item.state !== "proof_sent") throw ApiError.conflict("This order line is not awaiting proof approval", "PROOF_NOT_PENDING");
    const existing = await ProofApproval.findOne({ where: { proof_id: proof.id, user_id: auth.user.id }, transaction });
    if (existing) throw ApiError.conflict("You have already responded to this proof", "ALREADY_DECIDED");
    await ProofApproval.create({ proof_id: proof.id, user_id: auth.user.id, decision: "approved", comment }, { transaction });
    const approvals = await ProofApproval.count({ where: { proof_id: proof.id, decision: "approved" }, transaction });
    if (approvals < proof.required_approvals) {
      await orderService().event(order.id, item.id, "proof_partially_approved", { actorId: auth.user.id, note: `${approvals} of ${proof.required_approvals} approvals`, transaction });
      return { proof, complete: false, approvals, required: proof.required_approvals };
    }
    // Lock in the same update that approves: the trigger blocks every later change.
    await proof.update({ status: "approved", approved_at: new Date(), locked: true }, { transaction });
    const product = await Product.findByPk(item.product_id, { transaction });
    const productionDays = item.express ? Math.max(1, Math.ceil(product.lead_time_days / 2)) : product.lead_time_days;
    await item.update(
      { approved_proof_id: proof.id, due_date: shippingEstimator.toDateOnly(shippingEstimator.addWorkingDays(new Date(), productionDays)) },
      { transaction }
    );
    await orderService().transitionItem(item, "proof_approved", { actorId: auth.user.id, note: `Proof v${proof.version_no} approved and locked`, transaction });
    return { proof, complete: true, approvals, required: proof.required_approvals };
  });
}

async function requestChanges(auth, proofId, { comment, designVersionId }) {
  return sequelize.transaction(async (transaction) => {
    const { proof, item, order } = await loadForBuyer(auth, proofId, transaction);
    if (proof.status !== "sent" || item.state !== "proof_sent") throw ApiError.conflict("This proof is no longer awaiting approval", "PROOF_NOT_PENDING");
    await ProofApproval.create({ proof_id: proof.id, user_id: auth.user.id, decision: "changes_requested", comment }, { transaction });
    await proof.update({ status: "changes_requested" }, { transaction });
    await orderService().transitionItem(item, "artwork_pending", { actorId: auth.user.id, note: `Changes requested: ${comment}`, transaction });

    const { free_revisions: freeRevisions, revision_fee_paise: fee } = await settingsService.get("proofs");
    const nextIsChargeable = proof.version_no >= freeRevisions + 1;
    // An updated design from the studio produces the next proof straight away.
    if (designVersionId) {
      const version = await designService.usableVersion(auth, designVersionId, item.product_id, { transaction });
      await item.update({ design_version_id: version.id }, { transaction });
      if (version.preview_asset_id) {
        await send(item, { designVersionId: version.id, previewAssetId: version.preview_asset_id, notes: comment, source: "auto", actorId: auth.user.id, transaction });
      }
    }
    return { proof, nextIsChargeable, revisionFeePaise: nextIsChargeable ? fee : 0, orderId: order.id };
  });
}

async function forOrder(auth, orderId) {
  const order = await orderService().loadVisible(auth, orderId);
  const items = await OrderItem.findAll({ where: { order_id: order.id }, attributes: ["id"] });
  return Proof.findAll({
    where: { order_item_id: items.map((i) => i.id) },
    include: [{ model: ProofApproval, as: "approvals" }],
    order: [["order_item_id", "ASC"], ["version_no", "DESC"]],
  });
}

// Reminders at 24 h and 48 h (FR-PR-04). Due dates are set at approval, so late approval
// automatically shifts the production date.
async function sendReminders() {
  const now = Date.now();
  const pending = await Proof.findAll({ where: { status: "sent", sent_at: { [Op.lt]: new Date(now - 24 * 3600 * 1000) } } });
  for (const proof of pending) {
    const hours = (now - proof.sent_at.getTime()) / 3600000;
    const field = hours >= 48 && !proof.reminder_48_at ? "reminder_48_at" : !proof.reminder_24_at ? "reminder_24_at" : null;
    if (!field) continue;
    const item = await OrderItem.findByPk(proof.order_item_id);
    const order = await Order.findByPk(item.order_id);
    await notificationService.notify(order.user_id, {
      type: "proof_reminder",
      title: `Reminder: proof waiting for approval (${order.order_number})`,
      body: `Your proof for ${item.product_snapshot.name} is waiting. Production and delivery dates move until it is approved.`,
      link: `/orders/${order.id}`,
    });
    await proof.update({ [field]: new Date() });
  }
}

// Staff queue: lines waiting for a designer proof.
async function queue() {
  const items = await OrderItem.findAll({
    where: { state: { [Op.in]: ["artwork_pending", "proof_sent"] } },
    include: [{ model: Order, as: "order", attributes: ["id", "order_number", "user_id", "company_id", "placed_at"] }],
    order: [["updated_at", "ASC"]],
  });
  const artwork = new Set(items.flatMap((i) => i.product_snapshot.artworkAssetIds || []));
  const assets = artwork.size ? await ArtworkAsset.findAll({ where: { id: [...artwork] } }) : [];
  const byId = new Map(assets.map((a) => [a.id, assetService.present(a)]));
  return items.map((i) => ({ ...i.toJSON(), artwork: (i.product_snapshot.artworkAssetIds || []).map((id) => byId.get(id)).filter(Boolean) }));
}

module.exports = { autoCreate, create, approve, requestChanges, forOrder, sendReminders, queue };

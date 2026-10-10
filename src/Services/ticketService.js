// Customer support (FR-SU-01..03): a ticket per order with history and attachments,
// change requests until proof approval, and the complaint flow:
// photo evidence -> decision (reprint, replace, refund, reject) -> liability.
const { Op } = require("sequelize");
const { sequelize, Ticket, TicketMessage, Order, OrderItem, User, Commission, Proof, ProductionJob } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { nextNumber } = require("../Utils/numbering");
const settingsService = require("./settingsService");
const notificationService = require("./notificationService");
const assetService = require("./assetService");

const orderService = () => require("./orderService");

const PRE_APPROVAL = ["placed", "payment_pending", "artwork_pending", "proof_sent"];

async function create(auth, { orderId, orderItemId, type, subject, message, attachmentAssetIds = [] }) {
  return sequelize.transaction(async (transaction) => {
    let order = null;
    let item = null;
    if (orderId) {
      order = await orderService().loadVisible(auth, orderId, { transaction });
      if (order.user_id !== auth.user.id && order.company_id !== auth.companyId) throw ApiError.forbidden();
    }
    if (orderItemId) {
      item = await OrderItem.findByPk(orderItemId, { transaction });
      if (!item || !order || item.order_id !== order.id) throw ApiError.unprocessable("Choose an item from this order", "ITEM_INVALID");
    }
    if (attachmentAssetIds.length) await assetService.assertUsable(auth, attachmentAssetIds);

    if (type === "change_request") {
      if (!item) throw ApiError.unprocessable("Choose the item you want to change", "ITEM_REQUIRED");
      if (!PRE_APPROVAL.includes(item.state)) throw ApiError.conflict("Changes are only possible until the proof is approved", "CHANGE_WINDOW_CLOSED");
    }
    if (type === "complaint") {
      if (!item) throw ApiError.unprocessable("Choose the item with the problem", "ITEM_REQUIRED");
      const { complaint_window_days: days } = await settingsService.get("orders");
      if (item.state !== "delivered" || !item.delivered_at) throw ApiError.conflict("Complaints can be raised once the item is delivered", "NOT_DELIVERED");
      if (Date.now() - item.delivered_at.getTime() > days * 86400 * 1000) throw ApiError.conflict(`Complaints must be raised within ${days} days of delivery`, "COMPLAINT_WINDOW_CLOSED");
      if (!attachmentAssetIds.length) throw ApiError.unprocessable("Add at least one photo showing the problem", "PHOTO_REQUIRED");
    }
    const ticket = await Ticket.create(
      {
        ticket_number: await nextNumber("ticket", transaction),
        user_id: auth.user.id,
        order_id: order?.id || null,
        order_item_id: item?.id || null,
        type,
        subject,
        priority: type === "complaint" ? "high" : "normal",
      },
      { transaction }
    );
    await TicketMessage.create({ ticket_id: ticket.id, user_id: auth.user.id, body: message, attachment_asset_ids: attachmentAssetIds }, { transaction });
    if (order) await orderService().event(order.id, item?.id || null, "ticket_opened", { actorId: auth.user.id, note: `${ticket.ticket_number}: ${subject}`, transaction });
    transaction.afterCommit(() =>
      require("./productionService").notifyStaff("tickets.manage", { type: "ticket_opened", title: `${ticket.ticket_number}: ${subject}`, body: type.replace("_", " "), link: `/admin/support/${ticket.id}` }).catch(() => {})
    );
    return ticket;
  });
}

async function loadVisible(auth, id) {
  const ticket = await Ticket.findByPk(id);
  if (!ticket) throw ApiError.notFound("Ticket not found");
  if (ticket.user_id !== auth.user.id && !auth.permissions.has("tickets.manage")) throw ApiError.notFound("Ticket not found");
  return ticket;
}

async function list(auth, { scope = "mine", status, type, page = 1, limit = 20 }) {
  const where = {};
  if (scope === "all") {
    if (!auth.permissions.has("tickets.manage")) throw ApiError.forbidden();
  } else where.user_id = auth.user.id;
  if (status) where.status = status;
  if (type) where.type = type;
  const { rows, count } = await Ticket.findAndCountAll({
    where,
    include: [
      { model: User, as: "user", attributes: ["id", "name", "email"] },
      { model: Order, as: "order", attributes: ["id", "order_number"] },
      { model: User, as: "assignee", attributes: ["id", "name"] },
    ],
    order: [["updated_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { items: rows, total: count };
}

async function detail(auth, id) {
  const ticket = await loadVisible(auth, id);
  const staff = auth.permissions.has("tickets.manage");
  const messages = await TicketMessage.findAll({
    where: { ticket_id: ticket.id, ...(staff ? {} : { is_internal: false }) },
    include: [{ model: User, as: "user", attributes: ["id", "name"] }],
    order: [["created_at", "ASC"]],
  });
  const [order, item, user] = await Promise.all([
    ticket.order_id ? Order.findByPk(ticket.order_id, { attributes: ["id", "order_number", "status", "amount_paid_paise", "amount_refunded_paise"] }) : null,
    ticket.order_item_id ? OrderItem.findByPk(ticket.order_item_id) : null,
    User.findByPk(ticket.user_id, { attributes: ["id", "name", "email", "phone"] }),
  ]);
  const proofs = item ? await Proof.findAll({ where: { order_item_id: item.id }, order: [["version_no", "DESC"]] }) : [];
  return {
    ...ticket.toJSON(),
    user: staff ? user : undefined,
    order,
    item: item
      ? { id: item.id, name: item.product_snapshot.name, quantity: item.quantity, state: item.state, vendorId: staff ? item.vendor_id : undefined, fulfilmentSource: staff ? item.fulfilment_source : undefined, lineTotalPaise: item.line_total_paise }
      : null,
    proofs: proofs.map((p) => ({ id: p.id, versionNo: p.version_no, status: p.status, previewUrl: p.preview_asset_id ? `/api/v1/assets/${p.preview_asset_id}` : null })),
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      user: m.user?.name,
      isMine: m.user_id === auth.user.id,
      isInternal: m.is_internal,
      attachments: m.attachment_asset_ids.map((a) => `/api/v1/assets/${a}`),
      at: m.created_at,
    })),
  };
}

async function reply(auth, id, { body, attachmentAssetIds = [], internal = false }) {
  const ticket = await loadVisible(auth, id);
  const staff = auth.permissions.has("tickets.manage");
  if (internal && !staff) throw ApiError.forbidden();
  if (attachmentAssetIds.length) await assetService.assertUsable(auth, attachmentAssetIds);
  if (["closed"].includes(ticket.status)) throw ApiError.conflict("This ticket is closed", "TICKET_CLOSED");
  const message = await TicketMessage.create({ ticket_id: ticket.id, user_id: auth.user.id, body, attachment_asset_ids: attachmentAssetIds, is_internal: Boolean(internal) });
  const nextStatus = staff ? (internal ? ticket.status : "awaiting_customer") : "open";
  await ticket.update({ status: nextStatus, assigned_to: staff && !ticket.assigned_to ? auth.user.id : ticket.assigned_to });
  if (staff && !internal) {
    await notificationService.notify(ticket.user_id, { type: "ticket_reply", title: `Reply on ${ticket.ticket_number}`, body, link: `/support/tickets/${ticket.id}` });
  }
  return message;
}

async function update(auth, id, { status, priority, assignedTo }) {
  const ticket = await loadVisible(auth, id);
  await ticket.update({ status: status || ticket.status, priority: priority || ticket.priority, assigned_to: assignedTo === undefined ? ticket.assigned_to : assignedTo, resolved_at: ["resolved", "closed"].includes(status) ? new Date() : ticket.resolved_at });
  return ticket;
}

/**
 * Complaint decision (FR-SU-03). Reprint/replace creates a linked zero-price order line that
 * reuses the approved proof and goes straight to production assignment. Vendor liability
 * is charged back on the vendor's next settlement.
 */
async function resolveComplaint(auth, id, { decision, liability, note, refundPaise }) {
  return sequelize.transaction(async (transaction) => {
    const ticket = await Ticket.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!ticket) throw ApiError.notFound("Ticket not found");
    if (ticket.type !== "complaint") throw ApiError.conflict("Only complaints have a resolution decision", "NOT_A_COMPLAINT");
    if (ticket.decision) throw ApiError.conflict("This complaint has already been decided", "ALREADY_DECIDED");
    const item = await OrderItem.findByPk(ticket.order_item_id, { transaction, lock: transaction.LOCK.UPDATE });
    const order = await Order.findByPk(item.order_id, { transaction });
    let reprintItem = null;
    let refund = null;

    if (decision === "reprint" || decision === "replace") {
      const lineNo = ((await OrderItem.max("line_no", { where: { order_id: order.id }, transaction })) || 0) + 1;
      reprintItem = await OrderItem.create(
        {
          order_id: order.id,
          line_no: lineNo,
          product_id: item.product_id,
          variant_id: item.variant_id,
          method_id: item.method_id,
          design_version_id: item.design_version_id,
          product_snapshot: { ...item.product_snapshot, name: `${decision === "reprint" ? "Reprint" : "Replacement"}: ${item.product_snapshot.name}`, complaintTicket: ticket.ticket_number },
          quantity: item.quantity,
          size_breakdown: item.size_breakdown,
          print_area_count: item.print_area_count,
          unit_price_paise: 0,
          setup_fee_paise: 0,
          line_subtotal_paise: 0,
          taxable_paise: 0,
          hsn_code: item.hsn_code,
          gst_rate: item.gst_rate,
          tax_paise: 0,
          line_total_paise: 0,
          unit_cost_paise: item.unit_cost_paise,
          requires_proof: item.requires_proof,
          // The approved proof stays valid: production reuses that locked version.
          approved_proof_id: item.approved_proof_id,
          state: "proof_approved",
          reprint_of_item_id: item.id,
        },
        { transaction }
      );
      await orderService().event(order.id, reprintItem.id, "reprint_created", { actorId: auth.user.id, note: `${decision} for ${ticket.ticket_number}`, transaction });
      // The reopened order shows the replacement line in progress.
      if (order.status === "completed" || order.status === "delivered") await order.update({ closed_at: null }, { transaction });
      await orderService().refreshOrderStatus(order.id, transaction);
    } else if (decision === "refund") {
      const amount = refundPaise || item.line_total_paise;
      refund = await require("./refundService").createAndProcess(
        { order, amountPaise: Math.min(amount, order.amount_paid_paise - order.amount_refunded_paise), reason: `Complaint ${ticket.ticket_number}`, actorId: auth.user.id, autoApprove: auth.permissions.has("refunds.approve"), orderItemId: null, ticketId: ticket.id },
        { transaction }
      );
    }

    // Vendor bears reprint cost for production defects (Section 8.4).
    if (liability === "vendor" && item.vendor_id && decision !== "reject") {
      const job = await ProductionJob.findOne({ where: { order_item_id: item.id, vendor_id: item.vendor_id }, order: [["created_at", "DESC"]], transaction });
      const charge = decision === "refund" ? (refund?.amount_paise || 0) : job?.agreed_cost_paise || item.unit_cost_paise * item.quantity;
      const commission = await Commission.findOne({ where: { order_item_id: item.id }, transaction });
      if (commission && !commission.settlement_id) {
        await commission.update({ adjustment_paise: commission.adjustment_paise + charge }, { transaction });
      } else if (reprintItem) {
        // Already settled: carry the charge on the reprint line, deducted in the next cycle.
        await Commission.create(
          { order_item_id: reprintItem.id, vendor_id: item.vendor_id, model: commission?.model || "job_rate", item_value_paise: 0, commission_pct: 0, commission_paise: 0, vendor_earning_paise: 0, adjustment_paise: charge, eligible_at: new Date() },
          { transaction }
        );
      } else {
        await TicketMessage.create({ ticket_id: ticket.id, user_id: auth.user.id, is_internal: true, body: `Vendor charge-back of ₹${(charge / 100).toFixed(2)} needs a manual settlement adjustment (line already settled).` }, { transaction });
      }
      const { Vendor } = require("../Models");
      const vendor = await Vendor.findByPk(item.vendor_id, { transaction });
      await vendor.update({ quality_score: Math.max(1, Number(vendor.quality_score) - 0.1).toFixed(2) }, { transaction });
    }

    await ticket.update(
      { decision, liability, resolution_note: note, status: "resolved", resolved_at: new Date(), reprint_order_item_id: reprintItem?.id || null, assigned_to: ticket.assigned_to || auth.user.id },
      { transaction }
    );
    await TicketMessage.create({ ticket_id: ticket.id, user_id: auth.user.id, body: `Decision: ${decision}. ${note || ""}`.trim() }, { transaction });
    await notificationService.notify(
      ticket.user_id,
      { type: "complaint_resolved", title: `${ticket.ticket_number} resolved`, body: { reprint: "We will reprint your item free of charge.", replace: "We will send a replacement free of charge.", refund: "Your refund has been initiated.", reject: note || "We could not accept this complaint." }[decision], link: `/support/tickets/${ticket.id}` },
      { transaction }
    );
    return { ticket, reprintItemId: reprintItem?.id || null, refund };
  });
}

async function countOpen() {
  return Ticket.count({ where: { status: { [Op.in]: ["open", "in_progress"] } } });
}

module.exports = { create, list, detail, reply, update, resolveComplaint, countOpen };

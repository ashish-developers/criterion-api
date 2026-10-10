// Hybrid production (Sections 8 and 6.8): ops assigns each approved order line to in-house
// or a vendor (scorecard-assisted), producers update milestones, QC gates dispatch.
const { Op } = require("sequelize");
const {
  sequelize,
  ProductionJob,
  JobEvent,
  QcCheck,
  OrderItem,
  Order,
  Proof,
  Vendor,
  VendorUser,
  VendorCapability,
  ProductSource,
  Product,
  DecorationMethod,
  ArtworkAsset,
  DesignVersion,
  User,
} = require("../Models");
const ApiError = require("../Utils/ApiError");
const { nextNumber } = require("../Utils/numbering");
const settingsService = require("./settingsService");
const notificationService = require("./notificationService");
const shippingEstimator = require("./shippingEstimator");
const assetService = require("./assetService");

const orderService = () => require("./orderService");

const REJECTION_CODES = {
  capacity: "No capacity before the due date",
  method: "Method or material not available",
  artwork: "Artwork not suitable for production",
  quantity: "Quantity outside our range",
  other: "Other reason",
};

// Job status -> order line state it implies.
const JOB_TO_ITEM = {
  in_production: "in_production",
  quality_check: "quality_check",
  qc_failed: "qc_failed",
  ready_for_dispatch: "packed",
};

const JOB_TRANSITIONS = {
  assigned: ["accepted", "rejected", "cancelled", "on_hold"],
  accepted: ["in_production", "cancelled", "on_hold"],
  in_production: ["quality_check", "on_hold"],
  quality_check: ["ready_for_dispatch", "qc_failed"],
  qc_failed: ["in_production"],
  ready_for_dispatch: ["dispatched"],
  dispatched: ["delivered"],
  on_hold: ["accepted", "in_production"],
};

async function notifyVendor(vendorId, payload, transaction) {
  const members = await VendorUser.findAll({ where: { vendor_id: vendorId }, transaction });
  for (const m of members) await notificationService.notify(m.user_id, payload, { transaction });
}

async function notifyStaff(permission, payload) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id WHERE p.code = :permission`,
    { replacements: { permission } }
  );
  for (const r of rows) await notificationService.notify(r.user_id, { ...payload, email: false });
}

/**
 * Routing scorecard (Section 8.2): eligibility filters, then weighted score.
 * At MVP ops still chooses manually; this ranks the options.
 */
async function sourceOptions(orderItemId) {
  const item = await OrderItem.findByPk(orderItemId, { include: [{ model: Order, as: "order" }] });
  if (!item) throw ApiError.notFound("Order line not found");
  const product = await Product.findByPk(item.product_id);
  const weights = await settingsService.get("routing");
  const method = item.method_id ? await DecorationMethod.findByPk(item.method_id) : null;
  const sources = await ProductSource.findAll({ where: { product_id: item.product_id }, include: [{ model: Vendor, as: "vendor" }] });
  const destination = item.order.shipping_address.pincode;
  const deadline = item.order.deliver_by ? new Date(item.order.deliver_by) : null;

  const [loads] = await sequelize.query(
    `SELECT COALESCE(vendor_id::text, 'in_house') AS source, sum(quantity)::int AS qty
       FROM production_jobs WHERE status IN ('assigned','accepted','in_production','quality_check') GROUP BY 1`
  );
  const loadBySource = new Map(loads.map((l) => [l.source, l.qty]));

  const options = [];
  if (!sources.some((s) => s.source === "in_house") && method?.in_house) {
    sources.push({ source: "in_house", vendor_id: null, cost_paise: product.base_cost_paise, lead_time_days: product.lead_time_days });
  }
  for (const s of sources) {
    const reasons = [];
    let capability = null;
    let vendor = null;
    let dailyCapacity = 500;
    let quality = 4.5;
    let costPerUnit = Number(s.cost_paise);
    let lead = s.lead_time_days;
    let distanceZone = "local";
    if (s.source === "vendor") {
      vendor = s.vendor || (await Vendor.findByPk(s.vendor_id));
      if (!vendor || vendor.status !== "approved") reasons.push("Vendor not active");
      if (method) {
        capability = await VendorCapability.findOne({ where: { vendor_id: s.vendor_id, method_id: method.id, is_active: true } });
        if (!capability) reasons.push(`Does not offer ${method.name}`);
        else {
          if (item.quantity < capability.min_qty || item.quantity > capability.max_qty) reasons.push(`Quantity outside ${capability.min_qty}-${capability.max_qty}`);
          dailyCapacity = capability.daily_capacity;
          lead = capability.lead_time_days;
          costPerUnit += capability.cost_per_unit_paise * Math.max(1, item.print_area_count);
          quality = Number(capability.quality_score);
        }
      }
      quality = Math.min(quality, Number(vendor?.quality_score || quality));
      if (quality < weights.min_quality_score) reasons.push(`Quality score ${quality} below ${weights.min_quality_score}`);
      const cfg = await settingsService.get("shipping");
      distanceZone = vendor?.pincode ? shippingEstimator.zoneFor(vendor.pincode, destination, cfg) || "national" : "national";
    } else {
      if (method && !method.in_house) reasons.push(`${method.name} is not produced in-house`);
      costPerUnit += (method ? Number(method.default_cost_paise) : 0) * Math.max(1, item.print_area_count);
      const cfg = await settingsService.get("shipping");
      distanceZone = shippingEstimator.zoneFor(cfg.origin_pincode, destination, cfg) || "national";
    }
    const key = s.source === "vendor" ? s.vendor_id : "in_house";
    const load = loadBySource.get(key) || 0;
    if (load + item.quantity > dailyCapacity * Math.max(1, lead)) reasons.push("Over capacity for the lead time");
    const transit = { local: 1, regional: 3, national: 5, remote: 8 }[distanceZone];
    const readyBy = shippingEstimator.addWorkingDays(new Date(), lead + transit);
    if (deadline && readyBy > deadline) reasons.push("Cannot meet the customer's delivery date");
    options.push({
      source: s.source,
      vendorId: s.vendor_id || null,
      vendorName: vendor?.business_name || "In-house studio",
      eligible: reasons.length === 0,
      reasons,
      estCostPaise: costPerUnit * item.quantity,
      leadTimeDays: lead,
      transitDays: transit,
      quality,
      load,
      dailyCapacity,
      readyBy: shippingEstimator.toDateOnly(readyBy),
    });
  }
  // Normalise each factor to 0..1 (1 = best) and apply the configured weights.
  const eligible = options.filter((o) => o.eligible);
  const range = (k) => [Math.min(...eligible.map((o) => o[k])), Math.max(...eligible.map((o) => o[k]))];
  const norm = (v, [min, max], lowerIsBetter) => (max === min ? 1 : lowerIsBetter ? (max - v) / (max - min) : (v - min) / (max - min));
  const ranges = { cost: range("estCostPaise"), lead: range("leadTimeDays"), quality: range("quality"), transit: range("transitDays"), load: range("load") };
  for (const o of options) {
    if (!o.eligible) {
      o.score = 0;
      continue;
    }
    const score =
      weights.cost * norm(o.estCostPaise, ranges.cost, true) +
      weights.lead_time * norm(o.leadTimeDays, ranges.lead, true) +
      weights.quality * norm(o.quality, ranges.quality, false) +
      weights.distance * norm(o.transitDays, ranges.transit, true) +
      weights.load * norm(o.load, ranges.load, true);
    // In-house wins ties (Section 8.2).
    o.score = Math.round(score * 10) / 10 + (o.source === "in_house" ? 0.05 : 0);
  }
  // Key accounts can pin a preferred source.
  const company = item.order.company_id ? await require("../Models").Company.findByPk(item.order.company_id) : null;
  if (company?.preferred_vendor_id) {
    const pinned = options.find((o) => o.vendorId === company.preferred_vendor_id && o.eligible);
    if (pinned) pinned.pinned = true;
  }
  options.sort((a, b) => Number(b.pinned || 0) - Number(a.pinned || 0) || b.score - a.score);
  return { item: { id: item.id, quantity: item.quantity, method: method?.name, deliverBy: item.order.deliver_by }, options };
}

async function assign(auth, { orderItemId, source, vendorId, dueDate, agreedCostPaise, machine, notes }) {
  return sequelize.transaction(async (transaction) => {
    const item = await OrderItem.findByPk(orderItemId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!item) throw ApiError.notFound("Order line not found");
    if (item.state !== "proof_approved") {
      throw ApiError.conflict("Only lines with an approved proof (or no customisation) can be assigned", "NOT_READY_FOR_PRODUCTION");
    }
    if (item.requires_proof && !item.approved_proof_id) throw ApiError.conflict("This line has no approved proof", "PROOF_NOT_APPROVED");
    const order = await Order.findByPk(item.order_id, { transaction });
    if (!orderService().paymentConditionMet(order)) throw ApiError.conflict("Payment terms are not met for this order yet", "PAYMENT_PENDING");
    if (source === "vendor") {
      const vendor = await Vendor.findByPk(vendorId, { transaction });
      if (!vendor || vendor.status !== "approved") throw ApiError.unprocessable("Choose an approved vendor", "VENDOR_INVALID");
    }
    const job = await ProductionJob.create(
      {
        job_number: await nextNumber("job", transaction),
        order_item_id: item.id,
        source,
        vendor_id: source === "vendor" ? vendorId : null,
        proof_id: item.approved_proof_id,
        method_id: item.method_id,
        quantity: item.quantity,
        due_date: dueDate || item.due_date,
        agreed_cost_paise: agreedCostPaise || 0,
        // In-house jobs need no acceptance step.
        status: source === "in_house" ? "accepted" : "assigned",
        accepted_at: source === "in_house" ? new Date() : null,
        machine: machine || null,
        notes: notes || null,
        assigned_by: auth.user.id,
      },
      { transaction }
    );
    await JobEvent.create({ job_id: job.id, event: "assigned", status: job.status, note: notes, actor_user_id: auth.user.id }, { transaction });
    await item.update({ fulfilment_source: source, vendor_id: source === "vendor" ? vendorId : null, due_date: job.due_date }, { transaction });
    await orderService().transitionItem(item, "assigned", { actorId: auth.user.id, note: source === "vendor" ? "Assigned to a production partner" : "Assigned to in-house production", transaction });
    if (source === "vendor") {
      await notifyVendor(vendorId, { type: "job_assigned", title: `New job ${job.job_number}`, body: `${item.quantity} x ${item.product_snapshot.name}. Accept or reject within 4 business hours.`, link: `/vendor/assigned-orders/${job.id}` }, transaction);
    }
    return job;
  });
}

async function loadJob(auth, jobId, { transaction, forUpdate = false } = {}) {
  const job = await ProductionJob.findByPk(jobId, { transaction, lock: forUpdate ? transaction.LOCK.UPDATE : undefined });
  if (!job) throw ApiError.notFound("Job not found");
  const staff = auth.permissions.has("production.view") || auth.permissions.has("production.manage");
  const ownVendor = job.vendor_id && auth.vendorId === job.vendor_id && auth.permissions.has("vendor.jobs.view");
  if (!staff && !ownVendor) throw ApiError.notFound("Job not found");
  return job;
}

function canUpdate(auth, job) {
  if (job.source === "vendor") return auth.vendorId === job.vendor_id && auth.permissions.has("vendor.jobs.update") || auth.permissions.has("production.manage");
  return auth.permissions.has("production.manage");
}

async function respond(auth, jobId, { accept, reasonCode, note }) {
  return sequelize.transaction(async (transaction) => {
    const job = await loadJob(auth, jobId, { transaction, forUpdate: true });
    if (job.vendor_id !== auth.vendorId) throw ApiError.forbidden();
    if (job.status !== "assigned") throw ApiError.conflict("This job has already been answered", "JOB_ANSWERED");
    const item = await OrderItem.findByPk(job.order_item_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (accept) {
      await job.update({ status: "accepted", accepted_at: new Date() }, { transaction });
      await JobEvent.create({ job_id: job.id, event: "accepted", status: "accepted", note, actor_user_id: auth.user.id }, { transaction });
    } else {
      if (!REJECTION_CODES[reasonCode]) throw ApiError.unprocessable("Choose a rejection reason", "REASON_REQUIRED");
      await job.update({ status: "rejected", rejection_code: reasonCode, rejection_note: note }, { transaction });
      await JobEvent.create({ job_id: job.id, event: "rejected", status: "rejected", note: `${REJECTION_CODES[reasonCode]}${note ? `: ${note}` : ""}`, actor_user_id: auth.user.id }, { transaction });
      // The line returns to the assignment queue.
      await item.update({ fulfilment_source: null, vendor_id: null }, { transaction });
      await orderService().transitionItem(item, "proof_approved", { actorId: auth.user.id, note: "Vendor declined the job; awaiting reassignment", transaction, visible: false });
    }
    if (!accept) await notifyStaff("production.manage", { type: "job_rejected", title: `Job ${job.job_number} rejected by vendor`, body: REJECTION_CODES[reasonCode], link: `/admin/production` });
    return job;
  });
}

function assertJobTransition(job, to) {
  if (!(JOB_TRANSITIONS[job.status] || []).includes(to)) {
    throw ApiError.conflict(`Job cannot move from "${job.status.replace(/_/g, " ")}" to "${to.replace(/_/g, " ")}"`, "INVALID_JOB_TRANSITION");
  }
}

async function updateMilestone(auth, jobId, { status, note, photoAssetIds = [] }) {
  return sequelize.transaction(async (transaction) => {
    const job = await loadJob(auth, jobId, { transaction, forUpdate: true });
    if (!canUpdate(auth, job)) throw ApiError.forbidden();
    if (!["in_production", "quality_check", "on_hold", "accepted"].includes(status)) {
      throw ApiError.unprocessable("Use the QC form to pass or fail a job, and the dispatch form to ship it", "MILESTONE_INVALID");
    }
    assertJobTransition(job, status);
    if (photoAssetIds.length) await assetService.assertUsable(auth, photoAssetIds);
    const patch = { status };
    if (status === "in_production" && !job.started_at) patch.started_at = new Date();
    if (status === "quality_check") patch.completed_at = new Date();
    await job.update(patch, { transaction });
    await JobEvent.create({ job_id: job.id, event: "milestone", status, note, photo_asset_ids: photoAssetIds, actor_user_id: auth.user.id }, { transaction });
    const item = await OrderItem.findByPk(job.order_item_id, { transaction, lock: transaction.LOCK.UPDATE });
    const target = JOB_TO_ITEM[status] || (status === "on_hold" ? "on_hold" : null);
    if (target && item.state !== target) {
      await orderService().transitionItem(item, target === "on_hold" ? "on_hold" : target, { actorId: auth.user.id, note, transaction });
    } else if (status === "accepted" && item.state === "on_hold") {
      await orderService().transitionItem(item, item.previous_state, { actorId: auth.user.id, note: "Resumed", transaction });
    }
    if (status === "in_production") {
      const order = await Order.findByPk(item.order_id, { transaction });
      await notificationService.notify(order.user_id, { type: "in_production", title: `${order.order_number} is in production`, body: `${item.product_snapshot.name} is being made.`, link: `/orders/${order.id}` }, { transaction });
    }
    return job;
  });
}

// QC checklist with pass/fail and photos; a failed check sends the job back for reprint (FR-PM-03).
async function recordQc(auth, jobId, { result, checklist = {}, defectQty = 0, notes, photoAssetIds = [] }) {
  return sequelize.transaction(async (transaction) => {
    const job = await loadJob(auth, jobId, { transaction, forUpdate: true });
    const allowed = auth.permissions.has("qc.perform") || (job.vendor_id === auth.vendorId && auth.permissions.has("vendor.jobs.update"));
    if (!allowed) throw ApiError.forbidden();
    if (job.status !== "quality_check") throw ApiError.conflict("Move the job to quality check first", "NOT_IN_QC");
    if (photoAssetIds.length) await assetService.assertUsable(auth, photoAssetIds);
    const item = await OrderItem.findByPk(job.order_item_id, { transaction, lock: transaction.LOCK.UPDATE });
    const order = await Order.findByPk(item.order_id, { transaction });
    // Photo evidence is required for B2B orders over 50 units (Section 12.1).
    if (order.channel === "b2b" && item.quantity > 50 && !photoAssetIds.length) {
      throw ApiError.unprocessable("Add QC photos: they are required for business orders over 50 units", "QC_PHOTOS_REQUIRED");
    }
    const qc = await QcCheck.create(
      { job_id: job.id, result, checklist, defect_qty: defectQty, decision: result === "fail" ? "reprint" : "accept", notes, photo_asset_ids: photoAssetIds, checked_by: auth.user.id },
      { transaction }
    );
    if (result === "pass") {
      await job.update({ status: "ready_for_dispatch" }, { transaction });
      await JobEvent.create({ job_id: job.id, event: "qc_passed", status: "ready_for_dispatch", note: notes, photo_asset_ids: photoAssetIds, actor_user_id: auth.user.id }, { transaction });
      await orderService().transitionItem(item, "packed", { actorId: auth.user.id, note: "Quality check passed, packed", transaction });
    } else {
      await job.update({ status: "qc_failed" }, { transaction });
      await JobEvent.create({ job_id: job.id, event: "qc_failed", status: "qc_failed", note: `${defectQty} defective. ${notes || ""}`.trim(), photo_asset_ids: photoAssetIds, actor_user_id: auth.user.id }, { transaction });
      await orderService().transitionItem(item, "qc_failed", { actorId: auth.user.id, note: "Quality check failed", transaction, visible: false });
      // Reprint task: the job goes straight back into production.
      await job.update({ status: "in_production" }, { transaction });
      await JobEvent.create({ job_id: job.id, event: "reprint_started", status: "in_production", note: "Reprint after failed QC", actor_user_id: auth.user.id }, { transaction });
      await orderService().transitionItem(item, "in_production", { actorId: auth.user.id, note: "Reprinting after quality check", transaction, visible: false });
      if (job.vendor_id) {
        const vendor = await Vendor.findByPk(job.vendor_id, { transaction });
        await vendor.update({ quality_score: Math.max(1, Number(vendor.quality_score) - 0.05).toFixed(2) }, { transaction });
      }
    }
    return qc;
  });
}

const STAFF_INCLUDE = [
  { model: OrderItem, as: "orderItem", include: [{ model: Order, as: "order", attributes: ["id", "order_number", "channel", "deliver_by", "shipping_address", "company_id", "payment_terms", "amount_paid_paise", "total_paise"] }] },
  { model: Vendor, as: "vendor", attributes: ["id", "business_name"] },
  { model: DecorationMethod, as: "method", attributes: ["id", "code", "name"] },
];

function presentJob(job, auth) {
  const json = job.toJSON();
  const item = json.orderItem;
  const showCost = auth.vendorId === json.vendor_id || auth.permissions.has("settlements.manage");
  const atRisk = json.due_date && !["dispatched", "delivered", "cancelled", "rejected"].includes(json.status) && new Date(json.due_date) <= new Date(Date.now() + 24 * 3600 * 1000);
  const slaBreach = json.status === "assigned" && Date.now() - new Date(json.assigned_at).getTime() > 4 * 3600 * 1000;
  return {
    id: json.id,
    jobNumber: json.job_number,
    source: json.source,
    vendor: json.vendor,
    method: json.method,
    quantity: json.quantity,
    dueDate: json.due_date,
    status: json.status,
    isReprint: json.is_reprint,
    machine: json.machine,
    notes: json.notes,
    assignedAt: json.assigned_at,
    acceptedAt: json.accepted_at,
    agreedCostPaise: showCost ? json.agreed_cost_paise : undefined,
    rejection: json.rejection_code ? { code: json.rejection_code, label: REJECTION_CODES[json.rejection_code], note: json.rejection_note } : null,
    atRisk,
    slaBreach,
    item: item
      ? {
          id: item.id,
          name: item.product_snapshot.name,
          sku: item.product_snapshot.sku,
          attributes: item.product_snapshot.attributes,
          image: item.product_snapshot.image,
          sizeBreakdown: item.size_breakdown,
          printAreaCount: item.print_area_count,
          state: item.state,
          express: item.express,
          orderId: item.order?.id,
          orderNumber: item.order?.order_number,
          channel: item.order?.channel,
          deliverBy: item.order?.deliver_by,
          // Vendors receive only what shipping needs (Section 4.3).
          shipTo: item.order?.shipping_address,
        }
      : null,
  };
}

async function list(auth, { status, source, vendorId, methodCode, atRisk, page = 1, limit = 50 } = {}) {
  const where = {};
  if (auth.permissions.has("production.view")) {
    if (vendorId) where.vendor_id = vendorId;
    if (source) where.source = source;
  } else if (auth.vendorId && auth.permissions.has("vendor.jobs.view")) {
    where.vendor_id = auth.vendorId;
  } else {
    throw ApiError.forbidden();
  }
  if (status) where.status = status.includes(",") ? { [Op.in]: status.split(",") } : status;
  const include = STAFF_INCLUDE.map((i) => ({ ...i }));
  if (methodCode) include[2] = { ...include[2], where: { code: methodCode } };
  const { rows, count } = await ProductionJob.findAndCountAll({ where, include, order: [["due_date", "ASC NULLS LAST"], ["created_at", "ASC"]], limit, offset: (page - 1) * limit, distinct: true });
  let items = rows.map((j) => presentJob(j, auth));
  if (atRisk) items = items.filter((j) => j.atRisk);
  return { items, total: count };
}

async function detail(auth, jobId) {
  const job = await loadJob(auth, jobId);
  const full = await ProductionJob.findByPk(job.id, {
    include: [...STAFF_INCLUDE, { model: JobEvent, as: "events", include: [{ model: User, as: "actor", attributes: ["id", "name"] }] }, { model: QcCheck, as: "qcChecks" }],
  });
  const proof = job.proof_id ? await Proof.findByPk(job.proof_id) : null;
  const item = full.orderItem;
  const version = item.design_version_id ? await DesignVersion.findByPk(item.design_version_id) : null;
  const artworkIds = [...new Set([...(version?.asset_ids || []), ...(item.product_snapshot.artworkAssetIds || [])])];
  const artwork = artworkIds.length ? await ArtworkAsset.findAll({ where: { id: artworkIds } }) : [];
  const [shipments] = await sequelize.query(
    `SELECT s.id, s.shipment_number, s.carrier, s.tracking_number, s.tracking_url, s.status, s.dispatched_at, s.delivered_at
       FROM shipments s JOIN shipment_items si ON si.shipment_id = s.id WHERE si.order_item_id = :itemId ORDER BY s.created_at`,
    { replacements: { itemId: item.id } }
  );
  return {
    shipments,
    ...presentJob(full, auth),
    // Production works only from the approved, locked proof version (FR-PR-03).
    proof: proof
      ? { id: proof.id, versionNo: proof.version_no, locked: proof.locked, previewUrl: proof.preview_asset_id ? `/api/v1/assets/${proof.preview_asset_id}` : null, printFileUrl: proof.print_file_asset_id ? `/api/v1/assets/${proof.print_file_asset_id}` : null, approvedAt: proof.approved_at }
      : null,
    design: version ? { canvas: version.canvas, versionNo: version.version_no } : null,
    artwork: artwork.map(assetService.present),
    artworkNotes: item.product_snapshot.artworkNotes,
    events: full.events.sort((a, b) => a.created_at - b.created_at).map((e) => ({ id: e.id, event: e.event, status: e.status, note: e.note, photos: e.photo_asset_ids.map((id) => `/api/v1/assets/${id}`), actor: e.actor?.name, at: e.created_at })),
    qcChecks: full.qcChecks.map((q) => ({ id: q.id, result: q.result, checklist: q.checklist, defectQty: q.defect_qty, notes: q.notes, photos: q.photo_asset_ids.map((id) => `/api/v1/assets/${id}`), at: q.created_at })),
    rejectionCodes: REJECTION_CODES,
  };
}

// Capacity view for the job board (FR-PM-04): open quantity per source and method.
async function board() {
  const [rows] = await sequelize.query(
    `SELECT j.source, COALESCE(v.business_name, 'In-house studio') AS source_name, dm.name AS method, j.status,
            count(*)::int AS jobs, sum(j.quantity)::int AS units,
            sum(CASE WHEN j.due_date <= current_date + 1 THEN 1 ELSE 0 END)::int AS due_soon
       FROM production_jobs j
       LEFT JOIN vendors v ON v.id = j.vendor_id
       LEFT JOIN decoration_methods dm ON dm.id = j.method_id
      WHERE j.status NOT IN ('dispatched','delivered','cancelled','rejected')
      GROUP BY 1,2,3,4 ORDER BY 2,3`
  );
  const [ready] = await sequelize.query(
    `SELECT count(*)::int AS lines, COALESCE(sum(quantity),0)::int AS units FROM order_items WHERE state = 'proof_approved'`
  );
  return { capacity: rows, awaitingAssignment: ready[0] };
}

// Escalate jobs at risk of missing their due date (24 h before).
async function escalateAtRisk() {
  const jobs = await ProductionJob.findAll({
    where: { status: { [Op.notIn]: ["dispatched", "delivered", "cancelled", "rejected"] }, due_date: { [Op.lte]: shippingEstimator.toDateOnly(new Date(Date.now() + 24 * 3600 * 1000)) } },
  });
  for (const job of jobs) {
    const flagged = await JobEvent.count({ where: { job_id: job.id, event: "at_risk" } });
    if (flagged) continue;
    await JobEvent.create({ job_id: job.id, event: "at_risk", status: job.status, note: `Due ${job.due_date}; not yet dispatched` });
    await notifyStaff("production.manage", { type: "job_at_risk", title: `Job ${job.job_number} at risk`, body: `Due ${job.due_date} and not dispatched yet.`, link: `/admin/production/${job.id}` });
    if (job.vendor_id) await notifyVendor(job.vendor_id, { type: "job_at_risk", title: `Job ${job.job_number} is due soon`, body: `Due ${job.due_date}. Update its status or contact the platform team.`, link: `/vendor/assigned-orders/${job.id}`, email: false });
  }
}

module.exports = { sourceOptions, assign, respond, updateMilestone, recordQc, list, detail, board, escalateAtRisk, REJECTION_CODES, loadJob, canUpdate, presentJob, notifyStaff, notifyVendor };

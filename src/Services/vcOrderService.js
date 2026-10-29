// Visiting card orders: server-side quotes, placing orders (idempotent), the order lifecycle
// and artwork review. Customers see their own orders (and company admins their company's
// corporate orders); staff need vc.view, and money is hidden from staff who may not see it.
//
//   pending (unpaid) --payment--> artwork_review --artwork approved--> approved
//     --> in_production --> dispatched (with tracking) --> delivered
//   Rejected artwork stays in artwork_review until the customer resubmits it.
//   cancelled: by the customer before paying, by staff before dispatch (optionally refunded).
const { Op, UniqueConstraintError } = require("sequelize");
const { sequelize, VcOrder, VcOrderCard, VcOrderEvent, VcPayment, VcInvoice, VcPriceSlab, VcPrintOption, VcDesign, User, Company } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { nextNumber } = require("../Utils/numbering");
const settingsService = require("./settingsService");
const shippingEstimator = require("./shippingEstimator");
const notificationService = require("./notificationService");
const designs = require("./vcDesignService");
const pricing = require("./vcPricing");
const { STATUS_TRANSITIONS, STAFF_CANCELLABLE, PRINT_OPTION_GROUPS } = require("../Config/visitingCards");

const num = (x) => (x === null || x === undefined ? x : Number(x));
const rupees = (paise) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Production staff see orders and artwork but no prices or payments (Section 4.3).
function canSeeMoney(auth) {
  return auth.permissions.has("vc.payments.view") || auth.permissions.has("orders.view");
}

async function event(orderId, actorId, action, { from, to, note, transaction } = {}) {
  await VcOrderEvent.create({ order_id: orderId, actor_user_id: actorId || null, action, from_status: from || null, to_status: to || null, note: note || null }, { transaction });
}

function notifyCustomer(order, title, body, transaction) {
  return notificationService.notify(order.user_id, { type: "vc_order", title, body, link: `/visiting-cards/orders/${order.id}` }, { transaction });
}

// ---------------------------------------------------------------- print options
async function printOptions({ activeOnly = true } = {}) {
  const where = activeOnly ? { is_active: true } : {};
  const rows = await VcPrintOption.findAll({ where, order: [["group_code", "ASC"], ["sort_order", "ASC"], ["name", "ASC"]] });
  return rows;
}

function presentOption(o) {
  return { id: o.id, group: o.group_code, code: o.code, name: o.name, description: o.description, pricePerCardPaise: o.price_per_card_paise, isDefault: o.is_default, isActive: o.is_active, sortOrder: o.sort_order };
}

async function optionCatalogue() {
  const rows = await printOptions();
  return Object.entries(PRINT_OPTION_GROUPS)
    .map(([code, label]) => ({ code, label, options: rows.filter((o) => o.group_code === code).map(presentOption) }))
    .filter((g) => g.options.length);
}

/** One option per group: the chosen code, else the group's default. Unknown codes are refused. */
async function resolveOptions(codes, transaction) {
  const rows = await VcPrintOption.findAll({ where: { is_active: true }, transaction });
  const chosen = [];
  for (const code of codes) {
    const option = rows.find((o) => o.code === code);
    if (!option) throw ApiError.unprocessable("One of the printing options is no longer available. Choose again.", "OPTION_INVALID", { options: code });
    if (chosen.some((c) => c.group_code === option.group_code)) throw ApiError.unprocessable(`Choose one ${PRINT_OPTION_GROUPS[option.group_code].toLowerCase()} option`, "OPTION_INVALID", { options: code });
    chosen.push(option);
  }
  for (const group of Object.keys(PRINT_OPTION_GROUPS)) {
    if (chosen.some((c) => c.group_code === group)) continue;
    const fallback = rows.find((o) => o.group_code === group && o.is_default);
    if (fallback) chosen.push(fallback);
  }
  return chosen.sort((a, b) => Object.keys(PRINT_OPTION_GROUPS).indexOf(a.group_code) - Object.keys(PRINT_OPTION_GROUPS).indexOf(b.group_code));
}

// ---------------------------------------------------------------- quote
async function buildQuote(auth, input, { transaction, lock } = {}) {
  const settings = await designs.moduleSettings();
  const design = await designs.load(auth, input.designId, { transaction, lock });
  await designs.assertEnabled(auth, design.customer_type);
  const { cards, problems, totalQuantity } = designs.cardsFor(design, input.quantity, settings);
  const options = await resolveOptions(input.options || [], transaction);
  const slabs = await VcPriceSlab.findAll({ transaction });
  const seller = await settingsService.get("seller");

  let address = null;
  if (input.addressId) address = await require("./orderService").ownedAddress(auth, input.addressId, transaction);
  const interstate = address ? address.state.trim().toLowerCase() !== String(seller.state).trim().toLowerCase() : false;
  const delivery = address ? await shippingEstimator.quote({ pincode: address.pincode, productionDays: settings.production_days }) : null;
  if (delivery && !delivery.serviceable) problems.push({ code: "NOT_SERVICEABLE", message: delivery.reason || "We cannot deliver to this PIN code yet" });

  const q = pricing.quote({ quantities: cards.map((c) => c.quantity), doubleSided: Boolean(design.design.back), slabs, options, settings, interstate });
  if (!q.priced) problems.push({ code: "NO_PRICE", message: q.reason });
  return { settings, design, cards, totalQuantity, options, quote: q, address, delivery, problems };
}

function presentQuote(b) {
  return {
    canOrder: b.problems.length === 0,
    problems: b.problems,
    minOrderQty: b.settings.min_order_qty,
    minQtyPerCard: b.settings.min_qty_per_card,
    isDoubleSided: Boolean(b.design.design.back),
    cardCount: b.cards.length,
    totalQuantity: b.totalQuantity,
    cards: b.cards.map((c) => ({ lineNo: c.lineNo, name: c.fields.fullName || null, quantity: c.quantity })),
    pricing: b.quote.priced ? b.quote : null,
    delivery: b.delivery
      ? b.delivery.serviceable
        ? { serviceable: true, estimatedDispatch: b.delivery.estimatedDispatch, estimatedDelivery: b.delivery.estimatedDelivery, isEstimate: b.delivery.isEstimate }
        : { serviceable: false, reason: b.delivery.reason }
      : null,
    template: { orientation: b.design.orientation, widthMm: num(b.design.width_mm), heightMm: num(b.design.height_mm) },
  };
}

async function quote(auth, input) {
  return presentQuote(await buildQuote(auth, input));
}

// ---------------------------------------------------------------- place order
async function place(auth, input) {
  const existing = await VcOrder.findOne({ where: { user_id: auth.user.id, idempotency_key: input.idempotencyKey } });
  if (existing) return { order: await detail(auth, existing.id), duplicate: true };
  let orderId;
  try {
    orderId = await sequelize.transaction(async (transaction) => {
      const b = await buildQuote(auth, input, { transaction, lock: transaction.LOCK.UPDATE });
      if (b.problems.length) {
        const first = b.problems[0];
        throw ApiError.unprocessable(first.message, first.code, { problems: b.problems });
      }
      const billing = input.billingAddressId ? await require("./orderService").ownedAddress(auth, input.billingAddressId, transaction) : b.address;
      const { addressSnapshot } = require("./orderService");
      const company = b.design.company_id ? await Company.findByPk(b.design.company_id, { transaction }) : null;
      const template = b.design.template_id ? await b.design.getTemplate({ transaction, paranoid: false }) : null;
      const q = b.quote;
      const order = await VcOrder.create(
        {
          order_number: await nextNumber("vc_order", transaction),
          user_id: auth.user.id,
          company_id: b.design.customer_type === "corporate" ? b.design.company_id : null,
          customer_type: b.design.customer_type,
          design_id: b.design.id,
          template_id: b.design.template_id,
          template_snapshot: {
            id: b.design.template_id,
            code: template?.code || null,
            name: template?.name || b.design.name,
            orientation: b.design.orientation,
            widthMm: num(b.design.width_mm),
            heightMm: num(b.design.height_mm),
            bleedMm: num(template?.bleed_mm ?? 3),
            safeMarginMm: num(template?.safe_margin_mm ?? 3),
          },
          design_snapshot: b.design.design,
          fields_snapshot: b.design.fields,
          is_double_sided: Boolean(b.design.design.back),
          card_count: b.cards.length,
          total_quantity: q.totalQuantity,
          print_options: q.options,
          pricing: q,
          unit_price_paise: q.unitPricePaise,
          subtotal_paise: q.subtotalPaise,
          shipping_paise: q.shippingPaise,
          taxable_paise: q.taxablePaise,
          cgst_paise: q.cgstPaise,
          sgst_paise: q.sgstPaise,
          igst_paise: q.igstPaise,
          tax_paise: q.taxPaise,
          total_paise: q.totalPaise,
          gst_rate: q.gstRate,
          hsn_code: b.settings.hsn_code,
          is_interstate: q.interstate,
          contact: { name: auth.user.name, email: auth.user.email, phone: auth.user.phone },
          shipping_address: addressSnapshot(b.address),
          billing_address: addressSnapshot(billing),
          gstin: input.gstin || company?.gstin || null,
          customer_note: input.note || null,
          estimated_dispatch: b.delivery?.estimatedDispatch || null,
          estimated_delivery: b.delivery?.estimatedDelivery || null,
          idempotency_key: input.idempotencyKey,
        },
        { transaction }
      );
      await VcOrderCard.bulkCreate(
        b.cards.map((c) => ({ order_id: order.id, line_no: c.lineNo, fields: c.fields, quantity: c.quantity })),
        { transaction }
      );
      await event(order.id, auth.user.id, "placed", { to: "pending", note: `${q.totalQuantity} cards for ${b.cards.length} ${b.cards.length === 1 ? "person" : "people"}`, transaction });
      await b.design.update({ status: "ordered", last_ordered_at: new Date() }, { transaction });
      await notifyCustomer(order, `Visiting card order ${order.order_number} placed`, `Complete the payment of ${rupees(order.total_paise)} to send your artwork for review.`, transaction);
      return order.id;
    });
  } catch (error) {
    // Two simultaneous requests with the same key: the loser returns the winner's order.
    if (error instanceof UniqueConstraintError) {
      const winner = await VcOrder.findOne({ where: { user_id: auth.user.id, idempotency_key: input.idempotencyKey } });
      if (winner) return { order: await detail(auth, winner.id), duplicate: true };
    }
    throw error;
  }
  return { order: await detail(auth, orderId), duplicate: false };
}

// ---------------------------------------------------------------- visibility and presenters
function customerWhere(auth) {
  const own = { user_id: auth.user.id };
  if (auth.companyId && auth.permissions.has("company.brand.manage")) return { [Op.or]: [own, { company_id: auth.companyId }] };
  return own;
}

async function loadForCustomer(auth, id, { transaction, lock } = {}) {
  const order = await VcOrder.findOne({ where: { id, ...customerWhere(auth) }, transaction, lock });
  if (!order) throw ApiError.notFound("Order not found");
  return order;
}

async function loadForStaff(id, { transaction, lock } = {}) {
  const order = await VcOrder.findByPk(id, { transaction, lock });
  if (!order) throw ApiError.notFound("Order not found");
  return order;
}

function presentSummary(o, { money = true } = {}) {
  return {
    id: o.id,
    orderNumber: o.order_number,
    customerType: o.customer_type,
    templateName: o.template_snapshot?.name,
    orientation: o.template_snapshot?.orientation,
    isDoubleSided: o.is_double_sided,
    cardCount: o.card_count,
    totalQuantity: o.total_quantity,
    status: o.status,
    paymentStatus: o.payment_status,
    artworkStatus: o.artwork_status,
    placedAt: o.placed_at,
    estimatedDelivery: o.estimated_delivery,
    customer: o.customer ? { id: o.customer.id, name: o.customer.name, email: o.customer.email } : undefined,
    company: o.company ? { id: o.company.id, name: o.company.name } : null,
    ...(money ? { totalPaise: o.total_paise, amountPaidPaise: o.amount_paid_paise } : {}),
    // Front of the first card, for list thumbnails.
    preview: { template: o.template_snapshot, design: o.design_snapshot, fields: o.fields_snapshot },
  };
}

function presentPayment(p) {
  return {
    id: p.id,
    receiptNumber: p.receipt_number,
    provider: p.provider,
    providerPaymentId: p.provider_payment_id,
    amountPaise: p.amount_paise,
    status: p.status,
    method: p.method,
    failureReason: p.failure_reason,
    capturedAt: p.captured_at,
    refundedAt: p.refunded_at,
    createdAt: p.created_at,
    reference: p.raw?.reference || null,
  };
}

function customerActions(o) {
  const unpaid = o.payment_status === "unpaid" && o.status === "pending";
  return {
    pay: unpaid,
    cancel: unpaid,
    editArtwork: o.status === "pending" || (o.status === "artwork_review" && o.artwork_status === "rejected"),
    invoice: o.payment_status !== "unpaid",
  };
}

function staffActions(auth, o) {
  const manage = auth.permissions.has("vc.orders.manage");
  const payments = auth.permissions.has("vc.payments.manage");
  return {
    reviewArtwork: manage && o.status === "artwork_review" && o.artwork_status === "submitted",
    nextStatuses: manage ? STATUS_TRANSITIONS[o.status] || [] : [],
    tracking: manage && ["approved", "in_production", "dispatched"].includes(o.status),
    cancel: manage && STAFF_CANCELLABLE.includes(o.status),
    refundOnCancel: payments && o.payment_status === "paid",
    recordPayment: payments && o.payment_status === "unpaid" && o.status === "pending",
  };
}

async function present(auth, order, { staff = false } = {}) {
  const money = !staff || canSeeMoney(auth);
  const [cards, events, payments, invoice, customer, company] = await Promise.all([
    VcOrderCard.findAll({ where: { order_id: order.id }, order: [["line_no", "ASC"]] }),
    VcOrderEvent.findAll({ where: { order_id: order.id }, include: [{ model: User, as: "actor", attributes: ["id", "name"] }], order: [["created_at", "ASC"], ["id", "ASC"]] }),
    money ? VcPayment.findAll({ where: { order_id: order.id }, order: [["created_at", "ASC"]] }) : [],
    VcInvoice.findOne({ where: { order_id: order.id }, attributes: ["id", "invoice_number", "issued_at"] }),
    User.findByPk(order.user_id, { attributes: ["id", "name", "email", "phone"] }),
    order.company_id ? Company.findByPk(order.company_id, { attributes: ["id", "name", "gstin"] }) : null,
  ]);
  const out = {
    ...presentSummary({ ...order.get(), customer, company }, { money }),
    template: order.template_snapshot,
    design: order.design_snapshot,
    fields: order.fields_snapshot,
    cards: cards.map((c) => ({ id: c.id, lineNo: c.line_no, fields: c.fields, quantity: c.quantity })),
    printOptions: order.print_options.map((o) => (money ? o : { group: o.group, code: o.code, name: o.name })),
    artworkNote: order.artwork_note,
    artworkReviewedAt: order.artwork_reviewed_at,
    contact: order.contact,
    shippingAddress: order.shipping_address,
    billingAddress: order.billing_address,
    gstin: order.gstin,
    customerNote: order.customer_note,
    estimatedDispatch: order.estimated_dispatch,
    courier: order.courier,
    trackingNumber: order.tracking_number,
    trackingUrl: order.tracking_url,
    paidAt: order.paid_at,
    approvedAt: order.approved_at,
    productionStartedAt: order.production_started_at,
    dispatchedAt: order.dispatched_at,
    deliveredAt: order.delivered_at,
    cancelledAt: order.cancelled_at,
    cancelReason: order.cancel_reason,
    designId: order.design_id,
    events: events.map((e) => ({ id: Number(e.id), action: e.action, fromStatus: e.from_status, toStatus: e.to_status, note: e.note, actor: e.actor ? e.actor.name : null, at: e.created_at })),
    invoice: invoice ? { id: invoice.id, number: invoice.invoice_number, issuedAt: invoice.issued_at } : null,
    actions: staff ? staffActions(auth, order) : customerActions(order),
  };
  if (money) {
    Object.assign(out, {
      pricing: order.pricing,
      unitPricePaise: order.unit_price_paise,
      subtotalPaise: order.subtotal_paise,
      shippingPaise: order.shipping_paise,
      taxablePaise: order.taxable_paise,
      cgstPaise: order.cgst_paise,
      sgstPaise: order.sgst_paise,
      igstPaise: order.igst_paise,
      taxPaise: order.tax_paise,
      gstRate: num(order.gst_rate),
      hsnCode: order.hsn_code,
      isInterstate: order.is_interstate,
      payments: payments.map(presentPayment),
    });
  }
  return out;
}

async function detail(auth, id) {
  return present(auth, await loadForCustomer(auth, id));
}

async function staffDetail(auth, id) {
  return present(auth, await loadForStaff(id), { staff: true });
}

// ---------------------------------------------------------------- lists
function listWhere(q) {
  const where = {};
  if (q.status) where.status = { [Op.in]: q.status.split(",").filter(Boolean) };
  if (q.paymentStatus) where.payment_status = q.paymentStatus;
  if (q.artworkStatus) where.artwork_status = q.artworkStatus;
  if (q.customerType) where.customer_type = q.customerType;
  if (q.companyId) where.company_id = q.companyId;
  if (q.userId) where.user_id = q.userId;
  const placed = {};
  if (q.from) placed[Op.gte] = new Date(`${q.from}T00:00:00`);
  if (q.to) placed[Op.lt] = new Date(new Date(`${q.to}T00:00:00`).getTime() + 86400000);
  if (Object.getOwnPropertySymbols(placed).length) where.placed_at = placed;
  const qty = {};
  if (q.minQty) qty[Op.gte] = q.minQty;
  if (q.maxQty) qty[Op.lte] = q.maxQty;
  if (Object.getOwnPropertySymbols(qty).length) where.total_quantity = qty;
  return where;
}

async function listMine(auth, q) {
  const where = { ...listWhere({ status: q.status }), ...customerWhere(auth) };
  const { rows, count } = await VcOrder.findAndCountAll({
    where,
    include: [{ model: Company, as: "company", attributes: ["id", "name"] }, { model: User, as: "customer", attributes: ["id", "name", "email"] }],
    order: [["placed_at", "DESC"]],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { items: rows.map((o) => presentSummary(o)), total: count };
}

async function staffList(auth, q) {
  const where = listWhere(q);
  if (q.q) {
    const term = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
    where[Op.or] = [
      { order_number: { [Op.iLike]: term } },
      { tracking_number: { [Op.iLike]: term } },
      { "$customer.name$": { [Op.iLike]: term } },
      { "$customer.email$": { [Op.iLike]: term } },
      { "$company.name$": { [Op.iLike]: term } },
    ];
  }
  const { rows, count } = await VcOrder.findAndCountAll({
    where,
    include: [{ model: Company, as: "company", attributes: ["id", "name"] }, { model: User, as: "customer", attributes: ["id", "name", "email"] }],
    order: [["placed_at", "DESC"]],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    subQuery: false,
  });
  return { items: rows.map((o) => presentSummary(o, { money: canSeeMoney(auth) })), total: count };
}

// ---------------------------------------------------------------- customer actions
async function cancelByCustomer(auth, id, { reason }) {
  await sequelize.transaction(async (transaction) => {
    const order = await loadForCustomer(auth, id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!customerActions(order).cancel) throw ApiError.conflict("This order can no longer be cancelled online. Contact support for help.", "CANCEL_NOT_ALLOWED");
    await order.update({ status: "cancelled", cancelled_at: new Date(), cancel_reason: reason }, { transaction });
    await VcPayment.update({ status: "failed", failure_reason: "Order cancelled" }, { where: { order_id: order.id, status: "created" }, transaction });
    await event(order.id, auth.user.id, "cancelled", { from: "pending", to: "cancelled", note: reason, transaction });
  });
  return detail(auth, id);
}

/**
 * Corrected artwork from the customer: before payment, or after staff rejected it. The cards
 * keep their number and quantities (the price is fixed; quantities sent with the rows are ignored), but text, layout and images can change.
 */
async function updateArtwork(auth, id, data) {
  await sequelize.transaction(async (transaction) => {
    const order = await loadForCustomer(auth, id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!customerActions(order).editArtwork) throw ApiError.conflict("The artwork for this order can no longer be changed", "ARTWORK_LOCKED");
    if (Boolean(data.design.back) !== order.is_double_sided) {
      throw ApiError.unprocessable(order.is_double_sided ? "This order is printed on both sides; keep the back of the card" : "This order is printed on one side; remove the back of the card", "SIDES_CHANGED");
    }
    await designs.checkAssets(auth, data.fields);
    const settings = await designs.moduleSettings();
    const cards = await VcOrderCard.findAll({ where: { order_id: order.id }, order: [["line_no", "ASC"]], transaction });
    const asDesign = { customer_type: order.customer_type, fields: data.fields, employees: data.employees };
    const rebuilt = designs.cardsFor(asDesign, cards[0].quantity, settings);
    if (order.customer_type === "corporate") {
      if (data.employees.length !== cards.length) throw ApiError.unprocessable(`This order prints cards for ${cards.length} people; keep the same number of rows`, "CARD_COUNT_CHANGED");
      const invalid = rebuilt.problems.find((p) => p.code === "EMPLOYEE_ERRORS");
      if (invalid) throw ApiError.unprocessable(invalid.message, invalid.code, { problems: [invalid] });
    } else if (!rebuilt.cards[0].fields.fullName) {
      throw ApiError.unprocessable("Add your name to the card", "NAME_REQUIRED");
    }
    for (const [i, card] of cards.entries()) await card.update({ fields: rebuilt.cards[i].fields }, { transaction });
    const resubmitted = order.artwork_status === "rejected";
    await order.update({ design_snapshot: data.design, fields_snapshot: data.fields, ...(resubmitted ? { artwork_status: "submitted", artwork_note: null } : {}) }, { transaction });
    await event(order.id, auth.user.id, resubmitted ? "artwork_resubmitted" : "artwork_updated", { note: resubmitted ? "Corrected artwork sent for review" : "Artwork updated before payment", transaction });
  });
  return detail(auth, id);
}

// ---------------------------------------------------------------- payment outcome (called by vcPaymentService)
/** The order has been paid in full: start artwork review (or approve directly when review is off). */
async function markPaid(order, { actorId, transaction }) {
  const settings = await designs.moduleSettings();
  const review = Boolean(settings.artwork_review_required);
  const now = new Date();
  const patch = { payment_status: "paid", paid_at: now };
  if (order.status === "pending") {
    Object.assign(patch, review ? { status: "artwork_review", artwork_status: "submitted" } : { status: "approved", artwork_status: "approved", approved_at: now });
  }
  const from = order.status;
  await order.update(patch, { transaction });
  if (from !== order.status) await event(order.id, actorId, review ? "artwork_submitted" : "approved", { from, to: order.status, note: review ? "Payment received; artwork sent for review" : "Payment received; artwork review is not required", transaction });
  await notifyCustomer(
    order,
    `Payment received for ${order.order_number}`,
    review ? "Thank you! Our team is reviewing your artwork and will confirm before printing." : "Thank you! Your cards are approved for printing.",
    transaction
  );
}

// ---------------------------------------------------------------- staff actions
async function artworkDecision(auth, id, { decision, reason }) {
  if (decision === "reject" && (!reason || reason.length < 5)) {
    throw ApiError.unprocessable("Tell the customer what needs to change", "VALIDATION_FAILED", { reason: "Enter a reason of at least 5 characters" });
  }
  let before;
  await sequelize.transaction(async (transaction) => {
    const order = await loadForStaff(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!(order.status === "artwork_review" && order.artwork_status === "submitted")) throw ApiError.conflict("This order has no artwork waiting for review", "NOT_IN_REVIEW");
    before = { status: order.status, artwork_status: order.artwork_status };
    const now = new Date();
    if (decision === "approve") {
      await order.update({ status: "approved", artwork_status: "approved", approved_at: now, artwork_note: reason || null, artwork_reviewed_by: auth.user.id, artwork_reviewed_at: now }, { transaction });
      await event(order.id, auth.user.id, "artwork_approved", { from: "artwork_review", to: "approved", note: reason, transaction });
      // The design is now approved branding the company can reuse for later orders.
      if (order.design_id) await VcDesign.update({ approved_at: now }, { where: { id: order.design_id }, transaction });
      await notifyCustomer(order, `Artwork approved for ${order.order_number}`, "Your visiting cards are approved and will go into production shortly.", transaction);
    } else {
      await order.update({ artwork_status: "rejected", artwork_note: reason, artwork_reviewed_by: auth.user.id, artwork_reviewed_at: now }, { transaction });
      await event(order.id, auth.user.id, "artwork_rejected", { note: reason, transaction });
      await notifyCustomer(order, `Changes needed for ${order.order_number}`, `Our team asked for a change before printing: ${reason}`, transaction);
    }
  });
  return { order: await staffDetail(auth, id), before };
}

const STATUS_FIELDS = { in_production: "production_started_at", dispatched: "dispatched_at", delivered: "delivered_at" };
const STATUS_MESSAGES = {
  in_production: ["Your visiting cards are being printed", "Printing has started."],
  dispatched: ["Your visiting cards are on the way", "They have been handed to the courier."],
  delivered: ["Your visiting cards were delivered", "Thank you for ordering with us."],
};

async function setStatus(auth, id, { status, note, courier, trackingNumber, trackingUrl }) {
  let before;
  await sequelize.transaction(async (transaction) => {
    const order = await loadForStaff(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (status === "cancelled") throw ApiError.unprocessable("Use Cancel order to cancel", "USE_CANCEL");
    const allowed = STATUS_TRANSITIONS[order.status] || [];
    if (!allowed.includes(status)) {
      const hint =
        order.status === "pending" ? "The order moves on once it is paid." : order.status === "artwork_review" ? "Approve the artwork first." : `Next step: ${allowed.join(", ") || "none"}.`;
      throw ApiError.conflict(`An order that is ${order.status.replace(/_/g, " ")} cannot move to ${status.replace(/_/g, " ")}. ${hint}`, "INVALID_TRANSITION");
    }
    before = { status: order.status, tracking_number: order.tracking_number };
    const patch = { status, [STATUS_FIELDS[status]]: new Date() };
    if (courier) patch.courier = courier;
    if (trackingNumber) patch.tracking_number = trackingNumber;
    if (trackingUrl) patch.tracking_url = trackingUrl;
    if (status === "dispatched" && !(patch.tracking_number || order.tracking_number)) {
      throw ApiError.unprocessable("Add the courier and tracking number before dispatching", "TRACKING_REQUIRED", { trackingNumber: "Required to dispatch" });
    }
    const from = order.status;
    await order.update(patch, { transaction });
    const trackingNote = status === "dispatched" ? `${order.courier || "Courier"} ${order.tracking_number}` : null;
    await event(order.id, auth.user.id, status, { from, to: status, note: [note, trackingNote].filter(Boolean).join(" · ") || null, transaction });
    const [title, body] = STATUS_MESSAGES[status];
    await notifyCustomer(order, `${title} (${order.order_number})`, status === "dispatched" ? `${body} Tracking: ${order.courier || ""} ${order.tracking_number}`.trim() : body, transaction);
  });
  return { order: await staffDetail(auth, id), before };
}

async function updateTracking(auth, id, { courier, trackingNumber, trackingUrl }) {
  let before;
  await sequelize.transaction(async (transaction) => {
    const order = await loadForStaff(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!["approved", "in_production", "dispatched"].includes(order.status)) throw ApiError.conflict("Tracking can be added once the artwork is approved", "TRACKING_NOT_ALLOWED");
    before = { courier: order.courier, tracking_number: order.tracking_number, tracking_url: order.tracking_url };
    await order.update({ courier, tracking_number: trackingNumber, tracking_url: trackingUrl || null }, { transaction });
    await event(order.id, auth.user.id, "tracking_updated", { note: `${courier} ${trackingNumber}`, transaction });
  });
  return { order: await staffDetail(auth, id), before };
}

async function cancelByStaff(auth, id, { reason, refund }) {
  if (refund && !auth.permissions.has("vc.payments.manage")) throw ApiError.forbidden("Refunds need the visiting card payments permission");
  let before;
  let refunded = 0;
  // Refund calls go to the gateway, so they run before the order is locked and updated; each
  // payment is marked refunded only after the gateway accepts it.
  const order0 = await loadForStaff(id);
  if (!STAFF_CANCELLABLE.includes(order0.status)) throw ApiError.conflict(`An order that is ${order0.status.replace(/_/g, " ")} cannot be cancelled`, "CANCEL_NOT_ALLOWED");
  if (refund && order0.payment_status === "paid") refunded = await require("./vcPaymentService").refundOrder(auth, order0, reason);
  await sequelize.transaction(async (transaction) => {
    const order = await loadForStaff(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!STAFF_CANCELLABLE.includes(order.status)) throw ApiError.conflict(`An order that is ${order.status.replace(/_/g, " ")} cannot be cancelled`, "CANCEL_NOT_ALLOWED");
    before = { status: order.status, payment_status: order.payment_status };
    const patch = { status: "cancelled", cancelled_at: new Date(), cancel_reason: reason };
    if (refunded > 0) patch.payment_status = "refunded";
    const from = order.status;
    await order.update(patch, { transaction });
    await VcPayment.update({ status: "failed", failure_reason: "Order cancelled" }, { where: { order_id: order.id, status: "created" }, transaction });
    const paidNote = order.payment_status === "paid" ? " Payment kept: refund it separately if needed." : "";
    await event(order.id, auth.user.id, "cancelled", { from, to: "cancelled", note: `${reason}${refunded ? ` · ${rupees(refunded)} refunded` : paidNote}`, transaction });
    await notifyCustomer(order, `Order ${order.order_number} cancelled`, `${reason}${refunded ? ` A refund of ${rupees(refunded)} has been issued to your original payment method.` : ""}`, transaction);
  });
  return { order: await staffDetail(auth, id), before, refundedPaise: refunded };
}

module.exports = {
  canSeeMoney,
  event,
  optionCatalogue,
  printOptions,
  presentOption,
  resolveOptions,
  quote,
  place,
  detail,
  staffDetail,
  listMine,
  staffList,
  loadForCustomer,
  loadForStaff,
  cancelByCustomer,
  updateArtwork,
  markPaid,
  artworkDecision,
  setStatus,
  updateTracking,
  cancelByStaff,
  presentSummary,
  presentPayment,
  listWhere,
};

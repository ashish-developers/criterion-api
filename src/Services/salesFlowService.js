// The quotation-to-delivery flow in seven stages, shown to customers and staff on both the
// quotation and the order:
//
//   1 quotation   Admin approves the quotation       Awaiting approval / Sent to customer
//   2 response    Customer reviews it                 Accepted / Revision requested / Rejected / Expired
//   3 order       Sales order confirmation            Pending confirmation / Confirmed / Cancelled
//   4 payment     Advance or full payment, as agreed  Pending / Partially paid / Paid / Failed
//   5 production  Artwork approval and production     Artwork pending / Artwork approved / In production / Quality check
//   6 shipping    Quality check and dispatch          Ready to dispatch / Dispatched / Delivered
//   7 final       Delivery, final invoice and closure Completed
//
// Every stage is derived from records the workflow already keeps (quote and order status,
// order-line states, payments, invoice), so the flow can never disagree with them.
const { Quote, QuoteVersion, QuoteEvent, Order, OrderItem, Payment, Invoice } = require("../Models");

// How far an order line has progressed; on-hold lines count at the state they were held in.
const RANK = {
  placed: 0,
  payment_pending: 1,
  artwork_pending: 2,
  proof_sent: 3,
  proof_approved: 4,
  assigned: 5,
  in_production: 6,
  quality_check: 7,
  qc_failed: 7,
  packed: 8,
  dispatched: 9,
  rto: 9,
  delivered: 10,
  closed: 11,
};

const displayDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

const PRE_SENT = ["requested", "under_review", "correction_requested", "resubmitted"];

function quotationStage(quote, ctx) {
  const base = { key: "quotation", title: "Quotation approval" };
  if (!quote) return { ...base, status: "online_order", label: "Placed online", skipped: true };
  const labels = { requested: "Awaiting approval", under_review: "Under review", correction_requested: "Returned for correction", resubmitted: "Resubmitted for review" };
  if (PRE_SENT.includes(quote.status)) return { ...base, status: quote.status, label: labels[quote.status], hint: quote.status === "correction_requested" ? "Waiting for the customer to correct the request" : "The team is checking and pricing the request" };
  if (quote.status === "cancelled") return { ...base, status: "withdrawn", label: "Withdrawn", blocked: true };
  if (quote.status === "rejected" && ctx.rejectedBy !== "customer") return { ...base, status: "rejected", label: "Rejected", blocked: true, hint: ctx.rejectReason || null };
  return { ...base, status: "sent", label: "Sent to customer", done: true, at: ctx.sentAt, hint: ctx.versionNo ? `Version ${ctx.versionNo}` : null };
}

function responseStage(quote, ctx) {
  const base = { key: "response", title: "Customer review" };
  if (!quote) return { ...base, status: "online_order", label: "Placed online", skipped: true };
  switch (quote.status) {
    case "sent":
      return { ...base, status: "awaiting_response", label: "Awaiting response", hint: ctx.validUntil ? `Valid until ${displayDate(ctx.validUntil)}` : null };
    case "revision_requested":
      return { ...base, status: "revision_requested", label: "Revision requested", hint: "A revised quotation is being prepared" };
    case "accepted":
    case "converted":
      return { ...base, status: "accepted", label: "Accepted", done: true, at: ctx.acceptedAt };
    case "rejected":
      return ctx.rejectedBy === "customer" ? { ...base, status: "rejected", label: "Rejected", blocked: true, hint: ctx.rejectReason || null } : { ...base, status: "not_sent", label: "Not sent" };
    case "expired":
      return { ...base, status: "expired", label: "Expired", blocked: true };
    default:
      return { ...base, status: "not_sent", label: "Not sent yet" };
  }
}

function orderStage(order) {
  const base = { key: "order", title: "Order confirmation" };
  if (!order) return { ...base, status: "not_created", label: "Not created" };
  if (["cancelled", "refunded"].includes(order.status)) return { ...base, status: "cancelled", label: "Cancelled", blocked: true, at: order.cancelled_at, hint: order.cancel_reason || null };
  if (order.confirmation_status === "pending") return { ...base, status: "pending_confirmation", label: "Pending confirmation", hint: "The team is confirming the sales order" };
  if (order.approval_status === "pending") return { ...base, status: "awaiting_approval", label: "Awaiting company approval" };
  return { ...base, status: "confirmed", label: "Confirmed", done: true, at: order.confirmed_at || order.placed_at, hint: `Sales order ${order.order_number}` };
}

function paymentStage(order, ctx) {
  const base = { key: "payment", title: "Payment" };
  if (!order || order.confirmation_status === "pending") return { ...base, status: "pending", label: "Pending" };
  const met = ctx.paymentConditionMet(order);
  const labels = { pending: "Pending", partially_paid: "Partially paid", paid: "Paid", failed: "Failed", credit: "Credit terms", partially_refunded: "Partially refunded", refunded: "Refunded" };
  const status = order.payment_status === "pending" && ctx.lastPaymentStatus === "failed" ? "failed" : order.payment_status;
  const hint =
    status === "partially_paid"
      ? "Advance received; the balance is due before dispatch"
      : status === "credit"
        ? "Pay against the invoice by its due date"
        : order.payment_terms === "advance_50" && !met
          ? "50% advance starts production"
          : null;
  return { ...base, status, label: labels[status] || status, done: met, at: ctx.paidAt, hint };
}

function productionStage(lines) {
  const base = { key: "production", title: "Artwork & production" };
  if (!lines.length) return { ...base, status: "artwork_pending", label: "Artwork pending" };
  const slowest = lines.reduce((a, b) => (b.rank < a.rank ? b : a));
  const held = lines.some((l) => l.held);
  const at = (state) => ({ artwork_pending: "Artwork pending", proof_sent: "Artwork pending", proof_approved: "Artwork approved", assigned: "Artwork approved", in_production: "In production", quality_check: "Quality check", qc_failed: "Quality check" })[state];
  if (slowest.rank < RANK.artwork_pending) return { ...base, status: "artwork_pending", label: "Artwork pending", hint: "Starts once payment is received" };
  if (slowest.rank >= RANK.packed) return { ...base, status: "quality_passed", label: "Quality check passed", done: true };
  const status = { proof_sent: "artwork_pending", assigned: "artwork_approved", qc_failed: "quality_check" }[slowest.state] || slowest.state.replace("proof_approved", "artwork_approved");
  const hints = { proof_sent: "Proof sent: waiting for the customer's approval", artwork_pending: "The design team is preparing the proof", qc_failed: "Re-work after a failed quality check", assigned: "Assigned to production" };
  return { ...base, status, label: at(slowest.state), hint: held ? "On hold" : hints[slowest.state] || null };
}

function shippingStage(lines, order) {
  const base = { key: "shipping", title: "Dispatch" };
  if (!lines.length || lines.some((l) => l.rank < RANK.packed)) {
    const someOut = lines.some((l) => l.rank >= RANK.dispatched);
    return { ...base, status: someOut ? "partially_dispatched" : "not_ready", label: someOut ? "Partially dispatched" : "Not ready" };
  }
  if (lines.every((l) => l.rank >= RANK.delivered)) return { ...base, status: "delivered", label: "Delivered", done: true, at: order.delivered_at };
  if (lines.some((l) => l.rank < RANK.dispatched)) return { ...base, status: "ready_to_dispatch", label: "Ready to dispatch", hint: "Packed and waiting for pickup" };
  return { ...base, status: "dispatched", label: "Dispatched", hint: lines.some((l) => l.state === "rto") ? "Returned to origin: re-dispatch pending" : "Track it under Shipments" };
}

function finalStage(lines, order, ctx) {
  const base = { key: "final", title: "Delivery, invoice & closure" };
  if (lines.length && lines.every((l) => l.rank >= RANK.closed)) return { ...base, status: "completed", label: "Completed", done: true, at: order.closed_at, hint: ctx.invoiceNumber ? `Invoice ${ctx.invoiceNumber}` : null };
  if (lines.length && lines.every((l) => l.rank >= RANK.delivered)) return { ...base, status: "awaiting_closure", label: "Awaiting closure", hint: ctx.invoiceNumber ? `Invoice ${ctx.invoiceNumber} issued` : "Final invoice is issued once fully paid" };
  return { ...base, status: "open", label: "Open" };
}

/**
 * Pure: build the seven stages from loaded records.
 * quote / order may each be null (a request not yet ordered, or an order placed online).
 */
function build({ quote = null, order = null, items = [], ...ctx }) {
  const lines = items
    .filter((i) => !["cancelled", "refunded"].includes(i.state))
    .map((i) => {
      const state = i.state === "on_hold" ? i.previous_state : i.state;
      return { state, rank: RANK[state] ?? 0, held: i.state === "on_hold" };
    });
  const raw = [
    quotationStage(quote, ctx),
    responseStage(quote, ctx),
    orderStage(order),
    paymentStage(order, ctx),
    productionStage(lines),
    shippingStage(lines, order),
    finalStage(lines, order, ctx),
  ];
  let stopped = false;
  let current = null;
  const stages = raw.map((s, index) => {
    let state;
    if (stopped) state = "skipped";
    else if (s.skipped) state = "skipped";
    else if (s.done) state = "done";
    else if (s.blocked) {
      state = "blocked";
      stopped = true;
    } else if (!current) state = "current";
    else state = "upcoming";
    if (state === "current" || (state === "blocked" && !current)) current = s.key;
    const { done, blocked, skipped, ...rest } = s;
    return { step: index + 1, ...rest, state, at: rest.at || null, hint: state === "skipped" && stopped ? null : rest.hint || null };
  });
  return { current: current || (stages.every((s) => ["done", "skipped"].includes(s.state)) ? "final" : null), completed: stages.at(-1).state === "done", stages };
}

async function quoteContext(quote) {
  const [version, rejected, accepted] = await Promise.all([
    quote.current_version_id ? QuoteVersion.findByPk(quote.current_version_id, { attributes: ["version_no", "sent_at", "valid_until"] }) : null,
    quote.status === "rejected" ? QuoteEvent.findOne({ where: { quote_id: quote.id, event: "rejected" }, order: [["id", "DESC"]] }) : null,
    ["accepted", "converted"].includes(quote.status) ? QuoteEvent.findOne({ where: { quote_id: quote.id, event: ["accepted", "converted"] }, order: [["id", "DESC"]] }) : null,
  ]);
  return {
    versionNo: version?.version_no || null,
    sentAt: version?.sent_at || null,
    validUntil: version?.valid_until || null,
    rejectedBy: rejected?.actor_role || null,
    rejectReason: rejected?.reason || null,
    acceptedAt: accepted?.created_at || null,
  };
}

async function orderContext(order) {
  const [items, payments, invoice] = await Promise.all([
    OrderItem.findAll({ where: { order_id: order.id }, attributes: ["state", "previous_state"] }),
    Payment.findAll({ where: { order_id: order.id }, attributes: ["status", "captured_at", "created_at"], order: [["created_at", "ASC"]] }),
    Invoice.findOne({ where: { order_id: order.id }, attributes: ["invoice_number"] }),
  ]);
  const captured = payments.filter((p) => p.status === "captured");
  return {
    items,
    lastPaymentStatus: payments.at(-1)?.status || null,
    paidAt: captured.at(-1)?.captured_at || null,
    invoiceNumber: invoice?.invoice_number || null,
  };
}

/** Flow for a quotation and, once it is converted, its sales order. */
async function forQuote(quote) {
  const order = quote.order_id ? await Order.findByPk(quote.order_id) : null;
  const [qctx, octx] = await Promise.all([quoteContext(quote), order ? orderContext(order) : {}]);
  return build({ quote, order, ...qctx, ...octx, paymentConditionMet: require("./orderService").paymentConditionMet });
}

/** Flow for an order, including the quotation it came from (if any). */
async function forOrder(order) {
  const quote = order.quote_id ? await Quote.findByPk(order.quote_id) : null;
  const [qctx, octx] = await Promise.all([quote ? quoteContext(quote) : {}, orderContext(order)]);
  return build({ quote, order, ...qctx, ...octx, paymentConditionMet: require("./orderService").paymentConditionMet });
}

module.exports = { build, forQuote, forOrder, RANK };

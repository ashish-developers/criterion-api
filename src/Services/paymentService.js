// Payment flow (Section 9.2): order -> payment intent -> gateway checkout ->
// signature-verified callback or webhook -> capture (idempotent) -> production unlocked.
const { Op } = require("sequelize");
const { sequelize, Order, Payment, PaymentWebhookEvent, User } = require("../Models");
const ApiError = require("../Utils/ApiError");
const gatewayService = require("./gatewayService");
const gatewayCheckout = require("./gatewayCheckout");
const orderService = require("./orderService");
const notificationService = require("./notificationService");

async function createIntent(auth, orderId, { gateway } = {}) {
  return sequelize.transaction(async (transaction) => {
    const order = await Order.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order || order.user_id !== auth.user.id) throw ApiError.notFound("Order not found");
    if (["cancelled", "refunded"].includes(order.status)) throw ApiError.conflict("This order has been cancelled", "ORDER_CANCELLED");
    if (order.confirmation_status === "pending") throw ApiError.conflict("This order is waiting for our confirmation. You can pay once it is confirmed.", "CONFIRMATION_PENDING");
    if (order.approval_status === "pending") throw ApiError.conflict("This order is waiting for your company's approval", "APPROVAL_PENDING");
    const due = await orderService.amountDue(order);
    if (due.amountPaise <= 0) throw ApiError.conflict("Nothing is due on this order", "NOTHING_DUE");

    // Reuses an open intent for the same gateway, mode and amount instead of creating duplicates.
    const intent = await gatewayCheckout.openPayment(ledger, {
      orderId: order.id,
      orderNumber: order.order_number,
      amountPaise: due.amountPaise,
      gatewayCode: gateway,
      auth,
      notes: { order_id: order.id },
      fields: { purpose: due.purpose },
      transaction,
    });
    return { ...intent, purpose: due.purpose };
  });
}

/**
 * Marks a payment captured exactly once, even if the callback and webhook race.
 * Updates the order's paid amount and unlocks production when terms are satisfied.
 */
async function capture(paymentId, { providerPaymentId, method, raw, actorId, signatureVerified }) {
  return sequelize.transaction(async (transaction) => {
    const payment = await Payment.findByPk(paymentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!payment) throw ApiError.notFound("Payment not found");
    if (payment.status === "captured") return { payment, alreadyCaptured: true };
    if (payment.status !== "created" && payment.status !== "failed") throw ApiError.conflict("Payment cannot be captured", "PAYMENT_STATE");

    const order = await Order.findByPk(payment.order_id, { transaction, lock: transaction.LOCK.UPDATE });
    await payment.update(
      {
        status: "captured",
        provider_payment_id: providerPaymentId,
        method: method || null,
        raw: raw || {},
        signature_verified: Boolean(signatureVerified),
        captured_at: new Date(),
        failure_reason: null,
      },
      { transaction }
    );
    const paid = order.amount_paid_paise + payment.amount_paise;
    await order.update({ amount_paid_paise: paid, payment_status: paid >= order.total_paise ? "paid" : "partially_paid" }, { transaction });
    await orderService.event(order.id, null, "payment_received", {
      actorId,
      note: `₹${(payment.amount_paise / 100).toFixed(2)} received (${payment.purpose})`,
      transaction,
    });

    const wasCancelled = ["cancelled", "refunded"].includes(order.status);
    if (!wasCancelled) await orderService.advanceAfterPayment(order.id, { actorId, transaction });
    if (paid >= order.total_paise) await require("./invoiceService").generate(order.id, { transaction });
    await orderService.refreshOrderStatus(order.id, transaction);

    // A payment that lands after cancellation is refunded automatically.
    if (wasCancelled) {
      await require("./refundService").createAndProcess(
        { order, payment, amountPaise: payment.amount_paise, reason: "Payment received after cancellation", actorId, autoApprove: true },
        { transaction }
      );
    }
    await notificationService.notify(
      order.user_id,
      { type: "payment_received", title: `Payment received for ${order.order_number}`, body: `We received ₹${(payment.amount_paise / 100).toFixed(2)}. Thank you!`, link: `/orders/${order.id}` },
      { transaction }
    );
    return { payment, alreadyCaptured: false };
  });
}

async function fail(paymentId, reason) {
  const payment = await Payment.findByPk(paymentId);
  if (payment && payment.status === "created") await payment.update({ status: "failed", failure_reason: reason });
  return payment;
}

// Shop orders' ledger for the shared gateway checkout (gatewayCheckout).
const ledger = { name: "shop", Model: Payment, capture: (...args) => capture(...args), fail: (...args) => fail(...args) };

async function ownPayment(auth, paymentId) {
  const payment = await Payment.findByPk(paymentId, { include: [{ model: Order, as: "order" }] });
  if (!payment || payment.order.user_id !== auth.user.id) throw ApiError.notFound("Payment not found");
  return payment;
}

// Razorpay checkout handler result, posted by the browser. Confirmed with Razorpay before it counts.
async function verifyCheckout(auth, { paymentId, providerOrderId, providerPaymentId, signature }) {
  const payment = await ownPayment(auth, paymentId);
  await gatewayCheckout.verifyRazorpay(ledger, payment, { providerOrderId, providerPaymentId, signature, actorId: auth.user.id });
  return orderService.detail(auth, payment.order_id);
}

// PayPal onApprove: the server captures the order with PayPal and checks the result.
async function capturePaypal(auth, { paymentId, providerOrderId }) {
  const payment = await ownPayment(auth, paymentId);
  if (payment.provider_order_id !== providerOrderId) throw ApiError.badRequest("Payment does not match this order", undefined, "PAYMENT_MISMATCH");
  const result = await gatewayCheckout.settlePaypal(ledger, payment, { actorId: auth.user.id });
  return { pending: Boolean(result.pending), order: await orderService.detail(auth, payment.order_id) };
}

// Development-only simulated gateway: completes or fails a mock payment server-side.
async function completeMock(auth, paymentId, outcome) {
  if (!gatewayService.mockEnabled()) throw ApiError.forbidden("Mock payments are disabled");
  const payment = await ownPayment(auth, paymentId);
  if (payment.provider !== "mock") throw ApiError.notFound("Payment not found");
  if (outcome === "failure") {
    await fail(payment.id, "Payment declined (simulated)");
    throw ApiError.unprocessable("The payment was declined. You can try again.", "PAYMENT_FAILED");
  }
  await capture(payment.id, {
    providerPaymentId: `mock_pay_${payment.id.replace(/-/g, "").slice(0, 16)}`,
    method: "upi",
    actorId: auth.user.id,
    signatureVerified: true,
    raw: { simulated: true },
  });
  return orderService.detail(auth, payment.order_id);
}

// Finance records an offline payment (bank transfer against a PO / credit invoice).
async function recordOffline(auth, orderId, { amountPaise, reference, note }) {
  const order = await Order.findByPk(orderId);
  if (!order) throw ApiError.notFound("Order not found");
  if (order.confirmation_status === "pending") throw ApiError.conflict("Confirm the sales order before recording a payment", "CONFIRMATION_PENDING");
  const outstanding = order.total_paise - order.amount_paid_paise;
  if (amountPaise > outstanding) throw ApiError.unprocessable(`Only ₹${(outstanding / 100).toFixed(2)} is outstanding`, "AMOUNT_TOO_HIGH");
  const payment = await Payment.create({
    order_id: order.id,
    provider: "offline",
    purpose: order.amount_paid_paise === 0 ? (amountPaise >= order.total_paise ? "full" : "advance") : "balance",
    provider_order_id: null,
    amount_paise: amountPaise,
    status: "created",
    created_by: auth.user.id,
    raw: { reference, note },
  });
  await capture(payment.id, { providerPaymentId: `offline_${reference}`.slice(0, 100), method: "bank_transfer", actorId: auth.user.id, signatureVerified: false, raw: { reference, note } });
  return payment.reload();
}

const CUSTOMER = { model: User, as: "customer", attributes: ["id", "name", "email", "phone"] };

/** Admin transaction history: search (order, gateway ids, customer), gateway, status, date range. */
async function list({ page = 1, limit = 20, status, provider, q, from, to }) {
  const where = {};
  if (status) where.status = status;
  if (provider) where.provider = provider;
  if (from || to) {
    where.created_at = {};
    if (from) where.created_at[Op.gte] = new Date(`${from}T00:00:00+05:30`);
    if (to) where.created_at[Op.lt] = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 24 * 3600 * 1000);
  }
  if (q) {
    const term = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    where[Op.or] = [
      { provider_payment_id: { [Op.iLike]: term } },
      { provider_order_id: { [Op.iLike]: term } },
      { "$order.order_number$": { [Op.iLike]: term } },
      { "$order.customer.name$": { [Op.iLike]: term } },
      { "$order.customer.email$": { [Op.iLike]: term } },
    ];
  }
  const { rows, count } = await Payment.findAndCountAll({
    where,
    attributes: { exclude: ["raw"] },
    include: [{ model: Order, as: "order", attributes: ["id", "order_number", "user_id", "total_paise", "channel"], include: [CUSTOMER] }],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    subQuery: false,
  });
  return { items: rows, total: count };
}

/** One transaction with its order, customer, the gateway's reference data and webhook history. */
async function detail(paymentId) {
  const payment = await Payment.findByPk(paymentId, {
    include: [{ model: Order, as: "order", attributes: ["id", "order_number", "user_id", "total_paise", "amount_paid_paise", "payment_status", "status", "channel", "created_at"], include: [CUSTOMER] }],
  });
  if (!payment) throw ApiError.notFound("Payment not found");
  const creator = payment.created_by ? await User.findByPk(payment.created_by, { attributes: ["id", "name"] }) : null;
  const events = payment.provider_order_id
    ? await PaymentWebhookEvent.findAll({
        where: {
          provider: payment.provider,
          [Op.or]: [
            sequelize.where(sequelize.literal("payload::text"), { [Op.like]: `%${payment.provider_order_id}%` }),
            ...(payment.provider_payment_id ? [sequelize.where(sequelize.literal("payload::text"), { [Op.like]: `%${payment.provider_payment_id}%` })] : []),
          ],
        },
        attributes: ["id", "event_id", "event_type", "processed_at", "created_at"],
        order: [["created_at", "ASC"]],
        limit: 50,
      })
    : [];
  return { ...payment.toJSON(), createdBy: creator, webhookEvents: events };
}

async function expireStaleIntents() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  await Payment.update({ status: "failed", failure_reason: "Abandoned" }, { where: { status: "created", created_at: { [Op.lt]: cutoff }, provider: { [Op.ne]: "offline" } } });
}

module.exports = { ledger, createIntent, capture, verifyCheckout, capturePaypal, completeMock, recordOffline, list, detail, expireStaleIntents };

// Payment flow (Section 9.2): order -> payment intent -> gateway checkout ->
// signature-verified callback or webhook -> capture (idempotent) -> production unlocked.
const { Op } = require("sequelize");
const { sequelize, Order, Payment, PaymentWebhookEvent } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { config } = require("../Config/env");
const providers = require("./paymentProviders");
const orderService = require("./orderService");
const notificationService = require("./notificationService");

async function createIntent(auth, orderId) {
  return sequelize.transaction(async (transaction) => {
    const order = await Order.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order || order.user_id !== auth.user.id) throw ApiError.notFound("Order not found");
    if (["cancelled", "refunded"].includes(order.status)) throw ApiError.conflict("This order has been cancelled", "ORDER_CANCELLED");
    if (order.approval_status === "pending") throw ApiError.conflict("This order is waiting for your company's approval", "APPROVAL_PENDING");
    const due = await orderService.amountDue(order);
    if (due.amountPaise <= 0) throw ApiError.conflict("Nothing is due on this order", "NOTHING_DUE");

    const provider = providers.current();
    // Reuse an open intent for the same amount instead of creating duplicates.
    let payment = await Payment.findOne({
      where: { order_id: order.id, status: "created", provider: provider.name, amount_paise: due.amountPaise, purpose: due.purpose },
      transaction,
    });
    if (!payment) {
      const created = await provider.createOrder({ amountPaise: due.amountPaise, receipt: order.order_number, notes: { order_id: order.id } });
      payment = await Payment.create(
        {
          order_id: order.id,
          provider: provider.name,
          purpose: due.purpose,
          provider_order_id: created.providerOrderId,
          amount_paise: due.amountPaise,
          status: "created",
          created_by: auth.user.id,
        },
        { transaction }
      );
    }
    return {
      paymentId: payment.id,
      provider: provider.name,
      providerOrderId: payment.provider_order_id,
      amountPaise: payment.amount_paise,
      purpose: payment.purpose,
      currency: "INR",
      orderNumber: order.order_number,
      prefill: { name: auth.user.name, email: auth.user.email, contact: auth.user.phone },
      ...provider.checkoutOptions(),
    };
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

// Razorpay checkout handler result, posted by the browser. Trust only the signature.
async function verifyCheckout(auth, { paymentId, providerOrderId, providerPaymentId, signature }) {
  const payment = await Payment.findByPk(paymentId, { include: [{ model: Order, as: "order" }] });
  if (!payment || payment.order.user_id !== auth.user.id) throw ApiError.notFound("Payment not found");
  if (payment.provider !== "razorpay") throw ApiError.badRequest("Wrong payment provider", undefined, "PROVIDER_MISMATCH");
  if (payment.provider_order_id !== providerOrderId) throw ApiError.badRequest("Payment does not match this order", undefined, "PAYMENT_MISMATCH");
  const valid = providers.providers.razorpay.verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature });
  if (!valid) {
    await fail(payment.id, "Signature verification failed");
    throw ApiError.badRequest("Payment could not be verified", undefined, "SIGNATURE_INVALID");
  }
  await capture(payment.id, { providerPaymentId, actorId: auth.user.id, signatureVerified: true, raw: { providerOrderId } });
  return orderService.detail(auth, payment.order_id);
}

// Development-only simulated gateway: completes or fails a mock payment server-side.
async function completeMock(auth, paymentId, outcome) {
  if (config.isProduction || config.payments.provider !== "mock") throw ApiError.forbidden("Mock payments are disabled");
  const payment = await Payment.findByPk(paymentId, { include: [{ model: Order, as: "order" }] });
  if (!payment || payment.order.user_id !== auth.user.id || payment.provider !== "mock") throw ApiError.notFound("Payment not found");
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

// Signed gateway webhook; idempotent by event id.
async function handleRazorpayWebhook(req) {
  const signature = req.get("x-razorpay-signature");
  if (!providers.providers.razorpay.verifyWebhookSignature(req.rawBody, signature)) {
    throw ApiError.unauthorized("Invalid webhook signature", "SIGNATURE_INVALID");
  }
  const eventId = req.get("x-razorpay-event-id") || req.body?.id || `${req.body?.event}:${req.body?.payload?.payment?.entity?.id}`;
  const [record, created] = await PaymentWebhookEvent.findOrCreate({
    where: { provider: "razorpay", event_id: eventId },
    defaults: { provider: "razorpay", event_id: eventId, event_type: req.body?.event, payload: req.body },
  });
  if (!created && record.processed_at) return { duplicate: true };

  const entity = req.body?.payload?.payment?.entity;
  if (entity && ["payment.captured", "order.paid"].includes(req.body.event)) {
    const payment = await Payment.findOne({ where: { provider: "razorpay", provider_order_id: entity.order_id } });
    if (payment) {
      await capture(payment.id, { providerPaymentId: entity.id, method: entity.method, raw: entity, signatureVerified: true });
    }
  } else if (entity && req.body.event === "payment.failed") {
    const payment = await Payment.findOne({ where: { provider: "razorpay", provider_order_id: entity.order_id, status: "created" } });
    if (payment) await fail(payment.id, entity.error_description || "Payment failed");
  }
  await record.update({ processed_at: new Date() });
  return { processed: true };
}

// Finance records an offline payment (bank transfer against a PO / credit invoice).
async function recordOffline(auth, orderId, { amountPaise, reference, note }) {
  const order = await Order.findByPk(orderId);
  if (!order) throw ApiError.notFound("Order not found");
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

async function list({ page = 1, limit = 20, status, provider }) {
  const where = {};
  if (status) where.status = status;
  if (provider) where.provider = provider;
  const { rows, count } = await Payment.findAndCountAll({
    where,
    include: [{ model: Order, as: "order", attributes: ["id", "order_number", "user_id", "total_paise", "channel"] }],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { items: rows, total: count };
}

async function expireStaleIntents() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  await Payment.update({ status: "failed", failure_reason: "Abandoned" }, { where: { status: "created", created_at: { [Op.lt]: cutoff }, provider: { [Op.ne]: "offline" } } });
}

module.exports = { createIntent, capture, verifyCheckout, completeMock, handleRazorpayWebhook, recordOffline, list, expireStaleIntents };

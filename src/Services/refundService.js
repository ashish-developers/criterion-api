// Refunds (FR-AD-05, FR-SU-03). Support raises requests; refunds above the support limit
// need finance approval (refunds.approve). Processing calls the gateway that took the money.
const { Op } = require("sequelize");
const { sequelize, Order, Payment, Refund, OrderItem } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { SUPPORT_REFUND_LIMIT_PAISE } = require("../Config/roles");
const providers = require("./paymentProviders");
const notificationService = require("./notificationService");

function refundable(order) {
  return order.amount_paid_paise - order.amount_refunded_paise;
}

async function processRefund(refund, { actorId, transaction }) {
  const order = await Order.findByPk(refund.order_id, { transaction, lock: transaction.LOCK.UPDATE });
  if (refund.amount_paise > refundable(order)) throw ApiError.unprocessable("Refund exceeds the amount paid", "REFUND_TOO_HIGH");

  // Refund against captured payments, most recent first.
  const payments = await Payment.findAll({
    where: { order_id: order.id, status: { [Op.in]: ["captured", "partially_refunded"] } },
    order: [["captured_at", "DESC"]],
    transaction,
  });
  let remaining = refund.amount_paise;
  const references = [];
  for (const payment of payments) {
    if (remaining <= 0) break;
    const alreadyRefunded = Number(payment.raw?.refunded_paise || 0);
    const available = payment.amount_paise - alreadyRefunded;
    if (available <= 0) continue;
    const amount = Math.min(available, remaining);
    let reference;
    if (payment.provider === "offline") {
      reference = "manual-bank-transfer";
    } else {
      const provider = providers.providers[payment.provider];
      const result = await provider.refund({ providerPaymentId: payment.provider_payment_id, amountPaise: amount });
      reference = result.providerRefundId;
    }
    references.push(reference);
    const refundedNow = alreadyRefunded + amount;
    await payment.update(
      { raw: { ...payment.raw, refunded_paise: refundedNow }, status: refundedNow >= payment.amount_paise ? "refunded" : "partially_refunded" },
      { transaction }
    );
    remaining -= amount;
  }
  await refund.update({ status: "processed", processed_at: new Date(), approved_by: refund.approved_by || actorId, provider_refund_id: references.join(",").slice(0, 100) }, { transaction });
  const totalRefunded = order.amount_refunded_paise + refund.amount_paise;
  await order.update(
    { amount_refunded_paise: totalRefunded, payment_status: totalRefunded >= order.amount_paid_paise ? "refunded" : "partially_refunded" },
    { transaction }
  );
  if (refund.order_item_id) {
    const item = await OrderItem.findByPk(refund.order_item_id, { transaction });
    if (item && ["cancelled", "qc_failed", "rto"].includes(item.state)) {
      await require("./orderService").transitionItem(item, "refunded", { actorId, note: refund.reason, transaction });
    }
  }
  await require("./orderService").event(order.id, refund.order_item_id, "refund_processed", { actorId, note: `₹${(refund.amount_paise / 100).toFixed(2)} refunded`, transaction });
  await notificationService.notify(
    order.user_id,
    { type: "refund_processed", title: `Refund processed for ${order.order_number}`, body: `₹${(refund.amount_paise / 100).toFixed(2)} will reach your original payment method in 5-7 working days.`, link: `/orders/${order.id}` },
    { transaction }
  );
  return refund;
}

/** Internal: create and (optionally) immediately process a refund. */
async function createAndProcess({ order, payment, amountPaise, reason, actorId, autoApprove = false, orderItemId = null, ticketId = null }, { transaction }) {
  const refund = await Refund.create(
    {
      order_id: order.id,
      payment_id: payment ? payment.id : null,
      order_item_id: orderItemId,
      ticket_id: ticketId,
      amount_paise: amountPaise,
      reason,
      status: autoApprove ? "approved" : "requested",
      requested_by: actorId || null,
      approved_by: autoApprove ? actorId || null : null,
    },
    { transaction }
  );
  if (autoApprove) await processRefund(refund, { actorId, transaction });
  return refund;
}

async function request(auth, { orderId, orderItemId, amountPaise, reason, ticketId }) {
  return sequelize.transaction(async (transaction) => {
    const order = await Order.findByPk(orderId, { transaction });
    if (!order) throw ApiError.notFound("Order not found");
    if (amountPaise > refundable(order)) throw ApiError.unprocessable(`At most ₹${(refundable(order) / 100).toFixed(2)} can be refunded`, "REFUND_TOO_HIGH");
    // Finance processes immediately; support can refund up to the limit, above it the
    // request waits for finance approval (Section 4.3).
    const autoApprove = auth.permissions.has("refunds.approve") || amountPaise <= SUPPORT_REFUND_LIMIT_PAISE;
    return createAndProcess(
      { order, amountPaise, reason, actorId: auth.user.id, autoApprove, orderItemId, ticketId },
      { transaction }
    );
  });
}

async function approve(auth, refundId, { approve: approved = true, note }) {
  return sequelize.transaction(async (transaction) => {
    const refund = await Refund.findByPk(refundId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!refund) throw ApiError.notFound("Refund not found");
    if (!["requested", "approved"].includes(refund.status)) throw ApiError.conflict("This refund has already been decided", "REFUND_DECIDED");
    if (!approved) {
      await refund.update({ status: "rejected", approved_by: auth.user.id, reason: note ? `${refund.reason} | Rejected: ${note}` : refund.reason }, { transaction });
      return refund;
    }
    await refund.update({ status: "approved", approved_by: auth.user.id }, { transaction });
    return processRefund(refund, { actorId: auth.user.id, transaction });
  });
}

async function list({ page = 1, limit = 20, status }) {
  const where = status ? { status } : {};
  const { rows, count } = await Refund.findAndCountAll({
    where,
    include: [{ model: Order, as: "order", attributes: ["id", "order_number", "total_paise", "amount_paid_paise"] }],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { items: rows, total: count };
}

module.exports = { createAndProcess, request, approve, list, processRefund };

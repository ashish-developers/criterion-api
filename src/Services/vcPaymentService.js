// Visiting card payments, reusing the platform's gateway adapters (paymentProviders): the
// browser opens the gateway's hosted checkout, and an order only counts as paid once the
// server has verified the gateway signature (checkout callback or webhook).
//
// Duplicate protection: one open intent per order is reused; capture locks the payment and
// order rows and is a no-op for an already captured payment; gateway order/payment ids are
// unique in vc_payments; a second successful payment on an already paid order is refunded.
const { Op } = require("sequelize");
const { sequelize, VcOrder, VcPayment, VcInvoice, VcOrderCard, User, Company } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { nextNumber } = require("../Utils/numbering");
const gatewayService = require("./gatewayService");
const gatewayCheckout = require("./gatewayCheckout");
const settingsService = require("./settingsService");
const orders = require("./vcOrderService");

async function createIntent(auth, orderId, { gateway } = {}) {
  return sequelize.transaction(async (transaction) => {
    const order = await orders.loadForCustomer(auth, orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (order.status === "cancelled") throw ApiError.conflict("This order has been cancelled", "ORDER_CANCELLED");
    if (order.payment_status !== "unpaid") throw ApiError.conflict("This order is already paid", "ALREADY_PAID");
    const intent = await gatewayCheckout.openPayment(ledger, {
      orderId: order.id,
      orderNumber: order.order_number,
      amountPaise: order.total_paise - order.amount_paid_paise,
      gatewayCode: gateway,
      auth,
      notes: { vc_order_id: order.id },
      transaction,
    });
    return { ...intent, purpose: "full" };
  });
}

/** Issues the GST invoice for a paid order (once). Lines come from the order's price snapshot. */
async function issueInvoice(order, { transaction }) {
  const existing = await VcInvoice.findOne({ where: { order_id: order.id }, transaction });
  if (existing) return existing;
  const seller = await settingsService.get("seller");
  const customer = await User.findByPk(order.user_id, { transaction });
  const company = order.company_id ? await Company.findByPk(order.company_id, { transaction }) : null;
  const p = order.pricing;
  const options = (order.print_options || []).map((o) => o.name).join(", ");
  const lines = [
    {
      lineNo: 1,
      description: `Visiting cards: ${order.template_snapshot.name}, ${order.is_double_sided ? "double-sided" : "single-sided"}, ${order.template_snapshot.widthMm} × ${order.template_snapshot.heightMm} mm${options ? ` (${options})` : ""}; ${order.card_count} ${order.card_count === 1 ? "name" : "names"}`,
      hsn: order.hsn_code,
      quantity: order.total_quantity,
      unitPricePaise: order.unit_price_paise,
      discountPaise: 0,
      taxablePaise: order.subtotal_paise,
      gstRate: p.gstRate,
      cgstPaise: p.cardTax.cgst,
      sgstPaise: p.cardTax.sgst,
      igstPaise: p.cardTax.igst,
      totalPaise: order.subtotal_paise + p.cardTax.total,
    },
  ];
  if (order.shipping_paise > 0) {
    lines.push({
      lineNo: 2,
      description: "Delivery charges",
      hsn: "996812",
      quantity: 1,
      unitPricePaise: order.shipping_paise,
      discountPaise: 0,
      taxablePaise: order.shipping_paise,
      gstRate: p.shippingGstRate,
      cgstPaise: p.shippingTax.cgst,
      sgstPaise: p.shippingTax.sgst,
      igstPaise: p.shippingTax.igst,
      totalPaise: order.shipping_paise + p.shippingTax.total,
    });
  }
  return VcInvoice.create(
    {
      invoice_number: await nextNumber("invoice", transaction),
      order_id: order.id,
      seller,
      buyer: {
        name: company ? company.legal_name || company.name : customer.name,
        contact: customer.name,
        email: customer.email,
        gstin: order.gstin || null,
        billing_address: order.billing_address,
        shipping_address: order.shipping_address,
      },
      place_of_supply: order.shipping_address.state,
      is_interstate: order.is_interstate,
      lines,
      taxable_paise: order.taxable_paise,
      cgst_paise: order.cgst_paise,
      sgst_paise: order.sgst_paise,
      igst_paise: order.igst_paise,
      total_paise: order.total_paise,
      issued_at: new Date(),
    },
    { transaction }
  );
}

/**
 * Records a verified payment exactly once, even when the checkout callback and the webhook
 * race. Pays the order, issues the invoice and receipt, and starts artwork review. A payment
 * that arrives for a cancelled or already-paid order is refunded automatically.
 */
async function capture(paymentId, { providerPaymentId, method, raw, actorId, signatureVerified }) {
  const result = await sequelize.transaction(async (transaction) => {
    const payment = await VcPayment.findByPk(paymentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!payment) throw ApiError.notFound("Payment not found");
    if (payment.status === "captured" || payment.status === "refunded") return { payment, alreadyCaptured: true };
    if (!["created", "failed"].includes(payment.status)) throw ApiError.conflict("Payment cannot be captured", "PAYMENT_STATE");
    const order = await VcOrder.findByPk(payment.order_id, { transaction, lock: transaction.LOCK.UPDATE });
    await payment.update(
      {
        status: "captured",
        provider_payment_id: providerPaymentId,
        method: method || null,
        raw: { ...(payment.raw || {}), ...(raw || {}) },
        signature_verified: Boolean(signatureVerified),
        captured_at: new Date(),
        failure_reason: null,
        receipt_number: await nextNumber("vc_receipt", transaction),
      },
      { transaction }
    );
    const surplus = order.status === "cancelled" || order.payment_status !== "unpaid";
    if (surplus) {
      await orders.event(order.id, actorId, "payment_received", { note: `₹${(payment.amount_paise / 100).toFixed(2)} received after the order was ${order.status === "cancelled" ? "cancelled" : "paid"}; refunding it`, transaction });
      return { payment, order, refundNeeded: true };
    }
    const paid = order.amount_paid_paise + payment.amount_paise;
    await order.update({ amount_paid_paise: paid }, { transaction });
    await orders.event(order.id, actorId, "payment_received", { note: `₹${(payment.amount_paise / 100).toFixed(2)} received (${payment.provider === "offline" ? "offline" : method || "online"})`, transaction });
    if (paid >= order.total_paise) {
      await orders.markPaid(order, { actorId, transaction });
      await issueInvoice(order, { transaction });
    }
    return { payment, order, alreadyCaptured: false };
  });
  if (result.refundNeeded) {
    try {
      await refundPayment(result.payment, { reason: "Duplicate or late payment", actorId });
    } catch (error) {
      // The money is recorded either way; finance can refund it from the payment records.
      await orders.event(result.order.id, actorId, "refund_failed", { note: `Automatic refund failed (${error.message}); refund it manually` });
    }
  }
  return result;
}

async function fail(paymentId, reason) {
  const payment = await VcPayment.findByPk(paymentId);
  if (payment && payment.status === "created") await payment.update({ status: "failed", failure_reason: String(reason).slice(0, 300) });
  return payment;
}

// Visiting card orders' ledger for the shared gateway checkout (gatewayCheckout).
const ledger = { name: "visiting_cards", Model: VcPayment, capture: (...args) => capture(...args), fail: (...args) => fail(...args) };

async function ownPayment(auth, paymentId) {
  const payment = await VcPayment.findByPk(paymentId);
  if (!payment) throw ApiError.notFound("Payment not found");
  await orders.loadForCustomer(auth, payment.order_id).catch(() => {
    throw ApiError.notFound("Payment not found");
  });
  return payment;
}

// Razorpay checkout handler result, posted by the browser. Confirmed with Razorpay before it counts.
async function verifyCheckout(auth, { paymentId, providerOrderId, providerPaymentId, signature }) {
  const payment = await ownPayment(auth, paymentId);
  await gatewayCheckout.verifyRazorpay(ledger, payment, { providerOrderId, providerPaymentId, signature, actorId: auth.user.id });
  return orders.detail(auth, payment.order_id);
}

// PayPal onApprove: the server captures the order with PayPal and checks the result.
async function capturePaypal(auth, { paymentId, providerOrderId }) {
  const payment = await ownPayment(auth, paymentId);
  if (payment.provider_order_id !== providerOrderId) throw ApiError.badRequest("Payment does not match this order", undefined, "PAYMENT_MISMATCH");
  const result = await gatewayCheckout.settlePaypal(ledger, payment, { actorId: auth.user.id });
  return { pending: Boolean(result.pending), order: await orders.detail(auth, payment.order_id) };
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
  await capture(payment.id, { providerPaymentId: `mock_pay_${payment.id.replace(/-/g, "").slice(0, 16)}`, method: "upi", actorId: auth.user.id, signatureVerified: true, raw: { simulated: true } });
  return orders.detail(auth, payment.order_id);
}

// Finance records a bank transfer (or other offline payment) for the full outstanding amount.
async function recordOffline(auth, orderId, { reference, note }) {
  const order = await orders.loadForStaff(orderId);
  if (order.status !== "pending" || order.payment_status !== "unpaid") throw ApiError.conflict("Only unpaid orders can take an offline payment", "ALREADY_PAID");
  const taken = await VcPayment.findOne({ where: { provider: "offline", provider_payment_id: `offline_${reference}`.slice(0, 100) } });
  if (taken) throw ApiError.conflict("This reference has already been recorded", "DUPLICATE_REFERENCE", { reference: "Already recorded" });
  const payment = await VcPayment.create({ order_id: order.id, provider: "offline", amount_paise: order.total_paise - order.amount_paid_paise, status: "created", created_by: auth.user.id, raw: { reference, note } });
  await capture(payment.id, { providerPaymentId: `offline_${reference}`.slice(0, 100), method: "bank_transfer", actorId: auth.user.id, signatureVerified: false, raw: { reference, note } });
  return payment.reload();
}

async function refundPayment(payment, { reason, actorId }) {
  if (payment.status !== "captured") return 0;
  let providerRefundId = null;
  if (payment.provider !== "offline") {
    const result = await gatewayCheckout.refund(payment, payment.amount_paise, { requestId: `vc-refund-${payment.id}` });
    providerRefundId = result.providerRefundId;
  }
  await payment.update({ status: "refunded", refunded_at: new Date(), provider_refund_id: providerRefundId, raw: { ...(payment.raw || {}), refund_reason: reason, refunded_by: actorId || null } });
  return payment.amount_paise;
}

/** Refunds every captured payment on an order (staff cancellation). Returns paise refunded. */
async function refundOrder(auth, order, reason) {
  const payments = await VcPayment.findAll({ where: { order_id: order.id, status: "captured" } });
  let total = 0;
  for (const payment of payments) total += await refundPayment(payment, { reason, actorId: auth.user.id });
  return total;
}

// ---------------------------------------------------------------- documents
function presentInvoice(invoice, order) {
  return { ...invoice.toJSON(), order_number: order.order_number, amount_paid_paise: order.amount_paid_paise, payment_status: order.payment_status, payment_terms: "prepaid" };
}

async function invoice(auth, orderId, { staff = false } = {}) {
  const order = staff ? await orders.loadForStaff(orderId) : await orders.loadForCustomer(auth, orderId);
  const inv = await VcInvoice.findOne({ where: { order_id: order.id } });
  if (!inv) throw ApiError.notFound("An invoice is issued once the order is paid");
  return presentInvoice(inv, order);
}

async function receipt(auth, paymentId, { staff = false } = {}) {
  const payment = staff ? await VcPayment.findByPk(paymentId) : await ownPayment(auth, paymentId);
  if (!payment || !payment.receipt_number) throw ApiError.notFound("A receipt is issued once the payment is received");
  const order = await VcOrder.findByPk(payment.order_id);
  const inv = await VcInvoice.findOne({ where: { order_id: order.id }, attributes: ["invoice_number"] });
  const cards = await VcOrderCard.count({ where: { order_id: order.id } });
  return {
    receiptNumber: payment.receipt_number,
    payment: orders.presentPayment(payment),
    order: { id: order.id, orderNumber: order.order_number, totalPaise: order.total_paise, totalQuantity: order.total_quantity, cardCount: cards, templateName: order.template_snapshot.name },
    invoiceNumber: inv?.invoice_number || null,
    payer: { ...order.contact, gstin: order.gstin, billingAddress: order.billing_address },
    seller: await settingsService.get("seller"),
  };
}

async function list(q) {
  const where = {};
  if (q.status) where.status = q.status;
  if (q.q) {
    const term = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
    where[Op.or] = [{ receipt_number: { [Op.iLike]: term } }, { provider_payment_id: { [Op.iLike]: term } }, { "$order.order_number$": { [Op.iLike]: term } }];
  }
  const { rows, count } = await VcPayment.findAndCountAll({
    where,
    include: [{ model: VcOrder, as: "order", attributes: ["id", "order_number", "customer_type", "user_id", "total_paise", "contact"] }],
    order: [["created_at", "DESC"]],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    subQuery: false,
  });
  const [totals] = await sequelize.query(
    `SELECT COALESCE(sum(amount_paise) FILTER (WHERE status = 'captured'), 0)::bigint AS captured,
            COALESCE(sum(amount_paise) FILTER (WHERE status = 'refunded'), 0)::bigint AS refunded,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM vc_payments`
  );
  return {
    items: rows.map((p) => ({ ...orders.presentPayment(p), order: { id: p.order.id, orderNumber: p.order.order_number, customerType: p.order.customer_type, customerName: p.order.contact?.name, customerEmail: p.order.contact?.email } })),
    total: count,
    summary: { capturedPaise: Number(totals[0].captured), refundedPaise: Number(totals[0].refunded), failed: totals[0].failed },
  };
}

async function expireStaleIntents() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  await VcPayment.update({ status: "failed", failure_reason: "Abandoned" }, { where: { status: "created", created_at: { [Op.lt]: cutoff }, provider: { [Op.ne]: "offline" } } });
}

module.exports = { ledger, createIntent, capture, fail, verifyCheckout, capturePaypal, completeMock, recordOffline, refundOrder, invoice, receipt, list, expireStaleIntents, issueInvoice };

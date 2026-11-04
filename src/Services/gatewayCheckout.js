// Gateway checkout shared by the shop (payments) and visiting card (vc_payments) ledgers:
// opening a payment with the chosen gateway, confirming it with the gateway's server API,
// webhooks and refunds. A ledger is { name, Model, capture(paymentId, opts), fail(paymentId, reason) };
// its capture is idempotent under row locks, so a callback and a webhook can race safely.
//
// Nothing the browser sends is trusted on its own:
//  - Razorpay: the checkout signature must match, and the payment fetched from Razorpay must be
//    captured (or is captured here), for this gateway order, amount and currency.
//  - PayPal: the server captures the order itself and checks the capture PayPal returns.
//  - Webhooks: Razorpay HMAC signature / PayPal verify-webhook-signature API, de-duplicated by
//    event id, and the same amount checks before anything is recorded.
const crypto = require("crypto");
const { Op } = require("sequelize");
const { PaymentWebhookEvent } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { config } = require("../Config/env");
const { providers } = require("./paymentProviders");
const gatewayService = require("./gatewayService");

// Unapproved PayPal orders expire after a few hours, so older open ones are not reused.
const PAYPAL_REUSE_MS = 2 * 3600 * 1000;

// Both ledgers, loaded lazily (the payment services require this module).
const ledgers = () => [require("./paymentService").ledger, require("./vcPaymentService").ledger];

const expectedCharge = (payment) => ({ amount: payment.gateway_amount ?? payment.amount_paise, currency: payment.gateway_currency || "INR" });

async function credentialsFor(payment) {
  return gatewayService.credentials(payment.provider, payment.gateway_mode || undefined);
}

/**
 * Opens (or reuses) a gateway payment for an amount due. `fields` are extra ledger columns
 * (e.g. purpose). Returns what the browser needs to start the gateway's checkout: public ids only.
 */
async function openPayment(ledger, { orderId, orderNumber, amountPaise, gatewayCode, auth, notes = {}, fields = {}, transaction }) {
  const gateway = await gatewayService.resolveForCheckout(gatewayCode);
  const charge = gatewayService.chargeFor(gateway, amountPaise);
  const where = {
    order_id: orderId,
    status: "created",
    provider: gateway.code,
    amount_paise: amountPaise,
    gateway_mode: gateway.mode,
    gateway_currency: charge.currency,
    gateway_amount: charge.amount,
    ...fields,
  };
  if (gateway.code === "paypal") where.created_at = { [Op.gt]: new Date(Date.now() - PAYPAL_REUSE_MS) };
  let payment = await ledger.Model.findOne({ where, transaction });

  if (!payment) {
    const id = crypto.randomUUID();
    let created;
    if (gateway.code === "mock") {
      created = await providers.mock.createOrder();
    } else if (gateway.code === "razorpay") {
      created = await providers.razorpay.createOrder(gateway.creds, { amount: charge.amount, currency: charge.currency, receipt: orderNumber, notes: { ...notes, payment_id: id } });
    } else {
      created = await providers.paypal.createOrder(gateway.creds, {
        amount: charge.amount,
        currency: charge.currency,
        referenceId: id,
        invoiceId: `${orderNumber}-${id.slice(0, 8)}`,
        description: `Order ${orderNumber}`,
        requestId: `create-${id}`,
        brandName: config.brandName,
      });
    }
    payment = await ledger.Model.create(
      {
        id,
        order_id: orderId,
        provider: gateway.code,
        provider_order_id: created.providerOrderId,
        amount_paise: amountPaise,
        currency: "INR",
        status: "created",
        created_by: auth.user.id,
        gateway_mode: gateway.mode,
        gateway_currency: charge.currency,
        gateway_amount: charge.amount,
        ...fields,
      },
      { transaction }
    );
  }

  return {
    paymentId: payment.id,
    provider: gateway.code,
    gatewayName: gateway.name,
    mode: gateway.mode,
    providerOrderId: payment.provider_order_id,
    amountPaise: payment.amount_paise,
    currency: "INR",
    chargeAmount: payment.gateway_amount,
    chargeCurrency: payment.gateway_currency,
    orderNumber,
    prefill: { name: auth.user.name, email: auth.user.email, contact: auth.user.phone },
    ...(gateway.creds ? { keyId: gateway.creds.keyId } : {}),
  };
}

// What is kept from a gateway's payment object: enough to reconcile, no card or contact data.
function razorpaySummary(p) {
  return { razorpay: { id: p.id, order_id: p.order_id, status: p.status, method: p.method, amount: p.amount, currency: p.currency, bank: p.bank || null, wallet: p.wallet || null, card_network: p.card?.network || null, fee: p.fee ?? null, tax: p.tax ?? null, created_at: p.created_at } };
}

function amountMismatch(ledger, payment, got) {
  const want = expectedCharge(payment);
  const show = (c) => `${c.currency} ${(Number(c.amount) / 100).toFixed(2)}`;
  const note = `Amount mismatch: gateway reported ${show(got)}, expected ${show(want)}`;
  console.error(`[payments] ${ledger.name} payment ${payment.id}: ${note}; not recorded`);
  return ledger.fail(payment.id, note);
}

/** Razorpay Checkout handler result posted by the browser. */
async function verifyRazorpay(ledger, payment, { providerOrderId, providerPaymentId, signature, actorId }) {
  if (payment.provider !== "razorpay") throw ApiError.badRequest("Wrong payment provider", undefined, "PROVIDER_MISMATCH");
  if (payment.provider_order_id !== providerOrderId) throw ApiError.badRequest("Payment does not match this order", undefined, "PAYMENT_MISMATCH");
  if (payment.status === "captured" || payment.status === "refunded" || payment.status === "partially_refunded") return { alreadyCaptured: true };

  const creds = await credentialsFor(payment);
  if (!providers.razorpay.verifyCheckoutSignature(creds, { providerOrderId, providerPaymentId, signature })) {
    console.warn(`[payments] ${ledger.name} payment ${payment.id}: invalid Razorpay checkout signature`);
    await ledger.fail(payment.id, "Signature verification failed");
    throw ApiError.badRequest("Payment could not be verified", undefined, "SIGNATURE_INVALID");
  }

  // The signature proves the ids came from Razorpay; the payment itself is checked with the API.
  let remote = await providers.razorpay.fetchPayment(creds, providerPaymentId);
  const want = expectedCharge(payment);
  if (remote.order_id !== payment.provider_order_id) throw ApiError.badRequest("Payment does not match this order", undefined, "PAYMENT_MISMATCH");
  if (remote.amount !== want.amount || remote.currency !== want.currency) {
    await amountMismatch(ledger, payment, remote);
    throw ApiError.unprocessable("The paid amount does not match this order. Please contact support.", "AMOUNT_MISMATCH");
  }
  if (remote.status === "authorized") remote = await providers.razorpay.capturePayment(creds, providerPaymentId, want);
  if (remote.status !== "captured") {
    if (remote.status === "failed") await ledger.fail(payment.id, remote.error_description || "Payment failed");
    throw ApiError.unprocessable(remote.status === "failed" ? "The payment did not go through. You can try again." : "The payment is not complete yet", "PAYMENT_NOT_CAPTURED");
  }
  return ledger.capture(payment.id, { providerPaymentId: remote.id, method: remote.method, raw: razorpaySummary(remote), signatureVerified: true, actorId });
}

/**
 * Captures an approved PayPal order on the server (or, with capture=false, re-reads it) and
 * records the payment if PayPal reports a completed capture for the expected amount.
 * Returns { pending: true } while PayPal holds the capture (e.g. eCheck); a webhook finishes it.
 */
async function settlePaypal(ledger, payment, { actorId, capture = true } = {}) {
  if (payment.provider !== "paypal") throw ApiError.badRequest("Wrong payment provider", undefined, "PROVIDER_MISMATCH");
  if (payment.status === "captured" || payment.status === "refunded" || payment.status === "partially_refunded") return { alreadyCaptured: true };
  const creds = await credentialsFor(payment);

  let order;
  if (capture) {
    try {
      order = await providers.paypal.captureOrder(creds, payment.provider_order_id, `capture-${payment.id}`);
    } catch (error) {
      if (error.issue === "ORDER_ALREADY_CAPTURED") order = await providers.paypal.getOrder(creds, payment.provider_order_id);
      else if (error.issue === "INSTRUMENT_DECLINED") throw ApiError.unprocessable("Your payment method was declined. Please choose another one in PayPal.", "PAYMENT_DECLINED");
      else if (error.issue === "ORDER_NOT_APPROVED") throw ApiError.conflict("The payment was not approved in PayPal", "PAYMENT_NOT_APPROVED");
      else throw error;
    }
  } else {
    order = await providers.paypal.getOrder(creds, payment.provider_order_id);
  }

  const unit = order.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  if (order.id !== payment.provider_order_id || (unit?.custom_id || cap?.custom_id) !== payment.id) {
    console.error(`[payments] ${ledger.name} payment ${payment.id}: PayPal order ${order.id} does not reference it`);
    throw ApiError.badRequest("Payment does not match this order", undefined, "PAYMENT_MISMATCH");
  }
  if (!cap) return { pending: true, status: order.status };

  const got = { amount: providers.paypal.toMinor(cap.amount?.value), currency: cap.amount?.currency_code };
  const want = expectedCharge(payment);
  if (got.amount !== want.amount || got.currency !== want.currency) {
    await amountMismatch(ledger, payment, got);
    throw ApiError.unprocessable("The paid amount does not match this order. Please contact support.", "AMOUNT_MISMATCH");
  }
  if (cap.status === "PENDING") return { pending: true, status: cap.status, reason: cap.status_details?.reason || null };
  if (cap.status !== "COMPLETED") {
    await ledger.fail(payment.id, `PayPal capture ${String(cap.status).toLowerCase()}`);
    throw ApiError.unprocessable("The payment did not go through. You can try again.", "PAYMENT_FAILED");
  }
  return ledger.capture(payment.id, {
    providerPaymentId: cap.id,
    method: "paypal",
    raw: {
      paypal: {
        order_id: order.id,
        capture_id: cap.id,
        status: cap.status,
        amount: cap.amount,
        payer_id: order.payer?.payer_id || null,
        fee: cap.seller_receivable_breakdown?.paypal_fee || null,
        create_time: cap.create_time,
      },
    },
    signatureVerified: true,
    actorId,
  });
}

async function findByGatewayOrder(provider, providerOrderId) {
  if (!providerOrderId) return null;
  for (const ledger of ledgers()) {
    const payment = await ledger.Model.findOne({ where: { provider, provider_order_id: providerOrderId } });
    if (payment) return { ledger, payment };
  }
  return null;
}

/** Records the event once; returns null when it was already processed. */
async function claimEvent(provider, eventId, eventType, payload) {
  const [record, created] = await PaymentWebhookEvent.findOrCreate({
    where: { provider, event_id: String(eventId).slice(0, 120) },
    defaults: { provider, event_id: String(eventId).slice(0, 120), event_type: eventType, payload },
  });
  if (!created && record.processed_at) return null;
  return record;
}

// Razorpay webhook: signed with the webhook secret of the test or the live account.
async function handleRazorpayWebhook(req) {
  const signature = req.get("x-razorpay-signature");
  const candidates = await gatewayService.webhookCredentials("razorpay");
  if (!candidates.some((c) => providers.razorpay.verifyWebhookSignature(c.webhookSecret, req.rawBody, signature))) {
    console.warn("[payments] rejected a Razorpay webhook with an invalid signature");
    throw ApiError.unauthorized("Invalid webhook signature", "SIGNATURE_INVALID");
  }
  const event = req.body?.event;
  const entity = req.body?.payload?.payment?.entity;
  const eventId = req.get("x-razorpay-event-id") || req.body?.id || `${event}:${entity?.id}`;
  const record = await claimEvent("razorpay", eventId, event, req.body);
  if (!record) return { duplicate: true };

  const found = entity ? await findByGatewayOrder("razorpay", entity.order_id) : null;
  if (found) {
    const { ledger, payment } = found;
    if (["payment.captured", "order.paid"].includes(event)) {
      const want = expectedCharge(payment);
      if (entity.amount !== want.amount || entity.currency !== want.currency) {
        await amountMismatch(ledger, payment, entity);
      } else {
        await ledger.capture(payment.id, { providerPaymentId: entity.id, method: entity.method, raw: { webhook: event, ...razorpaySummary(entity) }, signatureVerified: true });
      }
    } else if (event === "payment.failed") {
      await ledger.fail(payment.id, entity.error_description || "Payment failed");
    }
  }
  await record.update({ processed_at: new Date() });
  return { processed: true };
}

// PayPal webhook: PayPal confirms the delivery is genuine (verify-webhook-signature), then the
// order is captured or re-read from PayPal; the event body alone never records a payment.
async function handlePaypalWebhook(req) {
  let event;
  try {
    event = JSON.parse(req.rawBody?.toString("utf8") || "");
  } catch {
    throw ApiError.badRequest("Invalid webhook body");
  }
  if (!req.get("paypal-transmission-sig") || !event?.id) throw ApiError.unauthorized("Invalid webhook signature", "SIGNATURE_INVALID");

  let verified = false;
  for (const creds of await gatewayService.webhookCredentials("paypal")) {
    if (!creds.keyId || !creds.secret) continue;
    try {
      verified = await providers.paypal.verifyWebhook(creds, creds.webhookSecret, req.headers, event);
    } catch (error) {
      console.error(`[payments] PayPal webhook verification call failed (${creds.mode}): ${error.message}`);
    }
    if (verified) break;
  }
  if (!verified) {
    console.warn("[payments] rejected a PayPal webhook that PayPal did not verify");
    throw ApiError.unauthorized("Invalid webhook signature", "SIGNATURE_INVALID");
  }

  const record = await claimEvent("paypal", event.id, event.event_type, event);
  if (!record) return { duplicate: true };

  const resource = event.resource || {};
  const orderId = event.event_type === "CHECKOUT.ORDER.APPROVED" ? resource.id : resource.supplementary_data?.related_ids?.order_id;
  const found = await findByGatewayOrder("paypal", orderId);
  if (found) {
    const { ledger, payment } = found;
    try {
      if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
        // The buyer approved but the browser never reached our capture call (closed tab).
        await settlePaypal(ledger, payment, { capture: true });
      } else if (["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING"].includes(event.event_type)) {
        await settlePaypal(ledger, payment, { capture: false });
      } else if (["PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"].includes(event.event_type)) {
        await ledger.fail(payment.id, `PayPal capture ${event.event_type.split(".").pop().toLowerCase()}`);
      }
    } catch (error) {
      // A final answer (declined, mismatch) is recorded; a gateway outage is retried by PayPal.
      if (!error.statusCode || error.statusCode >= 500) throw error;
      console.warn(`[payments] PayPal ${event.event_type} for payment ${payment.id}: ${error.message}`);
    }
  }
  await record.update({ processed_at: new Date() });
  return { processed: true };
}

/** Refunds part or all of a captured gateway payment; amountPaise is in INR paise. */
async function refund(payment, amountPaise, { requestId } = {}) {
  if (payment.provider === "mock") return providers.mock.refund();
  const provider = providers[payment.provider];
  if (!provider) throw ApiError.badRequest(`Cannot refund a ${payment.provider} payment through a gateway`);
  const creds = await credentialsFor(payment);
  const want = expectedCharge(payment);
  // Partial refunds convert at the rate the payment was charged at.
  const amount = amountPaise >= payment.amount_paise ? want.amount : Math.floor((want.amount * amountPaise) / payment.amount_paise);
  return provider.refund(creds, { providerPaymentId: payment.provider_payment_id, amount, currency: want.currency, requestId: requestId || crypto.randomUUID() });
}

module.exports = { openPayment, verifyRazorpay, settlePaypal, handleRazorpayWebhook, handlePaypalWebhook, refund };

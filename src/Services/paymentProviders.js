// Payment gateway adapters. Card/UPI data never touches this server: the gateway's hosted
// checkout collects it and we verify results by signature (Section 11.2).
//
// "mock" simulates a gateway for local development and demos. It is refused when
// APP_ENV=production (see Config/env assertConfig).
const crypto = require("crypto");
const { config } = require("../Config/env");
const ApiError = require("../Utils/ApiError");

const mock = {
  name: "mock",
  async createOrder({ amountPaise, receipt }) {
    return { providerOrderId: `mock_order_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, amountPaise, receipt };
  },
  checkoutOptions() {
    return { mock: true };
  },
  async refund({ amountPaise }) {
    return { providerRefundId: `mock_rfnd_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, amountPaise };
  },
};

function razorpayAuth() {
  if (!config.payments.razorpayKeyId || !config.payments.razorpayKeySecret) {
    throw ApiError.badRequest("Online payments are not configured", undefined, "PAYMENTS_NOT_CONFIGURED");
  }
  return "Basic " + Buffer.from(`${config.payments.razorpayKeyId}:${config.payments.razorpayKeySecret}`).toString("base64");
}

async function razorpayRequest(path, body) {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: "POST",
    headers: { Authorization: razorpayAuth(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw ApiError.badRequest(json?.error?.description || "Payment gateway request failed", undefined, "GATEWAY_ERROR");
  }
  return json;
}

const razorpay = {
  name: "razorpay",
  async createOrder({ amountPaise, receipt, notes }) {
    const order = await razorpayRequest("/orders", { amount: amountPaise, currency: "INR", receipt, notes });
    return { providerOrderId: order.id, amountPaise: order.amount, receipt };
  },
  checkoutOptions() {
    return { keyId: config.payments.razorpayKeyId };
  },
  // Checkout callback signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
  verifyCheckoutSignature({ providerOrderId, providerPaymentId, signature }) {
    const expected = crypto.createHmac("sha256", config.payments.razorpayKeySecret).update(`${providerOrderId}|${providerPaymentId}`).digest("hex");
    return signature && expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  },
  verifyWebhookSignature(rawBody, signature) {
    if (!config.payments.razorpayWebhookSecret || !rawBody || !signature) return false;
    const expected = crypto.createHmac("sha256", config.payments.razorpayWebhookSecret).update(rawBody).digest("hex");
    return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  },
  async refund({ providerPaymentId, amountPaise }) {
    const refund = await razorpayRequest(`/payments/${providerPaymentId}/refund`, { amount: amountPaise });
    return { providerRefundId: refund.id, amountPaise: refund.amount };
  },
};

const providers = { mock, razorpay };

function current() {
  const provider = providers[config.payments.provider];
  if (!provider) throw new Error(`Unknown PAYMENT_PROVIDER "${config.payments.provider}"`);
  if (provider === mock && config.isProduction) throw ApiError.forbidden("Mock payments are disabled in production");
  return provider;
}

module.exports = { current, providers };

// Payment gateway adapters. Card/UPI/PayPal account data never touches this server: the
// gateway's hosted checkout collects it, and every result is confirmed with the gateway's
// server API (signature + payment fetch for Razorpay, order capture/fetch for PayPal).
//
// Credentials are passed in by the caller (gatewayService.credentials), always for the mode a
// payment was created in, so a switch from test to live never re-verifies old payments with
// the wrong keys. Secrets are never logged or returned.
//
// "mock" simulates a gateway for local development and demos. It is refused when
// APP_ENV=production (see Config/env assertConfig).
const crypto = require("crypto");
const ApiError = require("../Utils/ApiError");

const TIMEOUT_MS = 20_000;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function gatewayError(gateway, message, status, code = "GATEWAY_ERROR") {
  const error = new ApiError(status >= 500 || !status ? 502 : 400, message, code);
  error.gateway = gateway;
  error.gatewayStatus = status;
  return error;
}

// Logs the failing call (method, path, HTTP status, gateway error code); never the body we sent.
function logFailure(gateway, method, path, status, detail) {
  console.error(`[payments] ${gateway} ${method} ${path} failed (${status || "network"}): ${detail || "no detail"}`);
}

async function send(gateway, url, { method = "GET", headers = {}, body, form } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: form ? new URLSearchParams(form).toString() : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    logFailure(gateway, method, new URL(url).pathname, null, error.name === "TimeoutError" ? "timed out" : error.message);
    throw gatewayError(gateway, `${gateway === "paypal" ? "PayPal" : "Razorpay"} could not be reached. Please try again.`, null, "GATEWAY_UNREACHABLE");
  }
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// ---------------------------------------------------------------- mock (development only)
const mock = {
  name: "mock",
  async createOrder() {
    return { providerOrderId: `mock_order_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}` };
  },
  async refund() {
    return { providerRefundId: `mock_rfnd_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}` };
  },
};

// ---------------------------------------------------------------- Razorpay
// https://razorpay.com/docs/api/ : Basic auth with key_id:key_secret, amounts in paise.
const RAZORPAY_API = "https://api.razorpay.com/v1";

function razorpayAuth(creds) {
  if (!creds?.keyId || !creds?.secret) throw ApiError.badRequest("Razorpay is not configured", undefined, "PAYMENTS_NOT_CONFIGURED");
  return "Basic " + Buffer.from(`${creds.keyId}:${creds.secret}`).toString("base64");
}

async function razorpayRequest(creds, method, path, body) {
  const { ok, status, json } = await send("razorpay", `${RAZORPAY_API}${path}`, { method, headers: { Authorization: razorpayAuth(creds) }, body });
  if (!ok) {
    logFailure("razorpay", method, path.replace(/\/(pay|order)_[A-Za-z0-9]+/g, "/$1_…"), status, json?.error?.code);
    if (status === 401) throw gatewayError("razorpay", "Razorpay rejected the API credentials", status, "GATEWAY_AUTH_FAILED");
    throw gatewayError("razorpay", json?.error?.description || "Payment gateway request failed", status);
  }
  return json;
}

const razorpay = {
  name: "razorpay",
  async createOrder(creds, { amount, currency, receipt, notes }) {
    const order = await razorpayRequest(creds, "POST", "/orders", { amount, currency, receipt: String(receipt).slice(0, 40), notes, payment_capture: 1 });
    return { providerOrderId: order.id, amount: order.amount, currency: order.currency };
  },
  async fetchPayment(creds, providerPaymentId) {
    return razorpayRequest(creds, "GET", `/payments/${encodeURIComponent(providerPaymentId)}`);
  },
  // Captures an authorized payment (only needed when auto-capture is off on the account).
  async capturePayment(creds, providerPaymentId, { amount, currency }) {
    return razorpayRequest(creds, "POST", `/payments/${encodeURIComponent(providerPaymentId)}/capture`, { amount, currency });
  },
  // Checkout callback signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
  verifyCheckoutSignature(creds, { providerOrderId, providerPaymentId, signature }) {
    if (!creds?.secret || !signature) return false;
    const expected = crypto.createHmac("sha256", creds.secret).update(`${providerOrderId}|${providerPaymentId}`).digest("hex");
    return safeEqual(expected, signature);
  },
  // Webhook signature: HMAC_SHA256(raw body, webhook secret)
  verifyWebhookSignature(secret, rawBody, signature) {
    if (!secret || !rawBody || !signature) return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqual(expected, signature);
  },
  async refund(creds, { providerPaymentId, amount, requestId }) {
    const refund = await razorpayRequest(creds, "POST", `/payments/${encodeURIComponent(providerPaymentId)}/refund`, { amount, notes: requestId ? { request_id: requestId } : undefined });
    return { providerRefundId: refund.id, amount: refund.amount };
  },
  // A read-only call that fails unless the key id and secret belong together.
  async testConnection(creds) {
    await razorpayRequest(creds, "GET", "/orders?count=1");
    return "Connected to Razorpay";
  },
};

// ---------------------------------------------------------------- PayPal
// https://developer.paypal.com/docs/api/orders/v2/ : OAuth2 client credentials, amounts as
// decimal strings in the order currency. PayPal-Request-Id makes create/capture/refund idempotent.
const PAYPAL_API = { test: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" };
const tokenCache = new Map(); // `${mode}:${clientId}` -> { token, expiresAt }

async function paypalToken(creds) {
  if (!creds?.keyId || !creds?.secret) throw ApiError.badRequest("PayPal is not configured", undefined, "PAYMENTS_NOT_CONFIGURED");
  const cacheKey = `${creds.mode}:${creds.keyId}:${crypto.createHash("sha256").update(creds.secret).digest("hex").slice(0, 12)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && !creds.forceFresh && cached.expiresAt > Date.now()) return cached.token;
  const { ok, status, json } = await send("paypal", `${PAYPAL_API[creds.mode]}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${creds.keyId}:${creds.secret}`).toString("base64") },
    form: { grant_type: "client_credentials" },
  });
  if (!ok || !json.access_token) {
    logFailure("paypal", "POST", "/v1/oauth2/token", status, json?.error);
    throw gatewayError("paypal", "PayPal rejected the API credentials", status, "GATEWAY_AUTH_FAILED");
  }
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + Math.max(60, (json.expires_in || 300) - 120) * 1000 });
  return json.access_token;
}

async function paypalRequest(creds, method, path, { body, requestId } = {}) {
  const token = await paypalToken(creds);
  const headers = { Authorization: `Bearer ${token}`, Prefer: "return=representation" };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const result = await send("paypal", `${PAYPAL_API[creds.mode]}${path}`, { method, headers, body });
  if (!result.ok) {
    const issue = result.json?.details?.[0]?.issue || result.json?.name;
    logFailure("paypal", method, path.replace(/\/orders\/[A-Z0-9]+/g, "/orders/…").replace(/\/captures\/[A-Z0-9]+/g, "/captures/…"), result.status, issue);
    const error = gatewayError("paypal", result.json?.details?.[0]?.description || result.json?.message || "PayPal request failed", result.status);
    error.issue = issue;
    throw error;
  }
  return result.json;
}

const toDecimal = (minor) => (minor / 100).toFixed(2);
const toMinor = (value) => Math.round(Number(value) * 100);

const paypal = {
  name: "paypal",
  toMinor,
  async createOrder(creds, { amount, currency, referenceId, invoiceId, description, requestId, brandName }) {
    const order = await paypalRequest(creds, "POST", "/v2/checkout/orders", {
      requestId,
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: referenceId,
            custom_id: referenceId,
            invoice_id: invoiceId,
            description: String(description).slice(0, 127),
            amount: { currency_code: currency, value: toDecimal(amount) },
          },
        ],
        payment_source: {
          paypal: { experience_context: { brand_name: String(brandName).slice(0, 127), shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } },
        },
      },
    });
    return { providerOrderId: order.id, amount, currency };
  },
  async getOrder(creds, providerOrderId) {
    return paypalRequest(creds, "GET", `/v2/checkout/orders/${encodeURIComponent(providerOrderId)}`);
  },
  async captureOrder(creds, providerOrderId, requestId) {
    return paypalRequest(creds, "POST", `/v2/checkout/orders/${encodeURIComponent(providerOrderId)}/capture`, { body: {}, requestId });
  },
  // Asks PayPal whether a webhook delivery is genuine (transmission headers + our webhook id).
  async verifyWebhook(creds, webhookId, headers, event) {
    const result = await paypalRequest(creds, "POST", "/v1/notifications/verify-webhook-signature", {
      body: {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
    return result.verification_status === "SUCCESS";
  },
  async refund(creds, { providerPaymentId, amount, currency, requestId }) {
    const refund = await paypalRequest(creds, "POST", `/v2/payments/captures/${encodeURIComponent(providerPaymentId)}/refund`, {
      requestId,
      body: { amount: { currency_code: currency, value: toDecimal(amount) } },
    });
    return { providerRefundId: refund.id, amount };
  },
  async testConnection(creds) {
    await paypalToken({ ...creds, forceFresh: true });
    return `Connected to PayPal (${creds.mode === "live" ? "live" : "sandbox"})`;
  },
};

const providers = { mock, razorpay, paypal };

module.exports = { providers, PAYPAL_API };

// Payment gateway settings, read from the server's .env (RAZORPAY_*, PAYPAL_*,
// PAYMENT_DEFAULT_GATEWAY; see Config/env.js). The admin page (Settings -> Payment gateways)
// shows them read-only and can run a connection test; it cannot change them.
//
// - Secrets (Razorpay key secret and webhook secret, PayPal client secret and webhook id) never
//   leave the server: the admin view says only whether each one is set.
// - Each gateway runs in one mode (test or live) with one set of credentials. A payment records
//   the mode it was created in and is verified, captured and refunded only with that mode's keys.
// - The development "mock" gateway is offered only when PAYMENT_PROVIDER=mock outside production.
// The older admin-saved settings (payment_gateways table) are no longer read; the rows are kept.
const ApiError = require("../Utils/ApiError");
const { config } = require("../Config/env");
const { providers } = require("./paymentProviders");

const CODES = ["razorpay", "paypal"];
const MODES = ["test", "live"];
const NAMES = { razorpay: "Razorpay", paypal: "PayPal" };
// PayPal does not accept INR for cross-border payments, so PayPal charges in one of these
// two-decimal currencies, converted from the INR order total with PAYPAL_EXCHANGE_RATE.
const PAYPAL_CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "SGD", "HKD", "NZD", "CHF", "SEK", "DKK", "NOK", "PLN", "CZK"];
// The .env variable behind each setting, shown on the admin page.
const ENV_NAMES = {
  razorpay: { enabled: "RAZORPAY_ENABLED", mode: "RAZORPAY_MODE", keyId: "RAZORPAY_KEY_ID", secret: "RAZORPAY_KEY_SECRET", webhookSecret: "RAZORPAY_WEBHOOK_SECRET" },
  paypal: { enabled: "PAYPAL_ENABLED", mode: "PAYPAL_MODE", keyId: "PAYPAL_CLIENT_ID", secret: "PAYPAL_CLIENT_SECRET", webhookSecret: "PAYPAL_WEBHOOK_ID", currency: "PAYPAL_CURRENCY", exchangeRate: "PAYPAL_EXCHANGE_RATE" },
};

const mockEnabled = () => !config.isProduction && config.payments.provider === "mock";

function settingsOf(code) {
  if (!CODES.includes(code)) throw ApiError.notFound("Unknown payment gateway");
  return config.payments[code];
}

const configured = (s) => Boolean(s.keyId && s.secret);

/** Missing or invalid .env values for a gateway, by variable name. */
function problems(code) {
  const s = settingsOf(code);
  const env = ENV_NAMES[code];
  const out = [];
  if (!MODES.includes(s.mode)) out.push(`${env.mode} (test or live)`);
  if (!s.keyId) out.push(env.keyId);
  if (!s.secret) out.push(env.secret);
  if (code === "razorpay" && s.keyId && MODES.includes(s.mode) && !s.keyId.startsWith(`rzp_${s.mode}_`)) out.push(`${env.keyId} (a ${s.mode} key starts with rzp_${s.mode}_)`);
  if (code === "paypal" && !PAYPAL_CURRENCIES.includes(s.currency)) out.push(`${env.currency} (one of ${PAYPAL_CURRENCIES.join(", ")})`);
  if (code === "paypal" && !(s.exchangeRate > 0)) out.push(env.exchangeRate);
  return out;
}

const usable = (code) => settingsOf(code).enabled && problems(code).length === 0;

function defaultCode(enabledCodes) {
  const wanted = config.payments.defaultGateway;
  return enabledCodes.includes(wanted) ? wanted : enabledCodes[0] || null;
}

/** Decrypted-equivalent credentials for one mode (server-side use only). */
function credentials(code, mode) {
  const s = settingsOf(code);
  if (mode && mode !== s.mode) {
    throw ApiError.conflict(`This payment was made in ${mode} mode, but ${NAMES[code]} is now set to ${s.mode} mode (${ENV_NAMES[code].mode}). Handle it in the ${NAMES[code]} dashboard.`, "GATEWAY_MODE_CHANGED");
  }
  return { mode: s.mode, keyId: s.keyId || null, secret: s.secret || null, webhookSecret: s.webhookSecret || null };
}

function webhookUrl(code) {
  const base = (config.publicApiUrl || `http://localhost:${config.port}`).replace(/\/+$/, "");
  return `${base}${config.apiPrefix}/webhooks/${code}`;
}

/** Admin view of a gateway: the public key id, and only whether each secret is set. */
function describe(code) {
  const s = settingsOf(code);
  const missing = problems(code);
  const enabledCodes = CODES.filter(usable);
  return {
    code,
    name: NAMES[code],
    source: "env",
    isEnabled: s.enabled,
    mode: s.mode,
    isDefault: defaultCode(enabledCodes) === code,
    currency: s.currency,
    exchangeRate: s.exchangeRate,
    keyId: s.keyId || "",
    hasSecret: Boolean(s.secret),
    hasWebhookSecret: Boolean(s.webhookSecret),
    status: missing.length ? "not_configured" : s.enabled ? "ready" : "disabled",
    missing,
    env: ENV_NAMES[code],
    webhookUrl: webhookUrl(code),
  };
}

async function list() {
  return CODES.map(describe);
}

async function get(code) {
  return describe(code);
}

/** Checks the credentials with the gateway (authentication only, no payment). Nothing is stored. */
async function test(code) {
  const s = settingsOf(code);
  const missing = problems(code);
  let ok = false;
  let message;
  if (missing.length) {
    message = `Missing in .env: ${missing.join(", ")}`;
  } else {
    try {
      message = await providers[code].testConnection(credentials(code));
      ok = true;
      if (!s.webhookSecret) message += `. ${ENV_NAMES[code].webhookSecret} is not set, so webhooks will be rejected.`;
    } catch (error) {
      message = error.message || "Connection failed";
    }
  }
  return { ok, message, gateway: describe(code) };
}

/** What the checkout may offer. Public: names, modes and currencies only. */
async function available() {
  const enabledCodes = CODES.filter(usable);
  const gateways = enabledCodes.map((code) => {
    const s = settingsOf(code);
    return { code, name: NAMES[code], mode: s.mode, currency: s.currency, exchangeRate: s.exchangeRate };
  });
  if (mockEnabled()) gateways.push({ code: "mock", name: "Simulated gateway (development)", mode: "test", currency: "INR", exchangeRate: 1 });
  const defaultGateway = defaultCode(enabledCodes) || gateways[0]?.code || null;
  return { available: gateways.length > 0, defaultGateway, gateways };
}

/**
 * The gateway a new payment uses: the one the customer picked, else the default. Refuses
 * gateways that are disabled or incomplete, so the browser cannot force one that is switched off.
 */
async function resolveForCheckout(code) {
  const { available: any, defaultGateway } = await available();
  if (!any) throw ApiError.conflict("Online payments are temporarily unavailable. Please try again later.", "PAYMENTS_UNAVAILABLE");
  const chosen = code || defaultGateway;
  if (chosen === "mock") {
    if (!mockEnabled()) throw ApiError.conflict("This payment method is not available", "GATEWAY_UNAVAILABLE");
    return { code: "mock", name: "Simulated gateway", mode: "test", currency: "INR", exchangeRate: 1, creds: null };
  }
  if (!CODES.includes(chosen)) throw ApiError.conflict("This payment method is not available", "GATEWAY_UNAVAILABLE");
  if (!usable(chosen)) throw ApiError.conflict(`${NAMES[chosen]} is not available right now. Please choose another payment method.`, "GATEWAY_UNAVAILABLE");
  const s = settingsOf(chosen);
  return { code: chosen, name: NAMES[chosen], mode: s.mode, currency: s.currency, exchangeRate: s.exchangeRate, creds: credentials(chosen) };
}

/** Amount charged by the gateway (minor units of its currency) for an INR amount in paise. */
function chargeFor(gateway, amountPaise) {
  if (gateway.currency === "INR") return { currency: "INR", amount: amountPaise };
  // Rounded up to the next cent so the business never receives less than the INR price.
  return { currency: gateway.currency, amount: Math.ceil(amountPaise / Number(gateway.exchangeRate)) };
}

/** Webhook credentials, when the webhook secret (Razorpay) or webhook id (PayPal) is set. */
async function webhookCredentials(code) {
  const creds = credentials(code);
  return creds.webhookSecret ? [creds] : [];
}

module.exports = { CODES, PAYPAL_CURRENCIES, ENV_NAMES, problems, list, get, test, available, resolveForCheckout, chargeFor, credentials, webhookCredentials, mockEnabled };

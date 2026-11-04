// Payment gateway settings (admin: Settings -> Payment gateways). Which gateways the checkout
// offers, test/live mode, credentials and currency all come from the payment_gateways table.
//
// - Secrets (Razorpay key secret and webhook secret, PayPal client secret and webhook id) are
//   AES-256-GCM encrypted with APP_KEY and never leave the server; the admin view shows only
//   whether one is set and its last four characters.
// - Each gateway keeps test and live credentials side by side. A payment records the mode it
//   was created in and is always verified, captured and refunded with that mode's keys.
// - The development "mock" gateway is offered only when PAYMENT_PROVIDER=mock outside production.
const { sequelize, PaymentGateway, User } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { config } = require("../Config/env");
const { encrypt, decrypt } = require("../Utils/crypto");
const { providers } = require("./paymentProviders");

const CODES = ["razorpay", "paypal"];
const MODES = ["test", "live"];
// PayPal does not accept INR for cross-border payments, so PayPal charges in one of these
// two-decimal currencies, converted from the INR order total with the admin's exchange rate.
const PAYPAL_CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "SGD", "HKD", "NZD", "CHF", "SEK", "DKK", "NOK", "PLN", "CZK"];

const mockEnabled = () => !config.isProduction && config.payments.provider === "mock";

function readSecret(row, column) {
  try {
    return decrypt(row[column]);
  } catch {
    // APP_KEY changed since the value was saved: treat it as missing so the admin re-enters it.
    console.error(`[payments] could not decrypt ${row.code}.${column}; re-enter it in Payment gateway settings`);
    return null;
  }
}

/** Decrypted credentials for one mode (server-side use only). */
function credentialsOf(row, mode = row.mode) {
  return {
    mode,
    keyId: row[`${mode}_key_id`] || null,
    secret: readSecret(row, `${mode}_secret_enc`),
    webhookSecret: readSecret(row, `${mode}_webhook_secret_enc`),
  };
}

const configured = (row, mode = row.mode) => Boolean(row[`${mode}_key_id`] && row[`${mode}_secret_enc`]);

async function load(code, options) {
  const row = await PaymentGateway.findByPk(code, options);
  if (!row) throw ApiError.notFound("Unknown payment gateway");
  return row;
}

async function credentials(code, mode) {
  const row = await load(code);
  return credentialsOf(row, mode || row.mode);
}

function hint(value) {
  return value ? `••••${value.slice(-4)}` : null;
}

function webhookUrl(code) {
  const base = (config.publicApiUrl || `http://localhost:${config.port}`).replace(/\/+$/, "");
  return `${base}${config.apiPrefix}/webhooks/${code}`;
}

function status(row) {
  if (!configured(row)) return "not_configured";
  if (row.last_test_mode === row.mode && row.last_test_status === "ok") return row.is_enabled ? "connected" : "disabled";
  if (row.last_test_mode === row.mode && row.last_test_status === "failed") return "failed";
  return row.is_enabled ? "untested" : "disabled";
}

/** Admin view of a gateway: public ids in full, secrets only as "set / last four". */
function describe(row, updatedBy) {
  const creds = {};
  for (const mode of MODES) {
    const secret = readSecret(row, `${mode}_secret_enc`);
    const webhook = readSecret(row, `${mode}_webhook_secret_enc`);
    creds[mode] = {
      keyId: row[`${mode}_key_id`] || "",
      hasSecret: Boolean(secret),
      secretHint: hint(secret),
      hasWebhookSecret: Boolean(webhook),
      webhookSecretHint: row.code === "paypal" ? webhook || null : hint(webhook),
    };
  }
  return {
    code: row.code,
    name: row.name,
    isEnabled: row.is_enabled,
    mode: row.mode,
    isDefault: row.is_default,
    currency: row.currency,
    exchangeRate: row.exchange_rate,
    credentials: creds,
    status: status(row),
    lastTest: row.last_tested_at ? { status: row.last_test_status, message: row.last_test_message, mode: row.last_test_mode, at: row.last_tested_at } : null,
    webhookUrl: webhookUrl(row.code),
    currencies: row.code === "paypal" ? PAYPAL_CURRENCIES : ["INR"],
    updatedAt: row.updated_at,
    updatedBy: updatedBy || null,
  };
}

async function list() {
  const rows = await PaymentGateway.findAll({ order: [["sort_order", "ASC"]] });
  const editors = await User.findAll({ where: { id: rows.map((r) => r.updated_by).filter(Boolean) }, attributes: ["id", "name"] });
  const names = new Map(editors.map((u) => [u.id, u.name]));
  return rows.map((r) => describe(r, r.updated_by ? names.get(r.updated_by) || null : null));
}

async function get(code) {
  const row = await load(code);
  const editor = row.updated_by ? await User.findByPk(row.updated_by, { attributes: ["name"] }) : null;
  return describe(row, editor?.name || null);
}

const KEY_PREFIX = { razorpay: { test: "rzp_test_", live: "rzp_live_" } };

function validateCredentials(code, mode, keyId) {
  const prefix = KEY_PREFIX[code]?.[mode];
  if (keyId && prefix && !keyId.startsWith(prefix)) {
    throw ApiError.unprocessable(`A ${mode} Razorpay Key ID starts with "${prefix}"`, "VALIDATION_FAILED", { [`${mode}.keyId`]: `Must start with ${prefix}` });
  }
}

/**
 * Saves a gateway. Secret fields left empty keep their stored value. Enabling needs complete
 * credentials for the selected mode; live mode in production needs an HTTPS site address.
 */
async function save(auth, code, input) {
  return sequelize.transaction(async (transaction) => {
    const row = await load(code, { transaction, lock: transaction.LOCK.UPDATE });
    const before = describe(row);
    const patch = { updated_by: auth.user.id };
    let credentialsChanged = false;

    for (const mode of MODES) {
      const given = input[mode];
      if (!given) continue;
      if (given.keyId !== undefined) {
        const keyId = given.keyId ? given.keyId.trim() : null;
        validateCredentials(code, mode, keyId);
        if (keyId !== (row[`${mode}_key_id`] || null)) {
          patch[`${mode}_key_id`] = keyId;
          if (mode === (input.mode || row.mode)) credentialsChanged = true;
          // A cleared id clears its secrets too, so no orphaned secret is left behind.
          if (!keyId) Object.assign(patch, { [`${mode}_secret_enc`]: null, [`${mode}_webhook_secret_enc`]: null });
        }
      }
      if (given.secret) {
        patch[`${mode}_secret_enc`] = encrypt(given.secret.trim());
        if (mode === (input.mode || row.mode)) credentialsChanged = true;
      }
      if (given.webhookSecret) patch[`${mode}_webhook_secret_enc`] = encrypt(given.webhookSecret.trim());
      if (given.clearWebhookSecret) patch[`${mode}_webhook_secret_enc`] = null;
    }

    if (input.mode && input.mode !== row.mode) {
      patch.mode = input.mode;
      credentialsChanged = true;
    }
    if (input.currency !== undefined) {
      const allowed = code === "paypal" ? PAYPAL_CURRENCIES : ["INR"];
      if (!allowed.includes(input.currency)) throw ApiError.unprocessable(`${row.name} cannot charge in ${input.currency}`, "VALIDATION_FAILED", { currency: `Choose one of ${allowed.join(", ")}` });
      patch.currency = input.currency;
    }
    if (input.exchangeRate !== undefined) patch.exchange_rate = (patch.currency || row.currency) === "INR" ? 1 : input.exchangeRate;
    if (input.isEnabled !== undefined) patch.is_enabled = input.isEnabled;

    const next = { ...row.get({ plain: true }), ...patch };
    if (next.is_enabled) {
      if (!configured(next, next.mode)) {
        throw ApiError.unprocessable(`Enter the ${next.mode} ${code === "paypal" ? "Client ID and Client Secret" : "Key ID and Key Secret"} before enabling ${row.name}`, "GATEWAY_NOT_CONFIGURED");
      }
      if (config.isProduction && next.mode === "live" && !config.webAppUrl.startsWith("https://")) {
        throw ApiError.unprocessable("Live payments need the site to be served over HTTPS (WEB_APP_URL must start with https://)", "HTTPS_REQUIRED");
      }
    }
    if (credentialsChanged) Object.assign(patch, { last_test_status: null, last_test_message: null, last_tested_at: null, last_test_mode: null });

    // Only an enabled gateway can be the default.
    if (!next.is_enabled || input.isDefault === false) {
      patch.is_default = false;
    } else if (input.isDefault === true) {
      await PaymentGateway.update({ is_default: false }, { where: { is_default: true }, transaction });
      patch.is_default = true;
    }

    await row.update(patch, { transaction });
    return { before, after: describe(row, auth.user.name) };
  });
}

/** Checks the active mode's credentials against the gateway and stores the result. */
async function test(code) {
  const row = await load(code);
  const creds = credentialsOf(row);
  let ok = false;
  let message;
  if (!creds.keyId || !creds.secret) {
    message = `Enter the ${row.mode} credentials first`;
  } else {
    try {
      message = await providers[code].testConnection(creds);
      ok = true;
      if (!creds.webhookSecret) message += `. No ${code === "paypal" ? "webhook ID" : "webhook secret"} is set, so webhooks will be rejected.`;
    } catch (error) {
      message = error.statusCode && error.statusCode < 500 ? error.message : error.message || "Connection failed";
    }
  }
  await row.update({ last_test_status: ok ? "ok" : "failed", last_test_message: String(message).slice(0, 300), last_tested_at: new Date(), last_test_mode: row.mode });
  return { ok, message, gateway: await get(code) };
}

async function enabledRows() {
  const rows = await PaymentGateway.findAll({ where: { is_enabled: true }, order: [["sort_order", "ASC"]] });
  return rows.filter((r) => configured(r));
}

/** What the checkout may offer. Public: names, modes and currencies only. */
async function available() {
  const rows = await enabledRows();
  const gateways = rows.map((r) => ({ code: r.code, name: r.name, mode: r.mode, currency: r.currency, exchangeRate: r.exchange_rate }));
  if (mockEnabled()) gateways.push({ code: "mock", name: "Simulated gateway (development)", mode: "test", currency: "INR", exchangeRate: 1 });
  const explicit = rows.find((r) => r.is_default);
  const defaultGateway = explicit?.code || gateways[0]?.code || null;
  return { available: gateways.length > 0, defaultGateway, gateways };
}

/**
 * The gateway a new payment uses: the one the customer picked, else the default. Refuses
 * gateways that are disabled or incomplete, so the browser cannot force one the admin turned off.
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
  const row = await load(chosen);
  if (!row.is_enabled || !configured(row)) throw ApiError.conflict(`${row.name} is not available right now. Please choose another payment method.`, "GATEWAY_UNAVAILABLE");
  return { code: row.code, name: row.name, mode: row.mode, currency: row.currency, exchangeRate: row.exchange_rate, creds: credentialsOf(row) };
}

/** Amount charged by the gateway (minor units of its currency) for an INR amount in paise. */
function chargeFor(gateway, amountPaise) {
  if (gateway.currency === "INR") return { currency: "INR", amount: amountPaise };
  // Rounded up to the next cent so the business never receives less than the INR price.
  return { currency: gateway.currency, amount: Math.ceil(amountPaise / Number(gateway.exchangeRate)) };
}

/** Webhook credentials for every mode that has them (an event may come from either account). */
async function webhookCredentials(code) {
  const row = await load(code);
  return MODES.map((mode) => credentialsOf(row, mode)).filter((c) => c.webhookSecret);
}

/**
 * One-time move of Razorpay keys from .env (the old configuration) into the admin settings, so
 * an existing installation keeps taking payments after this upgrade. Runs at startup and does
 * nothing once an admin has saved the gateway or when the keys are absent.
 */
async function importLegacyEnv() {
  const { razorpayKeyId: keyId, razorpayKeySecret: secret, razorpayWebhookSecret: webhookSecret } = config.payments;
  if (!keyId || !secret) return false;
  const row = await PaymentGateway.findByPk("razorpay");
  if (!row || row.updated_by || row.test_key_id || row.live_key_id) return false;
  const mode = keyId.startsWith("rzp_live_") ? "live" : "test";
  await row.update({
    mode,
    [`${mode}_key_id`]: keyId,
    [`${mode}_secret_enc`]: encrypt(secret),
    [`${mode}_webhook_secret_enc`]: encrypt(webhookSecret || null),
    is_enabled: config.payments.provider === "razorpay",
    is_default: config.payments.provider === "razorpay",
  });
  console.log(`[payments] Imported the Razorpay ${mode} keys from .env into Payment gateway settings. Manage them in the admin panel from now on.`);
  return true;
}

module.exports = { CODES, PAYPAL_CURRENCIES, list, get, save, test, available, resolveForCheckout, chargeFor, credentials, webhookCredentials, importLegacyEnv, mockEnabled };

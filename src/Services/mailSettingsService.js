// SMTP settings managed in the admin panel (Settings -> Email (SMTP)). Stored in the settings
// table under the private key "smtp" (never listed on the generic settings page), with the
// password AES-256-GCM encrypted with APP_KEY and never returned by the API.
//
// While admin SMTP is switched off (or never saved), mail uses the .env MAIL_* configuration.
// The effective configuration is cached in memory so mailService.isConfigured() stays synchronous;
// it is loaded at startup (Index.js) and refreshed whenever it is saved.
const { Setting, User } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { config } = require("../Config/env");
const { encrypt, decrypt } = require("../Utils/crypto");

const KEY = "smtp";
const ENCRYPTION = ["none", "starttls", "ssl"];

let cached = null; // { row value } or false when not saved

function envConfig() {
  return {
    source: "env",
    driver: config.mail.driver === "smtp" ? "smtp" : "log",
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    requireTLS: false,
    user: config.mail.user,
    password: config.mail.password,
    from: config.mail.from,
    replyTo: null,
  };
}

function readPassword(value) {
  try {
    return decrypt(value.passwordEnc);
  } catch {
    console.error("[mail] the saved SMTP password could not be decrypted (APP_KEY changed?); re-enter it in Email settings");
    return null;
  }
}

function fromHeader(v) {
  const name = (v.fromName || "").replace(/["\r\n]/g, "");
  return name ? `"${name}" <${v.fromEmail}>` : v.fromEmail;
}

/** What mailService sends with: the admin SMTP settings when enabled, else .env. */
function effective() {
  const v = cached || null;
  if (!v || !v.enabled) return envConfig();
  return {
    source: "admin",
    driver: "smtp",
    host: v.host,
    port: v.port,
    secure: v.encryption === "ssl",
    requireTLS: v.encryption === "starttls",
    user: v.username || "",
    password: v.passwordEnc ? readPassword(v) : "",
    from: fromHeader(v),
    replyTo: v.replyTo || null,
  };
}

async function load() {
  const row = await Setting.findByPk(KEY);
  cached = row ? row.value : false;
  return row;
}

/** Admin view: everything except the password, which shows only as set / last four. */
async function describe() {
  const row = await load();
  const v = row?.value || {};
  const editor = row?.updated_by ? await User.findByPk(row.updated_by, { attributes: ["name"] }) : null;
  const password = v.passwordEnc ? readPassword(v) : null;
  return {
    enabled: Boolean(v.enabled),
    host: v.host || "",
    port: v.port || 587,
    encryption: v.encryption || "starttls",
    username: v.username || "",
    hasPassword: Boolean(password),
    passwordHint: password ? `••••${password.slice(-4)}` : null,
    fromName: v.fromName || config.brandName,
    fromEmail: v.fromEmail || "",
    replyTo: v.replyTo || "",
    lastTest: v.lastTest || null,
    updatedAt: row?.updated_at || null,
    updatedBy: editor?.name || null,
    // What is in use right now, so the page can say whether .env or these settings apply.
    active: { source: effective().source, driver: effective().driver },
  };
}

async function save(auth, input) {
  const row = await Setting.findByPk(KEY);
  const current = row?.value || {};
  const next = {
    enabled: input.enabled,
    host: input.host,
    port: input.port,
    encryption: input.encryption,
    username: input.username || "",
    passwordEnc: input.password ? encrypt(input.password) : input.clearPassword ? null : current.passwordEnc || null,
    fromName: input.fromName || "",
    fromEmail: input.fromEmail,
    replyTo: input.replyTo || "",
    // A change to the server or account needs a fresh test.
    lastTest: ["host", "port", "encryption", "username"].some((k) => input[k] !== current[k]) || input.password ? null : current.lastTest || null,
  };
  if (!ENCRYPTION.includes(next.encryption)) throw ApiError.unprocessable("Choose an encryption type", "VALIDATION_FAILED", { encryption: "Invalid" });
  if (next.enabled && (!next.host || !next.fromEmail)) throw ApiError.unprocessable("Enter the SMTP host and the From address before turning SMTP on", "SMTP_INCOMPLETE");
  if (next.enabled && next.username && !next.passwordEnc) throw ApiError.unprocessable("Enter the SMTP password for this username", "SMTP_INCOMPLETE", { password: "Required with a username" });
  await Setting.upsert({ key: KEY, value: next, description: "SMTP server for outgoing email (password encrypted)", updated_by: auth.user.id, updated_at: new Date() });
  await load();
  require("./mailService").reset();
  return describe();
}

/** Sends a test email with the saved settings and records the outcome. */
async function test(auth, { to }) {
  await load();
  const settings = effective();
  if (settings.driver !== "smtp") throw ApiError.unprocessable("Turn on SMTP and save the settings before sending a test email", "SMTP_DISABLED");
  const result = await require("./mailService").sendWith(settings, {
    to,
    subject: `Test email from ${config.brandName}`,
    text: `This is a test email sent by ${auth.user.name} from the ${config.brandName} admin panel. Your SMTP settings work.`,
    html: `<p>This is a test email sent by <strong>${auth.user.name}</strong> from the ${config.brandName} admin panel.</p><p>Your SMTP settings work.</p>`,
  });
  const ok = Boolean(result.delivered);
  const message = ok ? `Test email sent to ${to}` : `Could not send: ${result.error || "unknown error"}`;
  const row = await Setting.findByPk(KEY);
  if (row) {
    await row.update({ value: { ...row.value, lastTest: { ok, message: message.slice(0, 300), at: new Date().toISOString() } } });
    await load();
  }
  return { ok, message, settings: await describe() };
}

module.exports = { KEY, load, effective, describe, save, test };

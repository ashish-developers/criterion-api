// Email (SMTP) settings, read from the server's .env (MAIL_*). The admin page (Settings -> Email
// (SMTP)) shows them read-only and can send a test email; it cannot change them. The password
// never leaves the server: the admin view says only whether one is set.
//
// The older admin-saved settings (settings row "smtp") are no longer read; the row is kept as is.
const ApiError = require("../Utils/ApiError");
const { config } = require("../Config/env");

const ENCRYPTION = ["none", "starttls", "ssl"];

/** What mailService sends with. */
function effective() {
  const m = config.mail;
  return {
    source: "env",
    driver: m.driver === "smtp" ? "smtp" : "log",
    host: m.host,
    port: m.port,
    secure: m.secure,
    requireTLS: m.requireTLS,
    user: m.user,
    password: m.password,
    from: m.from,
    replyTo: m.replyTo || null,
  };
}

/** Missing or invalid MAIL_* values, by variable name (empty when SMTP is ready or not in use). */
function problems() {
  const m = config.mail;
  if (m.driver !== "smtp") return [];
  const missing = [];
  if (!m.host) missing.push("MAIL_HOST");
  if (!m.port) missing.push("MAIL_PORT");
  if (!ENCRYPTION.includes(m.encryption)) missing.push("MAIL_ENCRYPTION (none, starttls or ssl)");
  if (!m.fromAddress) missing.push("MAIL_FROM_ADDRESS");
  if (m.user && !m.password) missing.push("MAIL_PASSWORD");
  return missing;
}

/** Admin view: everything except the password. */
function describe() {
  const m = config.mail;
  return {
    source: "env",
    enabled: m.driver === "smtp",
    host: m.host,
    port: m.port,
    encryption: m.encryption,
    username: m.user,
    hasPassword: Boolean(m.password),
    fromName: m.fromName,
    fromEmail: m.fromAddress,
    replyTo: m.replyTo,
    missing: problems(),
    active: { source: "env", driver: effective().driver },
  };
}

/**
 * Checks the SMTP connection and login without sending anything (nodemailer verify:
 * connect, TLS, AUTH, then QUIT).
 */
async function verify() {
  const s = effective();
  if (s.driver !== "smtp") return { ok: false, message: "MAIL_DRIVER is not smtp: emails are only written to the server log" };
  const missing = problems();
  if (missing.length) return { ok: false, message: `Missing in .env: ${missing.join(", ")}` };
  try {
    await require("./mailService").transportFor(s).verify();
    return { ok: true, message: `Connected to ${s.host}:${s.port} and signed in` };
  } catch (error) {
    return { ok: false, message: `Could not connect: ${error.message}` };
  }
}

/** Sends a test email (admin "Send test email" button). */
async function test(auth, { to }) {
  const settings = effective();
  if (settings.driver !== "smtp") throw ApiError.unprocessable("Email is not being sent: set MAIL_DRIVER=smtp and the MAIL_* values in the server's .env, then restart the API", "SMTP_DISABLED");
  const result = await require("./mailService").sendWith(settings, {
    to,
    subject: `Test email from ${config.brandName}`,
    text: `This is a test email sent by ${auth.user.name} from the ${config.brandName} admin panel. Your SMTP settings work.`,
    html: `<p>This is a test email sent by <strong>${auth.user.name}</strong> from the ${config.brandName} admin panel.</p><p>Your SMTP settings work.</p>`,
  });
  const ok = Boolean(result.delivered);
  const message = ok ? `Test email sent to ${to}` : `Could not send: ${result.error || "unknown error"}`;
  return { ok, message, settings: describe() };
}

module.exports = { effective, describe, problems, verify, test };

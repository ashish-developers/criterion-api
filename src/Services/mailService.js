// Email delivery abstraction. The SMTP server comes from the admin panel (Settings -> Email
// (SMTP), mailSettingsService) when switched on there, else from .env: MAIL_DRIVER=log (default)
// writes a redacted line to the console; MAIL_DRIVER=smtp sends through any SMTP server
// (Mailpit, SES SMTP, etc.). To use a provider API instead, add a driver with the same
// send({to, subject, text, html}) shape.
const { config } = require("../Config/env");

const settings = () => require("./mailSettingsService").effective();

// One transporter per SMTP configuration; a saved change gets a fresh one.
let transporter = null;
let transporterKey = null;

function transportFor(s) {
  const key = JSON.stringify([s.host, s.port, s.secure, s.requireTLS, s.user, s.password]);
  if (!transporter || transporterKey !== key) {
    const nodemailer = require("nodemailer");
    transporter = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      requireTLS: s.requireTLS,
      auth: s.user ? { user: s.user, pass: s.password } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
    });
    transporterKey = key;
  }
  return transporter;
}

const drivers = {
  async log({ to, subject }) {
    // Body is not logged: it may contain one-time codes.
    if (!config.isTest) console.log(`[mail:log] to=${to} subject="${subject}"`);
    return { delivered: false, driver: "log" };
  },
  async smtp({ to, subject, text, html }, s) {
    await transportFor(s).sendMail({ from: s.from, replyTo: s.replyTo || undefined, to, subject, text, html });
    return { delivered: true, driver: "smtp" };
  },
};

function isConfigured() {
  return settings().driver !== "log";
}

/** Sends with an explicit configuration (the admin "send test email" button). */
async function sendWith(s, message) {
  const driver = drivers[s.driver] || drivers.log;
  try {
    return await driver(message, s);
  } catch (error) {
    console.error(`[mail] delivery failed: ${error.message}`);
    return { delivered: false, error: error.message };
  }
}

async function send(message) {
  return sendWith(settings(), message);
}

function reset() {
  transporter = null;
  transporterKey = null;
}

module.exports = { send, sendWith, isConfigured, reset };

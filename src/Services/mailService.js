// Email delivery abstraction. MAIL_DRIVER=log (default) writes a redacted line to the
// console; MAIL_DRIVER=smtp sends through any SMTP server (Mailpit, SES SMTP, etc.).
// To use a provider API instead, add a driver with the same send({to, subject, text, html}) shape.
const { config } = require("../Config/env");

let transporter = null;

function smtpTransport() {
  if (!transporter) {
    const nodemailer = require("nodemailer");
    transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
    });
  }
  return transporter;
}

const drivers = {
  async log({ to, subject }) {
    // Body is not logged: it may contain one-time codes.
    if (!config.isTest) console.log(`[mail:log] to=${to} subject="${subject}"`);
    return { delivered: false, driver: "log" };
  },
  async smtp({ to, subject, text, html }) {
    await smtpTransport().sendMail({ from: config.mail.from, to, subject, text, html });
    return { delivered: true, driver: "smtp" };
  },
};

function isConfigured() {
  return config.mail.driver !== "log";
}

async function send(message) {
  const driver = drivers[config.mail.driver] || drivers.log;
  try {
    return await driver(message);
  } catch (error) {
    console.error(`[mail] delivery failed: ${error.message}`);
    return { delivered: false, error: error.message };
  }
}

module.exports = { send, isConfigured };

// npm run config:check
// Checks the email and payment gateway settings in .env without sending an email or creating a
// payment: SMTP connect + login (no message), Razorpay list-orders call, PayPal OAuth token.
// Prints variable names and results only, never the values of passwords or secrets.
const { config } = require("./env");
const mailSettings = require("../Services/mailSettingsService");
const gateways = require("../Services/gatewayService");

const mark = (ok) => (ok ? "OK  " : "FAIL");
const set = (value) => (value ? "set" : "MISSING");

(async () => {
  let failures = 0;

  const m = config.mail;
  console.log("\nEmail (SMTP)");
  console.log(`  MAIL_DRIVER=${m.driver}  MAIL_HOST=${m.host}  MAIL_PORT=${m.port}  MAIL_ENCRYPTION=${m.encryption}`);
  console.log(`  MAIL_USERNAME ${set(m.user)}, MAIL_PASSWORD ${set(m.password)}, MAIL_FROM_ADDRESS ${set(m.fromAddress)}, MAIL_FROM_NAME=${m.fromName || "-"}`);
  if (m.driver === "smtp") {
    const result = await mailSettings.verify();
    console.log(`  ${mark(result.ok)} ${result.message}`);
    if (!result.ok) failures++;
  } else {
    console.log("  -    MAIL_DRIVER is not smtp: emails are only written to the server log");
  }

  console.log("\nPayment gateways");
  const { gateways: offered, defaultGateway } = await gateways.available();
  console.log(`  Offered at checkout: ${offered.map((g) => g.code).join(", ") || "none"}; default: ${defaultGateway || "-"}`);
  for (const code of gateways.CODES) {
    const s = config.payments[code];
    const env = gateways.ENV_NAMES[code];
    console.log(`  ${code}: ${env.enabled}=${s.enabled} ${env.mode}=${s.mode} ${env.keyId} ${set(s.keyId)}, ${env.secret} ${set(s.secret)}, ${env.webhookSecret} ${set(s.webhookSecret)}`);
    if (!s.enabled && !s.keyId) continue;
    const result = await gateways.test(code);
    console.log(`  ${mark(result.ok)} ${result.message}`);
    if (!result.ok && s.enabled) failures++;
  }

  console.log(failures ? `\n${failures} problem(s) found.` : "\nAll configured integrations respond.");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(`Check failed: ${error.message}`);
  process.exit(1);
});

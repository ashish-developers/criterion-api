// Central, validated access to environment configuration.
// Every module reads settings from here instead of process.env directly.
require("dotenv").config({ quiet: true });

const str = (key, fallback = "") => (process.env[key] ?? fallback).toString().trim();
const int = (key, fallback) => {
  const value = parseInt(str(key), 10);
  return Number.isFinite(value) ? value : fallback;
};
const bool = (key, fallback = false) => {
  const value = str(key).toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
};

const appEnv = str("APP_ENV", "local");
const isProduction = appEnv === "production";

// API_VERSION in .env is the full mount prefix ("/api/v1"). Older configs used just "v1".
let apiPrefix = str("API_VERSION", "/api/v1");
if (!apiPrefix.startsWith("/")) apiPrefix = `/api/${apiPrefix}`;

const config = {
  appName: str("APP_NAME", "branding"),
  appEnv,
  isProduction,
  isTest: appEnv === "test",
  port: int("APP_PORT", 4000),
  apiPrefix,
  webAppUrl: str("WEB_APP_URL", "http://localhost:3000"),
  corsOrigins: str("CORS_ORIGINS", str("WEB_APP_URL", "http://localhost:3000"))
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  trustProxy: bool("TRUST_PROXY", false),

  db: {
    host: str("DB_HOST", "localhost"),
    port: int("DB_PORT", 5432),
    name: str("DB_NAME", "branding"),
    user: str("DB_USER", "postgres"),
    password: str("DB_PASSWORD"),
    ssl: bool("DB_SSL", false),
    logging: bool("DB_LOGGING", false),
  },

  auth: {
    accessSecret: str("JWT_ACCESS_SECRET"),
    accessExpiresIn: str("JWT_ACCESS_EXPIRES_IN", "15m"),
    refreshExpiresDays: int("JWT_REFRESH_EXPIRES_DAYS", 30),
    cookieSecure: bool("COOKIE_SECURE", isProduction),
    cookieDomain: str("COOKIE_DOMAIN") || undefined,
  },

  otp: {
    length: 6,
    ttlMinutes: int("OTP_TTL_MINUTES", 5),
    maxAttempts: int("OTP_MAX_ATTEMPTS", 5),
    resendCooldownSeconds: int("OTP_RESEND_COOLDOWN_SECONDS", 60),
    maxResends: int("OTP_MAX_RESENDS", 5),
    // SHOW_DEV_OTP is the documented switch; OTP_IN_RESPONSE is honoured for older .env files.
    // Never enabled in production regardless of configuration.
    showDevOtp: !isProduction && (bool("SHOW_DEV_OTP", false) || bool("OTP_IN_RESPONSE", false)),
  },

  mail: {
    driver: str("MAIL_DRIVER", "log"), // log | smtp
    host: str("MAIL_HOST", "localhost"),
    port: int("MAIL_PORT", 1025),
    secure: bool("MAIL_SECURE", false),
    user: str("MAIL_USER"),
    password: str("MAIL_PASSWORD"),
    from: str("MAIL_FROM", "Branding Platform <no-reply@localhost>"),
  },

  payments: {
    provider: str("PAYMENT_PROVIDER", "mock"), // mock | razorpay
    razorpayKeyId: str("RAZORPAY_KEY_ID"),
    razorpayKeySecret: str("RAZORPAY_KEY_SECRET"),
    razorpayWebhookSecret: str("RAZORPAY_WEBHOOK_SECRET"),
  },

  storage: {
    driver: str("STORAGE_DRIVER", "local"),
    localPath: str("STORAGE_LOCAL_PATH", "storage/uploads"),
    maxUploadMb: int("UPLOAD_MAX_MB", 25),
  },
};

function assertConfig() {
  const problems = [];
  if (!config.auth.accessSecret) problems.push("JWT_ACCESS_SECRET is not set");
  if (config.isProduction && config.auth.accessSecret.length < 32)
    problems.push("JWT_ACCESS_SECRET must be at least 32 characters in production");
  if (config.isProduction && config.payments.provider === "mock")
    problems.push("PAYMENT_PROVIDER=mock is not allowed when APP_ENV=production");
  return problems;
}

module.exports = { config, assertConfig };

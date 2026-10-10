const crypto = require("crypto");
const { promisify } = require("util");
const { config } = require("../Config/env");

const scrypt = promisify(crypto.scrypt);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

// Password hashing with scrypt (memory-hard KDF from Node's standard library).
// Stored format: scrypt$N$r$p$salt$hash (base64).
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, N, r, p, saltB64, hashB64] = stored.split("$");
  const expected = Buffer.from(hashB64, "base64");
  const derived = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  return crypto.timingSafeEqual(derived, expected);
}

// Keyed hash for OTPs, refresh tokens and reset tokens so a database leak
// does not reveal usable values.
function hmac(value) {
  return crypto.createHmac("sha256", config.auth.accessSecret).update(String(value)).digest("hex");
}

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function randomOtp(length = 6) {
  // crypto.randomInt is uniform; pad to keep leading zeros.
  return crypto.randomInt(0, 10 ** length).toString().padStart(length, "0");
}

function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// AES-256-GCM for sensitive values at rest (vendor bank account numbers).
function encryptionKey() {
  const source = process.env.APP_KEY || config.auth.accessSecret;
  return crypto.createHash("sha256").update(source).digest();
}

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

function decrypt(payload) {
  if (!payload) return null;
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = { hashPassword, verifyPassword, hmac, safeEqualHex, randomOtp, randomToken, encrypt, decrypt, sha256 };

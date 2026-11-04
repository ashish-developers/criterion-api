// Integration test harness: a dedicated test database (DB_NAME + "_test"), reset,
// migrated and seeded once per run, and an HTTP client with a cookie jar and CSRF header.
const zlib = require("zlib");

process.env.APP_ENV = "test";
process.env.SHOW_DEV_OTP = "true";
process.env.PAYMENT_PROVIDER = "mock";
process.env.DISABLE_SCHEDULER = "true";
// Never use the real mail server or gateway keys from .env in tests (set before .env loads, so
// these win). Tests that need a gateway set config.payments.* themselves.
process.env.MAIL_DRIVER = "log";
for (const name of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYMENT_DEFAULT_GATEWAY"]) process.env[name] = "";
process.env.RAZORPAY_ENABLED = "false";
process.env.PAYPAL_ENABLED = "false";
process.env.RAZORPAY_MODE = "test";
process.env.PAYPAL_MODE = "test";
process.env.PAYPAL_CURRENCY = "USD";
process.env.PAYPAL_EXCHANGE_RATE = "85";
require("dotenv").config({ quiet: true });
process.env.DB_NAME = process.env.TEST_DB_NAME || `${(process.env.DB_NAME || "branding").trim()}_test`;

let bootPromise = null;
let server = null;
let base = null;

async function boot() {
  if (!bootPromise) {
    bootPromise = (async () => {
      const runner = require("../src/Migrations/runner");
      await runner.createDatabase();
      await runner.reset();
      await runner.up();
      const { seedReference } = require("../src/Seeders/referenceData");
      const { seedDemo } = require("../src/Seeders/demoData");
      await seedReference();
      await seedDemo();
      const { createApp } = require("../src/app");
      server = createApp().listen(0);
      base = `http://localhost:${server.address().port}/api/v1`;
    })();
  }
  await bootPromise;
  return base;
}

async function shutdown() {
  if (server) server.close();
  await require("../src/Models").sequelize.close();
}

class Client {
  constructor() {
    this.cookies = {};
  }
  async request(method, path, body, { headers = {}, raw = false } = {}) {
    const url = (await boot()) + path;
    const h = { cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; "), ...headers };
    if (this.cookies.csrf_token) h["x-csrf-token"] = this.cookies.csrf_token;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [k, ...rest] = pair.split("=");
      const v = rest.join("=");
      if (!v || attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a))) delete this.cookies[k.trim()];
      else this.cookies[k.trim()] = v;
    }
    if (raw) return res;
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json, data: json.data, headers: res.headers };
  }
  get(p, o) {
    return this.request("GET", p, undefined, o);
  }
  post(p, b, o) {
    return this.request("POST", p, b ?? {}, o);
  }
  put(p, b) {
    return this.request("PUT", p, b ?? {});
  }
  patch(p, b) {
    return this.request("PATCH", p, b ?? {});
  }
  del(p) {
    return this.request("DELETE", p);
  }
  async csrf() {
    await this.get("/auth/csrf");
  }
  async login(email, password = "Demo@1234") {
    await this.csrf();
    const res = await this.post("/auth/login", { email, password });
    if (res.status !== 200) throw new Error(`login ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.data;
  }
  async upload(fileBuffer, filename, query = "") {
    const form = new FormData();
    form.append("file", new Blob([fileBuffer]), filename);
    return this.request("POST", `/uploads${query}`, form);
  }
}

// Minimal PNG encoder for generating test artwork of a given pixel size.
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function db() {
  await boot();
  return require("../src/Models");
}

module.exports = { boot, shutdown, Client, png, db };

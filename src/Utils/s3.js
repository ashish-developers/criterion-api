// Minimal S3-compatible client (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO) for private
// object storage: PUT, GET and DELETE of single objects, signed with AWS Signature Version 4.
// Uses the built-in fetch, so no SDK dependency.
const crypto = require("crypto");

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// RFC 3986 encoding as SigV4 requires; "/" stays literal in object keys.
function encodePath(p) {
  return p
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/**
 * Signs a request (AWS SigV4, service "s3"). Returns the headers to send, including
 * Authorization. `headers` must hold every header to sign except host and x-amz-*,
 * which are added here. `payloadHash` may be "UNSIGNED-PAYLOAD".
 */
function sign({ method, url, headers = {}, payloadHash, accessKeyId, secretAccessKey, region, date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host: u.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [method, encodePath(decodeURIComponent(u.pathname)), query, names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  const out = Object.fromEntries(Object.entries(all).filter(([k]) => k.toLowerCase() !== "host"));
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return out;
}

function client({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle = true, prefix = "" }) {
  const base = endpoint ? endpoint.replace(/\/+$/, "") : `https://s3.${region}.amazonaws.com`;
  const objectUrl = (key) => {
    const full = `${prefix ? `${prefix.replace(/\/+$/, "")}/` : ""}${key}`;
    if (forcePathStyle) return `${base}/${bucket}/${encodePath(full)}`;
    const u = new URL(base);
    return `${u.protocol}//${bucket}.${u.host}/${encodePath(full)}`;
  };

  async function request(method, key, { body, contentType } = {}) {
    const url = objectUrl(key);
    const payloadHash = body ? sha256(body) : sha256("");
    const headers = sign({ method, url, headers: contentType ? { "content-type": contentType } : {}, payloadHash, accessKeyId, secretAccessKey, region });
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    if (!res.ok && !(method === "DELETE" && res.status === 404)) {
      const text = await res.text().catch(() => "");
      const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1] || res.statusText;
      const error = new Error(`S3 ${method} failed (${res.status} ${code})`);
      error.status = res.status;
      throw error;
    }
    return res;
  }

  return {
    async put(key, body, contentType = "application/octet-stream") {
      await request("PUT", key, { body, contentType });
    },
    async get(key) {
      const res = await request("GET", key);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(key) {
      await request("DELETE", key);
    },
  };
}

module.exports = { sign, client, encodePath };

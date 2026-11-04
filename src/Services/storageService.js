// File storage abstraction. Files are only served through the access-controlled asset
// endpoint, never directly:
//  - local (default): STORAGE_LOCAL_PATH, outside any public web root;
//  - s3: a private bucket on any S3-compatible service (AWS S3, Cloudflare R2, DigitalOcean
//    Spaces, MinIO), configured with S3_*. Files saved locally before the switch are still read
//    from disk when they are not in the bucket, so existing assets keep working.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { config } = require("../Config/env");

const root = path.resolve(__dirname, "../..", config.storage.localPath);

function resolveKey(key) {
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error("Invalid storage key");
  return full;
}

const local = {
  async put(buffer, extension) {
    const now = new Date();
    const key = path.posix.join(
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      `${crypto.randomUUID()}.${extension}`
    );
    const full = resolveKey(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return key;
  },
  async read(key) {
    return fs.readFile(resolveKey(key));
  },
  async remove(key) {
    await fs.rm(resolveKey(key), { force: true });
  },
};

const CONTENT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", pdf: "application/pdf", ai: "application/postscript", eps: "application/postscript", csv: "text/csv", zip: "application/zip" };

let bucket = null;
function s3Client() {
  if (!bucket) bucket = require("../Utils/s3").client(config.storage.s3);
  return bucket;
}

const s3 = {
  async put(buffer, extension) {
    const now = new Date();
    const key = path.posix.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), `${crypto.randomUUID()}.${extension}`);
    await s3Client().put(key, buffer, CONTENT_TYPES[extension] || "application/octet-stream");
    return key;
  },
  async read(key) {
    try {
      return await s3Client().get(key);
    } catch (error) {
      // Saved on local disk before the switch to S3.
      if (error.status === 404) return local.read(key);
      throw error;
    }
  },
  async remove(key) {
    await s3Client().remove(key);
    await local.remove(key).catch(() => undefined);
  },
};

const drivers = { local, s3 };

function driver() {
  const d = drivers[config.storage.driver];
  if (!d) throw new Error(`Storage driver "${config.storage.driver}" is not implemented`);
  return d;
}

module.exports = {
  put: (buffer, ext) => driver().put(buffer, ext),
  read: (key) => driver().read(key),
  remove: (key) => driver().remove(key),
  root,
};

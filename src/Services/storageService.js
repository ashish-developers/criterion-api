// File storage abstraction. The local driver writes to STORAGE_LOCAL_PATH (outside any
// public web root); files are only served through the access-controlled asset endpoint.
// An S3 driver can implement the same put/read/remove interface with private buckets.
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

const drivers = { local };

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

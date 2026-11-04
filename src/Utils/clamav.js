// ClamAV daemon (clamd) client: streams a buffer with the INSTREAM command over TCP and reads
// the verdict. Used for uploads when CLAMAV_HOST is set (see assetService).
const net = require("net");

const CHUNK = 64 * 1024;

/**
 * Resolves { clean: true } or { clean: false, signature }; rejects when the daemon cannot be
 * reached, times out or answers with an error (e.g. the stream exceeds StreamMaxLength).
 */
function scanBuffer(buffer, { host, port = 3310, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let reply = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };
    socket.setTimeout(timeoutMs, () => finish(reject, new Error("ClamAV did not answer in time")));
    socket.on("error", (error) => finish(reject, new Error(`ClamAV unreachable: ${error.message}`)));
    socket.on("data", (data) => (reply += data.toString("utf8")));
    socket.on("end", () => {
      const text = reply.replace(/\0/g, "").trim();
      if (/:\s*OK$/.test(text)) return finish(resolve, { clean: true });
      const found = text.match(/:\s*(.+)\s+FOUND$/);
      if (found) return finish(resolve, { clean: false, signature: found[1] });
      finish(reject, new Error(`ClamAV error: ${text || "no reply"}`));
    });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let i = 0; i < buffer.length; i += CHUNK) {
        const chunk = buffer.subarray(i, i + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
    });
  });
}

module.exports = { scanBuffer };

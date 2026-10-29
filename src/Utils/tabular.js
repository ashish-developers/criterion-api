// Reads uploaded spreadsheets into rows of strings: CSV (UTF-8, RFC 4180 quoting) and
// Excel .xlsx (the first worksheet). XLSX is a ZIP of XML parts; this reader handles exactly
// what spreadsheet exports contain (stored or deflated entries, shared and inline strings)
// with size limits, so a crafted file cannot exhaust memory. Legacy .xls is not supported.
const zlib = require("zlib");
const ApiError = require("./ApiError");

const MAX_PART_BYTES = 20 * 1024 * 1024;

function parseCsv(text) {
  const src = text.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- ZIP
function zipEntries(buffer) {
  // End of central directory: scan back over the optional comment (max 64 KB).
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer, entry) {
  if (entry.size > MAX_PART_BYTES) throw new Error("part too large");
  const o = entry.localOffset;
  if (buffer.readUInt32LE(o) !== 0x04034b50) throw new Error("bad local header");
  const start = o + 30 + buffer.readUInt16LE(o + 26) + buffer.readUInt16LE(o + 28);
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.toString("utf8");
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }).toString("utf8");
  throw new Error("unsupported compression");
}

// ---------------------------------------------------------------- XLSX
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

// All <t> runs inside one string item (rich text has several).
function textRuns(xml) {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return decodeXml(out);
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] || "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function numberText(v) {
  // Excel stores long numbers (phone numbers) in full; normalise exponent notation and
  // drop float noise such as 9876543210.0000001.
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n) || /e/i.test(v)) return BigInt(Math.round(n)).toString();
  return String(Math.round(n * 1e6) / 1e6);
}

function parseXlsx(buffer, { maxRows = 5000 } = {}) {
  const entries = zipEntries(buffer);
  const shared = [];
  const sst = entries.get("xl/sharedStrings.xml");
  if (sst) for (const m of readEntry(buffer, sst).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1]));

  // The first sheet in workbook order, falling back to sheet1.xml.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbook = entries.get("xl/workbook.xml");
  const rels = entries.get("xl/_rels/workbook.xml.rels");
  if (workbook && rels) {
    const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(readEntry(buffer, workbook))?.[1];
    const target = firstId && new RegExp(`<Relationship\\b[^>]*\\bId="${firstId}"[^>]*\\bTarget="([^"]+)"`).exec(readEntry(buffer, rels))?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = entries.get(sheetPath);
  if (!sheet) throw new Error("no worksheet");

  const rows = [];
  for (const rowMatch of readEntry(buffer, sheet).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length > maxRows) break;
    const cells = [];
    for (const c of (rowMatch[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const inner = c[2] || "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = textRuns(inner);
      else if (type === "str" || type === "e") value = decodeXml(raw || "");
      else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
      else if (raw !== undefined) value = numberText(decodeXml(raw));
      cells[ref ? columnIndex(ref) : cells.length] = value;
    }
    rows.push(Array.from(cells, (v) => v ?? ""));
  }
  return rows;
}

/**
 * Rows of trimmed strings from an uploaded CSV or XLSX file, without blank rows.
 * Throws a 422 ApiError with a helpful message for unsupported or damaged files.
 */
function readSpreadsheet(file, { maxRows = 5000 } = {}) {
  if (!file) throw ApiError.badRequest("Choose a CSV or Excel file", undefined, "FILE_REQUIRED");
  const name = String(file.originalname || "").toLowerCase();
  const buf = file.buffer;
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  const isOle = buf.length > 8 && buf.readUInt32LE(0) === 0xe011cfd0;
  let rows;
  if (isOle || name.endsWith(".xls")) {
    throw ApiError.unprocessable("Old Excel .xls files are not supported. Save the sheet as .xlsx or CSV and upload it again.", "FILE_TYPE_REJECTED");
  } else if (isZip) {
    try {
      rows = parseXlsx(buf, { maxRows });
    } catch {
      throw ApiError.unprocessable("This Excel file could not be read. Save it as .xlsx or CSV and try again.", "FILE_UNREADABLE");
    }
  } else {
    if (buf.includes(0)) throw ApiError.unprocessable("Upload a CSV or .xlsx file", "FILE_TYPE_REJECTED");
    rows = parseCsv(buf.toString("utf8"));
  }
  const clean = rows.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some((c) => c !== ""));
  if (clean.length > maxRows + 1) throw ApiError.unprocessable(`Upload at most ${maxRows} rows at a time`, "FILE_TOO_LARGE");
  return clean;
}

module.exports = { parseCsv, parseXlsx, readSpreadsheet };

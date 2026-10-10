// Upload validation (FR-ST-01): the file type is detected from content, never trusted
// from the browser-supplied name or MIME type, and checked before anything is stored.
const { imageSize } = require("image-size");

const TYPES = {
  png: { mime: "image/png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  pdf: { mime: "application/pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  svg: {
    mime: "image/svg+xml",
    test: (b) => {
      const head = b.subarray(0, 2048).toString("utf8").replace(/^﻿/, "").trimStart();
      return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head);
    },
  },
};

function detectType(buffer) {
  for (const [ext, def] of Object.entries(TYPES)) if (def.test(buffer)) return { ext, mime: def.mime };
  return null;
}

// Content scan. This heuristic pass blocks active content in SVG/PDF; connect ClamAV or a
// cloud malware-scanning service here for production (Section 11.2).
function scan(buffer, ext) {
  if (ext === "svg") {
    const text = buffer.toString("utf8");
    if (/<script[\s>]/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text) || /<foreignObject/i.test(text)) {
      return { clean: false, reason: "SVG files containing scripts or event handlers are not allowed" };
    }
  }
  if (ext === "pdf") {
    const text = buffer.toString("latin1");
    if (/\/JavaScript|\/JS\s|\/Launch|\/EmbeddedFile/.test(text)) {
      return { clean: false, reason: "PDF files with embedded scripts or attachments are not allowed" };
    }
  }
  return { clean: true };
}

function dimensions(buffer, ext) {
  if (ext !== "png" && ext !== "jpg") return { width: null, height: null };
  try {
    const { width, height } = imageSize(buffer);
    return { width: width || null, height: height || null };
  } catch {
    return { width: null, height: null };
  }
}

/**
 * DPI the artwork would print at when stretched over the given physical size.
 * Vector files (SVG/PDF) are resolution independent and return null.
 */
function effectiveDpi(widthPx, heightPx, printWidthMm, printHeightMm) {
  if (!widthPx || !heightPx || !printWidthMm || !printHeightMm) return null;
  const dpiW = widthPx / (printWidthMm / 25.4);
  const dpiH = heightPx / (printHeightMm / 25.4);
  return Math.floor(Math.min(dpiW, dpiH));
}

module.exports = { detectType, scan, dimensions, effectiveDpi, TYPES };

// Blog post HTML: an allow-list sanitiser for the rich-text editor's output, plus plain-text
// extraction for search, excerpts and reading time. Content is sanitised when saved and again
// when served, so nothing that reaches a page can carry script, event handlers, styles,
// iframes or javascript:/data: URLs.
const sanitizeHtml = require("sanitize-html");

// Images in posts must come from our own asset store or an https URL.
const ASSET_URL = /^\/api\/v1\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAllowedImageUrl(src) {
  if (!src) return false;
  if (ASSET_URL.test(src)) return true;
  try {
    return new URL(src).protocol === "https:";
  } catch {
    return false;
  }
}

// Drops attributes the transforms below did not receive, so no empty attributes are emitted.
const defined = (attribs) => Object.fromEntries(Object.entries(attribs).filter(([, v]) => v !== undefined && v !== ""));

const OPTIONS = {
  allowedTags: [
    "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "sub", "sup",
    "blockquote", "ul", "ol", "li", "a", "img", "figure", "figcaption",
    "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "pre", "code",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading", "class"],
    table: ["class"],
    blockquote: ["class"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
    ul: ["class"],
    ol: ["start", "style"],
  },
  // Only the fixed list style set below: the theme resets list markers and has a class for
  // bulleted lists (ul.list-disc) but none for numbered ones.
  allowedStyles: { ol: { "list-style-type": [/^decimal$/], "padding-left": [/^15px$/] } },
  // Theme (Bootstrap) classes applied below; nothing else survives.
  allowedClasses: {
    table: ["table", "table-bordered"],
    img: ["img-fluid", "rounded"],
    blockquote: ["blockquote", "border-start", "border-3", "ps-3"],
    ul: ["list-disc"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["https"] },
  allowProtocolRelative: false,
  transformTags: {
    // The page title is the only h1; editor line breaks may arrive as <div>.
    h1: "h2",
    div: "p",
    a: (tagName, attribs) => {
      const out = { href: attribs.href, title: attribs.title };
      if (attribs.target === "_blank") Object.assign(out, { target: "_blank", rel: "noopener noreferrer" });
      return { tagName, attribs: defined(out) };
    },
    img: (tagName, attribs) => ({
      tagName,
      attribs: { ...defined({ src: attribs.src, title: attribs.title, width: attribs.width, height: attribs.height }), alt: attribs.alt || "", loading: "lazy", class: "img-fluid rounded" },
    }),
    table: (tagName) => ({ tagName, attribs: { class: "table table-bordered" } }),
    ul: (tagName) => ({ tagName, attribs: { class: "list-disc" } }),
    ol: (tagName, attribs) => ({ tagName, attribs: { ...defined({ start: attribs.start }), style: "list-style-type:decimal;padding-left:15px" } }),
    blockquote: (tagName) => ({ tagName, attribs: { class: "blockquote border-start border-3 ps-3" } }),
  },
  exclusiveFilter: (frame) => frame.tag === "img" && !isAllowedImageUrl(frame.attribs.src),
};

function sanitize(html) {
  return sanitizeHtml(String(html || ""), OPTIONS).trim();
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " " };

function toText(html) {
  const spaced = String(html || "").replace(/<\/(p|h\d|li|blockquote|td|th|figcaption|pre)>|<br\s*\/?>/gi, " ");
  const text = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} });
  return text
    .replace(/&(amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, " ")
    .trim();
}

function readingMinutes(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

function summarise(text, max = 160) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).trim()}…`;
}

function slugify(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200)
    .replace(/-+$/g, "");
}

module.exports = { sanitize, toText, readingMinutes, summarise, slugify, isAllowedImageUrl };

// Visiting card reference data: template categories, the starter template gallery, quantity
// price slabs and printing options. Safe for production: rows are only added when missing
// (by slug or code), so templates and prices edited by an admin are never overwritten.
//
// Templates are original layouts. Most use the site's own palette (navy #092C4C, orange
// #FE9F43, Poppins and Nunito); the creative, premium and technology ones use their own.
// Positions are percentages of the card; font sizes are points at print size.
const { VcTemplateCategory, VcTemplate, VcPriceSlab, VcPrintOption } = require("../Models");
const { derived } = require("../Services/vcTemplateService");
const { design: designSchema } = require("../Validators/vcValidators");

const CATEGORIES = [
  { slug: "minimal-professional", name: "Minimal & professional", icon: "ti-square", description: "Clean layouts with plenty of white space" },
  { slug: "corporate", name: "Corporate", icon: "ti-briefcase", description: "Structured cards for companies and teams" },
  { slug: "creative-colorful", name: "Creative & colourful", icon: "ti-palette", description: "Bold colour, gradients and shapes" },
  { slug: "premium-luxury", name: "Premium & luxury", icon: "ti-diamond", description: "Dark stocks, metallic tones and serif type" },
  { slug: "technology-it", name: "Technology & IT", icon: "ti-cpu", description: "Modern cards for tech and IT professionals" },
  { slug: "vertical", name: "Vertical cards", icon: "ti-arrows-vertical", description: "Portrait layouts that stand out" },
  { slug: "qr-code", name: "QR-code cards", icon: "ti-qrcode", description: "Scan to save the contact or open the website" },
  { slug: "double-sided", name: "Double-sided", icon: "ti-copy", description: "Separate front and back designs" },
].map((c, i) => ({ ...c, sort_order: i + 1 }));

// ---------------------------------------------------------------- builders
const text = (id, content, x, y, w, h, o = {}) => ({
  id,
  type: "text",
  content,
  x,
  y,
  w,
  h,
  fontFamily: o.font || "body",
  fontSize: o.size || 7,
  fontWeight: o.weight || 400,
  color: o.color || "text",
  align: o.align || "left",
  ...(o.italic ? { italic: true } : {}),
  ...(o.upper ? { uppercase: true } : {}),
  ...(o.ls !== undefined ? { letterSpacing: o.ls } : {}),
  ...(o.lh ? { lineHeight: o.lh } : {}),
});
const image = (id, source, x, y, w, h, o = {}) => ({ id, type: "image", source, x, y, w, h, fit: o.fit || "contain", shape: o.shape || "rect" });
const qr = (id, source, x, y, w, h, o = {}) => ({ id, type: "qr", source, x, y, w, h, color: o.color || "primary", background: o.bg || "#FFFFFF" });
const shape = (id, kind, x, y, w, h, o = {}) => ({
  id,
  type: "shape",
  shape: kind,
  x,
  y,
  w,
  h,
  fill: o.fill ?? "primary",
  stroke: o.stroke ?? "none",
  strokeWidth: o.sw ?? 0,
  ...(o.r !== undefined ? { radius: o.r } : {}),
  ...(o.op !== undefined ? { opacity: o.op } : {}),
});
const line = (id, x, y, w, h, color = "secondary", sw = 0.5) => shape(id, "line", x, y, w, h, { fill: "none", stroke: color, sw });
const side = (color, elements, gradientTo) => ({ background: { color, ...(gradientTo ? { gradientTo, gradientAngle: 135 } : {}) }, elements });
const theme = (primary, secondary, txt, muted, background, headingFont = "Poppins", bodyFont = "Nunito") => ({ primary, secondary, text: txt, muted, background, headingFont, bodyFont });

const BRAND = theme("#092C4C", "#FE9F43", "#1B2850", "#67748E", "#FFFFFF");
const WHITE = "#FFFFFF";
const L = { orientation: "landscape", width_mm: 89, height_mm: 51 };
const P = { orientation: "portrait", width_mm: 51, height_mm: 89 };

const TEMPLATES = [
  {
    code: "matrix-minimal",
    name: "Matrix Minimal",
    category: "minimal-professional",
    description: "A calm, single-sided layout: name and title on the left, contact details aligned right.",
    tags: ["minimal", "white", "single-sided"],
    featured: true,
    ...L,
    design: {
      version: 1,
      theme: BRAND,
      front: side("background", [
        image("logo", "logo", 6, 10, 22, 24),
        text("company", "{{company}}", 6, 36, 44, 8, { size: 6, weight: 700, color: "primary", upper: true, ls: 0.6 }),
        text("name", "{{fullName}}", 6, 52, 58, 12, { font: "heading", size: 13, weight: 700, color: "primary" }),
        text("title", "{{designation}}", 6, 64, 58, 8, { size: 7.5, weight: 600, color: "secondary" }),
        line("rule", 6, 75, 12, 1.5),
        text("mobile", "{{mobile}}", 52, 10, 42, 8, { size: 6.5, align: "right" }),
        text("email", "{{email}}", 52, 20, 42, 8, { size: 6.5, align: "right" }),
        text("web", "{{website}}", 52, 30, 42, 8, { size: 6.5, align: "right", color: "primary", weight: 600 }),
        text("address", "{{address}}", 46, 78, 48, 16, { size: 5.4, align: "right", color: "muted", lh: 1.25 }),
      ]),
      back: null,
    },
  },
  {
    code: "navy-corporate",
    name: "Navy Corporate",
    category: "corporate",
    description: "Navy brand panel with your logo, full contact details, and a branded back.",
    tags: ["corporate", "navy", "logo", "team"],
    featured: true,
    ...L,
    design: {
      version: 1,
      theme: BRAND,
      front: side("background", [
        shape("panel", "rect", 0, 0, 36, 100, { fill: "primary" }),
        image("logo", "logo", 6, 30, 24, 40),
        text("name", "{{fullName}}", 42, 16, 54, 12, { font: "heading", size: 12, weight: 700, color: "primary" }),
        text("title", "{{designation}}", 42, 29, 54, 8, { size: 7, weight: 600, color: "secondary" }),
        text("dept", "{{department}}", 42, 37, 54, 7, { size: 6, color: "muted" }),
        text("mobile", "M  {{mobile}}", 42, 54, 54, 7.5, { size: 6.3 }),
        text("phone", "T  {{phone}}", 42, 62, 54, 7.5, { size: 6.3 }),
        text("email", "E  {{email}}", 42, 70, 54, 7.5, { size: 6.3 }),
        text("address", "{{address}}", 42, 80, 54, 14, { size: 5.2, color: "muted", lh: 1.2 }),
      ]),
      back: side("primary", [
        image("logo-back", "logo", 35, 18, 30, 38),
        text("company", "{{company}}", 8, 60, 84, 10, { font: "heading", size: 10, weight: 700, color: WHITE, align: "center" }),
        text("tagline", "{{tagline}}", 8, 71, 84, 8, { size: 6.5, color: "secondary", align: "center", italic: true }),
        text("web", "{{website}}", 8, 82, 84, 7, { size: 6, color: WHITE, align: "center" }),
      ]),
    },
  },
  {
    code: "sunrise-creative",
    name: "Sunrise Creative",
    category: "creative-colorful",
    description: "A warm orange-to-pink gradient with soft circles for designers, studios and makers.",
    tags: ["gradient", "colourful", "creative"],
    ...L,
    design: {
      version: 1,
      theme: theme("#F97316", "#DB2777", "#FFFFFF", "#FDE7C7", "#F97316"),
      front: side(
        "primary",
        [
          shape("blob1", "ellipse", 62, -28, 56, 100, { fill: WHITE, op: 0.14 }),
          shape("blob2", "ellipse", -12, 62, 32, 56, { fill: WHITE, op: 0.12 }),
          image("logo", "logo", 74, 10, 18, 24),
          text("name", "{{fullName}}", 8, 18, 62, 14, { font: "heading", size: 14, weight: 800 }),
          text("title", "{{designation}}", 8, 33, 62, 8, { size: 7.5, weight: 600, color: "muted" }),
          text("mobile", "{{mobile}}", 8, 60, 60, 8, { size: 6.6 }),
          text("email", "{{email}}", 8, 69, 60, 8, { size: 6.6 }),
          text("web", "{{website}}", 8, 78, 60, 8, { size: 6.6, weight: 700 }),
        ],
        "secondary"
      ),
      back: null,
    },
  },
  {
    code: "onyx-gold",
    name: "Onyx Gold",
    category: "premium-luxury",
    description: "Gold serif lettering on black with a fine frame; a monogram-style back.",
    tags: ["luxury", "gold", "black", "serif"],
    featured: true,
    ...L,
    design: {
      version: 1,
      theme: theme("#C9A227", "#E8D48B", "#F5F0E1", "#B8A77A", "#121212", "Georgia", "Georgia"),
      front: side("background", [
        shape("frame", "rect", 4, 7, 92, 86, { fill: "none", stroke: "primary", sw: 0.3 }),
        text("name", "{{fullName}}", 10, 26, 80, 14, { font: "heading", size: 12.5, weight: 600, color: "primary", align: "center", upper: true, ls: 1.2 }),
        line("rule", 42, 44, 16, 1.5, "primary", 0.35),
        text("title", "{{designation}}", 10, 49, 80, 8, { size: 6.2, color: "muted", align: "center", upper: true, ls: 1.6 }),
        text("mobile", "{{mobile}}", 10, 63, 80, 7, { size: 5.8, align: "center" }),
        text("email", "{{email}}", 10, 71, 80, 7, { size: 5.8, align: "center" }),
        text("web", "{{website}}", 10, 79, 80, 7, { size: 5.8, align: "center", color: "secondary" }),
      ]),
      back: side("background", [
        shape("frame-back", "rect", 4, 7, 92, 86, { fill: "none", stroke: "primary", sw: 0.3 }),
        image("logo", "logo", 37, 22, 26, 34),
        text("company", "{{company}}", 10, 62, 80, 10, { font: "heading", size: 9, color: "primary", align: "center", upper: true, ls: 2 }),
        text("tagline", "{{tagline}}", 10, 73, 80, 7, { size: 5.8, color: "muted", align: "center", italic: true }),
      ]),
    },
  },
  {
    code: "circuit-tech",
    name: "Circuit Tech",
    category: "technology-it",
    description: "Dark navy with cyan accents, monospace contact lines and a vCard QR code.",
    tags: ["tech", "it", "dark", "qr"],
    ...L,
    design: {
      version: 1,
      theme: theme("#22D3EE", "#818CF8", "#E2E8F0", "#94A3B8", "#0B1F3A", "Poppins", "Courier New"),
      front: side("background", [
        shape("bar", "rect", 0, 0, 2.5, 100, { fill: "primary" }),
        line("trace1", 8, 88, 52, 1.5, "primary", 0.35),
        line("trace2", 60, 80, 1.5, 9, "primary", 0.35),
        text("name", "{{fullName}}", 8, 13, 58, 13, { font: "heading", size: 12, weight: 700 }),
        text("title", "{{designation}}", 8, 27, 58, 8, { font: "heading", size: 7, weight: 500, color: "primary" }),
        text("email", "{{email}}", 8, 50, 58, 8, { size: 5.8 }),
        text("mobile", "{{mobile}}", 8, 59, 58, 8, { size: 5.8 }),
        text("web", "{{website}}", 8, 68, 58, 8, { size: 5.8, color: "secondary" }),
        qr("qr", "vcard", 70, 16, 24, 42, { color: "#0B1F3A", bg: WHITE }),
        text("company", "{{company}}", 66, 64, 32, 8, { font: "heading", size: 5.4, color: "muted", align: "center" }),
      ]),
      back: null,
    },
  },
  {
    code: "vertical-clean",
    name: "Vertical Clean",
    category: "vertical",
    description: "Portrait card with a round profile photo under a navy band.",
    tags: ["vertical", "photo", "portrait"],
    ...P,
    design: {
      version: 1,
      theme: BRAND,
      front: side("background", [
        shape("band", "rect", 0, 0, 100, 30, { fill: "primary" }),
        image("logo", "logo", 6, 4, 26, 9),
        image("photo", "photo", 29, 15, 42, 24, { fit: "cover", shape: "circle" }),
        text("name", "{{fullName}}", 6, 43, 88, 7, { font: "heading", size: 10.5, weight: 700, color: "primary", align: "center" }),
        text("title", "{{designation}}", 6, 50.5, 88, 5, { size: 6.8, weight: 600, color: "secondary", align: "center" }),
        line("rule", 40, 58, 20, 1, "secondary", 0.5),
        text("mobile", "{{mobile}}", 6, 63, 88, 5, { size: 6, align: "center" }),
        text("email", "{{email}}", 6, 69, 88, 5, { size: 6, align: "center" }),
        text("web", "{{website}}", 6, 75, 88, 5, { size: 6, align: "center", color: "primary", weight: 600 }),
        text("company", "{{company}}", 6, 86, 88, 5, { size: 5.6, align: "center", color: "muted", upper: true, ls: 0.8 }),
      ]),
      back: null,
    },
  },
  {
    code: "scan-connect",
    name: "Scan & Connect",
    category: "qr-code",
    description: "A large vCard QR code that saves your contact straight to a phone.",
    tags: ["qr", "vcard", "contact"],
    featured: true,
    ...L,
    design: {
      version: 1,
      theme: theme("#092C4C", "#FE9F43", "#1B2850", "#67748E", "#F7F9FC"),
      front: side("background", [
        qr("qr", "vcard", 6, 13, 30, 52),
        text("scan", "Scan to save my contact", 4, 69, 34, 7, { size: 5, color: "muted", align: "center" }),
        line("divider", 41, 13, 1.5, 74, "secondary", 0.4),
        text("name", "{{fullName}}", 46, 13, 50, 12, { font: "heading", size: 11.5, weight: 700, color: "primary" }),
        text("title", "{{designation}}", 46, 26, 50, 8, { size: 7, weight: 600, color: "secondary" }),
        text("company", "{{company}}", 46, 34, 50, 7, { size: 6.2, weight: 700, color: "muted" }),
        text("mobile", "{{mobile}}", 46, 52, 50, 7.5, { size: 6.2 }),
        text("email", "{{email}}", 46, 61, 50, 7.5, { size: 6.2 }),
        text("web", "{{website}}", 46, 70, 50, 7.5, { size: 6.2, color: "primary", weight: 600 }),
      ]),
      back: null,
    },
  },
  {
    code: "duo-split",
    name: "Duo Split",
    category: "double-sided",
    description: "Bold orange front with your logo; the back carries your details and a website QR.",
    tags: ["double-sided", "orange", "logo", "qr"],
    ...L,
    design: {
      version: 1,
      theme: BRAND,
      front: side("secondary", [
        image("logo", "logo", 32, 16, 36, 40),
        text("company", "{{company}}", 8, 62, 84, 10, { font: "heading", size: 10, weight: 700, color: WHITE, align: "center" }),
        text("tagline", "{{tagline}}", 8, 74, 84, 7, { size: 6, color: WHITE, align: "center" }),
      ]),
      back: side("background", [
        shape("accent", "rect", 0, 0, 3.5, 100, { fill: "secondary" }),
        text("name", "{{fullName}}", 9, 14, 60, 12, { font: "heading", size: 12, weight: 700, color: "primary" }),
        text("title", "{{designation}}", 9, 27, 60, 8, { size: 7, weight: 600, color: "secondary" }),
        text("mobile", "{{mobile}}", 9, 50, 60, 7.5, { size: 6.2 }),
        text("email", "{{email}}", 9, 59, 60, 7.5, { size: 6.2 }),
        text("address", "{{address}}", 9, 70, 60, 16, { size: 5.3, color: "muted", lh: 1.2 }),
        qr("qr", "website", 74, 50, 18, 31.4),
        text("web", "{{website}}", 66, 84, 32, 7, { size: 5, color: "primary", align: "center" }),
      ]),
    },
  },
  {
    code: "vertical-bold",
    name: "Vertical Bold",
    category: "vertical",
    description: "Portrait navy front with the logo up top; the back holds a vCard QR code.",
    tags: ["vertical", "navy", "double-sided", "qr"],
    ...P,
    design: {
      version: 1,
      theme: BRAND,
      front: side("primary", [
        image("logo", "logo", 22, 9, 56, 18),
        line("rule", 8, 50, 16, 1, "secondary", 0.6),
        text("name", "{{fullName}}", 8, 54, 84, 7, { font: "heading", size: 10.5, weight: 700, color: WHITE }),
        text("title", "{{designation}}", 8, 61.5, 84, 5, { size: 6.6, weight: 600, color: "secondary" }),
        text("mobile", "{{mobile}}", 8, 73, 84, 5, { size: 5.8, color: "#E2E8F0" }),
        text("email", "{{email}}", 8, 79, 84, 5, { size: 5.8, color: "#E2E8F0" }),
        text("web", "{{website}}", 8, 85, 84, 5, { size: 5.8, color: "#E2E8F0" }),
      ]),
      back: side("background", [
        qr("qr", "vcard", 25, 22, 50, 28.65),
        text("scan", "Scan to connect", 8, 54, 84, 5, { size: 5.8, color: "muted", align: "center" }),
        text("company", "{{company}}", 8, 64, 84, 6, { font: "heading", size: 8, weight: 700, color: "primary", align: "center" }),
        text("web", "{{website}}", 8, 71, 84, 5, { size: 6, color: "secondary", align: "center" }),
      ]),
    },
  },
];

// Base price per card by order size (paise, excluding GST). Admins edit these under Pricing.
const SLABS = [
  { min_qty: 100, max_qty: 249, unit_price_paise: 300, label: "Starter" },
  { min_qty: 250, max_qty: 499, unit_price_paise: 220, label: null },
  { min_qty: 500, max_qty: 999, unit_price_paise: 160, label: "Popular" },
  { min_qty: 1000, max_qty: 2499, unit_price_paise: 120, label: null },
  { min_qty: 2500, max_qty: 4999, unit_price_paise: 95, label: "Team" },
  { min_qty: 5000, max_qty: null, unit_price_paise: 80, label: "Enterprise" },
];

const OPTIONS = [
  ["paper", "paper_300_matte", "Standard 300 gsm matte", "Smooth uncoated board for everyday cards", 0, true],
  ["paper", "paper_350_premium", "Premium 350 gsm", "Thicker, stiffer board with a satin feel", 40, false],
  ["paper", "paper_400_textured", "Textured 400 gsm", "Heavy linen-texture board for a luxury finish", 120, false],
  ["finish", "finish_none", "No lamination", "Natural paper finish", 0, true],
  ["finish", "finish_matte_lam", "Matte lamination", "Soft, glare-free and scuff resistant", 30, false],
  ["finish", "finish_gloss_lam", "Gloss lamination", "Vivid colours with a shiny surface", 30, false],
  ["finish", "finish_velvet", "Soft-touch velvet", "Velvety lamination with a premium feel", 90, false],
  ["finish", "finish_spot_uv", "Spot UV on logo", "Raised gloss highlight over the logo", 150, false],
  ["corners", "corners_square", "Square corners", "Standard straight cut", 0, true],
  ["corners", "corners_rounded", "Rounded corners (3 mm)", "Softened corners that resist dog-ears", 25, false],
];

async function seedVisitingCards(transaction) {
  const categoryId = new Map();
  for (const def of CATEGORIES) {
    let row = await VcTemplateCategory.findOne({ where: { slug: def.slug }, transaction });
    if (!row) row = await VcTemplateCategory.create(def, { transaction });
    categoryId.set(def.slug, row.id);
  }
  let added = 0;
  for (const [i, t] of TEMPLATES.entries()) {
    if (await VcTemplate.findOne({ where: { code: t.code }, paranoid: false, transaction })) continue;
    // Seeded layouts go through the same schema as admin edits.
    const design = designSchema.parse(t.design);
    await VcTemplate.create(
      {
        code: t.code,
        category_id: categoryId.get(t.category),
        name: t.name,
        slug: t.code,
        description: t.description,
        orientation: t.orientation,
        width_mm: t.width_mm,
        height_mm: t.height_mm,
        tags: t.tags,
        design,
        ...derived(design),
        status: "published",
        is_featured: Boolean(t.featured),
        sort_order: (i + 1) * 10,
        published_at: new Date(),
      },
      { transaction }
    );
    added += 1;
  }
  if (!(await VcPriceSlab.count({ transaction }))) await VcPriceSlab.bulkCreate(SLABS, { transaction });
  for (const [i, [group, code, name, description, price, isDefault]] of OPTIONS.entries()) {
    if (await VcPrintOption.findOne({ where: { code }, transaction })) continue;
    const hasDefault = await VcPrintOption.count({ where: { group_code: group, is_default: true }, transaction });
    await VcPrintOption.create({ group_code: group, code, name, description, price_per_card_paise: price, is_default: isDefault && !hasDefault, sort_order: i + 1 }, { transaction });
  }
  return { templates: TEMPLATES.length, added };
}

module.exports = { seedVisitingCards, TEMPLATES, CATEGORIES, SLABS };

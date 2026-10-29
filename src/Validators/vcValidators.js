// Visiting card request schemas, including the card design document:
//   { version: 1, theme, front: Side, back: Side | null }
//   Side    = { background: { color, gradientTo?, gradientAngle? }, elements: Element[] }
//   Element = text | image | qr | shape, positioned in percent of the card (x, y, w, h).
// Text may contain {{field}} placeholders filled from the card details; unknown placeholders
// are rejected so a typo cannot silently print "{{mobil}}" on 500 cards.
const { z, uuid, email, optionalText, rupeesToPaise, gstin } = require("./common");
const { FONTS, CARD_FIELDS, COLOR_TOKENS, FONT_TOKENS, ORDER_STATUSES, PRINT_OPTION_GROUPS } = require("../Config/visitingCards");

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour such as #092C4C");
const color = z.union([hex, z.enum(COLOR_TOKENS)]);
const paint = z.union([color, z.literal("none")]);
const font = z.union([z.enum(FONTS), z.enum(FONT_TOKENS)]);
const pct = (min, max) => z.number().min(min).max(max);
const elementId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "Invalid element id");
const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

// Decorative shapes may hang off the card edge (they are clipped to the bleed when printed).
const base = {
  id: elementId,
  x: pct(-60, 160),
  y: pct(-60, 160),
  w: pct(0.5, 200),
  h: pct(0.5, 200),
  hidden: z.boolean().optional(),
};

const text = z.object({
  ...base,
  type: z.literal("text"),
  content: z
    .string()
    .max(500)
    .refine((v) => v.split("\n").length <= 6, "Use at most 6 lines")
    .refine((v) => [...v.matchAll(PLACEHOLDER)].every((m) => m[1] in CARD_FIELDS), "Unknown field placeholder"),
  fontFamily: font,
  fontSize: z.number().min(3).max(48),
  fontWeight: z.union([300, 400, 500, 600, 700, 800].map((n) => z.literal(n))),
  italic: z.boolean().optional(),
  uppercase: z.boolean().optional(),
  color,
  align: z.enum(["left", "center", "right"]),
  letterSpacing: z.number().min(-2).max(20).optional(),
  lineHeight: z.number().min(0.8).max(3).optional(),
});

const image = z.object({
  ...base,
  type: z.literal("image"),
  source: z.enum(["logo", "photo"]),
  fit: z.enum(["contain", "cover"]),
  shape: z.enum(["rect", "rounded", "circle"]),
});

const qr = z.object({
  ...base,
  type: z.literal("qr"),
  source: z.enum(["vcard", "website", "custom"]),
  value: z.string().trim().max(300).optional(),
  color,
  background: paint,
});

const shape = z.object({
  ...base,
  type: z.literal("shape"),
  shape: z.enum(["rect", "ellipse", "line"]),
  fill: paint,
  stroke: paint,
  strokeWidth: z.number().min(0).max(5),
  radius: z.number().min(0).max(20).optional(),
  opacity: z.number().min(0).max(1).optional(),
});

const element = z.discriminatedUnion("type", [text, image, qr, shape]);

const side = z.object({
  background: z.object({ color, gradientTo: color.nullable().optional(), gradientAngle: z.number().min(0).max(360).optional() }),
  elements: z
    .array(element)
    .max(40, "Use at most 40 elements per side")
    .refine((els) => new Set(els.map((e) => e.id)).size === els.length, "Element ids must be unique"),
});

const design = z.object({
  version: z.literal(1),
  theme: z.object({ primary: hex, secondary: hex, text: hex, muted: hex, background: hex, headingFont: z.enum(FONTS), bodyFont: z.enum(FONTS) }),
  front: side,
  back: side.nullable(),
});

const phoneLike = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[0-9][0-9 ()-]{5,22}[0-9]$/, "Enter a valid phone number")
  .optional()
  .or(z.literal("").transform(() => undefined));

const optionalEmail = email.optional().or(z.literal("").transform(() => undefined));
const optionalStr = (max) => z.string().trim().max(max, `Use at most ${max} characters`).optional();

const fields = z.object({
  fullName: optionalStr(CARD_FIELDS.fullName),
  designation: optionalStr(CARD_FIELDS.designation),
  department: optionalStr(CARD_FIELDS.department),
  company: optionalStr(CARD_FIELDS.company),
  tagline: optionalStr(CARD_FIELDS.tagline),
  mobile: phoneLike,
  phone: phoneLike,
  email: optionalEmail,
  website: optionalStr(CARD_FIELDS.website),
  address: optionalStr(CARD_FIELDS.address).refine((v) => !v || v.split("\n").length <= 4, "Use at most 4 address lines"),
  logoAssetId: uuid.nullable().optional(),
  photoAssetId: uuid.nullable().optional(),
});

// One person on a corporate order. Blank values fall back to the company-wide card details.
const employee = z.object({
  ref: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  employeeCode: optionalStr(40),
  fullName: z.string({ error: "Enter the name" }).trim().min(2, "Enter the name").max(CARD_FIELDS.fullName),
  designation: optionalStr(CARD_FIELDS.designation),
  department: optionalStr(CARD_FIELDS.department),
  mobile: phoneLike,
  phone: phoneLike,
  email: optionalEmail,
  address: optionalStr(CARD_FIELDS.address),
  quantity: z.coerce.number().int("Use a whole number").min(1).max(100000).nullable().optional(),
});

const designSave = z.object({
  name: z.string().trim().min(2, "Name this design").max(120),
  orientation: z.enum(["landscape", "portrait"]),
  design,
  fields,
  employees: z.array(employee).max(2000).default([]),
});

const designCreate = z.object({
  templateId: uuid,
  customerType: z.enum(["individual", "corporate"]),
  name: optionalText(120),
});

const options = z.array(z.string().regex(/^[a-z0-9_]{1,40}$/)).max(5).default([]);

const quote = z.object({
  designId: uuid,
  quantity: z.coerce.number().int("Use a whole number").min(1).max(100000),
  options,
  addressId: uuid.optional().nullable(),
});

const order = quote.extend({
  addressId: uuid,
  billingAddressId: uuid.optional().nullable(),
  gstin: gstin.optional().nullable().or(z.literal("").transform(() => null)),
  note: optionalText(500),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, "Invalid request key"),
});

const artworkUpdate = z.object({ design, fields, employees: z.array(employee).max(2000).default([]) });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional();

const orderList = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.string().trim().max(200).regex(/^[a-z_,]*$/, "Invalid status filter").optional(),
  paymentStatus: z.enum(["unpaid", "paid", "refunded"]).optional(),
  artworkStatus: z.enum(["pending", "submitted", "approved", "rejected"]).optional(),
  customerType: z.enum(["individual", "corporate"]).optional(),
  from: isoDate,
  to: isoDate,
  minQty: z.coerce.number().int().min(0).optional(),
  maxQty: z.coerce.number().int().min(0).optional(),
  companyId: uuid.optional(),
  userId: uuid.optional(),
});

const templateList = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(100).regex(/^[a-z0-9-]*$/).optional(),
  orientation: z.enum(["landscape", "portrait"]).optional(),
  doubleSided: z.enum(["true", "false"]).optional(),
  qr: z.enum(["true", "false"]).optional(),
  status: z.enum(["draft", "published", "unpublished"]).optional(),
});

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .max(140)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens")
  .optional()
  .nullable()
  .or(z.literal("").transform(() => null));

const template = z.object({
  name: z.string().trim().min(2, "Enter a name").max(120),
  slug,
  description: optionalText(500),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  orientation: z.enum(["landscape", "portrait"]),
  widthMm: z.coerce.number().min(40).max(120),
  heightMm: z.coerce.number().min(40).max(120),
  bleedMm: z.coerce.number().min(0).max(10).default(3),
  safeMarginMm: z.coerce.number().min(0).max(10).default(3),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  isFeatured: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
  design,
});

const templateStatus = z.object({ status: z.enum(["published", "unpublished"]) });

const category = z.object({
  name: z.string().trim().min(2, "Enter a name").max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(100)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens")
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  description: optionalText(300),
  icon: z.string().trim().regex(/^ti-[a-z0-9-]{1,36}$/, "Use a Tabler icon name such as ti-briefcase").optional().nullable().or(z.literal("").transform(() => null)),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
});

const artworkDecision = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: optionalText(1000),
});

const statusUpdate = z.object({
  status: z.enum(ORDER_STATUSES),
  note: optionalText(1000),
  courier: optionalText(80),
  trackingNumber: optionalText(80),
  trackingUrl: z.string().trim().url("Enter a full tracking link").max(300).refine((v) => /^https?:\/\//i.test(v), "Use an http(s) link").optional().nullable().or(z.literal("").transform(() => null)),
});

const tracking = z.object({
  courier: z.string().trim().min(2, "Enter the courier").max(80),
  trackingNumber: z.string().trim().min(3, "Enter the tracking number").max(80),
  trackingUrl: statusUpdate.shape.trackingUrl,
});

const cancel = z.object({ reason: z.string().trim().min(3, "Give a reason").max(500), refund: z.boolean().optional() });
const offlinePayment = z.object({ reference: z.string().trim().min(3, "Enter the bank or UTR reference").max(60), note: optionalText(300) });

const slabs = z.object({
  slabs: z
    .array(z.object({ minQty: z.coerce.number().int().min(1).max(1000000), maxQty: z.coerce.number().int().min(1).max(1000000).nullable().optional(), unitPrice: rupeesToPaise, label: optionalText(60) }))
    .min(1, "Add at least one slab")
    .max(20),
});

const printOption = z.object({
  groupCode: z.enum(Object.keys(PRINT_OPTION_GROUPS)),
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,40}$/, "Use lowercase letters, numbers and underscores"),
  name: z.string().trim().min(2, "Enter a name").max(80),
  description: optionalText(300),
  pricePerCard: rupeesToPaise,
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
});

const settings = z.object({
  enabled: z.boolean(),
  allowIndividual: z.boolean(),
  allowCorporate: z.boolean(),
  minOrderQty: z.coerce.number().int().min(1).max(100000),
  minQtyPerCard: z.coerce.number().int().min(1).max(100000),
  maxQtyPerCard: z.coerce.number().int().min(1).max(1000000),
  maxEmployeesPerOrder: z.coerce.number().int().min(1).max(2000),
  doubleSidedPerCard: rupeesToPaise,
  gstRate: z.coerce.number().min(0).max(40),
  hsnCode: z.string().trim().regex(/^\d{4}(\d{2}){0,2}$/, "Use a 4, 6 or 8 digit HSN code"),
  productionDays: z.coerce.number().int().min(0).max(60),
  artworkReviewRequired: z.boolean(),
  shipping: z.object({
    base: rupeesToPaise,
    perBox: rupeesToPaise,
    boxSize: z.coerce.number().int().min(50).max(100000),
    freeAbove: rupeesToPaise,
    gstRate: z.coerce.number().min(0).max(40),
  }),
});

const reportQuery = z.object({ from: isoDate, to: isoDate });

module.exports = {
  design,
  fields,
  employee,
  designSave,
  designCreate,
  quote,
  order,
  artworkUpdate,
  orderList,
  templateList,
  template,
  templateStatus,
  category,
  artworkDecision,
  statusUpdate,
  tracking,
  cancel,
  offlinePayment,
  slabs,
  printOption,
  settings,
  reportQuery,
  PLACEHOLDER,
  idParam: z.object({ id: uuid }),
  intId: z.object({ id: z.coerce.number().int().positive() }),
  listQuery: z.object({ page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), q: z.string().trim().max(120).optional(), status: z.string().trim().max(40).optional() }),
};

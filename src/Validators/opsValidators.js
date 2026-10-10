// Validators for vendor, production, shipping and admin endpoints.
const { z, uuid, phone, gstin, pan, pincode, ifsc, optionalText, listQuery } = require("./common");

const paise = z.coerce.number().int().min(0).max(10_000_000_000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const assetIds = z.array(uuid).max(20).optional().default([]);

const capability = z.object({
  methodCode: z.string().max(40),
  minQty: z.coerce.number().int().min(1),
  maxQty: z.coerce.number().int().min(1),
  dailyCapacity: z.coerce.number().int().min(1),
  leadTimeDays: z.coerce.number().int().min(1).max(60),
  costPerUnitPaise: paise.optional(),
  isActive: z.boolean().optional(),
});
const vendorAddress = z.object({ line1: z.string().trim().min(3).max(200), line2: z.string().max(200).optional().nullable(), city: z.string().trim().min(2).max(80), state: z.string().trim().min(2).max(80), pincode });
const vendorApplication = z.object({
  businessName: z.string().trim().min(2).max(160),
  legalName: z.string().trim().min(2).max(200),
  vendorType: z.enum(["fulfilment_partner", "marketplace_seller", "both"]),
  gstin,
  pan,
  bankAccountName: z.string().trim().min(2).max(160),
  bankAccountNumber: z.string().trim().regex(/^\d{9,18}$/, "Enter a valid account number").optional(),
  bankIfsc: ifsc,
  contactEmail: z.string().trim().email().max(190),
  contactPhone: phone,
  address: vendorAddress,
  servicePincodePrefixes: z.array(z.string().regex(/^\d{1,3}$/)).max(50).optional(),
  machines: optionalText(1000),
  dailyCapacity: z.coerce.number().int().min(1).max(1000000),
  capabilities: z.array(capability).min(1, "Add at least one production capability").max(20),
});
const vendorProfile = vendorApplication.partial().extend({ capabilities: z.array(capability).max(20).optional() });
const holidays = z.object({ holidays: z.array(z.object({ date, note: optionalText(160) })).max(100) });
const staff = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(190), phone });

const listing = z.object({
  categoryId: uuid,
  name: z.string().trim().min(3).max(200),
  shortDescription: z.string().trim().max(300).optional(),
  description: optionalText(5000),
  images: z.array(z.string().max(300)).max(10).optional(),
  pricePaise: paise.refine((v) => v > 0, "Enter a price"),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/, "Enter a 4-8 digit HSN code"),
  gstRate: z.coerce.number().refine((v) => [0, 5, 12, 18, 28].includes(v), "Choose a GST rate"),
  moq: z.coerce.number().int().min(1),
  maxInstantQty: z.coerce.number().int().min(1).optional(),
  leadTimeDays: z.coerce.number().int().min(1).max(60),
  weightGrams: z.coerce.number().int().min(1).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  occasions: z.array(z.string().max(40)).max(10).optional(),
  variants: z
    .array(
      z.object({
        sku: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9-_]+$/, "Letters, numbers and dashes only"),
        attributes: z.record(z.string().max(30), z.string().max(60)),
        stockQty: z.coerce.number().int().min(0).optional(),
        trackInventory: z.boolean().optional(),
        colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
        image: z.string().max(300).optional().nullable(),
      })
    )
    .min(1, "Add at least one variant"),
  methods: z.array(z.object({ code: z.string().max(40), costPerUnitPaise: paise, setupFeePaise: paise.optional(), moq: z.coerce.number().int().min(1).optional() })).max(10).optional(),
});

const jobResponse = z.object({ accept: z.boolean(), reasonCode: z.string().max(20).optional(), note: optionalText(500) }).refine((d) => d.accept || d.reasonCode, { path: ["reasonCode"], message: "Choose a rejection reason" });
const milestone = z.object({ status: z.enum(["accepted", "in_production", "quality_check", "on_hold"]), note: optionalText(1000), photoAssetIds: assetIds });
const qc = z.object({
  result: z.enum(["pass", "fail"]),
  checklist: z.record(z.string().max(60), z.boolean()).default({}),
  defectQty: z.coerce.number().int().min(0).default(0),
  notes: optionalText(1000),
  photoAssetIds: assetIds,
});
const shipment = z.object({
  jobIds: z.array(uuid).max(50).optional().default([]),
  orderItemIds: z.array(uuid).max(50).optional().default([]),
  carrier: z.string().trim().min(2).max(80),
  trackingNumber: z.string().trim().min(4).max(80),
  trackingUrl: z.string().trim().url().max(300).optional().nullable().or(z.literal("")).transform((v) => v || null),
  weightGrams: z.coerce.number().int().min(1).optional(),
  recipientRef: z.string().max(20).optional().nullable(),
});
const tracking = z.object({ status: z.enum(["picked_up", "in_transit", "out_for_delivery", "delivered", "rto"]), location: optionalText(120), description: optionalText(300) });
const jobList = listQuery.extend({ source: z.enum(["in_house", "vendor"]).optional(), vendorId: uuid.optional(), methodCode: z.string().max(40).optional(), atRisk: z.enum(["true", "false"]).transform((v) => v === "true").optional() });

const assign = z.object({
  source: z.enum(["in_house", "vendor"]),
  vendorId: uuid.optional().nullable(),
  dueDate: date.optional().nullable(),
  agreedCostPaise: paise.optional(),
  machine: optionalText(80),
  notes: optionalText(1000),
}).refine((d) => d.source === "in_house" || d.vendorId, { path: ["vendorId"], message: "Choose a vendor" });
const proofCreate = z.object({ orderItemId: uuid, previewAssetId: uuid, printFileAssetId: uuid.optional().nullable(), notes: optionalText(1000) });
const itemTransition = z.object({ to: z.enum(["on_hold", "placed", "payment_pending", "artwork_pending", "proof_sent", "proof_approved", "assigned", "in_production", "quality_check", "packed", "dispatched", "delivered", "closed", "cancelled", "refunded", "rto"]), note: z.string().trim().min(3).max(500) });
const offlinePayment = z.object({ amountPaise: paise.refine((v) => v > 0, "Enter an amount"), reference: z.string().trim().min(3).max(80), note: optionalText(300) });
const refundRequest = z.object({ orderId: uuid, orderItemId: uuid.optional().nullable(), amountPaise: paise.refine((v) => v > 0, "Enter an amount"), reason: z.string().trim().min(3).max(500), ticketId: uuid.optional().nullable() });
const refundDecision = z.object({ approve: z.boolean(), note: optionalText(500) });
const complaintDecision = z.object({ decision: z.enum(["reprint", "replace", "refund", "reject"]), liability: z.enum(["vendor", "courier", "platform", "customer"]), note: optionalText(1000), refundPaise: paise.optional() });
const ticketUpdate = z.object({ status: z.enum(["open", "in_progress", "awaiting_customer", "resolved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), assignedTo: uuid.optional().nullable() });

const category = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(140).optional(),
  parentId: uuid.optional().nullable(),
  description: optionalText(1000),
  image: optionalText(300),
  defaultLeadTimeDays: z.coerce.number().int().min(1).max(60).optional(),
  sortOrder: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
});

const product = z.object({
  categoryId: uuid,
  name: z.string().trim().min(3).max(200),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(220).optional(),
  sourceType: z.enum(["own", "kit", "vendor_listing"]).optional(),
  shortDescription: optionalText(300),
  description: optionalText(10000),
  images: z.array(z.string().max(300)).max(12).default([]),
  baseCostPaise: paise,
  packagingCostPaise: paise.default(0),
  expressUpliftPct: z.coerce.number().min(0).max(100).default(20),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/, "Enter a 4-8 digit HSN code"),
  gstRate: z.coerce.number().refine((v) => [0, 5, 12, 18, 28].includes(v), "Choose a GST rate"),
  moq: z.coerce.number().int().min(1),
  maxInstantQty: z.coerce.number().int().min(1),
  leadTimeDays: z.coerce.number().int().min(1).max(60),
  weightGrams: z.coerce.number().int().min(1),
  specifications: z.record(z.string().max(60), z.string().max(300)).optional(),
  careInstructions: optionalText(1000),
  occasions: z.array(z.string().max(40)).max(10).default([]),
  tags: z.array(z.string().max(40)).max(30).default([]),
  isCustomisable: z.boolean().default(true),
  supportsLivePreview: z.boolean().default(true),
  minDpi: z.coerce.number().int().min(50).max(600).optional(),
  blockBelowDpi: z.coerce.number().int().min(30).max(600).optional(),
  maxTextLines: z.coerce.number().int().min(0).max(10).optional(),
  status: z.enum(["draft", "pending_approval", "active", "inactive", "rejected"]),
  isFeatured: z.boolean().optional(),
  variants: z
    .array(
      z.object({
        id: uuid.optional(),
        sku: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9-_]+$/, "Letters, numbers and dashes only"),
        attributes: z.record(z.string().max(30), z.string().max(60)),
        colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
        image: z.string().max(300).optional().nullable(),
        costAdjustPaise: z.coerce.number().int().default(0),
        trackInventory: z.boolean().optional(),
        stockQty: z.coerce.number().int().min(0).optional(),
        lowStockThreshold: z.coerce.number().int().min(0).optional(),
        isActive: z.boolean().optional(),
      })
    )
    .min(1, "Add at least one variant"),
  printAreas: z
    .array(
      z.object({
        code: z.string().trim().regex(/^[a-z0-9_]+$/).max(40),
        name: z.string().trim().min(2).max(80),
        widthMm: z.coerce.number().min(1).max(2000),
        heightMm: z.coerce.number().min(1).max(2000),
        safeMarginMm: z.coerce.number().min(0).max(50).optional(),
        box: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100), w: z.number().min(1).max(100), h: z.number().min(1).max(100) }),
        allowedMethods: z.array(z.string().max(40)).optional(),
        maxTextChars: z.coerce.number().int().min(1).max(200).optional(),
      })
    )
    .default([]),
  methods: z.array(z.object({ methodId: z.coerce.number().int(), costPerUnitPaise: paise, setupFeePaise: paise.default(0), moq: z.coerce.number().int().min(1).default(1), isDefault: z.boolean().optional() })).default([]),
  priceTiers: z
    .array(z.object({ minQty: z.coerce.number().int().min(1), maxQty: z.coerce.number().int().min(1).optional().nullable(), marginPct: z.coerce.number().min(-50).max(500), checkoutPath: z.enum(["instant", "instant_or_quote", "quote_only"]) }))
    .min(1, "Add at least one price tier"),
  sources: z.array(z.object({ source: z.enum(["in_house", "vendor"]), vendorId: uuid.optional().nullable(), costPaise: paise.optional(), leadTimeDays: z.coerce.number().int().min(1).optional(), isDefault: z.boolean().optional() })).optional(),
  bundleItems: z.array(z.object({ productId: uuid, variantId: uuid.optional().nullable(), quantity: z.coerce.number().int().min(1) })).optional(),
});
const productStatus = z.object({ status: z.enum(["draft", "pending_approval", "active", "inactive", "rejected"]) });
const method = z.object({
  code: z.string().trim().regex(/^[a-z0-9_]+$/).max(40),
  name: z.string().trim().min(2).max(80),
  description: optionalText(500),
  defaultCostPaise: paise,
  defaultSetupPaise: paise,
  defaultMoq: z.coerce.number().int().min(1),
  inHouse: z.boolean(),
  isActive: z.boolean().optional(),
});
const stockAdjust = z.object({ change: z.coerce.number().int().refine((v) => v !== 0, "Enter a non-zero quantity"), reason: z.enum(["purchase", "adjustment", "damage", "return"]), note: optionalText(300) });
const userStatus = z.object({ status: z.enum(["active", "suspended"]) });
const userRoles = z.object({ roles: z.array(z.string().max(40)).min(1) });
const staffCreate = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(190), phone, roles: z.array(z.string().max(40)).min(1) });
const companyTerms = z.object({
  paymentTerms: z.enum(["prepaid", "advance_50", "credit_15", "credit_30"]).optional(),
  creditApproved: z.boolean().optional(),
  creditLimitPaise: paise.optional(),
  approvalLimitPaise: paise.optional(),
  isKeyAccount: z.boolean().optional(),
  preferredVendorId: uuid.optional().nullable(),
  status: z.enum(["active", "suspended"]).optional(),
});
const vendorDecision = z.object({ status: z.enum(["under_review", "approved", "rejected", "suspended"]), reason: optionalText(500), commissionPct: z.coerce.number().min(0).max(60).optional() });
const coupon = z.object({
  code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/),
  description: optionalText(200),
  discountType: z.enum(["percent", "flat"]),
  value: z.coerce.number().positive(),
  minOrderPaise: paise.optional(),
  maxDiscountPaise: paise.optional().nullable(),
  appliesTo: z.enum(["all", "b2c", "b2b"]),
  startsAt: z.string().datetime({ offset: true }).optional().nullable().or(date.optional().nullable()),
  endsAt: z.string().datetime({ offset: true }).optional().nullable().or(date.optional().nullable()),
  usageLimit: z.coerce.number().int().min(1).optional().nullable(),
  perUserLimit: z.coerce.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
});
const rolePermissions = z.object({ permissions: z.array(z.string().max(80)) });
const page = z.object({
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(120).optional(),
  type: z.enum(["page", "policy", "faq", "banner"]),
  title: z.string().trim().min(2).max(200),
  body: z.string().max(50000),
  sortOrder: z.coerce.number().int().optional(),
  isPublished: z.boolean().optional(),
});
const settingValue = z.object({ value: z.record(z.string(), z.any()) });
const settlementGenerate = z.object({ vendorId: uuid });
const settlementStatus = z.object({ status: z.enum(["approved", "paid"]), reference: optionalText(100) });
const reportQuery = z.object({ from: date.optional(), to: date.optional(), format: z.enum(["json", "csv"]).optional() });
const reviewModerate = z.object({ status: z.enum(["approved", "rejected"]) });

module.exports = {
  vendorApplication,
  vendorProfile,
  holidays,
  staff,
  listing,
  jobResponse,
  milestone,
  qc,
  shipment,
  tracking,
  jobList,
  assign,
  proofCreate,
  itemTransition,
  offlinePayment,
  refundRequest,
  refundDecision,
  complaintDecision,
  ticketUpdate,
  category,
  product,
  productStatus,
  method,
  stockAdjust,
  userStatus,
  userRoles,
  staffCreate,
  companyTerms,
  vendorDecision,
  coupon,
  rolePermissions,
  page,
  settingValue,
  settlementGenerate,
  settlementStatus,
  reportQuery,
  reviewModerate,
  listQuery,
  idParam: z.object({ id: uuid }),
  intIdParam: z.object({ id: z.coerce.number().int() }),
  keyParam: z.object({ key: z.string().max(80) }),
};

const { z, uuid, phone, gstin, pincode, optionalText, sizeBreakdown, address, listQuery } = require("./common");

const paise = z.coerce.number().int().min(0).max(10_000_000_000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const assetIds = z.array(uuid).max(20).optional().default([]);

const profile = z.object({ name: z.string().trim().min(2).max(120), phone, marketingOptIn: z.boolean().optional() });
const addressBody = address.extend({ forCompany: z.boolean().optional() });

// Canvas layers are stored as JSON; validate their shape and bounds strictly.
const layer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image"),
    id: z.string().max(40),
    assetId: uuid,
    x: z.number().min(-1).max(2),
    y: z.number().min(-1).max(2),
    width: z.number().min(0.01).max(3),
    height: z.number().min(0.01).max(3),
    rotation: z.number().min(-360).max(360).default(0),
  }),
  z.object({
    type: z.literal("text"),
    id: z.string().max(40),
    text: z.string().max(200),
    font: z.enum(["Nunito", "Poppins", "Georgia", "Courier New", "Arial", "Impact"]),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    size: z.number().min(0.02).max(1),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    x: z.number().min(-1).max(2),
    y: z.number().min(-1).max(2),
    rotation: z.number().min(-360).max(360).default(0),
    width: z.number().min(0).max(3).optional(),
    height: z.number().min(0).max(3).optional(),
  }),
]);
const canvas = z.object({ areas: z.record(z.string().max(40), z.object({ layers: z.array(layer).max(20) })) });

const designVersion = z.object({
  designId: uuid.optional(),
  productId: uuid.optional(),
  variantId: uuid.optional().nullable(),
  methodId: z.coerce.number().int().optional().nullable(),
  name: z.string().trim().max(160).optional(),
  canvas,
  previewAssetId: uuid.optional().nullable(),
  brandTemplate: z.boolean().optional(),
}).refine((d) => d.designId || d.productId, { message: "productId is required for a new design", path: ["productId"] });

const cartItem = z.object({
  productId: uuid,
  variantId: uuid,
  methodId: z.coerce.number().int().optional().nullable(),
  quantity: z.coerce.number().int().min(1).max(100000).default(1),
  sizeBreakdown,
  designVersionId: uuid.optional().nullable(),
  artworkAssetIds: assetIds,
  artworkNotes: optionalText(500),
  printAreaCount: z.coerce.number().int().min(0).max(10).optional(),
  express: z.boolean().optional(),
  giftWrap: z.boolean().optional(),
});
const cartItemUpdate = z.object({ quantity: z.coerce.number().int().min(1).max(100000).optional(), express: z.boolean().optional() });
const coupon = z.object({ code: z.string().trim().max(40).optional().nullable() });
const cartQuery = z.object({ addressId: uuid.optional(), couponCode: z.string().max(40).optional() });

const checkout = z.object({
  addressId: uuid,
  billingAddressId: uuid.optional().nullable(),
  gstin: gstin.optional().or(z.literal("")).transform((v) => v || undefined),
  poNumber: optionalText(60),
  couponCode: z.string().trim().max(40).optional().nullable(),
  deliverBy: date.optional().nullable(),
  notes: optionalText(1000),
  giftOptions: z.object({ giftWrap: z.boolean().optional(), message: z.string().max(300).optional(), hidePrices: z.boolean().optional() }).optional(),
  idempotencyKey: z.string().min(8).max(80),
});

const orderList = listQuery.extend({ scope: z.enum(["mine", "company", "all"]).default("mine") });
const cancel = z.object({ reason: z.string().trim().min(3, "Tell us why you are cancelling").max(500), itemIds: z.array(uuid).optional() });
const approval = z.object({ approve: z.boolean(), comment: optionalText(500) });
const proofDecision = z.object({ comment: optionalText(1000) });
const proofChanges = z.object({ comment: z.string().trim().min(3, "Describe the change you need").max(1000), designVersionId: uuid.optional().nullable() });

const paymentVerify = z.object({ paymentId: uuid, providerOrderId: z.string().max(100), providerPaymentId: z.string().max(100), signature: z.string().max(200) });
const mockComplete = z.object({ outcome: z.enum(["success", "failure"]) });

const quoteItem = z.object({
  productId: uuid,
  variantId: uuid.optional().nullable(),
  methodId: z.coerce.number().int().optional().nullable(),
  quantity: z.coerce.number().int().min(1).max(1000000),
  sizeBreakdown,
  printAreaCount: z.coerce.number().int().min(0).max(10).optional(),
  artworkAssetIds: assetIds,
  designVersionId: uuid.optional().nullable(),
  notes: optionalText(1000),
});
const recipient = z.object({
  ref: z.string().max(20),
  name: z.string().max(120),
  size: z.string().max(10).nullable().optional(),
  phone: z.string().max(20).optional().default(""),
  address: z.string().max(300),
  city: z.string().max(80),
  state: z.string().max(80),
  pincode,
});
const quoteCreate = z.object({
  title: z.string().trim().min(3, "Give your request a title").max(200),
  deadline: date.optional().nullable(),
  budgetPaise: paise.optional().nullable(),
  deliveryLocations: optionalText(1000),
  deliveryPincode: pincode.optional().nullable(),
  notes: optionalText(2000),
  message: optionalText(2000),
  recipients: z.array(recipient).max(5000).optional(),
  items: z.array(quoteItem).min(1, "Add at least one product").max(30),
});
const quoteVersion = z.object({
  validUntil: date.optional(),
  productionDays: z.coerce.number().int().min(1).max(120),
  paymentTerms: z.enum(["prepaid", "advance_50", "credit_15", "credit_30"]),
  shippingPaise: paise.default(0),
  packagingPaise: paise.default(0),
  discountPaise: paise.default(0),
  notes: optionalText(2000),
  items: z
    .array(
      z.object({
        requestItemId: uuid.optional().nullable(),
        productId: uuid,
        variantId: uuid.optional().nullable(),
        methodId: z.coerce.number().int().optional().nullable(),
        description: z.string().trim().min(2).max(300),
        quantity: z.coerce.number().int().min(1),
        sizeBreakdown,
        unitPricePaise: paise,
        setupFeePaise: paise.default(0),
      })
    )
    .min(1),
});
const quoteAccept = z.object({ addressId: uuid, poNumber: optionalText(60), gstin: gstin.optional().or(z.literal("")).transform((v) => v || undefined) });
const quoteComment = z.object({ comment: z.string().trim().min(3).max(1000) });
const quoteReject = z.object({ reason: optionalText(1000) });
const message = z.object({ body: z.string().trim().min(1).max(4000) });
const quoteList = listQuery.extend({ scope: z.enum(["mine", "all"]).default("mine") });

const ticketCreate = z.object({
  orderId: uuid.optional().nullable(),
  orderItemId: uuid.optional().nullable(),
  type: z.enum(["query", "change_request", "complaint", "refund", "cancellation"]),
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(3).max(4000),
  attachmentAssetIds: assetIds,
});
const ticketReply = z.object({ body: z.string().trim().min(1).max(4000), attachmentAssetIds: assetIds, internal: z.boolean().optional() });
const ticketList = listQuery.extend({ scope: z.enum(["mine", "all"]).default("mine"), type: z.string().max(20).optional() });

const review = z.object({ productId: uuid, rating: z.coerce.number().int().min(1).max(5), title: optionalText(160), body: optionalText(2000), photoAssetIds: assetIds });

const companyUpdate = z.object({
  name: z.string().trim().min(2).max(160),
  legal_name: optionalText(200),
  gstin: gstin.optional().nullable().or(z.literal("")).transform((v) => v || null),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "Enter a valid PAN").optional().nullable().or(z.literal("")).transform((v) => v || null),
  industry: optionalText(80),
  company_size: optionalText(40),
  website: optionalText(200),
  billing_email: z.string().trim().email().max(190).optional().nullable(),
  billing_phone: phone.optional().nullable(),
  billing_address: z.object({ line1: z.string().max(200), line2: z.string().max(200).optional().nullable(), city: z.string().max(80), state: z.string().max(80), pincode }).optional(),
  approval_limit_paise: paise.optional(),
});
const teamInvite = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(190), phone, role: z.enum(["admin", "approver", "buyer"]) });
const teamUpdate = z.object({ role: z.enum(["admin", "approver", "buyer"]).optional(), remove: z.boolean().optional() });
const brandKit = z.object({
  name: z.string().trim().min(2).max(120),
  colors: z.array(z.object({ name: z.string().max(40), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).max(20).default([]),
  fonts: z.array(z.string().max(60)).max(10).default([]),
  guidelines: optionalText(4000),
});
const recipientsCsv = z.object({ csv: z.string().min(10).max(2_000_000) });

const uploadQuery = z.object({ kind: z.string().max(30).default("artwork"), companyAsset: z.enum(["true", "false"]).optional(), brandKitId: uuid.optional() });

module.exports = {
  profile,
  addressBody,
  designVersion,
  cartItem,
  cartItemUpdate,
  coupon,
  cartQuery,
  checkout,
  orderList,
  cancel,
  approval,
  proofDecision,
  proofChanges,
  paymentVerify,
  mockComplete,
  quoteCreate,
  quoteVersion,
  quoteAccept,
  quoteComment,
  quoteReject,
  message,
  quoteList,
  ticketCreate,
  ticketReply,
  ticketList,
  review,
  companyUpdate,
  teamInvite,
  teamUpdate,
  brandKit,
  recipientsCsv,
  uploadQuery,
  idParam: z.object({ id: uuid }),
  paise,
  date,
};

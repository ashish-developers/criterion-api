const { z, uuid, pincode } = require("./common");

const rupees = z.coerce.number().min(0).max(10000000).transform((v) => Math.round(v * 100));
const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const productSearch = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(140).optional(),
  method: z.string().trim().max(40).optional(),
  color: z.string().trim().max(40).optional(),
  occasion: z.string().trim().max(60).optional(),
  minPrice: rupees.optional(),
  maxPrice: rupees.optional(),
  moqMax: z.coerce.number().int().min(1).optional(),
  readyWithin: z.coerce.number().int().min(1).max(60).optional(),
  deliverBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  pincode: pincode.optional(),
  source: z.enum(["own", "marketplace"]).optional(),
  featured: bool.optional(),
  sort: z.enum(["relevance", "price_asc", "price_desc", "fastest", "rating", "name"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(12),
});

const priceQuery = z.object({
  quantity: z.coerce.number().int().min(1).max(100000),
  variantId: uuid.optional(),
  methodId: z.coerce.number().int().optional(),
  printAreaCount: z.coerce.number().int().min(0).max(10).default(1),
  express: bool.optional().default(false),
  pincode: pincode.optional(),
});

const deliveryQuery = z.object({ pincode, quantity: z.coerce.number().int().min(1).max(100000).default(1) });

module.exports = { productSearch, priceQuery, deliveryQuery, idParam: z.object({ id: uuid }), slugParam: z.object({ slug: z.string().max(220) }) };

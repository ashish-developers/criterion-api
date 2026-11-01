// Public catalogue reads: categories, product search with typo tolerance, product detail.
const { Op } = require("sequelize");
const {
  sequelize,
  Category,
  Product,
  ProductVariant,
  ProductMethod,
  DecorationMethod,
  PriceTier,
  PrintArea,
  BundleItem,
  Vendor,
} = require("../Models");
const ApiError = require("../Utils/ApiError");
const pricingService = require("./pricingService");
const shippingEstimator = require("./shippingEstimator");

const PRODUCT_INCLUDES = [
  // The parent too, so storefront links can use the category hierarchy (/products/<parent>/<child>).
  { model: Category, as: "category", attributes: ["id", "name", "slug", "parent_id"], include: [{ model: Category, as: "parent", attributes: ["name", "slug"] }] },
  { model: ProductVariant, as: "variants" },
  { model: ProductMethod, as: "methods", include: [{ model: DecorationMethod, as: "method" }] },
  { model: PriceTier, as: "priceTiers" },
  { model: PrintArea, as: "printAreas" },
];

async function categoryTree() {
  const [rows] = await sequelize.query(
    `SELECT c.id, c.parent_id, c.name, c.slug, c.description, c.image, c.default_lead_time_days, c.sort_order,
            (SELECT count(*)::int FROM products p
               WHERE p.deleted_at IS NULL AND p.status = 'active'
                 AND (p.category_id = c.id OR p.category_id IN (SELECT id FROM categories WHERE parent_id = c.id))) AS product_count
       FROM categories c WHERE c.is_active ORDER BY c.sort_order, c.name`
  );
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const row of byId.values()) {
    if (row.parent_id && byId.has(row.parent_id)) byId.get(row.parent_id).children.push(row);
    else roots.push(row);
  }
  return roots;
}

async function categoryBySlug(slug) {
  const category = await Category.findOne({ where: { slug, is_active: true }, include: [{ model: Category, as: "children", where: { is_active: true }, required: false }] });
  if (!category) throw ApiError.notFound("Category not found");
  return category;
}

function summarise(p) {
  const colors = [...new Map(p.variants.filter((v) => v.attributes?.color).map((v) => [v.attributes.color, v.color_hex])).entries()];
  const totalStock = p.variants.reduce((s, v) => s + (v.track_inventory ? v.stock_qty : 0), 0);
  const tracksStock = p.variants.some((v) => v.track_inventory);
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    shortDescription: p.short_description,
    image: (p.images || [])[0] || null,
    category: p.category ? { name: p.category.name, slug: p.category.slug, parent: p.category.parent ? { name: p.category.parent.name, slug: p.category.parent.slug } : null } : null,
    sourceType: p.source_type,
    moq: p.moq,
    leadTimeDays: p.lead_time_days,
    isCustomisable: p.is_customisable,
    isFeatured: p.is_featured,
    methods: p.methods.map((m) => ({ id: m.method_id, code: m.method?.code, name: m.method?.name })),
    colors: colors.map(([name, hex]) => ({ name, hex })),
    startingPricePaise: pricingService.startingPrice(p),
    ratingAvg: Number(p.rating_avg),
    ratingCount: p.rating_count,
    availability: !tracksStock ? "made_to_order" : totalStock <= 0 ? "out_of_stock" : totalStock < 20 ? "low_stock" : "in_stock",
    occasions: p.occasions,
  };
}

/**
 * Search and filter (FR-CS-02). Text search combines full-text ranking with trigram
 * similarity so small typos ("tshrt", "notbook") still match.
 */
async function searchProducts(query) {
  const where = { status: "active" };
  const and = [];
  const replacements = {};
  let rankOrder = null;

  if (query.q) {
    replacements.q = query.q;
    and.push(
      sequelize.literal(
        `("Product"."search_vector" @@ websearch_to_tsquery('english', :q)
          OR similarity("Product"."name", :q) > 0.2
          OR word_similarity(:q, "Product"."name") > 0.45
          OR "Product"."name" ILIKE '%' || :q || '%'
          OR EXISTS (SELECT 1 FROM unnest("Product"."tags") t WHERE similarity(t, :q) > 0.35))`
      )
    );
    rankOrder = sequelize.literal(
      `(ts_rank("Product"."search_vector", websearch_to_tsquery('english', :q)) + similarity("Product"."name", :q)) DESC`
    );
  }
  if (query.category) {
    const category = await Category.findOne({ where: { slug: query.category } });
    if (!category) return { items: [], total: 0, facets: await facets() };
    const children = await Category.findAll({ where: { parent_id: category.id }, attributes: ["id"] });
    where.category_id = { [Op.in]: [category.id, ...children.map((c) => c.id)] };
  }
  if (query.occasion) and.push({ occasions: { [Op.contains]: [query.occasion] } });
  if (query.moqMax) and.push({ moq: { [Op.lte]: query.moqMax } });
  if (query.readyWithin) and.push({ lead_time_days: { [Op.lte]: query.readyWithin } });
  if (query.source === "own") and.push({ source_type: { [Op.in]: ["own", "kit"] } });
  if (query.source === "marketplace") and.push({ source_type: "vendor_listing" });
  if (query.featured) where.is_featured = true;
  if (query.method) {
    replacements.method = query.method;
    and.push(
      sequelize.literal(
        `EXISTS (SELECT 1 FROM product_methods pm JOIN decoration_methods dm ON dm.id = pm.method_id
                  WHERE pm.product_id = "Product"."id" AND dm.code = :method)`
      )
    );
  }
  if (query.color) {
    replacements.color = query.color.toLowerCase();
    and.push(
      sequelize.literal(
        `EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = "Product"."id" AND pv.is_active AND lower(pv.attributes->>'color') = :color)`
      )
    );
  }
  if (and.length) where[Op.and] = and;

  // The catalogue is small (tens to hundreds of SKUs) so price filtering/sorting on the
  // computed starting price happens after the database filter.
  const products = await Product.findAll({
    where,
    include: PRODUCT_INCLUDES,
    replacements,
    order: rankOrder ? [rankOrder] : [["is_featured", "DESC"], ["created_at", "DESC"]],
  });

  let items = products.map(summarise);

  // Deliver-by filter needs a destination; without a PIN code assume national transit.
  if (query.deliverBy) {
    const target = new Date(query.deliverBy);
    const transit = query.pincode ? null : 5;
    const kept = [];
    for (const item of items) {
      let estimate;
      if (query.pincode) {
        const quote = await shippingEstimator.quote({ pincode: query.pincode, productionDays: item.leadTimeDays });
        if (!quote.serviceable) continue;
        estimate = new Date(quote.estimatedDelivery);
      } else {
        estimate = shippingEstimator.addWorkingDays(new Date(), item.leadTimeDays + transit);
      }
      if (estimate <= target) kept.push(item);
    }
    items = kept;
  }
  if (query.minPrice !== undefined) items = items.filter((i) => i.startingPricePaise !== null && i.startingPricePaise >= query.minPrice);
  if (query.maxPrice !== undefined) items = items.filter((i) => i.startingPricePaise !== null && i.startingPricePaise <= query.maxPrice);

  const sorters = {
    price_asc: (a, b) => (a.startingPricePaise ?? Infinity) - (b.startingPricePaise ?? Infinity),
    price_desc: (a, b) => (b.startingPricePaise ?? -1) - (a.startingPricePaise ?? -1),
    fastest: (a, b) => a.leadTimeDays - b.leadTimeDays,
    rating: (a, b) => b.ratingAvg - a.ratingAvg,
    name: (a, b) => a.name.localeCompare(b.name),
  };
  if (sorters[query.sort]) items.sort(sorters[query.sort]);

  const total = items.length;
  const start = (query.page - 1) * query.limit;
  return { items: items.slice(start, start + query.limit), total, facets: await facets() };
}

let facetCache = null;
let facetCachedAt = 0;
async function facets() {
  if (facetCache && Date.now() - facetCachedAt < 60_000) return facetCache;
  const [methods] = await sequelize.query(
    `SELECT DISTINCT dm.code, dm.name FROM decoration_methods dm JOIN product_methods pm ON pm.method_id = dm.id
       JOIN products p ON p.id = pm.product_id WHERE p.status = 'active' AND p.deleted_at IS NULL ORDER BY dm.name`
  );
  const [colors] = await sequelize.query(
    `SELECT DISTINCT pv.attributes->>'color' AS name, pv.color_hex AS hex FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
      WHERE p.status = 'active' AND p.deleted_at IS NULL AND pv.is_active AND pv.attributes ? 'color' ORDER BY 1`
  );
  const [occasions] = await sequelize.query(
    `SELECT DISTINCT unnest(occasions) AS name FROM products WHERE status = 'active' AND deleted_at IS NULL ORDER BY 1`
  );
  facetCache = {
    methods,
    colors: [...new Map(colors.map((c) => [c.name.toLowerCase(), c])).values()],
    occasions: occasions.map((o) => o.name),
  };
  facetCachedAt = Date.now();
  return facetCache;
}

async function productDetail(slug, { includeInactive = false } = {}) {
  const where = includeInactive ? { slug } : { slug, status: "active" };
  const p = await Product.findOne({
    where,
    include: [
      ...PRODUCT_INCLUDES,
      { model: Vendor, as: "vendor", attributes: ["id", "business_name"] },
      { model: BundleItem, as: "bundleItems", include: [{ model: Product, as: "component", attributes: ["id", "name", "slug", "images"] }] },
    ],
  });
  if (!p) throw ApiError.notFound("Product not found");
  const defaultMethod = p.methods.find((m) => m.is_default) || p.methods[0];
  return {
    ...summarise(p),
    description: p.description,
    images: p.images,
    hsnCode: p.hsn_code,
    gstRate: Number(p.gst_rate),
    maxInstantQty: p.max_instant_qty,
    weightGrams: p.weight_grams,
    dimensions: p.dimensions,
    specifications: p.specifications,
    careInstructions: p.care_instructions,
    supportsLivePreview: p.supports_live_preview,
    minDpi: p.min_dpi,
    blockBelowDpi: p.block_below_dpi,
    allowedFileTypes: p.allowed_file_types,
    maxTextLines: p.max_text_lines,
    expressUpliftPct: Number(p.express_uplift_pct),
    status: p.status,
    soldBy: p.vendor ? p.vendor.business_name : null,
    variants: p.variants
      .filter((v) => v.is_active)
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        attributes: v.attributes,
        colorHex: v.color_hex,
        image: v.image,
        inStock: !v.track_inventory || v.stock_qty > 0,
        stockQty: v.track_inventory ? v.stock_qty : null,
      })),
    methods: p.methods.map((m) => ({
      id: m.method_id,
      code: m.method?.code,
      name: m.method?.name,
      description: m.method?.description,
      moq: m.moq,
      setupFeePaise: m.setup_fee_paise,
      isDefault: m.is_default,
    })),
    printAreas: p.printAreas
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        widthMm: Number(a.width_mm),
        heightMm: Number(a.height_mm),
        safeMarginMm: Number(a.safe_margin_mm),
        box: a.box,
        allowedMethods: a.allowed_methods,
        maxTextChars: a.max_text_chars,
      })),
    tierTable: pricingService.tierTable(p, { methodId: defaultMethod?.method_id }),
    kitComponents: (p.bundleItems || []).map((b) => ({ quantity: b.quantity, product: b.component })),
  };
}

async function priceQuote(productId, input) {
  const p = await pricingService.loadProduct(productId);
  if (p.status !== "active") throw ApiError.notFound("Product not found");
  const line = pricingService.priceLine(p, { ...input, enforceCheckout: false });
  let delivery = null;
  if (input.pincode) {
    delivery = await shippingEstimator.quote({
      pincode: input.pincode,
      weightGrams: p.weight_grams * input.quantity,
      subtotalPaise: line.lineSubtotalPaise,
      productionDays: line.leadTimeDays,
    });
  }
  const { variant, ...rest } = line;
  return { ...rest, variantId: variant.id, sku: variant.sku, delivery };
}

async function deliveryEstimate(productId, { pincode, quantity = 1 }) {
  const p = await Product.findByPk(productId);
  if (!p || p.status !== "active") throw ApiError.notFound("Product not found");
  return shippingEstimator.quote({ pincode, weightGrams: p.weight_grams * quantity, productionDays: p.lead_time_days });
}

async function methods() {
  return DecorationMethod.findAll({ where: { is_active: true }, order: [["name", "ASC"]] });
}

module.exports = { categoryTree, categoryBySlug, searchProducts, productDetail, priceQuote, deliveryEstimate, methods, summarise, PRODUCT_INCLUDES };

// Loads catalogue data and prices a line with the pure pricing engine.
// The server is the only source of truth for prices: carts, orders and quotes all call this.
const { Product, ProductVariant, ProductMethod, DecorationMethod, PriceTier, PrintArea } = require("../Models");
const ApiError = require("../Utils/ApiError");
const engine = require("./pricingEngine");

async function loadProduct(productId, { transaction } = {}) {
  const product = await Product.findByPk(productId, {
    include: [
      { model: ProductVariant, as: "variants" },
      { model: ProductMethod, as: "methods", include: [{ model: DecorationMethod, as: "method" }] },
      { model: PriceTier, as: "priceTiers" },
      { model: PrintArea, as: "printAreas" },
    ],
    transaction,
  });
  if (!product) throw ApiError.notFound("Product not found");
  return product;
}

/**
 * Price one line. Throws on invalid combinations (inactive product, MOQ, unknown method).
 * @param {object} p  product instance with variants/methods/priceTiers loaded (see loadProduct)
 */
function priceLine(p, { variantId, methodId, quantity, tierQuantity, printAreaCount = 0, express = false, enforceCheckout = true }) {
  // Lines of a size breakdown share one design: tier, MOQ and setup use the group total.
  const groupQty = Math.max(quantity, tierQuantity || quantity);
  const variant = variantId ? p.variants.find((v) => v.id === variantId) : p.variants.find((v) => v.is_active);
  if (!variant || !variant.is_active) throw ApiError.unprocessable("Choose an available option for this product", "VARIANT_UNAVAILABLE");

  let productMethod = null;
  if (p.is_customisable && printAreaCount > 0) {
    productMethod = methodId
      ? p.methods.find((m) => m.method_id === Number(methodId))
      : p.methods.find((m) => m.is_default) || p.methods[0];
    if (!productMethod) throw ApiError.unprocessable("This decoration method is not available for the product", "METHOD_UNAVAILABLE");
  }
  const areas = productMethod ? Math.max(1, Math.min(printAreaCount, p.printAreas.length || 1)) : 0;
  const moq = Math.max(p.moq, productMethod ? productMethod.moq : 1);
  if (groupQty < moq) {
    throw ApiError.unprocessable(`Minimum order quantity is ${moq} for this product${productMethod ? " and method" : ""}`, "BELOW_MOQ", { moq });
  }

  const tier = engine.selectTier(p.priceTiers, groupQty);
  const checkoutPath = groupQty > p.max_instant_qty ? "quote_only" : tier.checkout_path;
  if (enforceCheckout && checkoutPath === "quote_only") {
    throw ApiError.unprocessable(
      `Orders of ${groupQty} units need a quotation. Request a quote and our team will price it within one business day.`,
      "QUOTE_REQUIRED",
      { maxInstantQty: p.max_instant_qty }
    );
  }

  const baseCost = p.base_cost_paise + variant.cost_adjust_paise;
  const decorationCost = productMethod ? productMethod.cost_per_unit_paise * areas : 0;
  const setupFee = productMethod ? productMethod.setup_fee_paise * areas : 0;
  const expressPct = express ? Number(p.express_uplift_pct) : 0;
  const price = engine.unitPrice({
    baseCost,
    decorationCost,
    packagingCost: p.packaging_cost_paise,
    marginPct: Number(tier.margin_pct),
    setupFee,
    quantity: groupQty,
    expressPct,
  });

  return {
    variant,
    methodId: productMethod ? productMethod.method_id : null,
    methodName: productMethod?.method?.name || null,
    printAreaCount: areas,
    quantity,
    moq,
    tier: { minQty: tier.min_qty, maxQty: tier.max_qty, marginPct: Number(tier.margin_pct) },
    checkoutPath,
    unitPricePaise: price.unitPrice,
    setupFeePaise: Math.round((setupFee * quantity) / groupQty),
    lineSubtotalPaise: price.unitPrice * quantity,
    unitCostPaise: Math.round(baseCost + decorationCost + p.packaging_cost_paise + setupFee / groupQty),
    gstRate: Number(p.gst_rate),
    hsnCode: p.hsn_code,
    express,
    leadTimeDays: express ? Math.max(1, Math.ceil(p.lead_time_days / 2)) : p.lead_time_days,
  };
}

// Tier table for the product page: unit price at each tier's minimum quantity (FR-CS-03).
function tierTable(p, { methodId, printAreaCount = 1 } = {}) {
  const tiers = (p.priceTiers.length ? p.priceTiers : engine.DEFAULT_TIERS).slice().sort((a, b) => a.min_qty - b.min_qty);
  return tiers.map((tier) => {
    const quantity = Math.max(tier.min_qty, p.moq);
    let unit = null;
    try {
      unit = priceLine(p, { methodId, quantity, printAreaCount: p.is_customisable ? printAreaCount : 0, enforceCheckout: false }).unitPricePaise;
    } catch {
      unit = null;
    }
    return {
      minQty: tier.min_qty,
      maxQty: tier.max_qty,
      unitPricePaise: unit,
      checkoutPath: quantity > p.max_instant_qty ? "quote_only" : tier.checkout_path,
    };
  });
}

// Lowest per-unit price a buyer can see (MOQ, best tier, one print area) - used on listing cards.
function startingPrice(p) {
  try {
    const customised = p.is_customisable && p.methods.length > 0;
    const method = customised ? p.methods.find((m) => m.is_default) || p.methods[0] : null;
    const quantity = Math.max(1, p.moq, method ? method.moq : 1);
    return priceLine(p, { quantity, methodId: method?.method_id, printAreaCount: customised ? 1 : 0, enforceCheckout: false }).unitPricePaise;
  } catch {
    return null;
  }
}

module.exports = { loadProduct, priceLine, tierTable, startingPrice };

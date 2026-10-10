// Cart with multiple customised items, each with its own design (FR-CS-04).
// Prices are always recomputed on the server from the catalogue; nothing price-related
// is accepted from the browser.
const crypto = require("crypto");
const { sequelize, Cart, CartItem, Product, ProductVariant, Address } = require("../Models");
const ApiError = require("../Utils/ApiError");
const pricingService = require("./pricingService");
const designService = require("./designService");
const assetService = require("./assetService");
const totalsService = require("./totalsService");

async function cartFor(userId, transaction) {
  const [cart] = await Cart.findOrCreate({ where: { user_id: userId }, defaults: { user_id: userId }, transaction });
  return cart;
}

// Prices all lines; lines that are no longer valid are returned with an error instead of a price.
async function priceItems(items, { transaction } = {}) {
  const groupTotals = new Map();
  for (const item of items) {
    const group = item.options?.groupId;
    if (group) groupTotals.set(group, (groupTotals.get(group) || 0) + item.quantity);
  }
  const products = new Map();
  const priced = [];
  for (const item of items) {
    if (!products.has(item.product_id)) products.set(item.product_id, await pricingService.loadProduct(item.product_id, { transaction }));
    const product = products.get(item.product_id);
    const base = {
      id: item.id,
      productId: product.id,
      productName: product.name,
      productSlug: product.slug,
      image: null,
      variantId: item.variant_id,
      quantity: item.quantity,
      sizeBreakdown: item.size_breakdown,
      designVersionId: item.design_version_id,
      options: item.options || {},
      express: item.express,
      groupId: item.options?.groupId || null,
    };
    try {
      if (product.status !== "active") throw ApiError.unprocessable("This product is no longer available", "PRODUCT_UNAVAILABLE");
      // Price first: quantities that need a quote are reported as such regardless of stock.
      const line = pricingService.priceLine(product, {
        variantId: item.variant_id,
        methodId: item.method_id,
        quantity: item.quantity,
        tierQuantity: groupTotals.get(item.options?.groupId),
        printAreaCount: item.print_area_count,
        express: item.express,
      });
      const variant = line.variant;
      if (variant.track_inventory && variant.stock_qty < item.quantity) {
        throw ApiError.unprocessable(`Only ${variant.stock_qty} left in stock for this option`, "OUT_OF_STOCK", { available: variant.stock_qty });
      }
      priced.push({
        ...base,
        image: line.variant.image || (product.images || [])[0],
        sku: line.variant.sku,
        attributes: line.variant.attributes,
        methodId: line.methodId,
        methodName: line.methodName,
        printAreaCount: line.printAreaCount,
        unitPricePaise: line.unitPricePaise,
        setupFeePaise: line.setupFeePaise,
        lineSubtotalPaise: line.lineSubtotalPaise,
        unitCostPaise: line.unitCostPaise,
        gstRate: line.gstRate,
        hsnCode: line.hsnCode,
        tier: line.tier,
        moq: line.moq,
        leadTimeDays: line.leadTimeDays,
        weightGrams: product.weight_grams * item.quantity,
        requiresProof: line.printAreaCount > 0 || Boolean(item.options?.artworkAssetIds?.length),
        supportsLivePreview: product.supports_live_preview,
        error: null,
      });
    } catch (error) {
      priced.push({ ...base, error: { message: error.message, code: error.code || "INVALID", details: error.details } });
    }
  }
  return priced;
}

async function view(auth, { addressId, couponCode } = {}) {
  const cart = await cartFor(auth.user.id);
  const items = await CartItem.findAll({ where: { cart_id: cart.id }, order: [["created_at", "ASC"]] });
  const priced = await priceItems(items);
  for (const line of priced) {
    if (line.designVersionId) {
      const version = await designService.usableVersion(auth, line.designVersionId).catch(() => null);
      line.designPreviewUrl = version?.preview_asset_id ? `/api/v1/assets/${version.preview_asset_id}` : null;
    }
  }
  const valid = priced.filter((l) => !l.error);
  let address = null;
  if (addressId) {
    address = await Address.findByPk(addressId);
    const owns = address && (address.user_id === auth.user.id || (auth.companyId && address.company_id === auth.companyId));
    if (!owns) address = null;
  }
  let coupon = null;
  let couponError = null;
  const code = couponCode !== undefined ? couponCode : cart.coupon_code;
  if (code) {
    try {
      coupon = await totalsService.validateCoupon(code, {
        userId: auth.user.id,
        isB2B: Boolean(auth.companyId),
        subtotalPaise: valid.reduce((s, l) => s + l.lineSubtotalPaise, 0),
      });
    } catch (error) {
      couponError = error.message;
    }
  }
  const totals = await totalsService.compute(valid, { coupon, address });
  return { items: priced, totals: { ...totals, lines: undefined }, couponCode: code || null, couponError, hasErrors: priced.some((l) => l.error) };
}

async function addItem(auth, input) {
  return sequelize.transaction(async (transaction) => {
    const cart = await cartFor(auth.user.id, transaction);
    const product = await Product.findOne({ where: { id: input.productId, status: "active" }, transaction });
    if (!product) throw ApiError.notFound("Product not found");

    let printAreaCount = 0;
    let methodId = input.methodId || null;
    if (input.designVersionId) {
      const version = await designService.usableVersion(auth, input.designVersionId, product.id, { transaction });
      printAreaCount = designService.presentVersion(version).printAreaCount;
      methodId = methodId || version.method_id;
    } else if (input.artworkAssetIds?.length) {
      await assetService.assertUsable(auth, input.artworkAssetIds);
      printAreaCount = Math.max(1, input.printAreaCount || 1);
    }

    // A size breakdown becomes one line per size variant sharing a group id.
    let lines;
    if (input.sizeBreakdown && Object.keys(input.sizeBreakdown).length) {
      const variants = await ProductVariant.findAll({ where: { product_id: product.id, is_active: true }, transaction });
      const base = variants.find((v) => v.id === input.variantId);
      if (!base) throw ApiError.unprocessable("Choose a colour", "VARIANT_INVALID");
      const groupId = crypto.randomUUID();
      lines = Object.entries(input.sizeBreakdown)
        .filter(([, qty]) => qty > 0)
        .map(([size, qty]) => {
          const variant = variants.find((v) => v.attributes.color === base.attributes.color && v.attributes.size === size);
          if (!variant) throw ApiError.unprocessable(`Size ${size} is not available in ${base.attributes.color}`, "VARIANT_INVALID");
          return { variantId: variant.id, quantity: qty, groupId };
        });
      if (!lines.length) throw ApiError.unprocessable("Enter a quantity for at least one size", "QUANTITY_REQUIRED");
    } else {
      lines = [{ variantId: input.variantId, quantity: input.quantity, groupId: null }];
    }

    const created = [];
    for (const line of lines) {
      created.push(
        await CartItem.create(
          {
            cart_id: cart.id,
            product_id: product.id,
            variant_id: line.variantId,
            method_id: printAreaCount ? methodId : null,
            design_version_id: input.designVersionId || null,
            quantity: line.quantity,
            size_breakdown: input.sizeBreakdown || null,
            print_area_count: printAreaCount,
            express: Boolean(input.express),
            options: {
              groupId: line.groupId,
              artworkAssetIds: input.artworkAssetIds || [],
              artworkNotes: input.artworkNotes || null,
              giftWrap: Boolean(input.giftWrap),
            },
          },
          { transaction }
        )
      );
    }
    // Validate pricing now so the customer learns about MOQ / quote limits immediately.
    const priced = await priceItems(created, { transaction });
    const failed = priced.find((l) => l.error);
    if (failed) throw ApiError.unprocessable(failed.error.message, failed.error.code, failed.error.details);
    return priced;
  });
}

async function findItem(auth, itemId) {
  const cart = await cartFor(auth.user.id);
  const item = await CartItem.findOne({ where: { id: itemId, cart_id: cart.id } });
  if (!item) throw ApiError.notFound("Cart item not found");
  return item;
}

async function updateItem(auth, itemId, { quantity, express }) {
  const item = await findItem(auth, itemId);
  const before = { quantity: item.quantity, express: item.express };
  await item.update({ quantity: quantity ?? item.quantity, express: express ?? item.express });
  const [priced] = await priceItems([item]);
  if (priced.error && ["BELOW_MOQ", "QUOTE_REQUIRED", "OUT_OF_STOCK"].includes(priced.error.code)) {
    await item.update(before);
    throw ApiError.unprocessable(priced.error.message, priced.error.code, priced.error.details);
  }
  return priced;
}

async function removeItem(auth, itemId) {
  const item = await findItem(auth, itemId);
  await item.destroy();
}

async function setCoupon(auth, code) {
  const cart = await cartFor(auth.user.id);
  if (code) {
    const current = await view(auth, { couponCode: code });
    if (current.couponError) throw ApiError.unprocessable(current.couponError, "COUPON_INVALID");
  }
  await cart.update({ coupon_code: code || null });
  return view(auth);
}

async function clear(userId, transaction) {
  const cart = await Cart.findOne({ where: { user_id: userId }, transaction });
  if (cart) {
    await CartItem.destroy({ where: { cart_id: cart.id }, transaction });
    await cart.update({ coupon_code: null }, { transaction });
  }
}

async function count(userId) {
  const cart = await Cart.findOne({ where: { user_id: userId } });
  if (!cart) return 0;
  return CartItem.count({ where: { cart_id: cart.id } });
}

module.exports = { view, addItem, updateItem, removeItem, setCoupon, clear, priceItems, cartFor, count };

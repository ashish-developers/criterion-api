// Pure pricing and tax functions (Section 7.2 / 7.3). No database access here so the
// rules are unit-testable; pricingService loads product data and calls these.
//
//   P_unit = [ (C_base + C_decoration + C_packaging) × (1 + m) + F_setup / q ] × (1 + u_express)
//
// All money is integer paise. Rates are percentages (18 = 18%).

const DEFAULT_TIERS = [
  { min_qty: 1, max_qty: 9, margin_pct: 60, checkout_path: "instant" },
  { min_qty: 10, max_qty: 49, margin_pct: 50, checkout_path: "instant" },
  { min_qty: 50, max_qty: 99, margin_pct: 42, checkout_path: "instant" },
  { min_qty: 100, max_qty: 499, margin_pct: 35, checkout_path: "instant_or_quote" },
  { min_qty: 500, max_qty: null, margin_pct: 28, checkout_path: "quote_only" },
];

function selectTier(tiers, quantity) {
  const list = (tiers && tiers.length ? tiers : DEFAULT_TIERS)
    .map((t) => ({ ...t, min_qty: Number(t.min_qty), max_qty: t.max_qty === null ? null : Number(t.max_qty), margin_pct: Number(t.margin_pct) }))
    .sort((a, b) => a.min_qty - b.min_qty);
  let selected = list[0];
  for (const tier of list) {
    if (quantity >= tier.min_qty && (tier.max_qty === null || quantity <= tier.max_qty)) return tier;
    if (quantity >= tier.min_qty) selected = tier;
  }
  return selected;
}

/**
 * @returns {{unitPrice:number, setupPerUnit:number, setupTotal:number, marginPct:number}}
 */
function unitPrice({ baseCost, decorationCost = 0, packagingCost = 0, marginPct, setupFee = 0, quantity, expressPct = 0 }) {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("quantity must be a positive integer");
  const marked = (baseCost + decorationCost + packagingCost) * (1 + marginPct / 100);
  const amortisedSetup = setupFee / quantity;
  const unit = (marked + amortisedSetup) * (1 + expressPct / 100);
  return {
    unitPrice: Math.round(unit),
    setupPerUnit: Math.round(amortisedSetup * (1 + expressPct / 100)),
    setupTotal: setupFee,
    marginPct,
  };
}

function round(value) {
  return Math.round(value);
}

// GST on a taxable value. Intra-state supply splits into CGST + SGST; inter-state is IGST.
function gst(taxablePaise, ratePct, interstate) {
  const total = round((taxablePaise * ratePct) / 100);
  if (interstate) return { cgst: 0, sgst: 0, igst: total, total };
  const cgst = Math.floor(total / 2);
  return { cgst, sgst: total - cgst, igst: 0, total };
}

// Spread a whole-order discount across lines in proportion to their value.
// The last line absorbs rounding so the parts always sum to the discount.
function allocateDiscount(lineValues, discount) {
  const total = lineValues.reduce((s, v) => s + v, 0);
  if (!discount || !total) return lineValues.map(() => 0);
  let remaining = discount;
  return lineValues.map((value, index) => {
    if (index === lineValues.length - 1) return remaining;
    const share = Math.floor((discount * value) / total);
    remaining -= share;
    return share;
  });
}

function couponDiscount(coupon, subtotalPaise) {
  if (!coupon) return 0;
  if (subtotalPaise < Number(coupon.min_order_paise || 0)) return 0;
  let discount =
    coupon.discount_type === "percent"
      ? Math.floor((subtotalPaise * Number(coupon.value)) / 100)
      : Math.round(Number(coupon.value) * 100);
  if (coupon.max_discount_paise) discount = Math.min(discount, Number(coupon.max_discount_paise));
  return Math.min(discount, subtotalPaise);
}

module.exports = { DEFAULT_TIERS, selectTier, unitPrice, gst, allocateDiscount, couponDiscount };

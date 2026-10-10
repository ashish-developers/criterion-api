// Order totals shared by cart preview, checkout and quotations: coupon discount,
// GST per line (CGST+SGST intra-state, IGST inter-state) and shipping.
const { Op } = require("sequelize");
const { Coupon, CouponRedemption } = require("../Models");
const ApiError = require("../Utils/ApiError");
const engine = require("./pricingEngine");
const settingsService = require("./settingsService");
const shippingEstimator = require("./shippingEstimator");

async function validateCoupon(code, { userId, isB2B, subtotalPaise, transaction }) {
  if (!code) return null;
  const coupon = await Coupon.findOne({
    where: { code: { [Op.iLike]: code.trim() }, is_active: true },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  const fail = (message) => {
    throw ApiError.unprocessable(message, "COUPON_INVALID");
  };
  if (!coupon) fail("This coupon code is not valid");
  const now = new Date();
  if (coupon.starts_at && coupon.starts_at > now) fail("This coupon is not active yet");
  if (coupon.ends_at && coupon.ends_at < now) fail("This coupon has expired");
  if (coupon.applies_to === "b2c" && isB2B) fail("This coupon is for individual customers only");
  if (coupon.applies_to === "b2b" && !isB2B) fail("This coupon is for business accounts only");
  if (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit) fail("This coupon has been fully used");
  if (subtotalPaise < coupon.min_order_paise) fail(`Add items worth ₹${(coupon.min_order_paise / 100).toFixed(0)} or more to use this coupon`);
  const used = await CouponRedemption.count({ where: { coupon_id: coupon.id, user_id: userId }, transaction });
  if (used >= coupon.per_user_limit) fail("You have already used this coupon");
  return coupon;
}

/**
 * @param lines  [{ lineSubtotalPaise, gstRate, weightGrams, leadTimeDays, ... }]
 * @param opts   { coupon, address: {state, pincode}, shippingOverridePaise }
 */
async function compute(lines, { coupon = null, address = null, shippingOverridePaise = null } = {}) {
  const seller = await settingsService.get("seller");
  const subtotal = lines.reduce((s, l) => s + l.lineSubtotalPaise, 0);
  const setupFees = lines.reduce((s, l) => s + (l.setupFeePaise || 0), 0);
  const discount = engine.couponDiscount(coupon, subtotal);
  const shares = engine.allocateDiscount(lines.map((l) => l.lineSubtotalPaise), discount);
  const interstate = address ? address.state.trim().toLowerCase() !== seller.state.trim().toLowerCase() : false;

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  const taxedLines = lines.map((line, i) => {
    const taxable = line.lineSubtotalPaise - shares[i];
    const tax = engine.gst(taxable, line.gstRate, interstate);
    cgst += tax.cgst;
    sgst += tax.sgst;
    igst += tax.igst;
    return { ...line, discountPaise: shares[i], taxablePaise: taxable, taxPaise: tax.total, lineTotalPaise: taxable + tax.total };
  });

  let shipping = { chargePaise: 0, serviceable: true, estimatedDelivery: null };
  if (shippingOverridePaise !== null) {
    shipping = { chargePaise: shippingOverridePaise, serviceable: true };
  } else if (address?.pincode && lines.length) {
    shipping = await shippingEstimator.quote({
      pincode: address.pincode,
      weightGrams: lines.reduce((s, l) => s + (l.weightGrams || 0), 0),
      subtotalPaise: subtotal - discount,
      productionDays: Math.max(...lines.map((l) => l.leadTimeDays || 1)),
    });
  }
  const shippingCharge = shipping.serviceable ? shipping.chargePaise : 0;
  const shippingCfg = await settingsService.get("shipping");
  const shippingTax = engine.gst(shippingCharge, shippingCfg.gst_rate, interstate);
  cgst += shippingTax.cgst;
  sgst += shippingTax.sgst;
  igst += shippingTax.igst;

  const tax = cgst + sgst + igst;
  return {
    lines: taxedLines,
    subtotalPaise: subtotal,
    setupFeesPaise: setupFees,
    discountPaise: discount,
    shippingPaise: shippingCharge,
    taxPaise: tax,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    totalPaise: subtotal - discount + shippingCharge + tax,
    interstate,
    shipping,
    coupon: coupon ? { code: coupon.code, description: coupon.description } : null,
  };
}

module.exports = { compute, validateCoupon };

// Unit tests for the pure business rules: pricing formula, tiers, GST, discounts and the
// order-line state model.
const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../src/Services/pricingEngine");
const machine = require("../src/Services/orderStateMachine");
const { effectiveDpi, detectType, scan } = require("../src/Services/fileInspector");
const { png } = require("./helpers");

test("unit price follows P = [(Cb + Cd + Cp)(1 + m) + F/q](1 + u)", () => {
  // Worked example from Section 3.4 with the 35% tier margin: 100 polos, embroidery.
  const r = engine.unitPrice({ baseCost: 22000, decorationCost: 4500, packagingCost: 1000, marginPct: 35, setupFee: 80000, quantity: 100 });
  assert.equal(r.unitPrice, Math.round(27500 * 1.35 + 800));
  const express = engine.unitPrice({ baseCost: 10000, marginPct: 50, quantity: 1, expressPct: 20 });
  assert.equal(express.unitPrice, 18000);
});

test("tier selection uses the quantity band, defaulting to the documented tiers", () => {
  assert.equal(engine.selectTier([], 1).margin_pct, 60);
  assert.equal(engine.selectTier([], 49).margin_pct, 50);
  assert.equal(engine.selectTier([], 50).margin_pct, 42);
  assert.equal(engine.selectTier([], 250).checkout_path, "instant_or_quote");
  assert.equal(engine.selectTier([], 5000).checkout_path, "quote_only");
});

test("GST splits CGST/SGST intra-state and IGST inter-state", () => {
  assert.deepEqual(engine.gst(10001, 18, false), { cgst: 900, sgst: 900, igst: 0, total: 1800 });
  assert.deepEqual(engine.gst(10000, 12, true), { cgst: 0, sgst: 0, igst: 1200, total: 1200 });
});

test("discount allocation always sums to the discount", () => {
  const shares = engine.allocateDiscount([3333, 3333, 3334], 1001);
  assert.equal(shares.reduce((a, b) => a + b, 0), 1001);
  assert.deepEqual(engine.allocateDiscount([100], 0), [0]);
});

test("coupon discount respects minimum order and cap", () => {
  const coupon = { discount_type: "percent", value: 10, min_order_paise: 49900, max_discount_paise: 20000 };
  assert.equal(engine.couponDiscount(coupon, 40000), 0);
  assert.equal(engine.couponDiscount(coupon, 100000), 10000);
  assert.equal(engine.couponDiscount(coupon, 500000), 20000);
  assert.equal(engine.couponDiscount({ discount_type: "flat", value: 100, min_order_paise: 0 }, 5000), 5000);
});

test("order-line state model allows only documented transitions", () => {
  assert.ok(machine.canTransition("proof_sent", "proof_approved"));
  assert.ok(machine.canTransition("proof_sent", "artwork_pending"), "change requests loop back");
  assert.ok(machine.canTransition("quality_check", "qc_failed"));
  assert.ok(!machine.canTransition("placed", "dispatched"));
  assert.ok(!machine.canTransition("in_production", "cancelled"), "no cancellation once in production");
  assert.ok(machine.canTransition("on_hold", "assigned", "assigned"), "resume to previous state");
  assert.ok(!machine.canTransition("on_hold", "packed", "assigned"));
  assert.throws(() => machine.assertTransition("delivered", "in_production"), /cannot move/);
});

test("cancellation policy follows Section 7.6", () => {
  assert.deepEqual(machine.cancellationPolicy("proof_sent"), { allowed: true, charges: false });
  assert.deepEqual(machine.cancellationPolicy("proof_approved"), { allowed: true, charges: true });
  assert.deepEqual(machine.cancellationPolicy("in_production"), { allowed: false, charges: false });
});

test("order status is derived from line states", () => {
  assert.equal(machine.deriveOrderStatus(["dispatched", "in_production"]), "partially_shipped");
  assert.equal(machine.deriveOrderStatus(["delivered", "closed"]), "delivered");
  assert.equal(machine.deriveOrderStatus(["cancelled", "closed"]), "completed");
  assert.equal(machine.deriveOrderStatus(["payment_pending"], { paymentPending: true }), "payment_pending");
  assert.equal(machine.deriveOrderStatus(["cancelled"]), "cancelled");
});

test("file inspection detects type from content and computes DPI", () => {
  assert.equal(detectType(png(10, 10)).ext, "png");
  assert.equal(detectType(Buffer.from("%PDF-1.7 ...")).ext, "pdf");
  assert.equal(detectType(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>')).ext, "svg");
  assert.equal(detectType(Buffer.from("MZ executable")), null);
  assert.equal(scan(Buffer.from('<svg onload="alert(1)"></svg>'), "svg").clean, false);
  // 1181 px across 100 mm is 300 DPI.
  assert.equal(effectiveDpi(1181, 1181, 100, 100), 299);
  assert.equal(effectiveDpi(300, 300, 254, 254), 30);
});

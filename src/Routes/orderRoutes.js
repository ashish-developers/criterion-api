// /api/v1/cart, /checkout, /orders, /proofs, /payments, /reviews
const router = require("express").Router();
const c = require("../Controllers/orderController");
const v = require("../Validators/commerceValidators");
const { validate } = require("../Middleware/validate");
const { requireAuth, requirePermission } = require("../Middleware/auth");
const { rateLimit } = require("../Middleware/rateLimit");

const buyer = [requireAuth, requirePermission("shop.purchase")];

router.get("/cart", ...buyer, validate({ query: v.cartQuery }), c.cart);
router.post("/cart/items", ...buyer, validate({ body: v.cartItem }), c.addToCart);
router.patch("/cart/items/:id", ...buyer, validate({ params: v.idParam, body: v.cartItemUpdate }), c.updateCartItem);
router.delete("/cart/items/:id", ...buyer, validate({ params: v.idParam }), c.removeCartItem);
router.put("/cart/coupon", ...buyer, validate({ body: v.coupon }), c.setCoupon);

router.post("/checkout", ...buyer, rateLimit({ name: "checkout", windowMs: 60 * 1000, max: 10, by: (req) => req.auth?.user?.id }), validate({ body: v.checkout }), c.checkout);

// Order visibility is enforced per record (owner, company members, staff).
router.get("/orders", requireAuth, validate({ query: v.orderList }), c.list);
router.get("/orders/:id", requireAuth, validate({ params: v.idParam }), c.detail);
router.get("/orders/:id/timeline", requireAuth, validate({ params: v.idParam }), c.timeline);
router.get("/orders/:id/proofs", requireAuth, validate({ params: v.idParam }), c.proofs);
router.get("/orders/:id/invoice", requireAuth, validate({ params: v.idParam }), c.invoice);
router.post("/orders/:id/cancel", requireAuth, validate({ params: v.idParam, body: v.cancel }), c.cancel);
router.post("/orders/:id/reorder", ...buyer, validate({ params: v.idParam }), c.reorder);
router.post("/orders/:id/payments", ...buyer, rateLimit({ name: "pay", windowMs: 60 * 1000, max: 20 }), validate({ params: v.idParam }), c.createPayment);

router.post("/proofs/:id/approve", requireAuth, validate({ params: v.idParam, body: v.proofDecision }), c.approveProof);
router.post("/proofs/:id/request-changes", requireAuth, validate({ params: v.idParam, body: v.proofChanges }), c.requestProofChanges);

router.post("/payments/verify", ...buyer, validate({ body: v.paymentVerify }), c.verifyPayment);
// Development-only simulated gateway (refused unless PAYMENT_PROVIDER=mock outside production).
router.post("/payments/:id/mock-complete", ...buyer, validate({ params: v.idParam, body: v.mockComplete }), c.completeMockPayment);

router.get("/products/:id/reviews", validate({ params: v.idParam }), c.productReviews);
router.post("/reviews", requireAuth, requirePermission("reviews.write"), validate({ body: v.review }), c.createReview);

module.exports = router;

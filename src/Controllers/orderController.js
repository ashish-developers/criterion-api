const cartService = require("../Services/cartService");
const orderService = require("../Services/orderService");
const proofService = require("../Services/proofService");
const paymentService = require("../Services/paymentService");
const invoiceService = require("../Services/invoiceService");
const reviewService = require("../Services/reviewService");
const { ok, created, pageMeta } = require("../Utils/http");

module.exports = {
  // Cart
  cart: async (req, res) => ok(res, await cartService.view(req.auth, req.validatedQuery || {})),
  addToCart: async (req, res) => created(res, await cartService.addItem(req.auth, req.body), "Added to cart"),
  updateCartItem: async (req, res) => ok(res, await cartService.updateItem(req.auth, req.params.id, req.body), "Cart updated"),
  removeCartItem: async (req, res) => {
    await cartService.removeItem(req.auth, req.params.id);
    return ok(res, null, "Removed from cart");
  },
  setCoupon: async (req, res) => ok(res, await cartService.setCoupon(req.auth, req.body.code), req.body.code ? "Coupon applied" : "Coupon removed"),

  // Checkout and orders
  checkout: async (req, res) => {
    const result = await orderService.checkout(req.auth, req.body);
    return result.duplicate ? ok(res, result.order, "Order already placed") : created(res, result.order, "Order placed");
  },
  list: async (req, res) => {
    const query = req.validatedQuery;
    const page = query.page || 1;
    const limit = query.limit || 20;
    const result = await orderService.list(req.auth, { ...query, page, limit });
    return ok(res, result.items, "OK", pageMeta({ page, limit }, result.total));
  },
  detail: async (req, res) => ok(res, await orderService.detail(req.auth, req.params.id)),
  timeline: async (req, res) => ok(res, await orderService.timeline(req.auth, req.params.id)),
  cancel: async (req, res) => ok(res, await orderService.cancel(req.auth, req.params.id, req.body), "Cancellation processed"),
  reorder: async (req, res) => ok(res, await orderService.reorder(req.auth, req.params.id), "Items added to your cart"),
  invoice: async (req, res) => ok(res, await invoiceService.forOrder(req.auth, req.params.id)),

  // Proofs
  proofs: async (req, res) => ok(res, await proofService.forOrder(req.auth, req.params.id)),
  approveProof: async (req, res) => {
    const result = await proofService.approve(req.auth, req.params.id, req.body);
    return ok(res, result, result.complete ? "Proof approved. Production can start." : "Approval recorded. Waiting for the other approver.");
  },
  requestProofChanges: async (req, res) => ok(res, await proofService.requestChanges(req.auth, req.params.id, req.body), "Change request sent"),

  // Payments
  createPayment: async (req, res) => created(res, await paymentService.createIntent(req.auth, req.params.id), "Payment started"),
  verifyPayment: async (req, res) => ok(res, await paymentService.verifyCheckout(req.auth, req.body), "Payment verified"),
  completeMockPayment: async (req, res) => ok(res, await paymentService.completeMock(req.auth, req.params.id, req.body.outcome), "Payment successful"),
  razorpayWebhook: async (req, res) => ok(res, await paymentService.handleRazorpayWebhook(req)),

  // Reviews
  productReviews: async (req, res) => ok(res, await reviewService.forProduct(req.params.id)),
  createReview: async (req, res) => created(res, await reviewService.create(req.auth, req.body), "Thank you! Your review will appear after moderation."),
};

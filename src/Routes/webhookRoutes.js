// /api/v1/webhooks - inbound gateway and courier events. Authenticated by signature only.
const router = require("express").Router();
const orderController = require("../Controllers/orderController");
const shipmentService = require("../Services/shipmentService");
const { ok } = require("../Utils/http");
const { rateLimit } = require("../Middleware/rateLimit");

router.use(rateLimit({ name: "webhook", windowMs: 60 * 1000, max: 600 }));
router.post("/razorpay", orderController.razorpayWebhook);
router.post("/shipping", async (req, res) => ok(res, await shipmentService.handleTrackingWebhook(req)));

module.exports = router;

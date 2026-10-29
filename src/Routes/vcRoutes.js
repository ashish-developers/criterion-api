// /api/v1/visiting-cards - template gallery, designer drafts and card orders for customers.
// Every route needs a signed-in buyer (shop.purchase); corporate designs and orders also need
// company.brand.manage, and each design and order is checked for ownership in the services.
const router = require("express").Router();
const { customer: c } = require("../Controllers/vcController");
const v = require("../Validators/vcValidators");
const cv = require("../Validators/commerceValidators");
const { validate } = require("../Middleware/validate");
const { requireAuth, requirePermission } = require("../Middleware/auth");
const { upload } = require("../Middleware/upload");
const { rateLimit } = require("../Middleware/rateLimit");

const id = validate({ params: v.idParam });
const perUser = (name, max, windowMs = 60 * 1000) => rateLimit({ name, windowMs, max, by: (req) => req.auth?.user?.id });

router.use(requireAuth, requirePermission("shop.purchase"));

router.get("/context", c.context);
router.get("/categories", c.categories);
router.get("/templates", validate({ query: v.templateList }), c.templates);
router.get("/templates/:id", id, c.template);
router.get("/print-options", c.printOptions);
router.get("/pricing", c.pricing);

router.get("/designs", c.designs);
router.post("/designs", perUser("vc-design", 30), validate({ body: v.designCreate }), c.createDesign);
router.get("/designs/:id", id, c.design);
router.put("/designs/:id", perUser("vc-save", 120), id, validate({ body: v.designSave }), c.saveDesign);
router.post("/designs/:id/duplicate", perUser("vc-design", 30), id, c.duplicateDesign);
router.delete("/designs/:id", id, c.deleteDesign);

router.post("/employees/import", perUser("vc-import", 30, 60 * 60 * 1000), upload.single("file"), c.importEmployees);
router.get("/employees/directory", c.directory);

router.post("/quote", perUser("vc-quote", 120), validate({ body: v.quote }), c.quote);
router.post("/orders", perUser("vc-order", 10), validate({ body: v.order }), c.placeOrder);
router.get("/orders", validate({ query: v.listQuery }), c.orders);
router.get("/orders/:id", id, c.order);
router.post("/orders/:id/cancel", id, validate({ body: v.cancel.pick({ reason: true }) }), c.cancel);
router.put("/orders/:id/artwork", perUser("vc-save", 120), id, validate({ body: v.artworkUpdate }), c.updateArtwork);
router.post("/orders/:id/payments", perUser("vc-pay", 20), id, c.createPayment);
router.get("/orders/:id/invoice", id, c.invoice);

router.post("/payments/verify", validate({ body: cv.paymentVerify }), c.verifyPayment);
// Development-only simulated gateway (refused unless PAYMENT_PROVIDER=mock outside production).
router.post("/payments/:id/mock-complete", id, validate({ body: cv.mockComplete }), c.completeMockPayment);
router.get("/payments/:id/receipt", id, c.receipt);

module.exports = router;

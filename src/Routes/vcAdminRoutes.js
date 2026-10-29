// /api/v1/admin/visiting-cards - visiting card administration. Mounted inside adminRoutes
// (after requireAuth). Each route needs a vc.* permission; production staff can work orders
// but never see prices or payments (the services strip them).
const router = require("express").Router();
const { staff: c } = require("../Controllers/vcController");
const v = require("../Validators/vcValidators");
const { z } = require("../Validators/common");
const { validate } = require("../Middleware/validate");
const { requirePermission: can } = require("../Middleware/auth");

const id = validate({ params: v.idParam });
const intId = validate({ params: v.intId });
const view = can("vc.view");
const orders = can("vc.orders.manage");
const templates = can("vc.templates.manage");
const pricing = can("vc.pricing.manage");

router.get("/dashboard", view, c.dashboard);
router.get("/reports", can("vc.reports.view"), validate({ query: v.reportQuery }), c.reports);

router.get("/templates", can("vc.view", "vc.templates.manage"), validate({ query: v.templateList }), c.templates);
router.post("/templates", templates, validate({ body: v.template }), c.saveTemplate);
router.get("/templates/:id", can("vc.view", "vc.templates.manage"), id, c.template);
router.put("/templates/:id", templates, id, validate({ body: v.template }), c.saveTemplate);
router.post("/templates/:id/status", templates, id, validate({ body: v.templateStatus }), c.templateStatus);
router.post("/templates/:id/duplicate", templates, id, c.duplicateTemplate);
router.delete("/templates/:id", templates, id, c.deleteTemplate);

router.get("/categories", can("vc.view", "vc.templates.manage"), c.categories);
router.post("/categories", templates, validate({ body: v.category }), c.saveCategory);
router.put("/categories/:id", templates, intId, validate({ body: v.category }), c.saveCategory);
router.delete("/categories/:id", templates, intId, c.deleteCategory);

router.get("/orders", view, validate({ query: v.orderList }), c.orders);
router.get("/orders/:id", view, id, c.order);
router.post("/orders/:id/artwork", orders, id, validate({ body: v.artworkDecision }), c.artwork);
router.post("/orders/:id/status", orders, id, validate({ body: v.statusUpdate }), c.status);
router.put("/orders/:id/tracking", orders, id, validate({ body: v.tracking }), c.tracking);
router.post("/orders/:id/cancel", orders, id, validate({ body: v.cancel }), c.cancel);
router.post("/orders/:id/offline-payment", can("vc.payments.manage"), id, validate({ body: v.offlinePayment }), c.offlinePayment);
router.get("/orders/:id/invoice", can("vc.payments.view"), id, c.invoice);

router.get("/customers/:type", view, validate({ params: z.object({ type: z.enum(["corporate", "individual"]) }), query: v.listQuery }), c.customers);

router.get("/payments", can("vc.payments.view"), validate({ query: v.listQuery }), c.payments);
router.get("/payments/:id/receipt", can("vc.payments.view"), id, c.receipt);

router.get("/pricing", pricing, c.pricing);
router.put("/pricing/slabs", pricing, validate({ body: v.slabs }), c.saveSlabs);
router.post(
  "/pricing/preview",
  pricing,
  validate({ body: z.object({ quantity: z.coerce.number().int().min(1).max(1000000), doubleSided: z.boolean().optional(), options: z.array(z.string().max(40)).max(5).optional() }) }),
  c.pricePreview
);
router.get("/print-options", can("vc.pricing.manage", "vc.view"), c.printOptions);
router.post("/print-options", pricing, validate({ body: v.printOption }), c.saveOption);
router.put("/print-options/:id", pricing, intId, validate({ body: v.printOption }), c.saveOption);
router.delete("/print-options/:id", pricing, intId, c.deleteOption);
router.get("/settings", can("vc.pricing.manage", "vc.view"), c.settings);
router.put("/settings", pricing, validate({ body: v.settings }), c.saveSettings);

module.exports = router;

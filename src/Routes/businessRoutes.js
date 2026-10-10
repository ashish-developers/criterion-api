// /api/v1/business - company-scoped B2B portal.
const router = require("express").Router();
const c = require("../Controllers/businessController");
const q = require("../Controllers/quoteController");
const v = require("../Validators/commerceValidators");
const { validate } = require("../Middleware/validate");
const { requireAuth, requireCompany, requirePermission } = require("../Middleware/auth");

router.use(requireAuth, requireCompany, requirePermission("company.view"));
router.get("/dashboard", c.dashboard);
router.get("/company", c.profile);
router.put("/company", requirePermission("company.manage"), validate({ body: v.companyUpdate }), c.updateProfile);
router.get("/team", c.team);
router.post("/team", requirePermission("company.team.manage"), validate({ body: v.teamInvite }), c.invite);
router.patch("/team/:id", requirePermission("company.team.manage"), validate({ body: v.teamUpdate }), c.updateMember);
router.get("/brand-kits", c.brandKits);
router.post("/brand-kits", requirePermission("company.brand.manage"), validate({ body: v.brandKit }), c.createBrandKit);
router.put("/brand-kits/:id", requirePermission("company.brand.manage"), validate({ params: v.idParam, body: v.brandKit }), c.updateBrandKit);
router.delete("/brand-kits/:id", requirePermission("company.brand.manage"), validate({ params: v.idParam }), c.deleteBrandKit);
router.get("/invoices", c.invoices);
router.get("/purchase-orders", c.purchaseOrders);
router.get("/approvals", requirePermission("company.orders.approve"), q.approvals);
router.post("/approvals/:id", requirePermission("company.orders.approve"), validate({ params: v.idParam, body: v.approval }), q.decideApproval);

module.exports = router;

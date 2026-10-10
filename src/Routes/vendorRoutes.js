// /api/v1/vendor - vendor-scoped portal. Every query is limited to the caller's vendor.
const router = require("express").Router();
const c = require("../Controllers/vendorController");
const v = require("../Validators/opsValidators");
const { validate } = require("../Middleware/validate");
const { requireAuth, requireVendor, requirePermission } = require("../Middleware/auth");

router.use(requireAuth);
router.get("/me", c.me);
// Application is open to vendor accounts before approval.
router.post("/application", validate({ body: v.vendorApplication }), c.apply);

const approved = requireVendor({ approved: true });
const member = requireVendor({ approved: false });
router.put("/profile", member, requirePermission("vendor.profile.manage"), validate({ body: v.vendorProfile }), c.updateProfile);
router.put("/holidays", approved, requirePermission("vendor.profile.manage"), validate({ body: v.holidays }), c.setHolidays);
router.get("/staff", member, requirePermission("vendor.team.manage"), c.staff);
router.post("/staff", approved, requirePermission("vendor.team.manage"), validate({ body: v.staff }), c.addStaff);
router.delete("/staff/:id", approved, requirePermission("vendor.team.manage"), validate({ params: v.intIdParam }), c.removeStaff);

router.get("/dashboard", approved, requirePermission("vendor.jobs.view"), c.dashboard);
router.get("/performance", approved, requirePermission("vendor.jobs.view"), c.performance);

router.get("/products", approved, requirePermission("vendor.listings.manage"), c.listings);
router.post("/products", approved, requirePermission("vendor.listings.manage"), validate({ body: v.listing }), c.createListing);
router.put("/products/:id", approved, requirePermission("vendor.listings.manage"), validate({ params: v.idParam, body: v.listing }), c.updateListing);
router.post("/products/:id/active", approved, requirePermission("vendor.listings.manage"), validate({ params: v.idParam }), c.setListingActive);

router.get("/jobs", approved, requirePermission("vendor.jobs.view"), validate({ query: v.jobList }), c.jobs);
router.get("/jobs/:id", approved, requirePermission("vendor.jobs.view"), validate({ params: v.idParam }), c.job);
router.post("/jobs/:id/respond", approved, requirePermission("vendor.jobs.update"), validate({ params: v.idParam, body: v.jobResponse }), c.respond);
router.post("/jobs/:id/events", approved, requirePermission("vendor.jobs.update"), validate({ params: v.idParam, body: v.milestone }), c.milestone);
router.post("/jobs/:id/qc", approved, requirePermission("vendor.jobs.update"), validate({ params: v.idParam, body: v.qc }), c.qc);
router.post("/jobs/:id/shipments", approved, requirePermission("vendor.jobs.update"), validate({ params: v.idParam, body: v.shipment }), c.ship);
router.get("/shipments", approved, requirePermission("vendor.jobs.view"), c.shipments);
router.post("/shipments/:id/tracking", approved, requirePermission("vendor.jobs.update"), validate({ params: v.idParam, body: v.tracking }), c.tracking);

router.get("/settlements", approved, requirePermission("vendor.settlements.view"), c.settlements);
router.get("/settlements/:id", approved, requirePermission("vendor.settlements.view"), validate({ params: v.idParam }), c.settlement);

module.exports = router;

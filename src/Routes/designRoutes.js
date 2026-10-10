// /api/v1/uploads, /api/v1/assets, /api/v1/designs - artwork uploads and saved designs.
const router = require("express").Router();
const c = require("../Controllers/assetController");
const v = require("../Validators/commerceValidators");
const { validate } = require("../Middleware/validate");
const { requireAuth, optionalAuth, requirePermission } = require("../Middleware/auth");
const { upload } = require("../Middleware/upload");
const { rateLimit } = require("../Middleware/rateLimit");

router.post(
  "/uploads",
  requireAuth,
  rateLimit({ name: "upload", windowMs: 60 * 60 * 1000, max: 200, by: (req) => req.auth?.user?.id }),
  upload.single("file"),
  validate({ query: v.uploadQuery }),
  c.upload
);
router.get("/uploads/mine", requireAuth, c.mine);
// Access is checked per file (owner, company, assigned vendor, order buyer or staff).
router.get("/assets/:id", optionalAuth, validate({ params: v.idParam }), c.download);

router.get("/designs", requireAuth, requirePermission("designs.manage_own"), c.designs);
router.post("/designs", requireAuth, requirePermission("designs.manage_own"), validate({ body: v.designVersion }), c.saveDesign);
router.get("/designs/:id", requireAuth, requirePermission("designs.manage_own"), validate({ params: v.idParam }), c.design);
router.delete("/designs/:id", requireAuth, requirePermission("designs.manage_own"), validate({ params: v.idParam }), c.deleteDesign);

module.exports = router;

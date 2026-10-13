// All API route groups, mounted under the versioned prefix (/api/v1) in app.js.
const router = require("express").Router();

router.use("/auth", require("./authRoutes"));
router.use("/catalog", require("./catalogRoutes"));
router.use("/account", require("./accountRoutes"));
router.use("/", require("./designRoutes")); //   /uploads, /assets, /designs
router.use("/", require("./orderRoutes")); //    /cart, /checkout, /orders, /proofs, /payments, /reviews
router.use("/quotes", require("./quoteRoutes"));
router.use("/business", require("./businessRoutes"));
router.use("/vendor", require("./vendorRoutes"));
router.use("/", require("./supportRoutes")); //  /tickets, /content
router.use("/blog", require("./blogRoutes")); //  public blog (published posts only)
router.use("/admin", require("./adminRoutes"));
router.use("/webhooks", require("./webhookRoutes"));

module.exports = router;

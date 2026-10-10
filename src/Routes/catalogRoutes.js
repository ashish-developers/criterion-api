const router = require("express").Router();
const catalogController = require("../Controllers/catalogController");
const v = require("../Validators/catalogValidators");
const { validate } = require("../Middleware/validate");
const { rateLimit } = require("../Middleware/rateLimit");

const publicLimit = rateLimit({ name: "catalog", windowMs: 60 * 1000, max: 240 });

router.use(publicLimit);
router.get("/categories", catalogController.categories);
router.get("/categories/:slug", validate({ params: v.slugParam }), catalogController.category);
router.get("/methods", catalogController.methods);
router.get("/products", validate({ query: v.productSearch }), catalogController.products);
router.get("/products/:slug", validate({ params: v.slugParam }), catalogController.product);
router.get("/products/:id/price", validate({ params: v.idParam, query: v.priceQuery }), catalogController.price);
router.get("/products/:id/delivery-estimate", validate({ params: v.idParam, query: v.deliveryQuery }), catalogController.deliveryEstimate);

module.exports = router;

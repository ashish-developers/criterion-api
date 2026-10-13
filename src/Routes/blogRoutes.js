// /api/v1/blog - the public website's blog. Only published posts are ever returned.
const router = require("express").Router();
const c = require("../Controllers/blogController");
const v = require("../Validators/blogValidators");
const { validate } = require("../Middleware/validate");
const { rateLimit } = require("../Middleware/rateLimit");

router.get("/posts", validate({ query: v.publicList }), c.publicList);
router.get("/posts/:slug", rateLimit({ name: "blog-post", windowMs: 60_000, max: 300 }), validate({ params: v.publicSlug, query: v.publicDetailQuery }), c.publicPost);
router.get("/categories", c.publicCategories);
router.get("/sitemap", c.sitemap);

module.exports = router;

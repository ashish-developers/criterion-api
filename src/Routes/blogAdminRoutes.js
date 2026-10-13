// /api/v1/admin/blog - blog management. Mounted inside adminRoutes (after requireAuth).
// The route guards check the permission family; blogService then applies the per-post
// ownership and status rules, so a direct API call can never do more than the UI offers.
const router = require("express").Router();
const c = require("../Controllers/blogController");
const v = require("../Validators/blogValidators");
const { validate } = require("../Middleware/validate");
const { requirePermission: can } = require("../Middleware/auth");
const { BLOG_PERMISSIONS } = require("../Config/roles");

const anyBlog = can(...BLOG_PERMISSIONS.filter((p) => p !== "blog.permissions.manage"));
const taxonomy = can("blog.taxonomy.manage");
const admin = can("blog.permissions.manage");
const id = validate({ params: v.idParam });

router.get("/meta", anyBlog, c.meta);
router.get("/stats", anyBlog, c.stats);
router.get("/analytics", can("blog.analytics.view"), c.analytics);

router.get("/posts", anyBlog, validate({ query: v.list }), c.list);
router.post("/posts", can("blog.create"), validate({ body: v.post }), c.create);
router.get("/posts/slug-check", can("blog.create", "blog.edit_own", "blog.edit_all"), validate({ query: v.slugCheck }), c.slugCheck);
router.get("/posts/:id", anyBlog, id, c.detail);
router.put("/posts/:id", can("blog.edit_own", "blog.edit_all"), id, validate({ body: v.post }), c.update);
router.delete("/posts/:id", can("blog.delete_own", "blog.delete_all"), id, c.remove);
router.get("/posts/:id/history", anyBlog, id, c.history);
router.post("/posts/:id/:action", anyBlog, validate({ params: v.idParam.extend(v.action.shape), body: v.actionBody }), c.transition);

router.get("/categories", anyBlog, c.categories);
router.post("/categories", taxonomy, validate({ body: v.category }), c.saveCategory);
router.put("/categories/:id", taxonomy, validate({ params: v.intId, body: v.category }), c.saveCategory);
router.delete("/categories/:id", taxonomy, validate({ params: v.intId }), c.deleteCategory);
router.get("/tags", anyBlog, validate({ query: v.tagQuery }), c.tags);
router.post("/tags", taxonomy, validate({ body: v.tag }), c.saveTag);
router.put("/tags/:id", taxonomy, validate({ params: v.intId, body: v.tag }), c.saveTag);
router.delete("/tags/:id", taxonomy, validate({ params: v.intId }), c.deleteTag);

router.get("/permissions", admin, validate({ query: v.tagQuery }), c.permissions);
router.put("/permissions/:userId", admin, validate({ params: v.userId, body: v.permissions }), c.setPermissions);
router.put("/settings", admin, validate({ body: v.settings }), c.saveSettings);

module.exports = router;

// /api/v1/quotes - request, review, accept and convert quotations.
const router = require("express").Router();
const c = require("../Controllers/quoteController");
const v = require("../Validators/commerceValidators");
const { validate } = require("../Middleware/validate");
const { requireAuth, requirePermission } = require("../Middleware/auth");
const { rateLimit } = require("../Middleware/rateLimit");

router.use(requireAuth);
router.post("/recipients/parse", requirePermission("quotes.request"), validate({ body: v.recipientsCsv }), c.parseRecipients);
router.post("/", requirePermission("quotes.request"), rateLimit({ name: "quote", windowMs: 60 * 60 * 1000, max: 30 }), validate({ body: v.quoteCreate }), c.create);
router.get("/", validate({ query: v.quoteList }), c.list);
router.get("/:id", validate({ params: v.idParam }), c.detail);
router.post("/:id/accept", requirePermission("quotes.request"), validate({ params: v.idParam, body: v.quoteAccept }), c.accept);
router.post("/:id/request-revision", requirePermission("quotes.request"), validate({ params: v.idParam, body: v.quoteComment }), c.requestRevision);
router.post("/:id/reject", requirePermission("quotes.request"), validate({ params: v.idParam, body: v.quoteReject }), c.reject);
router.post("/:id/messages", validate({ params: v.idParam, body: v.message }), c.message);
router.post("/:id/repeat", requirePermission("quotes.request"), validate({ params: v.idParam }), c.repeat);

// Staff pricing
router.get("/:id/suggestion", requirePermission("quotes.manage"), validate({ params: v.idParam }), c.suggest);
router.post("/:id/review", requirePermission("quotes.manage"), validate({ params: v.idParam }), c.review);
router.post("/:id/versions", requirePermission("quotes.manage"), validate({ params: v.idParam, body: v.quoteVersion }), c.sendVersion);

module.exports = router;

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
// The customer corrects a request staff returned to them, and resubmits it.
router.post("/:id/resubmit", requirePermission("quotes.request"), validate({ params: v.idParam, body: v.quoteResubmit }), c.resubmit);
// History and the printable quotation (any version) for whoever can see the quotation.
router.get("/:id/history", validate({ params: v.idParam }), c.history);
router.get("/:id/document", validate({ params: v.idParam, query: v.quoteDocument }), c.document);

// Staff pricing
router.get("/:id/suggestion", requirePermission("quotes.manage"), validate({ params: v.idParam }), c.suggest);
router.post("/:id/review", requirePermission("quotes.manage"), validate({ params: v.idParam }), c.review);
router.post("/:id/versions", requirePermission("quotes.manage"), validate({ params: v.idParam, body: v.quoteVersion }), c.sendVersion);
router.post("/:id/return", requirePermission("quotes.manage"), validate({ params: v.idParam, body: v.quoteReturn }), c.returnToCustomer);
router.post("/:id/decline", requirePermission("quotes.manage"), validate({ params: v.idParam, body: v.quoteDecline }), c.decline);

module.exports = router;

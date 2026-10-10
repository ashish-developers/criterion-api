// /api/v1/tickets (customer support) and /api/v1/content (public CMS pages).
const router = require("express").Router();
const c = require("../Controllers/supportController");
const v = require("../Validators/commerceValidators");
const { validate } = require("../Middleware/validate");
const { requireAuth, requirePermission } = require("../Middleware/auth");

router.get("/content/pages", c.pages);
router.get("/content/pages/:slug", c.page);

router.post("/tickets", requireAuth, requirePermission("tickets.create", "tickets.manage"), validate({ body: v.ticketCreate }), c.create);
router.get("/tickets", requireAuth, validate({ query: v.ticketList }), c.list);
router.get("/tickets/:id", requireAuth, validate({ params: v.idParam }), c.detail);
router.post("/tickets/:id/messages", requireAuth, validate({ params: v.idParam, body: v.ticketReply }), c.reply);

module.exports = router;

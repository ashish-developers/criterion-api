// /api/v1/tickets (customer support), /api/v1/contact (inquiries) and /api/v1/content (CMS).
const router = require("express").Router();
const c = require("../Controllers/supportController");
const contact = require("../Controllers/contactController");
const v = require("../Validators/commerceValidators");
const { validate } = require("../Middleware/validate");
const { requireAuth, requirePermission } = require("../Middleware/auth");
const { rateLimit } = require("../Middleware/rateLimit");

router.get("/content/pages", c.pages);
router.get("/content/pages/:slug", c.page);

// Public contact & corporate quote enquiry forms (delivers email to CONTACT_US)
router.post("/contact", rateLimit({ name: "contact", windowMs: 15 * 60 * 1000, max: 15 }), validate({ body: v.contactSubmit }), contact.submitContact);
router.post("/contact/enquiry", rateLimit({ name: "enquiry", windowMs: 15 * 60 * 1000, max: 15 }), validate({ body: v.enquirySubmit }), contact.submitEnquiry);

router.post("/tickets", requireAuth, requirePermission("tickets.create", "tickets.manage"), validate({ body: v.ticketCreate }), c.create);
router.get("/tickets", requireAuth, validate({ query: v.ticketList }), c.list);
router.get("/tickets/:id", requireAuth, validate({ params: v.idParam }), c.detail);
router.post("/tickets/:id/messages", requireAuth, validate({ params: v.idParam, body: v.ticketReply }), c.reply);

module.exports = router;

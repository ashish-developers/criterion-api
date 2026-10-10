const ticketService = require("../Services/ticketService");
const { CmsPage } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { ok, created, pageMeta } = require("../Utils/http");

module.exports = {
  create: async (req, res) => created(res, await ticketService.create(req.auth, req.body), "Ticket created. Our team will reply soon."),
  list: async (req, res) => {
    const query = req.validatedQuery;
    const page = query.page || 1;
    const limit = query.limit || 20;
    const result = await ticketService.list(req.auth, { ...query, page, limit });
    return ok(res, result.items, "OK", pageMeta({ page, limit }, result.total));
  },
  detail: async (req, res) => ok(res, await ticketService.detail(req.auth, req.params.id)),
  reply: async (req, res) => created(res, await ticketService.reply(req.auth, req.params.id, req.body), "Reply sent"),

  // Public CMS content (policies, FAQs, about)
  pages: async (req, res) => {
    const where = { is_published: true };
    if (req.query.type) where.type = String(req.query.type);
    return ok(res, await CmsPage.findAll({ where, attributes: ["slug", "type", "title", "body", "sort_order", "updated_at"], order: [["sort_order", "ASC"]] }));
  },
  page: async (req, res) => {
    const page = await CmsPage.findOne({ where: { slug: req.params.slug, is_published: true } });
    if (!page) throw ApiError.notFound("Page not found");
    return ok(res, page);
  },
};

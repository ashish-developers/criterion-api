const quoteService = require("../Services/quoteService");
const companyService = require("../Services/companyService");
const orderService = require("../Services/orderService");
const auditService = require("../Services/auditService");
const { ok, created, pageMeta } = require("../Utils/http");

module.exports = {
  create: async (req, res) => created(res, await quoteService.create(req.auth, req.body), "Quote request submitted. We usually respond within 4 business hours."),
  list: async (req, res) => {
    const query = req.validatedQuery;
    const page = query.page || 1;
    const limit = query.limit || 20;
    const result = await quoteService.list(req.auth, { ...query, page, limit });
    return ok(res, result.items, "OK", pageMeta({ page, limit }, result.total));
  },
  detail: async (req, res) => ok(res, await quoteService.detail(req.auth, req.params.id)),
  accept: async (req, res) => ok(res, await quoteService.accept(req.auth, req.params.id, req.body), "Quotation accepted and converted to an order"),
  requestRevision: async (req, res) => ok(res, await quoteService.requestRevision(req.auth, req.params.id, req.body), "Revision requested"),
  reject: async (req, res) => ok(res, await quoteService.reject(req.auth, req.params.id, req.body), "Quotation rejected"),
  message: async (req, res) => created(res, await quoteService.postMessage(req.auth, req.params.id, req.body), "Message sent"),
  repeat: async (req, res) => created(res, await quoteService.repeat(req.auth, req.params.id), "Repeat request created"),
  resubmit: async (req, res) => {
    const result = await quoteService.resubmit(req.auth, req.params.id, req.body);
    return ok(res, { id: result.quote.id, status: result.quote.status, requestRevision: result.requestRevision, changes: result.changes }, "Corrections sent. Our team will review your quotation again.");
  },
  history: async (req, res) => ok(res, await quoteService.history(req.auth, req.params.id)),
  document: async (req, res) => ok(res, await quoteService.document(req.auth, req.params.id, req.validatedQuery)),
  parseRecipients: async (req, res) => ok(res, companyService.parseRecipientsCsv(req.body.csv)),

  // Staff
  suggest: async (req, res) => ok(res, await quoteService.suggest(req.auth, req.params.id)),
  review: async (req, res) => ok(res, await quoteService.markUnderReview(req.auth, req.params.id), "Marked under review"),
  returnToCustomer: async (req, res) => {
    const quote = await quoteService.returnToCustomer(req.auth, req.params.id, req.body);
    await auditService.record(req, "quote.returned", "quote", quote.id, { after: { status: quote.status, category: req.body.category, reason: req.body.reason } });
    return ok(res, { id: quote.id, status: quote.status }, "Quotation sent back to the customer for correction");
  },
  decline: async (req, res) => {
    const quote = await quoteService.decline(req.auth, req.params.id, req.body);
    await auditService.record(req, "quote.rejected", "quote", quote.id, { after: { status: quote.status, reason: req.body.reason } });
    return ok(res, { id: quote.id, status: quote.status }, "Quotation rejected");
  },
  sendVersion: async (req, res) => {
    const version = await quoteService.sendVersion(req.auth, req.params.id, req.body);
    await auditService.record(req, "quote.sent", "quote", req.params.id, { after: version });
    return created(res, version, "Quotation sent to the customer");
  },

  // Business approvals (company scope)
  approvals: async (req, res) => ok(res, await orderService.pendingApprovals(req.auth)),
  decideApproval: async (req, res) => ok(res, await orderService.decideApproval(req.auth, req.params.id, req.body), req.body.approve ? "Order approved" : "Order rejected"),
};

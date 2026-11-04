// Visiting card endpoints for customers (/visiting-cards) and staff (/admin/visiting-cards).
const designs = require("../Services/vcDesignService");
const templates = require("../Services/vcTemplateService");
const orders = require("../Services/vcOrderService");
const payments = require("../Services/vcPaymentService");
const admin = require("../Services/vcAdminService");
const pricing = require("../Services/vcPricing");
const settingsService = require("../Services/settingsService");
const audit = require("../Services/auditService");
const ApiError = require("../Utils/ApiError");
const { ok, created, pageParams, pageMeta } = require("../Utils/http");

const paged = async (req, res, fn) => {
  const paging = pageParams(req.validatedQuery || {});
  const result = await fn({ ...(req.validatedQuery || {}), ...paging });
  const meta = pageMeta(paging, result.total);
  if (result.summary) meta.summary = result.summary;
  return ok(res, result.items, "OK", meta);
};

const STATUS_MESSAGES = { in_production: "Marked as in production", dispatched: "Marked as dispatched", delivered: "Marked as delivered" };

const customer = {
  context: async (req, res) => ok(res, await designs.context(req.auth)),
  categories: async (req, res) => ok(res, await templates.galleryCategories()),
  templates: async (req, res) => ok(res, await templates.gallery(req.validatedQuery)),
  template: async (req, res) => ok(res, templates.present(await templates.publishedTemplate(req.params.id))),
  printOptions: async (req, res) => ok(res, await orders.optionCatalogue()),
  pricing: async (req, res) => ok(res, await admin.pricingTable()),

  designs: async (req, res) => ok(res, await designs.list(req.auth)),
  design: async (req, res) => ok(res, await designs.get(req.auth, req.params.id)),
  createDesign: async (req, res) => created(res, await designs.create(req.auth, req.body), "Draft created"),
  saveDesign: async (req, res) => ok(res, await designs.save(req.auth, req.params.id, req.body), "Draft saved"),
  duplicateDesign: async (req, res) => created(res, await designs.duplicate(req.auth, req.params.id), "Design copied"),
  deleteDesign: async (req, res) => {
    await designs.remove(req.auth, req.params.id);
    return ok(res, null, "Design deleted");
  },
  importEmployees: async (req, res) => {
    const result = await designs.importEmployees(req.auth, req.file);
    return ok(res, result, result.errorCount ? `${result.validCount} row(s) ready, ${result.errorCount} need fixing` : `${result.validCount} row(s) ready to add`);
  },
  directory: async (req, res) => ok(res, await designs.directory(req.auth)),

  quote: async (req, res) => ok(res, await orders.quote(req.auth, req.body)),
  placeOrder: async (req, res) => {
    const result = await orders.place(req.auth, req.body);
    return result.duplicate ? ok(res, result.order, "Order already placed") : created(res, result.order, "Order placed");
  },
  orders: (req, res) => paged(req, res, (q) => orders.listMine(req.auth, q)),
  order: async (req, res) => ok(res, await orders.detail(req.auth, req.params.id)),
  cancel: async (req, res) => {
    if (!req.body.reason) throw ApiError.unprocessable("Tell us why you are cancelling", "VALIDATION_FAILED", { reason: "Required" });
    return ok(res, await orders.cancelByCustomer(req.auth, req.params.id, req.body), "Order cancelled");
  },
  updateArtwork: async (req, res) => {
    const order = await orders.updateArtwork(req.auth, req.params.id, req.body);
    return ok(res, order, order.artworkStatus === "submitted" ? "Corrected artwork sent for review" : "Artwork updated");
  },
  createPayment: async (req, res) => created(res, await payments.createIntent(req.auth, req.params.id, req.body || {}), "Payment started"),
  verifyPayment: async (req, res) => ok(res, await payments.verifyCheckout(req.auth, req.body), "Payment verified"),
  capturePaypal: async (req, res) => {
    const result = await payments.capturePaypal(req.auth, req.body);
    return ok(res, result, result.pending ? "PayPal is still processing this payment. We will update your order when it completes." : "Payment verified");
  },
  completeMockPayment: async (req, res) => ok(res, await payments.completeMock(req.auth, req.params.id, req.body.outcome), "Payment successful"),
  invoice: async (req, res) => ok(res, await payments.invoice(req.auth, req.params.id)),
  receipt: async (req, res) => ok(res, await payments.receipt(req.auth, req.params.id)),
};

const staff = {
  dashboard: async (req, res) => ok(res, await admin.dashboard(req.auth)),
  reports: async (req, res) => ok(res, await admin.reports(req.auth, req.validatedQuery)),

  // Templates and categories
  templates: async (req, res) => ok(res, await templates.adminList(req.validatedQuery)),
  template: async (req, res) => ok(res, templates.present(await templates.adminGet(req.params.id))),
  saveTemplate: async (req, res) => {
    const { template, before } = await templates.save(req.auth, req.body, req.params.id);
    const after = templates.present(await templates.adminGet(template.id), { withDesign: false });
    await audit.record(req, req.params.id ? "vc.template_updated" : "vc.template_created", "vc_template", template.id, { before, after });
    return req.params.id ? ok(res, templates.present(await templates.adminGet(template.id)), "Template saved") : created(res, templates.present(await templates.adminGet(template.id)), "Template created as a draft");
  },
  templateStatus: async (req, res) => {
    const { template, before } = await templates.setStatus(req.auth, req.params.id, req.body.status);
    await audit.record(req, `vc.template_${req.body.status}`, "vc_template", template.id, { before: { status: before }, after: { status: template.status } });
    return ok(res, templates.present(await templates.adminGet(template.id)), req.body.status === "published" ? "Template published" : "Template unpublished");
  },
  duplicateTemplate: async (req, res) => {
    const copy = await templates.duplicate(req.auth, req.params.id);
    await audit.record(req, "vc.template_duplicated", "vc_template", copy.id, { after: { source: req.params.id } });
    return created(res, templates.present(await templates.adminGet(copy.id)), "Copy created as a draft");
  },
  deleteTemplate: async (req, res) => {
    const { before } = await templates.remove(req.params.id);
    await audit.record(req, "vc.template_deleted", "vc_template", req.params.id, { before });
    return ok(res, null, "Template removed");
  },
  categories: async (req, res) => ok(res, await templates.listCategories()),
  saveCategory: async (req, res) => {
    const { category, before } = await templates.saveCategory(req.body, req.params.id);
    await audit.record(req, req.params.id ? "vc.category_updated" : "vc.category_created", "vc_category", category.id, { before, after: category });
    return req.params.id ? ok(res, category, "Category saved") : created(res, category, "Category added");
  },
  deleteCategory: async (req, res) => {
    const { before, templatesAffected } = await templates.deleteCategory(req.params.id);
    await audit.record(req, "vc.category_deleted", "vc_category", req.params.id, { before });
    return ok(res, null, templatesAffected ? `Category deleted; ${templatesAffected} template(s) are now uncategorised` : "Category deleted");
  },

  // Orders
  orders: (req, res) => paged(req, res, (q) => orders.staffList(req.auth, q)),
  order: async (req, res) => ok(res, await orders.staffDetail(req.auth, req.params.id)),
  artwork: async (req, res) => {
    const { order, before } = await orders.artworkDecision(req.auth, req.params.id, req.body);
    await audit.record(req, `vc.artwork_${req.body.decision === "approve" ? "approved" : "rejected"}`, "vc_order", req.params.id, { before, after: { status: order.status, artwork_status: order.artworkStatus, reason: req.body.reason } });
    return ok(res, order, req.body.decision === "approve" ? "Artwork approved" : "Artwork returned to the customer");
  },
  status: async (req, res) => {
    const { order, before } = await orders.setStatus(req.auth, req.params.id, req.body);
    await audit.record(req, "vc.order_status", "vc_order", req.params.id, { before, after: { status: order.status, tracking_number: order.trackingNumber, note: req.body.note } });
    return ok(res, order, STATUS_MESSAGES[order.status] || "Order updated");
  },
  tracking: async (req, res) => {
    const { order, before } = await orders.updateTracking(req.auth, req.params.id, req.body);
    await audit.record(req, "vc.order_tracking", "vc_order", req.params.id, { before, after: { courier: order.courier, tracking_number: order.trackingNumber, tracking_url: order.trackingUrl } });
    return ok(res, order, "Tracking saved");
  },
  cancel: async (req, res) => {
    const { order, before, refundedPaise } = await orders.cancelByStaff(req.auth, req.params.id, req.body);
    await audit.record(req, "vc.order_cancelled", "vc_order", req.params.id, { before, after: { status: order.status, payment_status: order.paymentStatus, reason: req.body.reason, refunded_paise: refundedPaise } });
    return ok(res, order, refundedPaise ? "Order cancelled and refunded" : "Order cancelled");
  },
  offlinePayment: async (req, res) => {
    const payment = await payments.recordOffline(req.auth, req.params.id, req.body);
    await audit.record(req, "vc.offline_payment", "vc_order", req.params.id, { after: { payment_id: payment.id, amount_paise: payment.amount_paise, reference: req.body.reference } });
    return ok(res, await orders.staffDetail(req.auth, req.params.id), "Payment recorded");
  },
  invoice: async (req, res) => ok(res, await payments.invoice(req.auth, req.params.id, { staff: true })),

  customers: (req, res) => paged(req, res, (q) => admin.customers(req.auth, req.params.type, q)),

  // Money
  payments: (req, res) => paged(req, res, (q) => payments.list(q)),
  receipt: async (req, res) => ok(res, await payments.receipt(req.auth, req.params.id, { staff: true })),

  // Pricing, printing specifications and settings
  pricing: async (req, res) => ok(res, await admin.pricingTable()),
  saveSlabs: async (req, res) => {
    const { before, after } = await admin.saveSlabs(req.body.slabs);
    await audit.record(req, "vc.pricing_updated", "setting", "vc_price_slabs", { before: { slabs: before }, after: { slabs: after } });
    return ok(res, await admin.pricingTable(), "Price slabs saved");
  },
  pricePreview: async (req, res) => {
    const settings = await settingsService.get("visiting_cards");
    const options = await orders.resolveOptions(req.body.options || []);
    const slabs = await require("../Models").VcPriceSlab.findAll();
    return ok(res, pricing.quote({ quantities: [req.body.quantity], doubleSided: Boolean(req.body.doubleSided), slabs, options, settings, interstate: false }));
  },
  printOptions: async (req, res) => ok(res, await admin.listOptions()),
  saveOption: async (req, res) => {
    const { option, before } = await admin.saveOption(req.body, req.params.id);
    await audit.record(req, req.params.id ? "vc.print_option_updated" : "vc.print_option_created", "vc_print_option", option.id, { before, after: option });
    return req.params.id ? ok(res, option, "Printing option saved") : created(res, option, "Printing option added");
  },
  deleteOption: async (req, res) => {
    const { before } = await admin.deleteOption(req.params.id);
    await audit.record(req, "vc.print_option_deleted", "vc_print_option", req.params.id, { before });
    return ok(res, null, "Printing option removed");
  },
  settings: async (req, res) => ok(res, await admin.getSettings()),
  saveSettings: async (req, res) => {
    const { before, after } = await admin.saveSettings(req.auth, req.body);
    await audit.record(req, "vc.settings_updated", "setting", "visiting_cards", { before, after });
    return ok(res, after, "Settings saved");
  },
};

module.exports = { customer, staff };

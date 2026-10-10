// Admin endpoints. Every write is recorded in the audit log (FR-AD-08).
const adminService = require("../Services/adminService");
const reportService = require("../Services/reportService");
const orderService = require("../Services/orderService");
const proofService = require("../Services/proofService");
const productionService = require("../Services/productionService");
const shipmentService = require("../Services/shipmentService");
const paymentService = require("../Services/paymentService");
const refundService = require("../Services/refundService");
const settlementService = require("../Services/settlementService");
const ticketService = require("../Services/ticketService");
const quoteService = require("../Services/quoteService");
const reviewService = require("../Services/reviewService");
const settingsService = require("../Services/settingsService");
const catalogService = require("../Services/catalogService");
const audit = require("../Services/auditService");
const ApiError = require("../Utils/ApiError");
const { ok, created, pageMeta } = require("../Utils/http");

const paging = (req, def = 20) => {
  const q = req.validatedQuery || req.query;
  return { page: Number(q.page) || 1, limit: Math.min(100, Number(q.limit) || def) };
};
const listed = (res, req, result, def) => ok(res, result.items, "OK", pageMeta(paging(req, def), result.total));

module.exports = {
  // ---- Dashboard and reports
  dashboard: async (req, res) => ok(res, await reportService.dashboard(req.auth, req.validatedQuery)),
  report: async (req, res) => {
    const kinds = { sales: reportService.sales, margin: reportService.margin, vendors: reportService.vendorPerformance, kpis: reportService.kpis, inventory: reportService.inventory };
    const fn = kinds[req.params.kind];
    if (!fn) throw ApiError.notFound("Unknown report");
    const rows = await fn(req.validatedQuery || {});
    if (req.validatedQuery?.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.kind}-report.csv"`);
      return res.send(reportService.toCsv(rows));
    }
    return ok(res, rows);
  },

  // ---- Catalogue
  categories: async (req, res) => ok(res, await adminService.listCategories()),
  saveCategory: async (req, res) => {
    const category = await adminService.saveCategory(req.body, req.params.id);
    await audit.record(req, req.params.id ? "category.updated" : "category.created", "category", category.id, { after: category });
    return req.params.id ? ok(res, category, "Category updated") : created(res, category, "Category created");
  },
  deleteCategory: async (req, res) => {
    await adminService.deleteCategory(req.params.id);
    await audit.record(req, "category.deleted", "category", req.params.id);
    return ok(res, null, "Category deleted");
  },
  products: async (req, res) => listed(res, req, await adminService.listProducts({ ...req.query, ...paging(req) })),
  product: async (req, res) => ok(res, await adminService.productForEdit(req.params.id)),
  saveProduct: async (req, res) => {
    const before = req.params.id ? await adminService.productForEdit(req.params.id) : null;
    const product = await adminService.saveProduct(req.auth, req.body, req.params.id);
    await audit.record(req, req.params.id ? "product.updated" : "product.created", "product", product.id, { before, after: req.body });
    return req.params.id ? ok(res, product, "Product saved") : created(res, product, "Product created");
  },
  productStatus: async (req, res) => {
    const { before, after } = await adminService.setProductStatus(req.params.id, req.body.status);
    await audit.record(req, "product.status", "product", req.params.id, { before: { status: before.status }, after: { status: after.status } });
    return ok(res, after, "Status updated");
  },
  deleteProduct: async (req, res) => {
    await adminService.deleteProduct(req.params.id);
    await audit.record(req, "product.deleted", "product", req.params.id);
    return ok(res, null, "Product removed");
  },
  productPreview: async (req, res) => ok(res, await catalogService.productDetail(req.params.slug, { includeInactive: true })),
  methods: async (req, res) => ok(res, await adminService.methods()),
  saveMethod: async (req, res) => {
    const method = await adminService.saveMethod(req.body, req.params.id);
    await audit.record(req, "method.saved", "decoration_method", method.id, { after: method });
    return ok(res, method, "Method saved");
  },

  // ---- Inventory
  inventory: async (req, res) => ok(res, await reportService.inventory()),
  adjustStock: async (req, res) => {
    const variant = await adminService.adjustStock(req.auth, req.params.id, req.body);
    await audit.record(req, "inventory.adjusted", "product_variant", req.params.id, { after: { ...req.body, balance: variant.stock_qty } });
    return ok(res, variant, "Stock updated");
  },
  stockHistory: async (req, res) => ok(res, await adminService.stockHistory(req.params.id)),

  // ---- Orders, proofs, production
  orders: async (req, res) => {
    const result = await orderService.list(req.auth, { ...req.validatedQuery, scope: "all", ...paging(req) });
    return listed(res, req, result);
  },
  order: async (req, res) => ok(res, await orderService.detail(req.auth, req.params.id)),
  transitionItem: async (req, res) => {
    const item = await orderService.adminTransition(req.auth, req.params.id, req.body);
    await audit.record(req, "order_item.state", "order_item", req.params.id, { after: req.body });
    return ok(res, item, "Order line updated");
  },
  cancelOrder: async (req, res) => {
    const result = await orderService.cancel(req.auth, req.params.id, req.body);
    await audit.record(req, "order.cancelled", "order", req.params.id, { after: { ...req.body, ...result } });
    return ok(res, result, "Order cancelled");
  },
  proofQueue: async (req, res) => ok(res, await proofService.queue()),
  createProof: async (req, res) => {
    const proof = await proofService.create(req.auth, req.body);
    await audit.record(req, "proof.sent", "proof", proof.id, { after: req.body });
    return created(res, proof, "Proof sent to the customer");
  },
  sourceOptions: async (req, res) => ok(res, await productionService.sourceOptions(req.params.id)),
  assign: async (req, res) => {
    const job = await productionService.assign(req.auth, { ...req.body, orderItemId: req.params.id });
    await audit.record(req, "order_item.assigned", "order_item", req.params.id, { after: req.body });
    return created(res, job, "Order line assigned");
  },
  jobs: async (req, res) => listed(res, req, await productionService.list(req.auth, { ...req.validatedQuery, ...paging(req, 50) }), 50),
  job: async (req, res) => ok(res, await productionService.detail(req.auth, req.params.id)),
  board: async (req, res) => ok(res, await productionService.board()),
  milestone: async (req, res) => ok(res, await productionService.updateMilestone(req.auth, req.params.id, req.body), "Status updated"),
  qc: async (req, res) => created(res, await productionService.recordQc(req.auth, req.params.id, req.body), "Quality check recorded"),
  ship: async (req, res) => {
    const shipment = await shipmentService.createShipment(req.auth, req.body);
    await audit.record(req, "shipment.created", "shipment", shipment.id, { after: req.body });
    return created(res, shipment, "Shipment created");
  },
  shipments: async (req, res) => listed(res, req, await shipmentService.list(req.auth, { ...paging(req, 30), status: req.query.status }), 30),
  tracking: async (req, res) => ok(res, await shipmentService.addTracking(req.auth, req.params.id, req.body), "Tracking updated"),

  // ---- Payments, refunds, settlements
  payments: async (req, res) => listed(res, req, await paymentService.list({ ...paging(req), status: req.query.status, provider: req.query.provider })),
  offlinePayment: async (req, res) => {
    const payment = await paymentService.recordOffline(req.auth, req.params.id, req.body);
    await audit.record(req, "payment.offline_recorded", "order", req.params.id, { after: req.body });
    return created(res, payment, "Payment recorded");
  },
  refunds: async (req, res) => listed(res, req, await refundService.list({ ...paging(req), status: req.query.status })),
  requestRefund: async (req, res) => {
    const refund = await refundService.request(req.auth, req.body);
    await audit.record(req, "refund.requested", "refund", refund.id, { after: req.body });
    return created(res, refund, refund.status === "processed" ? "Refund processed" : "Refund requested - waiting for finance approval");
  },
  decideRefund: async (req, res) => {
    const refund = await refundService.approve(req.auth, req.params.id, req.body);
    await audit.record(req, req.body.approve ? "refund.approved" : "refund.rejected", "refund", req.params.id, { after: req.body });
    return ok(res, refund, req.body.approve ? "Refund processed" : "Refund rejected");
  },
  settlements: async (req, res) => listed(res, req, await settlementService.list({ ...paging(req), vendorId: req.query.vendorId, status: req.query.status })),
  settlement: async (req, res) => ok(res, await settlementService.detail(req.params.id)),
  settlementPreview: async (req, res) => ok(res, await settlementService.preview(req.params.id)),
  generateSettlement: async (req, res) => {
    const settlement = await settlementService.generate(req.auth, req.body);
    await audit.record(req, "settlement.generated", "settlement", settlement.id, { after: settlement });
    return created(res, settlement, "Settlement generated");
  },
  settlementStatus: async (req, res) => {
    const settlement = await settlementService.setStatus(req.auth, req.params.id, req.body);
    await audit.record(req, `settlement.${req.body.status}`, "settlement", req.params.id, { after: req.body });
    return ok(res, settlement, "Settlement updated");
  },

  // ---- Quotes
  quotes: async (req, res) => {
    const result = await quoteService.list(req.auth, { ...req.validatedQuery, scope: "all", ...paging(req) });
    return listed(res, req, result);
  },

  // ---- People
  users: async (req, res) => listed(res, req, await adminService.listUsers({ ...req.query, ...paging(req) })),
  userStatus: async (req, res) => {
    const user = await adminService.setUserStatus(req.auth, req.params.id, req.body.status);
    await audit.record(req, `user.${req.body.status}`, "user", req.params.id);
    return ok(res, user, "Account updated");
  },
  userRoles: async (req, res) => {
    const roles = await adminService.setUserRoles(req.auth, req.params.id, req.body.roles);
    await audit.record(req, "user.roles", "user", req.params.id, { after: { roles } });
    return ok(res, roles, "Roles updated");
  },
  createStaff: async (req, res) => {
    const user = await adminService.createStaff(req.auth, { ...req.body, roleCodes: req.body.roles });
    await audit.record(req, "user.staff_created", "user", user.id, { after: { email: user.email, roles: req.body.roles } });
    return created(res, user, "Staff account created");
  },
  companies: async (req, res) => listed(res, req, await adminService.listCompanies({ ...req.query, ...paging(req) })),
  company: async (req, res) => ok(res, await adminService.companyDetail(req.params.id)),
  companyTerms: async (req, res) => {
    const { before, after } = await adminService.updateCompanyTerms(req.params.id, req.body);
    await audit.record(req, "company.terms", "company", req.params.id, { before, after });
    return ok(res, after, "Company terms updated");
  },
  vendors: async (req, res) => listed(res, req, await adminService.listVendors({ ...req.query, ...paging(req) })),
  vendor: async (req, res) => ok(res, await adminService.vendorDetail(req.params.id)),
  decideVendor: async (req, res) => {
    const { before, after } = await adminService.decideVendor(req.auth, req.params.id, req.body);
    await audit.record(req, `vendor.${req.body.status}`, "vendor", req.params.id, { before: { status: before.status }, after: { status: after.status, reason: req.body.reason } });
    return ok(res, after, "Vendor updated");
  },

  // ---- Coupons, support, reviews
  coupons: async (req, res) => ok(res, await adminService.listCoupons()),
  saveCoupon: async (req, res) => {
    const coupon = await adminService.saveCoupon(req.body, req.params.id);
    await audit.record(req, "coupon.saved", "coupon", coupon.id, { after: req.body });
    return ok(res, coupon, "Coupon saved");
  },
  tickets: async (req, res) => {
    const result = await ticketService.list(req.auth, { ...req.validatedQuery, scope: "all", ...paging(req) });
    return listed(res, req, result);
  },
  updateTicket: async (req, res) => ok(res, await ticketService.update(req.auth, req.params.id, req.body), "Ticket updated"),
  resolveComplaint: async (req, res) => {
    const result = await ticketService.resolveComplaint(req.auth, req.params.id, req.body);
    await audit.record(req, "complaint.resolved", "ticket", req.params.id, { after: req.body });
    return ok(res, result, "Complaint resolved");
  },
  reviews: async (req, res) => listed(res, req, await reviewService.list({ ...paging(req), status: req.query.status })),
  moderateReview: async (req, res) => {
    const review = await reviewService.moderate(req.params.id, req.body.status);
    await audit.record(req, `review.${req.body.status}`, "review", req.params.id);
    return ok(res, review, "Review updated");
  },

  // ---- Settings, roles, CMS, audit
  settings: async (req, res) => ok(res, { values: await settingsService.loadAll(), descriptions: settingsService.describe() }),
  saveSetting: async (req, res) => {
    const before = await settingsService.get(req.params.key);
    if (before === undefined) throw ApiError.notFound("Unknown setting");
    const value = await settingsService.set(req.params.key, req.body.value, req.auth.user.id);
    await audit.record(req, "setting.updated", "setting", req.params.key, { before, after: value });
    return ok(res, value, "Settings saved");
  },
  roles: async (req, res) => ok(res, await adminService.rolesMatrix()),
  setRolePermissions: async (req, res) => {
    const result = await adminService.setRolePermissions(req.auth, Number(req.params.id), req.body.permissions);
    await audit.record(req, "role.permissions", "role", req.params.id, { before: { permissionIds: result.before }, after: { permissionIds: result.after } });
    return ok(res, result.role, "Permissions updated");
  },
  pages: async (req, res) => ok(res, await adminService.listPages(req.query)),
  savePage: async (req, res) => {
    const page = await adminService.savePage(req.auth, req.body, req.params.id);
    await audit.record(req, "cms.saved", "cms_page", page.id, { after: { slug: page.slug, title: page.title } });
    return ok(res, page, "Page saved");
  },
  deletePage: async (req, res) => {
    await adminService.deletePage(req.params.id);
    await audit.record(req, "cms.deleted", "cms_page", req.params.id);
    return ok(res, null, "Page deleted");
  },
  audit: async (req, res) => listed(res, req, await adminService.auditLog({ ...req.query, ...paging(req, 30) }), 30),
};

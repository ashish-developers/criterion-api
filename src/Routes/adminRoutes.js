// /api/v1/admin - platform staff. Each endpoint requires a specific permission, so support
// agents and production staff only reach the parts their role allows.
const router = require("express").Router();
const c = require("../Controllers/adminController");
const v = require("../Validators/opsValidators");
const cv = require("../Validators/commerceValidators");
const { validate } = require("../Middleware/validate");
const { requireAuth, requirePermission: can } = require("../Middleware/auth");

const id = validate({ params: v.idParam });
router.use(requireAuth);

router.get("/dashboard", can("admin.dashboard.view"), validate({ query: v.reportQuery }), c.dashboard);
router.get("/reports/:kind", can("reports.view"), validate({ query: v.reportQuery }), c.report);

// Catalogue
router.get("/categories", can("catalogue.manage"), c.categories);
router.post("/categories", can("catalogue.manage"), validate({ body: v.category }), c.saveCategory);
router.put("/categories/:id", can("catalogue.manage"), id, validate({ body: v.category }), c.saveCategory);
router.delete("/categories/:id", can("catalogue.manage"), id, c.deleteCategory);
router.get("/products", can("catalogue.manage"), c.products);
router.post("/products", can("catalogue.manage"), validate({ body: v.product }), c.saveProduct);
router.get("/products/preview/:slug", can("catalogue.manage"), c.productPreview);
router.get("/products/:id", can("catalogue.manage"), id, c.product);
router.put("/products/:id", can("catalogue.manage"), id, validate({ body: v.product }), c.saveProduct);
router.post("/products/:id/status", can("catalogue.manage"), id, validate({ body: v.productStatus }), c.productStatus);
router.delete("/products/:id", can("catalogue.manage"), id, c.deleteProduct);
router.get("/methods", can("catalogue.manage", "pricing.manage"), c.methods);
router.post("/methods", can("pricing.manage"), validate({ body: v.method }), c.saveMethod);
router.put("/methods/:id", can("pricing.manage"), validate({ params: v.intIdParam, body: v.method }), c.saveMethod);

// Inventory
router.get("/inventory", can("inventory.manage"), c.inventory);
router.post("/inventory/:id/adjust", can("inventory.manage"), id, validate({ body: v.stockAdjust }), c.adjustStock);
router.get("/inventory/:id/history", can("inventory.manage"), id, c.stockHistory);

// Orders, proofs, production, shipping
router.get("/orders", can("orders.view", "production.view"), validate({ query: cv.orderList }), c.orders);
router.get("/orders/:id", can("orders.view", "production.view"), id, c.order);
router.post("/orders/:id/cancel", can("orders.manage"), id, validate({ body: cv.cancel }), c.cancelOrder);
router.post("/orders/:id/payments", can("payments.view"), can("refunds.approve"), id, validate({ body: v.offlinePayment }), c.offlinePayment);
router.post("/order-items/:id/transition", can("orders.manage"), id, validate({ body: v.itemTransition }), c.transitionItem);
router.get("/order-items/:id/sources", can("production.manage"), id, c.sourceOptions);
router.post("/order-items/:id/assign", can("production.manage"), id, validate({ body: v.assign }), c.assign);
router.get("/proofs/queue", can("proofs.manage"), c.proofQueue);
router.post("/proofs", can("proofs.manage"), validate({ body: v.proofCreate }), c.createProof);
router.get("/production/board", can("production.view"), c.board);
router.get("/production/jobs", can("production.view"), validate({ query: v.jobList }), c.jobs);
router.get("/production/jobs/:id", can("production.view"), id, c.job);
router.post("/production/jobs/:id/events", can("production.manage"), id, validate({ body: v.milestone }), c.milestone);
router.post("/production/jobs/:id/qc", can("qc.perform"), id, validate({ body: v.qc }), c.qc);
router.post("/shipments", can("shipping.manage"), validate({ body: v.shipment }), c.ship);
router.get("/shipments", can("shipping.manage"), c.shipments);
router.post("/shipments/:id/tracking", can("shipping.manage"), id, validate({ body: v.tracking }), c.tracking);

// Money
router.get("/payments", can("payments.view"), c.payments);
router.get("/refunds", can("refunds.request", "refunds.approve"), c.refunds);
router.post("/refunds", can("refunds.request", "refunds.approve"), validate({ body: v.refundRequest }), c.requestRefund);
router.post("/refunds/:id/decision", can("refunds.approve"), id, validate({ body: v.refundDecision }), c.decideRefund);
router.get("/settlements", can("settlements.manage"), c.settlements);
router.post("/settlements", can("settlements.manage"), validate({ body: v.settlementGenerate }), c.generateSettlement);
router.get("/settlements/vendor/:id/preview", can("settlements.manage"), id, c.settlementPreview);
router.get("/settlements/:id", can("settlements.manage"), id, c.settlement);
router.post("/settlements/:id/status", can("settlements.manage"), id, validate({ body: v.settlementStatus }), c.settlementStatus);

// Quotes (pricing endpoints live under /quotes/:id with quotes.manage)
router.get("/quotes", can("quotes.view"), validate({ query: cv.quoteList }), c.quotes);

// People
router.get("/users", can("customers.view"), c.users);
router.post("/users/staff", can("roles.manage"), validate({ body: v.staffCreate }), c.createStaff);
router.post("/users/:id/status", can("customers.manage"), id, validate({ body: v.userStatus }), c.userStatus);
router.put("/users/:id/roles", can("roles.manage"), id, validate({ body: v.userRoles }), c.userRoles);
router.get("/companies", can("customers.view"), c.companies);
router.get("/companies/:id", can("customers.view"), id, c.company);
router.put("/companies/:id/terms", can("customers.manage"), id, validate({ body: v.companyTerms }), c.companyTerms);
router.get("/vendors", can("vendors.view", "production.manage"), c.vendors);
router.get("/vendors/:id", can("vendors.view"), id, c.vendor);
router.post("/vendors/:id/decision", can("vendors.manage"), id, validate({ body: v.vendorDecision }), c.decideVendor);

// Promotions, support, reviews
router.get("/coupons", can("coupons.manage"), c.coupons);
router.post("/coupons", can("coupons.manage"), validate({ body: v.coupon }), c.saveCoupon);
router.put("/coupons/:id", can("coupons.manage"), id, validate({ body: v.coupon }), c.saveCoupon);
router.get("/tickets", can("tickets.manage"), validate({ query: cv.ticketList }), c.tickets);
router.patch("/tickets/:id", can("tickets.manage"), id, validate({ body: v.ticketUpdate }), c.updateTicket);
router.post("/tickets/:id/resolve", can("tickets.manage"), id, validate({ body: v.complaintDecision }), c.resolveComplaint);
router.get("/reviews", can("reviews.moderate"), c.reviews);
router.post("/reviews/:id/moderate", can("reviews.moderate"), id, validate({ body: v.reviewModerate }), c.moderateReview);

// Settings, roles, CMS, audit
router.get("/settings", can("settings.manage"), c.settings);
router.put("/settings/:key", can("settings.manage"), validate({ params: v.keyParam, body: v.settingValue }), c.saveSetting);
router.get("/roles", can("roles.manage"), c.roles);
router.put("/roles/:id/permissions", can("roles.manage"), validate({ params: v.intIdParam, body: v.rolePermissions }), c.setRolePermissions);
router.get("/pages", can("cms.manage"), c.pages);
router.post("/pages", can("cms.manage"), validate({ body: v.page }), c.savePage);
router.put("/pages/:id", can("cms.manage"), id, validate({ body: v.page }), c.savePage);
router.delete("/pages/:id", can("cms.manage"), id, c.deletePage);
router.get("/audit-logs", can("audit.view"), c.audit);

module.exports = router;

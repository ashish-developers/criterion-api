const vendorService = require("../Services/vendorService");
const productionService = require("../Services/productionService");
const shipmentService = require("../Services/shipmentService");
const settlementService = require("../Services/settlementService");
const { sequelize } = require("../Models");
const { ok, created, pageMeta } = require("../Utils/http");

module.exports = {
  me: async (req, res) => ok(res, await vendorService.myVendor(req.auth)),
  apply: async (req, res) => created(res, await vendorService.apply(req.auth, req.body), "Application submitted. We will verify your details and notify you."),
  updateProfile: async (req, res) => ok(res, await vendorService.updateProfile(req.auth, req.body), "Profile updated"),
  setHolidays: async (req, res) => ok(res, await vendorService.setHolidays(req.auth, req.body.holidays), "Holidays saved"),
  staff: async (req, res) => ok(res, await vendorService.staff(req.auth)),
  addStaff: async (req, res) => created(res, await vendorService.addStaff(req.auth, req.body), "Staff member added"),
  removeStaff: async (req, res) => {
    await vendorService.removeStaff(req.auth, Number(req.params.id));
    return ok(res, null, "Staff member removed");
  },
  dashboard: async (req, res) => {
    const vendorId = req.auth.vendorId;
    const [performance, earnings, jobs] = await Promise.all([
      vendorService.performance(vendorId),
      settlementService.pendingEarnings(vendorId),
      productionService.list(req.auth, { status: "assigned,accepted,in_production,quality_check,ready_for_dispatch", limit: 8 }),
    ]);
    const [[listings]] = await sequelize.query(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'pending_approval')::int AS pending FROM products WHERE vendor_id = :vendorId AND deleted_at IS NULL`,
      { replacements: { vendorId } }
    );
    return ok(res, { performance, earnings, openJobs: jobs.items, listings });
  },
  performance: async (req, res) => ok(res, await vendorService.performance(req.auth.vendorId)),

  // Listings
  listings: async (req, res) => ok(res, await vendorService.listings(req.auth)),
  createListing: async (req, res) => created(res, await vendorService.saveListing(req.auth, req.body), "Listing submitted for approval"),
  updateListing: async (req, res) => ok(res, await vendorService.saveListing(req.auth, req.body, req.params.id), "Listing updated and sent for approval"),
  setListingActive: async (req, res) => ok(res, await vendorService.setListingActive(req.auth, req.params.id, Boolean(req.body.active)), "Listing updated"),

  // Jobs
  jobs: async (req, res) => {
    const query = req.validatedQuery;
    const page = query.page || 1;
    const limit = query.limit || 50;
    const result = await productionService.list(req.auth, { ...query, page, limit });
    return ok(res, result.items, "OK", pageMeta({ page, limit }, result.total));
  },
  job: async (req, res) => ok(res, await productionService.detail(req.auth, req.params.id)),
  respond: async (req, res) => ok(res, await productionService.respond(req.auth, req.params.id, req.body), req.body.accept ? "Job accepted" : "Job declined"),
  milestone: async (req, res) => ok(res, await productionService.updateMilestone(req.auth, req.params.id, req.body), "Status updated"),
  qc: async (req, res) => created(res, await productionService.recordQc(req.auth, req.params.id, req.body), req.body.result === "pass" ? "Quality check passed" : "Quality check failed - reprint started"),
  ship: async (req, res) => created(res, await shipmentService.createShipment(req.auth, { ...req.body, jobIds: [req.params.id] }), "Shipment created"),
  shipments: async (req, res) => {
    const result = await shipmentService.list(req.auth, { page: Number(req.query.page) || 1, limit: 30, status: req.query.status });
    return ok(res, result.items, "OK", pageMeta({ page: Number(req.query.page) || 1, limit: 30 }, result.total));
  },
  tracking: async (req, res) => ok(res, await shipmentService.addTracking(req.auth, req.params.id, req.body), "Tracking updated"),

  // Settlements
  settlements: async (req, res) => {
    const result = await settlementService.list({ vendorId: req.auth.vendorId, page: Number(req.query.page) || 1 });
    return ok(res, { items: result.items, earnings: await settlementService.pendingEarnings(req.auth.vendorId) }, "OK", pageMeta({ page: Number(req.query.page) || 1, limit: 20 }, result.total));
  },
  settlement: async (req, res) => ok(res, await settlementService.detail(req.params.id, { vendorId: req.auth.vendorId })),
};

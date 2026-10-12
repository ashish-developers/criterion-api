// Vendor portal (FR-VP-01, 05, 07): application with KYC, profile and capabilities,
// listings, staff, holidays and the performance dashboard.
const taxService = require("./taxService");
const { Op } = require("sequelize");
const {
  sequelize,
  Vendor,
  VendorUser,
  VendorCapability,
  VendorHoliday,
  DecorationMethod,
  User,
  Product,
  ProductVariant,
  ProductMethod,
  PrintArea,
  PriceTier,
  ProductSource,
  Category,
} = require("../Models");
const ApiError = require("../Utils/ApiError");
const { encrypt, hashPassword, randomToken } = require("../Utils/crypto");
const authService = require("./authService");
const notificationService = require("./notificationService");

function present(vendor) {
  const json = vendor.toJSON();
  delete json.bank_account_number_enc;
  return json;
}

async function myVendor(auth) {
  if (!auth.vendorId) return null;
  const vendor = await Vendor.findByPk(auth.vendorId, {
    include: [
      { model: VendorCapability, as: "capabilities", include: [{ model: DecorationMethod, as: "method" }] },
      { model: VendorHoliday, as: "holidays" },
    ],
  });
  return vendor ? present(vendor) : null;
}

function kycFields(data) {
  const fields = {
    business_name: data.businessName,
    legal_name: data.legalName,
    vendor_type: data.vendorType,
    gstin: data.gstin,
    pan: data.pan,
    bank_account_name: data.bankAccountName,
    bank_ifsc: data.bankIfsc,
    contact_email: data.contactEmail,
    contact_phone: data.contactPhone,
    address: data.address,
    pincode: data.address?.pincode,
    service_pincode_prefixes: data.servicePincodePrefixes || [],
    machines: data.machines,
    daily_capacity: data.dailyCapacity,
  };
  if (data.bankAccountNumber) {
    // Stored encrypted; only the last four digits are ever shown.
    fields.bank_account_number_enc = encrypt(data.bankAccountNumber);
    fields.bank_account_last4 = data.bankAccountNumber.slice(-4);
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

async function apply(auth, data) {
  if (auth.user.account_type !== "vendor") throw ApiError.forbidden("Register a vendor account to apply as a vendor");
  return sequelize.transaction(async (transaction) => {
    let vendor = await Vendor.findOne({ where: { owner_user_id: auth.user.id }, transaction });
    if (vendor && !["draft", "rejected", "applied"].includes(vendor.status)) {
      throw ApiError.conflict("Your application is already under review or approved", "APPLICATION_LOCKED");
    }
    if (!data.bankAccountNumber && !vendor?.bank_account_number_enc) throw ApiError.unprocessable("Enter your bank account number", "BANK_REQUIRED", { bankAccountNumber: "Required" });
    const fields = { ...kycFields(data), status: "applied", rejection_reason: null };
    if (vendor) await vendor.update(fields, { transaction });
    else vendor = await Vendor.create({ ...fields, owner_user_id: auth.user.id }, { transaction });
    await VendorUser.findOrCreate({ where: { vendor_id: vendor.id, user_id: auth.user.id }, defaults: { member_role: "admin" }, transaction });
    await authService.assignRole(auth.user.id, "vendor_admin", "vendor", vendor.id, transaction);
    await saveCapabilities(vendor.id, data.capabilities || [], transaction);
    transaction.afterCommit(() =>
      require("./productionService")
        .notifyStaff("vendors.manage", { type: "vendor_applied", title: `Vendor application: ${vendor.business_name}`, body: "Review KYC and capabilities.", link: `/admin/vendors/${vendor.id}` })
        .catch(() => {})
    );
    return present(vendor);
  });
}

async function saveCapabilities(vendorId, capabilities, transaction) {
  const methods = await DecorationMethod.findAll({ transaction });
  const byCode = new Map(methods.map((m) => [m.code, m]));
  const keep = [];
  for (const c of capabilities) {
    const method = byCode.get(c.methodCode);
    if (!method) throw ApiError.unprocessable(`Unknown method ${c.methodCode}`, "METHOD_INVALID");
    if (c.maxQty < c.minQty) throw ApiError.unprocessable(`${method.name}: maximum quantity must be at least the minimum`, "QTY_RANGE");
    const [cap] = await VendorCapability.findOrCreate({ where: { vendor_id: vendorId, method_id: method.id }, defaults: { vendor_id: vendorId, method_id: method.id }, transaction });
    await cap.update(
      { min_qty: c.minQty, max_qty: c.maxQty, daily_capacity: c.dailyCapacity, lead_time_days: c.leadTimeDays, cost_per_unit_paise: c.costPerUnitPaise || 0, is_active: c.isActive !== false },
      { transaction }
    );
    keep.push(cap.id);
  }
  await VendorCapability.update({ is_active: false }, { where: { vendor_id: vendorId, id: { [Op.notIn]: keep.length ? keep : [0] } }, transaction });
}

async function updateProfile(auth, data) {
  return sequelize.transaction(async (transaction) => {
    const vendor = await Vendor.findByPk(auth.vendorId, { transaction });
    if (!vendor) throw ApiError.notFound("Vendor not found");
    const fields = kycFields(data);
    // Changing legal or bank identity after approval needs re-verification.
    const sensitive = ["gstin", "pan", "bank_account_number_enc", "bank_ifsc"].some((k) => fields[k] !== undefined && fields[k] !== vendor[k]);
    if (vendor.status === "approved" && sensitive) fields.status = "under_review";
    await vendor.update(fields, { transaction });
    if (data.capabilities) await saveCapabilities(vendor.id, data.capabilities, transaction);
    return present(vendor);
  });
}

async function setHolidays(auth, holidays) {
  await VendorHoliday.destroy({ where: { vendor_id: auth.vendorId } });
  await VendorHoliday.bulkCreate(holidays.map((h) => ({ vendor_id: auth.vendorId, holiday: h.date, note: h.note || null })));
  return VendorHoliday.findAll({ where: { vendor_id: auth.vendorId }, order: [["holiday", "ASC"]] });
}

async function staff(auth) {
  const members = await VendorUser.findAll({ where: { vendor_id: auth.vendorId }, include: [{ model: User, as: "user", attributes: ["id", "name", "email", "phone", "status"] }] });
  return members.map((m) => ({ id: m.id, role: m.member_role, user: m.user }));
}

async function addStaff(auth, { name, email, phone }) {
  return sequelize.transaction(async (transaction) => {
    const normalised = email.toLowerCase();
    let user = await User.findOne({ where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), normalised), transaction });
    if (user && (await VendorUser.findOne({ where: { user_id: user.id }, transaction }))) throw ApiError.conflict("This person already belongs to a vendor", "ALREADY_MEMBER");
    if (user && user.account_type !== "vendor") throw ApiError.conflict("This email is registered as a different account type", "ACCOUNT_TYPE_MISMATCH");
    if (!user) {
      user = await User.create({ name, email: normalised, phone, password_hash: await hashPassword(randomToken(24)), account_type: "vendor", status: "pending" }, { transaction });
    }
    await VendorUser.create({ vendor_id: auth.vendorId, user_id: user.id, member_role: "staff" }, { transaction });
    await authService.assignRole(user.id, "vendor_staff", "vendor", auth.vendorId, transaction);
    await notificationService.notify(user.id, { type: "team_invite", title: "You have been added as vendor staff", body: 'Use "Forgot password" with this email to set your password, then sign in.', link: "/forgot-password" }, { transaction });
    return user;
  });
}

async function removeStaff(auth, memberId) {
  const member = await VendorUser.findOne({ where: { id: memberId, vendor_id: auth.vendorId } });
  if (!member) throw ApiError.notFound("Staff member not found");
  if (member.member_role === "admin") throw ApiError.forbidden("The vendor admin cannot be removed");
  const { UserRole, Role } = require("../Models");
  const role = await Role.findOne({ where: { code: "vendor_staff" } });
  await UserRole.destroy({ where: { user_id: member.user_id, role_id: role.id, scope_id: auth.vendorId } });
  await member.destroy();
}

// ---- Listings (marketplace products owned by the vendor; admin approves before going live)
async function listings(auth) {
  const products = await Product.findAll({
    where: { vendor_id: auth.vendorId },
    include: [{ model: ProductVariant, as: "variants" }, { model: Category, as: "category", attributes: ["id", "name"] }, { model: ProductMethod, as: "methods" }],
    order: [["created_at", "DESC"]],
  });
  return products;
}

async function saveListing(auth, data, id) {
  return sequelize.transaction(async (transaction) => {
    let product;
    if (id) {
      product = await Product.findOne({ where: { id, vendor_id: auth.vendorId }, transaction });
      if (!product) throw ApiError.notFound("Listing not found");
    }
    const category = await Category.findByPk(data.categoryId, { transaction });
    if (!category) throw ApiError.unprocessable("Choose a category", "CATEGORY_INVALID");
    const fields = {
      category_id: category.id,
      name: data.name,
      short_description: data.shortDescription,
      description: data.description,
      images: data.images || [],
      base_cost_paise: data.pricePaise,
      packaging_cost_paise: 0,
      hsn_code: data.hsnCode,
      // GST from the tax master (chosen rate, else HSN mapping, else category default).
      ...(await taxService.resolveForProduct({ taxRateId: data.taxRateId, gstRate: data.gstRate, hsnCode: data.hsnCode, categoryId: category.id, currentTaxRateId: product?.tax_rate_id }, transaction)),
      moq: data.moq,
      max_instant_qty: data.maxInstantQty || 199,
      lead_time_days: data.leadTimeDays,
      weight_grams: data.weightGrams || 250,
      is_customisable: data.methods?.length > 0,
      supports_live_preview: false,
      tags: data.tags || [],
      occasions: data.occasions || [],
      // Every create or edit goes back to the admin for approval.
      status: "pending_approval",
    };
    if (product) await product.update(fields, { transaction });
    else {
      const base = data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 180);
      let slug = base;
      for (let n = 2; await Product.findOne({ where: { slug }, paranoid: false, transaction }); n++) slug = `${base}-${n}`;
      product = await Product.create({ ...fields, slug, source_type: "vendor_listing", vendor_id: auth.vendorId, created_by: auth.user.id }, { transaction });
      await PriceTier.bulkCreate(
        [
          { product_id: product.id, min_qty: 1, max_qty: 49, margin_pct: 0, checkout_path: "instant" },
          { product_id: product.id, min_qty: 50, max_qty: null, margin_pct: 0, checkout_path: "instant_or_quote" },
        ],
        { transaction }
      );
      await ProductSource.create({ product_id: product.id, source: "vendor", vendor_id: auth.vendorId, cost_paise: data.pricePaise, lead_time_days: data.leadTimeDays, is_default: true }, { transaction });
      await PrintArea.create({ product_id: product.id, code: "main", name: "Main area", width_mm: 80, height_mm: 80, box: { x: 30, y: 30, w: 40, h: 40 } }, { transaction });
    }
    // Variants: replace the set by SKU.
    const existing = await ProductVariant.findAll({ where: { product_id: product.id }, transaction });
    const keep = new Set();
    for (const v of data.variants) {
      const sku = v.sku.toUpperCase();
      const clash = await ProductVariant.findOne({ where: { sku, product_id: { [Op.ne]: product.id } }, transaction });
      if (clash) throw ApiError.conflict(`SKU ${sku} is already used`, "SKU_TAKEN");
      const found = existing.find((e) => e.sku === sku);
      const fields2 = { attributes: v.attributes, stock_qty: v.stockQty ?? 0, track_inventory: v.trackInventory !== false, color_hex: v.colorHex || null, image: v.image || null, is_active: true };
      if (found) {
        await found.update(fields2, { transaction });
        keep.add(found.id);
      } else {
        const created = await ProductVariant.create({ ...fields2, sku, product_id: product.id }, { transaction });
        keep.add(created.id);
      }
    }
    for (const e of existing) if (!keep.has(e.id)) await e.update({ is_active: false }, { transaction });
    // Methods the vendor offers on this listing.
    const methods = await DecorationMethod.findAll({ where: { code: (data.methods || []).map((m) => m.code) }, transaction });
    await ProductMethod.destroy({ where: { product_id: product.id }, transaction });
    for (const [i, m] of (data.methods || []).entries()) {
      const method = methods.find((x) => x.code === m.code);
      if (!method) continue;
      await ProductMethod.create({ product_id: product.id, method_id: method.id, cost_per_unit_paise: m.costPerUnitPaise, setup_fee_paise: m.setupFeePaise || 0, moq: m.moq || 1, is_default: i === 0 }, { transaction });
    }
    transaction.afterCommit(() =>
      require("./productionService").notifyStaff("catalogue.manage", { type: "listing_review", title: `Listing awaiting approval: ${product.name}`, body: "A vendor listing was created or changed.", link: `/admin/products/${product.id}` }).catch(() => {})
    );
    return product;
  });
}

async function setListingActive(auth, id, active) {
  const product = await Product.findOne({ where: { id, vendor_id: auth.vendorId } });
  if (!product) throw ApiError.notFound("Listing not found");
  if (active && product.status !== "inactive") throw ApiError.conflict("Only approved listings that were paused can be re-activated", "LISTING_NOT_APPROVED");
  await product.update({ status: active ? "active" : "inactive" });
  return product;
}

// Performance dashboard (FR-VP-07).
async function performance(vendorId) {
  const [rows] = await sequelize.query(
    `SELECT
       count(*) FILTER (WHERE j.status <> 'cancelled')::int AS jobs,
       count(*) FILTER (WHERE j.status = 'rejected')::int AS rejected,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (j.accepted_at - j.assigned_at)) / 3600)
         FILTER (WHERE j.accepted_at IS NOT NULL) AS median_accept_hours,
       count(*) FILTER (WHERE j.dispatched_at IS NOT NULL)::int AS dispatched,
       count(*) FILTER (WHERE j.dispatched_at IS NOT NULL AND j.dispatched_at::date <= j.due_date)::int AS on_time,
       count(*) FILTER (WHERE j.status IN ('assigned','accepted','in_production','quality_check','ready_for_dispatch'))::int AS open_jobs,
       COALESCE(sum(j.quantity) FILTER (WHERE j.dispatched_at IS NOT NULL), 0)::int AS units_shipped
     FROM production_jobs j WHERE j.vendor_id = :vendorId`,
    { replacements: { vendorId } }
  );
  const [qc] = await sequelize.query(
    `SELECT COALESCE(sum(q.defect_qty),0)::int AS defects, count(*) FILTER (WHERE q.result = 'fail')::int AS failed_checks, count(*)::int AS checks
       FROM qc_checks q JOIN production_jobs j ON j.id = q.job_id WHERE j.vendor_id = :vendorId`,
    { replacements: { vendorId } }
  );
  const vendor = await Vendor.findByPk(vendorId, { attributes: ["quality_score", "commission_pct", "status"] });
  const r = rows[0];
  return {
    qualityScore: Number(vendor.quality_score),
    jobs: r.jobs,
    openJobs: r.open_jobs,
    rejected: r.rejected,
    medianAcceptHours: r.median_accept_hours === null ? null : Math.round(r.median_accept_hours * 10) / 10,
    onTimePct: r.dispatched ? Math.round((r.on_time / r.dispatched) * 1000) / 10 : null,
    unitsShipped: r.units_shipped,
    defectRatePct: r.units_shipped ? Math.round((qc[0].defects / r.units_shipped) * 1000) / 10 : 0,
    qcChecks: qc[0].checks,
    qcFailed: qc[0].failed_checks,
  };
}

module.exports = { myVendor, apply, updateProfile, setHolidays, staff, addStaff, removeStaff, listings, saveListing, setListingActive, performance, present, saveCapabilities };

// Platform administration (FR-AD-01, 04, 05, 07): catalogue CRUD, customers, companies,
// vendor approval, coupons, inventory, settings, roles and CMS. Callers audit-log writes.
const taxService = require("./taxService");
const { Op } = require("sequelize");
const {
  sequelize,
  User,
  UserRole,
  Role,
  Permission,
  RolePermission,
  Company,
  CompanyMember,
  Vendor,
  VendorCapability,
  DecorationMethod,
  Category,
  Product,
  ProductVariant,
  PrintArea,
  ProductMethod,
  PriceTier,
  ProductSource,
  BundleItem,
  InventoryMovement,
  Coupon,
  CmsPage,
  AuditLog,
  Session,
  Order,
  TaxRate,
} = require("../Models");
const ApiError = require("../Utils/ApiError");
const accessService = require("./accessService");
const notificationService = require("./notificationService");

// ------------------------------------------------------------------ catalogue
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 180);
}

async function uniqueSlug(model, base, excludeId, transaction) {
  let slug = base;
  for (let n = 2; ; n++) {
    const where = { slug };
    if (excludeId) where.id = { [Op.ne]: excludeId };
    const clash = await model.findOne({ where, paranoid: false, transaction });
    if (!clash) return slug;
    slug = `${base}-${n}`;
  }
}

async function listCategories() {
  return Category.findAll({ order: [["sort_order", "ASC"], ["name", "ASC"]] });
}

async function saveCategory(data, id) {
  if (data.defaultTaxRateId) {
    const rate = await TaxRate.findByPk(data.defaultTaxRateId);
    if (!rate || !rate.is_active) throw ApiError.unprocessable("Choose an active GST rate", "TAX_RATE_INVALID", { defaultTaxRateId: "Choose an active GST rate" });
  }
  const fields = {
    name: data.name,
    parent_id: data.parentId || null,
    description: data.description || null,
    image: data.image || null,
    default_lead_time_days: data.defaultLeadTimeDays ?? 5,
    default_tax_rate_id: data.defaultTaxRateId || null,
    sort_order: data.sortOrder ?? 0,
    is_active: data.isActive !== false,
  };
  if (id) {
    const category = await Category.findByPk(id);
    if (!category) throw ApiError.notFound("Category not found");
    if (data.parentId === id) throw ApiError.unprocessable("A category cannot be its own parent", "CATEGORY_PARENT");
    return category.update({ ...fields, slug: await uniqueSlug(Category, data.slug || slugify(data.name), id) });
  }
  return Category.create({ ...fields, slug: await uniqueSlug(Category, data.slug || slugify(data.name)) });
}

async function deleteCategory(id) {
  const used = await Product.count({ where: { category_id: id } });
  if (used) throw ApiError.conflict("Move or delete the products in this category first", "CATEGORY_IN_USE");
  await Category.update({ parent_id: null }, { where: { parent_id: id } });
  await Category.destroy({ where: { id } });
}

async function listProducts({ q, status, categoryId, source, page = 1, limit = 20 }) {
  const where = {};
  if (q) where[Op.or] = [{ name: { [Op.iLike]: `%${q}%` } }, { slug: { [Op.iLike]: `%${q}%` } }];
  if (status) where.status = status;
  if (categoryId) where.category_id = categoryId;
  if (source) where.source_type = source;
  const { rows, count } = await Product.findAndCountAll({
    where,
    include: [
      { model: Category, as: "category", attributes: ["id", "name"] },
      { model: Vendor, as: "vendor", attributes: ["id", "business_name"] },
      { model: ProductVariant, as: "variants", attributes: ["id", "stock_qty", "track_inventory", "is_active", "low_stock_threshold"] },
    ],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  return {
    items: rows.map((p) => ({
      ...p.toJSON(),
      stock: p.variants.filter((v) => v.track_inventory && v.is_active).reduce((s, v) => s + v.stock_qty, 0),
      lowStockVariants: p.variants.filter((v) => v.track_inventory && v.is_active && v.stock_qty <= v.low_stock_threshold).length,
      variantCount: p.variants.length,
    })),
    total: count,
  };
}

async function productForEdit(id) {
  const product = await Product.findByPk(id, {
    include: [
      { model: Category, as: "category" },
      { model: TaxRate, as: "taxRate" },
      { model: Vendor, as: "vendor", attributes: ["id", "business_name"] },
      { model: ProductVariant, as: "variants" },
      { model: PrintArea, as: "printAreas" },
      { model: ProductMethod, as: "methods", include: [{ model: DecorationMethod, as: "method" }] },
      { model: PriceTier, as: "priceTiers" },
      { model: ProductSource, as: "sources", include: [{ model: Vendor, as: "vendor", attributes: ["id", "business_name"] }] },
      { model: BundleItem, as: "bundleItems", include: [{ model: Product, as: "component", attributes: ["id", "name", "slug"] }] },
    ],
    paranoid: false,
  });
  if (!product) throw ApiError.notFound("Product not found");
  return product;
}

/** Saves a product with its variants, print areas, methods, tiers and sources in one transaction. */
async function saveProduct(auth, data, id) {
  return sequelize.transaction(async (transaction) => {
    const fields = {
      category_id: data.categoryId,
      name: data.name,
      short_description: data.shortDescription || null,
      description: data.description || null,
      images: data.images || [],
      base_cost_paise: data.baseCostPaise,
      packaging_cost_paise: data.packagingCostPaise || 0,
      express_uplift_pct: data.expressUpliftPct ?? 20,
      hsn_code: data.hsnCode,
      moq: data.moq,
      max_instant_qty: data.maxInstantQty,
      lead_time_days: data.leadTimeDays,
      weight_grams: data.weightGrams,
      specifications: data.specifications || {},
      care_instructions: data.careInstructions || null,
      occasions: data.occasions || [],
      tags: data.tags || [],
      is_customisable: data.isCustomisable,
      supports_live_preview: data.supportsLivePreview,
      min_dpi: data.minDpi ?? 150,
      block_below_dpi: data.blockBelowDpi ?? 72,
      max_text_lines: data.maxTextLines ?? 3,
      status: data.status,
      is_featured: Boolean(data.isFeatured),
    };
    const category = await Category.findByPk(data.categoryId, { transaction });
    if (!category) throw ApiError.unprocessable("Choose a category", "CATEGORY_INVALID", { categoryId: "Choose a category" });
    let product;
    if (id) {
      product = await Product.findByPk(id, { transaction, paranoid: false });
      if (!product) throw ApiError.notFound("Product not found");
    }
    // GST comes from the tax master: chosen rate, else the HSN mapping, else the category default.
    Object.assign(fields, await taxService.resolveForProduct({ taxRateId: data.taxRateId, gstRate: data.gstRate, hsnCode: data.hsnCode, categoryId: category.id, currentTaxRateId: product?.tax_rate_id }, transaction));
    if (id) {
      await product.update({ ...fields, slug: await uniqueSlug(Product, data.slug || slugify(data.name), id, transaction) }, { transaction });
    } else {
      product = await Product.create(
        { ...fields, source_type: data.sourceType || "own", slug: await uniqueSlug(Product, data.slug || slugify(data.name), null, transaction), created_by: auth.user.id },
        { transaction }
      );
    }

    // Variants (matched by id, else created). Removed variants are deactivated, never deleted,
    // because past orders reference them.
    const existing = await ProductVariant.findAll({ where: { product_id: product.id }, transaction });
    const keep = new Set();
    for (const v of data.variants) {
      const sku = v.sku.trim().toUpperCase();
      const clash = await ProductVariant.findOne({ where: { sku, id: { [Op.ne]: v.id || "00000000-0000-0000-0000-000000000000" } }, transaction });
      if (clash) throw ApiError.conflict(`SKU ${sku} is already in use`, "SKU_TAKEN");
      const vf = {
        sku,
        attributes: v.attributes || {},
        color_hex: v.colorHex || null,
        image: v.image || null,
        cost_adjust_paise: v.costAdjustPaise || 0,
        track_inventory: v.trackInventory !== false,
        low_stock_threshold: v.lowStockThreshold ?? 10,
        is_active: v.isActive !== false,
      };
      const found = v.id && existing.find((e) => e.id === v.id);
      if (found) {
        await found.update(vf, { transaction });
        keep.add(found.id);
      } else {
        const created = await ProductVariant.create({ ...vf, product_id: product.id, stock_qty: v.stockQty || 0 }, { transaction });
        if (v.stockQty) await InventoryMovement.create({ variant_id: created.id, change_qty: v.stockQty, balance_after: v.stockQty, reason: "initial", created_by: auth.user.id }, { transaction });
        keep.add(created.id);
      }
    }
    for (const e of existing) if (!keep.has(e.id)) await e.update({ is_active: false }, { transaction });

    await PrintArea.destroy({ where: { product_id: product.id }, transaction });
    for (const [i, a] of (data.printAreas || []).entries()) {
      await PrintArea.create(
        { product_id: product.id, code: a.code, name: a.name, width_mm: a.widthMm, height_mm: a.heightMm, safe_margin_mm: a.safeMarginMm ?? 3, box: a.box, allowed_methods: a.allowedMethods || [], max_text_chars: a.maxTextChars ?? 40, sort_order: i },
        { transaction }
      );
    }
    await ProductMethod.destroy({ where: { product_id: product.id }, transaction });
    for (const m of data.methods || []) {
      await ProductMethod.create(
        { product_id: product.id, method_id: m.methodId, cost_per_unit_paise: m.costPerUnitPaise, setup_fee_paise: m.setupFeePaise || 0, moq: m.moq || 1, is_default: Boolean(m.isDefault) },
        { transaction }
      );
    }
    await PriceTier.destroy({ where: { product_id: product.id }, transaction });
    for (const t of data.priceTiers || []) {
      await PriceTier.create({ product_id: product.id, min_qty: t.minQty, max_qty: t.maxQty || null, margin_pct: t.marginPct, checkout_path: t.checkoutPath }, { transaction });
    }
    if (data.sources) {
      await ProductSource.destroy({ where: { product_id: product.id }, transaction });
      for (const s of data.sources) {
        await ProductSource.create(
          { product_id: product.id, source: s.source, vendor_id: s.source === "vendor" ? s.vendorId : null, cost_paise: s.costPaise || 0, lead_time_days: s.leadTimeDays || product.lead_time_days, is_default: Boolean(s.isDefault) },
          { transaction }
        );
      }
    }
    if (data.bundleItems) {
      await BundleItem.destroy({ where: { kit_product_id: product.id }, transaction });
      for (const b of data.bundleItems) {
        await BundleItem.create({ kit_product_id: product.id, component_product_id: b.productId, component_variant_id: b.variantId || null, quantity: b.quantity || 1 }, { transaction });
      }
    }
    return product;
  });
}

async function setProductStatus(id, status) {
  const product = await Product.findByPk(id, { paranoid: false });
  if (!product) throw ApiError.notFound("Product not found");
  const before = product.toJSON();
  await product.update({ status });
  if (product.vendor_id && ["active", "rejected"].includes(status)) {
    await require("./productionService").notifyVendor(product.vendor_id, {
      type: "listing_decided",
      title: `Listing ${status === "active" ? "approved" : "rejected"}: ${product.name}`,
      body: status === "active" ? "Your listing is now live." : "Please review and resubmit the listing.",
      link: "/vendor/products",
    });
  }
  return { before, after: product };
}

async function deleteProduct(id) {
  const product = await Product.findByPk(id);
  if (!product) throw ApiError.notFound("Product not found");
  // Soft delete: order history keeps referencing it.
  await product.update({ status: "inactive" });
  await product.destroy();
}

async function methods() {
  return DecorationMethod.findAll({ order: [["name", "ASC"]] });
}

async function saveMethod(data, id) {
  const fields = {
    code: data.code,
    name: data.name,
    description: data.description,
    default_cost_paise: data.defaultCostPaise,
    default_setup_paise: data.defaultSetupPaise,
    default_moq: data.defaultMoq,
    in_house: data.inHouse,
    is_active: data.isActive !== false,
  };
  if (id) {
    const method = await DecorationMethod.findByPk(id);
    if (!method) throw ApiError.notFound("Method not found");
    return method.update(fields);
  }
  return DecorationMethod.create(fields);
}

// ------------------------------------------------------------------ inventory
async function adjustStock(auth, variantId, { change, reason, note }) {
  return sequelize.transaction(async (transaction) => {
    const variant = await ProductVariant.findByPk(variantId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!variant) throw ApiError.notFound("Variant not found");
    const next = variant.stock_qty + change;
    if (next < 0) throw ApiError.unprocessable(`Stock cannot go below zero (current ${variant.stock_qty})`, "STOCK_NEGATIVE");
    await variant.update({ stock_qty: next }, { transaction });
    await InventoryMovement.create({ variant_id: variant.id, change_qty: change, balance_after: next, reason, note, created_by: auth.user.id }, { transaction });
    return variant;
  });
}

async function stockHistory(variantId) {
  return InventoryMovement.findAll({ where: { variant_id: variantId }, order: [["created_at", "DESC"]], limit: 100 });
}

// ------------------------------------------------------------------ customers and companies
async function listUsers({ q, accountType, status, page = 1, limit = 20 }) {
  const where = {};
  if (q) where[Op.or] = [{ name: { [Op.iLike]: `%${q}%` } }, { email: { [Op.iLike]: `%${q}%` } }, { phone: { [Op.iLike]: `%${q}%` } }];
  if (accountType) where.account_type = accountType;
  if (status) where.status = status;
  const { rows, count } = await User.findAndCountAll({
    where,
    include: [{ model: UserRole, as: "userRoles", include: [{ model: Role, as: "role", attributes: ["code", "name"] }] }],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  const ids = rows.map((u) => u.id);
  const [stats] = ids.length
    ? await sequelize.query(
        `SELECT user_id, count(*)::int AS orders, COALESCE(sum(total_paise),0)::bigint AS spend FROM orders WHERE user_id IN (:ids) AND status NOT IN ('cancelled','refunded') GROUP BY user_id`,
        { replacements: { ids } }
      )
    : [[]];
  const byId = new Map(stats.map((s) => [s.user_id, s]));
  return {
    items: rows.map((u) => ({
      ...u.toJSON(),
      roles: u.userRoles.map((r) => r.role.code),
      orders: byId.get(u.id)?.orders || 0,
      spendPaise: Number(byId.get(u.id)?.spend || 0),
    })),
    total: count,
  };
}

async function setUserStatus(auth, userId, status) {
  if (userId === auth.user.id) throw ApiError.forbidden("You cannot change your own account status");
  const user = await User.findByPk(userId);
  if (!user) throw ApiError.notFound("User not found");
  if (status === "suspended") {
    if (user.status !== "suspended") {
      // Recorded as a platform suspension: organisation admins cannot lift it.
      await user.update({ status, status_before_deactivation: user.status, deactivated_scope: "platform", deactivated_at: new Date() });
    } else if (user.deactivated_scope !== "platform") {
      await user.update({ deactivated_scope: "platform" });
    }
    await Session.update({ revoked_at: new Date() }, { where: { user_id: userId, revoked_at: null } });
  } else {
    await user.update({ status, status_before_deactivation: null, deactivated_scope: null, deactivated_at: null });
  }
  return user;
}

async function setUserRoles(auth, userId, roleCodes) {
  if (userId === auth.user.id) throw ApiError.forbidden("You cannot change your own roles");
  return sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(userId, { transaction });
    if (!user || user.account_type !== "staff") throw ApiError.unprocessable("Platform roles can only be given to staff accounts", "NOT_STAFF");
    const roles = await Role.findAll({ where: { code: roleCodes, scope_type: "platform" }, transaction });
    if (roles.length !== roleCodes.length) throw ApiError.unprocessable("Unknown platform role", "ROLE_INVALID");
    const platformRoles = await Role.findAll({ where: { scope_type: "platform" }, transaction });
    await UserRole.destroy({ where: { user_id: userId, role_id: platformRoles.map((r) => r.id) }, transaction });
    for (const role of roles) await UserRole.create({ user_id: userId, role_id: role.id, scope_type: "platform", scope_id: null }, { transaction });
    return roles.map((r) => r.code);
  });
}

async function createStaff(auth, { name, email, phone, roleCodes }) {
  const { hashPassword, randomToken } = require("../Utils/crypto");
  const exists = await User.findOne({ where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), email.toLowerCase()) });
  if (exists) throw ApiError.conflict("An account with this email already exists", "EMAIL_TAKEN");
  const user = await User.create({ name, email: email.toLowerCase(), phone, password_hash: await hashPassword(randomToken(24)), account_type: "staff", status: "active", email_verified_at: null });
  await setUserRoles({ user: { id: "00000000-0000-0000-0000-000000000000" } }, user.id, roleCodes);
  await notificationService.notify(user.id, { type: "staff_invite", title: "Your staff account is ready", body: 'Use "Forgot password" with this email to set your password.', link: "/forgot-password" });
  return user;
}

async function listCompanies({ q, page = 1, limit = 20 }) {
  const where = q ? { [Op.or]: [{ name: { [Op.iLike]: `%${q}%` } }, { gstin: { [Op.iLike]: `%${q}%` } }] } : {};
  const { rows, count } = await Company.findAndCountAll({ where, order: [["created_at", "DESC"]], limit, offset: (page - 1) * limit });
  const ids = rows.map((c) => c.id);
  const [stats] = ids.length
    ? await sequelize.query(
        `SELECT c.id, (SELECT count(*)::int FROM company_members m WHERE m.company_id = c.id AND m.status <> 'removed') AS members,
                (SELECT count(*)::int FROM orders o WHERE o.company_id = c.id AND o.status NOT IN ('cancelled','refunded')) AS orders,
                (SELECT COALESCE(sum(total_paise),0)::bigint FROM orders o WHERE o.company_id = c.id AND o.status NOT IN ('cancelled','refunded')) AS spend
           FROM companies c WHERE c.id IN (:ids)`,
        { replacements: { ids } }
      )
    : [[]];
  const byId = new Map(stats.map((s) => [s.id, s]));
  return { items: rows.map((c) => ({ ...c.toJSON(), members: byId.get(c.id)?.members || 0, orders: byId.get(c.id)?.orders || 0, spendPaise: Number(byId.get(c.id)?.spend || 0) })), total: count };
}

async function companyDetail(id) {
  const company = await Company.findByPk(id, { include: [{ model: CompanyMember, as: "members", include: [{ model: User, as: "user", attributes: ["id", "name", "email", "status"] }] }] });
  if (!company) throw ApiError.notFound("Company not found");
  const orders = await Order.findAll({ where: { company_id: id }, order: [["placed_at", "DESC"]], limit: 20, attributes: ["id", "order_number", "status", "total_paise", "amount_paid_paise", "placed_at", "payment_terms"] });
  return { ...company.toJSON(), orders };
}

async function updateCompanyTerms(id, data) {
  const company = await Company.findByPk(id);
  if (!company) throw ApiError.notFound("Company not found");
  const before = company.toJSON();
  await company.update({
    payment_terms: data.paymentTerms ?? company.payment_terms,
    credit_approved: data.creditApproved ?? company.credit_approved,
    credit_limit_paise: data.creditLimitPaise ?? company.credit_limit_paise,
    approval_limit_paise: data.approvalLimitPaise ?? company.approval_limit_paise,
    is_key_account: data.isKeyAccount ?? company.is_key_account,
    preferred_vendor_id: data.preferredVendorId === undefined ? company.preferred_vendor_id : data.preferredVendorId,
    status: data.status ?? company.status,
  });
  return { before, after: company };
}

// ------------------------------------------------------------------ vendors
async function listVendors({ status, q, page = 1, limit = 20 }) {
  const where = {};
  if (status) where.status = status.includes(",") ? { [Op.in]: status.split(",") } : status;
  if (q) where.business_name = { [Op.iLike]: `%${q}%` };
  const { rows, count } = await Vendor.findAndCountAll({
    where,
    include: [{ model: VendorCapability, as: "capabilities", include: [{ model: DecorationMethod, as: "method", attributes: ["code", "name"] }] }, { model: User, as: "owner", attributes: ["id", "name", "email", "phone"] }],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  return { items: rows, total: count };
}

async function vendorDetail(id) {
  const vendor = await Vendor.findByPk(id, {
    include: [
      { model: VendorCapability, as: "capabilities", include: [{ model: DecorationMethod, as: "method" }] },
      { model: User, as: "owner", attributes: ["id", "name", "email", "phone"] },
    ],
  });
  if (!vendor) throw ApiError.notFound("Vendor not found");
  const performance = await require("./vendorService").performance(id);
  return { ...vendor.toJSON(), performance };
}

async function decideVendor(auth, id, { status, reason, commissionPct }) {
  const vendor = await Vendor.findByPk(id);
  if (!vendor) throw ApiError.notFound("Vendor not found");
  const before = vendor.toJSON();
  const transitions = {
    applied: ["under_review", "approved", "rejected"],
    under_review: ["approved", "rejected"],
    approved: ["suspended"],
    suspended: ["approved"],
    rejected: ["under_review"],
    draft: [],
  };
  if (!(transitions[vendor.status] || []).includes(status)) throw ApiError.conflict(`A ${vendor.status} vendor cannot be ${status}`, "VENDOR_STATE");
  await vendor.update({
    status,
    rejection_reason: status === "rejected" || status === "suspended" ? reason || null : null,
    approved_at: status === "approved" ? new Date() : vendor.approved_at,
    approved_by: status === "approved" ? auth.user.id : vendor.approved_by,
    commission_pct: commissionPct ?? vendor.commission_pct,
  });
  // Suspended vendors' listings are hidden from the storefront.
  if (status === "suspended") await Product.update({ status: "inactive" }, { where: { vendor_id: id, status: "active" } });
  await notificationService.notify(vendor.owner_user_id, {
    type: "vendor_status",
    title: `Vendor account ${status.replace("_", " ")}`,
    body: { approved: "You can now receive jobs and publish listings.", rejected: reason || "Please review your application.", suspended: reason || "Contact the platform team.", under_review: "Our team is verifying your details." }[status],
    link: "/vendor/dashboard",
  });
  return { before, after: vendor };
}

// ------------------------------------------------------------------ coupons
async function listCoupons() {
  return Coupon.findAll({ order: [["created_at", "DESC"]] });
}

async function saveCoupon(data, id) {
  const fields = {
    code: data.code.toUpperCase(),
    description: data.description,
    discount_type: data.discountType,
    value: data.value,
    min_order_paise: data.minOrderPaise || 0,
    max_discount_paise: data.maxDiscountPaise || null,
    applies_to: data.appliesTo,
    starts_at: data.startsAt || null,
    ends_at: data.endsAt || null,
    usage_limit: data.usageLimit || null,
    per_user_limit: data.perUserLimit || 1,
    is_active: data.isActive !== false,
  };
  if (data.discountType === "percent" && data.value > 90) throw ApiError.unprocessable("Percentage discounts cannot exceed 90%", "COUPON_VALUE");
  if (id) {
    const coupon = await Coupon.findByPk(id);
    if (!coupon) throw ApiError.notFound("Coupon not found");
    return coupon.update(fields);
  }
  return Coupon.create(fields);
}

// ------------------------------------------------------------------ roles and permissions
async function rolesMatrix() {
  const [roles, permissions, links] = await Promise.all([Role.findAll({ order: [["id", "ASC"]] }), Permission.findAll({ order: [["module", "ASC"], ["code", "ASC"]] }), RolePermission.findAll()]);
  return {
    roles,
    permissions,
    grants: links.map((l) => ({ roleId: l.role_id, permissionId: l.permission_id })),
  };
}

async function setRolePermissions(auth, roleId, permissionCodes) {
  return sequelize.transaction(async (transaction) => {
    const role = await Role.findByPk(roleId, { transaction });
    if (!role) throw ApiError.notFound("Role not found");
    // Guard against locking every admin out of role management.
    if (role.code === "platform_admin" && !permissionCodes.includes("roles.manage")) {
      throw ApiError.unprocessable("The platform admin role must keep roles.manage", "ROLE_LOCKOUT");
    }
    const permissions = await Permission.findAll({ where: { code: permissionCodes }, transaction });
    const before = (await RolePermission.findAll({ where: { role_id: roleId }, transaction })).map((r) => r.permission_id);
    await RolePermission.destroy({ where: { role_id: roleId }, transaction });
    await RolePermission.bulkCreate(permissions.map((p) => ({ role_id: roleId, permission_id: p.id })), { transaction });
    transaction.afterCommit(() => accessService.invalidateRoleCache());
    return { role, before, after: permissions.map((p) => p.id) };
  });
}

// ------------------------------------------------------------------ CMS and audit
async function listPages({ type }) {
  return CmsPage.findAll({ where: type ? { type } : {}, order: [["type", "ASC"], ["sort_order", "ASC"]] });
}

async function savePage(auth, data, id) {
  const fields = { slug: data.slug || slugify(data.title), type: data.type, title: data.title, body: data.body, sort_order: data.sortOrder ?? 0, is_published: data.isPublished !== false, updated_by: auth.user.id };
  if (id) {
    const page = await CmsPage.findByPk(id);
    if (!page) throw ApiError.notFound("Page not found");
    return page.update(fields);
  }
  return CmsPage.create(fields);
}

async function deletePage(id) {
  await CmsPage.destroy({ where: { id } });
}

async function auditLog({ entityType, actorId, action, page = 1, limit = 30 }) {
  const where = {};
  if (entityType) where.entity_type = entityType;
  if (actorId) where.actor_user_id = actorId;
  if (action) where.action = { [Op.iLike]: `%${action}%` };
  const { rows, count } = await AuditLog.findAndCountAll({
    where,
    include: [{ model: User, as: "actor", attributes: ["id", "name", "email"] }],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { items: rows, total: count };
}

module.exports = {
  listCategories,
  saveCategory,
  deleteCategory,
  listProducts,
  productForEdit,
  saveProduct,
  setProductStatus,
  deleteProduct,
  methods,
  saveMethod,
  adjustStock,
  stockHistory,
  listUsers,
  setUserStatus,
  setUserRoles,
  createStaff,
  listCompanies,
  companyDetail,
  updateCompanyTerms,
  listVendors,
  vendorDetail,
  decideVendor,
  listCoupons,
  saveCoupon,
  rolesMatrix,
  setRolePermissions,
  listPages,
  savePage,
  deletePage,
  auditLog,
};

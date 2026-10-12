// Tax master: GST rates and HSN/SAC codes. Products link to a rate (tax_rate_id) and their
// gst_rate column is kept in sync, so changing a rate here re-prices every product using it.
// Order, quote and invoice lines keep the rate they were charged (copied at checkout).
const { Op, UniqueConstraintError } = require("sequelize");
const { sequelize, TaxRate, HsnCode, Product, Category } = require("../Models");
const ApiError = require("../Utils/ApiError");

const HSN_RE = /^\d{4}(\d{2}){0,2}$/;
const num = (v) => Number(v);

function presentRate(r, usage = {}) {
  return { id: r.id, name: r.name, rate: num(r.rate), description: r.description, isActive: r.is_active, sortOrder: r.sort_order, products: usage.products || 0, hsnCodes: usage.hsn || 0, categories: usage.categories || 0 };
}

async function rateUsage(ids) {
  if (!ids.length) return new Map();
  const [rows] = await sequelize.query(
    `SELECT t.id,
            (SELECT count(*) FROM products p WHERE p.tax_rate_id = t.id AND p.deleted_at IS NULL)::int AS products,
            (SELECT count(*) FROM hsn_codes h WHERE h.tax_rate_id = t.id AND h.is_active)::int AS hsn,
            (SELECT count(*) FROM categories c WHERE c.default_tax_rate_id = t.id)::int AS categories
       FROM tax_rates t WHERE t.id IN (:ids)`,
    { replacements: { ids } }
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// ------------------------------------------------------------------ rates
async function listRates() {
  const rates = await TaxRate.findAll({ order: [["is_active", "DESC"], ["rate", "ASC"], ["name", "ASC"]] });
  const usage = await rateUsage(rates.map((r) => r.id));
  return rates.map((r) => presentRate(r, usage.get(r.id)));
}

function rateConflict(error) {
  if (error instanceof UniqueConstraintError) {
    const byName = Object.keys(error.fields || {}).includes("name");
    throw ApiError.conflict(byName ? "A rate with this name already exists" : "An active rate with this percentage already exists", "TAX_RATE_DUPLICATE", byName ? { name: "Already in use" } : { rate: "Already exists" });
  }
  throw error;
}

async function saveRate(data, id) {
  try {
    return await sequelize.transaction(async (transaction) => {
      let rate;
      let repriced = 0;
      if (id) {
        rate = await TaxRate.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!rate) throw ApiError.notFound("Tax rate not found");
        const changed = num(rate.rate) !== num(data.rate);
        await rate.update({ name: data.name, rate: data.rate, description: data.description ?? null, sort_order: data.sortOrder ?? rate.sort_order }, { transaction });
        // Products follow the master; past orders keep their own copy of the rate.
        if (changed) [repriced] = await Product.update({ gst_rate: data.rate }, { where: { tax_rate_id: rate.id }, transaction, paranoid: false });
      } else {
        rate = await TaxRate.create({ name: data.name, rate: data.rate, description: data.description ?? null, sort_order: data.sortOrder ?? Math.round(data.rate * 100), is_active: true }, { transaction });
      }
      const usage = await rateUsage([rate.id]);
      return { ...presentRate(rate, usage.get(rate.id)), productsUpdated: repriced };
    });
  } catch (error) {
    return rateConflict(error);
  }
}

async function setRateActive(id, active) {
  const rate = await TaxRate.findByPk(id);
  if (!rate) throw ApiError.notFound("Tax rate not found");
  if (!active) {
    const usage = (await rateUsage([id])).get(id);
    if (usage.products || usage.hsn || usage.categories) {
      const parts = [usage.products && `${usage.products} product(s)`, usage.hsn && `${usage.hsn} HSN/SAC code(s)`, usage.categories && `${usage.categories} category default(s)`].filter(Boolean);
      throw ApiError.conflict(`This rate is still used by ${parts.join(", ")}. Move them to another rate first.`, "TAX_RATE_IN_USE", usage);
    }
  }
  try {
    await rate.update({ is_active: active });
  } catch (error) {
    rateConflict(error);
  }
  return presentRate(rate, (await rateUsage([id])).get(id));
}

// ------------------------------------------------------------------ HSN / SAC
function presentHsn(h, products = 0) {
  return {
    id: h.id,
    code: h.code,
    kind: h.kind,
    description: h.description,
    isActive: h.is_active,
    taxRate: h.taxRate ? { id: h.taxRate.id, name: h.taxRate.name, rate: num(h.taxRate.rate), isActive: h.taxRate.is_active } : null,
    products,
  };
}

async function productsByHsn(codes) {
  if (!codes.length) return new Map();
  const [rows] = await sequelize.query(`SELECT hsn_code, count(*)::int AS n FROM products WHERE deleted_at IS NULL AND hsn_code IN (:codes) GROUP BY hsn_code`, { replacements: { codes } });
  return new Map(rows.map((r) => [r.hsn_code, r.n]));
}

async function listHsn({ q, taxRateId, status, page = 1, limit = 20 } = {}) {
  const where = {};
  if (q) where[Op.or] = [{ code: { [Op.startsWith]: q.replace(/\D/g, "") || q } }, { description: { [Op.iLike]: `%${q}%` } }];
  if (taxRateId) where.tax_rate_id = taxRateId;
  if (status === "active") where.is_active = true;
  if (status === "inactive") where.is_active = false;
  const { rows, count } = await HsnCode.findAndCountAll({ where, include: [{ model: TaxRate, as: "taxRate" }], order: [["code", "ASC"]], limit, offset: (page - 1) * limit });
  const counts = await productsByHsn(rows.map((h) => h.code));
  return { items: rows.map((h) => presentHsn(h, counts.get(h.code) || 0)), total: count };
}

async function activeRate(id, transaction) {
  const rate = await TaxRate.findByPk(id, { transaction });
  if (!rate || !rate.is_active) throw ApiError.unprocessable("Choose an active GST rate", "TAX_RATE_INVALID", { taxRateId: "Choose an active GST rate" });
  return rate;
}

async function saveHsn(data, id) {
  return sequelize.transaction(async (transaction) => {
    const rate = await activeRate(data.taxRateId, transaction);
    let hsn;
    if (id) {
      hsn = await HsnCode.findByPk(id, { transaction });
      if (!hsn) throw ApiError.notFound("HSN/SAC code not found");
      // The code is the link to products, so it cannot be renamed; add a new code instead.
      await hsn.update({ kind: data.kind, description: data.description, tax_rate_id: rate.id }, { transaction });
    } else {
      if (!HSN_RE.test(data.code)) throw ApiError.unprocessable("Enter a 4, 6 or 8 digit code", "HSN_INVALID", { code: "Enter a 4, 6 or 8 digit code" });
      try {
        hsn = await HsnCode.create({ code: data.code, kind: data.kind, description: data.description, tax_rate_id: rate.id, is_active: true }, { transaction });
      } catch (error) {
        if (error instanceof UniqueConstraintError) throw ApiError.conflict("This code already exists", "HSN_DUPLICATE", { code: "Already exists" });
        throw error;
      }
    }
    let productsUpdated = 0;
    if (data.applyToProducts) {
      [productsUpdated] = await Product.update({ tax_rate_id: rate.id, gst_rate: rate.rate }, { where: { hsn_code: hsn.code }, transaction, paranoid: false });
    }
    hsn.taxRate = rate;
    const counts = await productsByHsn([hsn.code]);
    return { ...presentHsn(hsn, counts.get(hsn.code) || 0), productsUpdated };
  });
}

async function setHsnActive(id, active) {
  const hsn = await HsnCode.findByPk(id, { include: [{ model: TaxRate, as: "taxRate" }] });
  if (!hsn) throw ApiError.notFound("HSN/SAC code not found");
  if (active && !hsn.taxRate.is_active) throw ApiError.unprocessable("Its GST rate is inactive. Assign an active rate first.", "TAX_RATE_INVALID");
  await hsn.update({ is_active: active });
  const counts = await productsByHsn([hsn.code]);
  return presentHsn(hsn, counts.get(hsn.code) || 0);
}

// ------------------------------------------------------------------ pickers and products
/** Active rates and HSN/SAC codes for product, listing and category forms. */
async function options() {
  const [rates, codes] = await Promise.all([
    TaxRate.findAll({ where: { is_active: true }, order: [["rate", "ASC"]] }),
    HsnCode.findAll({ where: { is_active: true }, order: [["code", "ASC"]], attributes: ["id", "code", "kind", "description", "tax_rate_id"] }),
  ]);
  return {
    rates: rates.map((r) => ({ id: r.id, name: r.name, rate: num(r.rate) })),
    hsnCodes: codes.map((h) => ({ code: h.code, kind: h.kind, description: h.description, taxRateId: h.tax_rate_id })),
  };
}

/**
 * Decides a product's GST rate: an explicitly chosen rate, else a percentage matched to an
 * active rate (older clients), else the HSN code's mapped rate, else the category default.
 * A product may keep a rate that has since been deactivated until it is moved to another.
 */
async function resolveForProduct({ taxRateId, gstRate, hsnCode, categoryId, currentTaxRateId }, transaction) {
  let rate = null;
  if (taxRateId) {
    rate = await TaxRate.findByPk(taxRateId, { transaction });
    if (!rate || (!rate.is_active && rate.id !== currentTaxRateId)) {
      throw ApiError.unprocessable("Choose an active GST rate", "TAX_RATE_INVALID", { taxRateId: "Choose an active GST rate" });
    }
  } else if (gstRate !== undefined && gstRate !== null && gstRate !== "") {
    rate = await TaxRate.findOne({ where: { rate: gstRate, is_active: true }, transaction });
    if (!rate) throw ApiError.unprocessable(`There is no active ${gstRate}% GST rate in the tax master`, "TAX_RATE_INVALID", { gstRate: "Not an active GST rate" });
  } else {
    const hsn = hsnCode ? await HsnCode.findOne({ where: { code: hsnCode, is_active: true }, include: [{ model: TaxRate, as: "taxRate" }], transaction }) : null;
    if (hsn?.taxRate?.is_active) rate = hsn.taxRate;
    else if (categoryId) {
      const category = await Category.findByPk(categoryId, { include: [{ model: TaxRate, as: "defaultTaxRate" }], transaction });
      if (category?.defaultTaxRate?.is_active) rate = category.defaultTaxRate;
    }
    if (!rate) throw ApiError.unprocessable("Choose a GST rate, or use an HSN code that is mapped to one in the tax master", "TAX_RATE_REQUIRED", { taxRateId: "Choose a GST rate" });
  }
  return { tax_rate_id: rate.id, gst_rate: num(rate.rate) };
}

async function setCategoryDefault(categoryId, taxRateId, transaction) {
  if (taxRateId) await activeRate(taxRateId, transaction);
  await Category.update({ default_tax_rate_id: taxRateId || null }, { where: { id: categoryId }, transaction });
}

module.exports = { listRates, saveRate, setRateActive, listHsn, saveHsn, setHsnActive, options, resolveForProduct, setCategoryDefault, HSN_RE };

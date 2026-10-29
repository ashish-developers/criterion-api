// Visiting card template gallery: categories and templates. Customers only ever see published
// templates in active categories; staff with vc.templates.manage create, edit, publish,
// unpublish and remove them. Removing is a soft delete because saved designs and orders refer
// to the template (orders keep their own snapshot, so they are unaffected).
const { Op, UniqueConstraintError } = require("sequelize");
const { sequelize, VcTemplate, VcTemplateCategory } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { slugify } = require("./blogContent");

const num = (v) => (v === null || v === undefined ? v : Number(v));

function derived(design) {
  const elements = [...design.front.elements, ...(design.back?.elements || [])];
  return { is_double_sided: Boolean(design.back), has_qr: elements.some((e) => e.type === "qr" && !e.hidden) };
}

function presentCategory(c, count) {
  return { id: c.id, name: c.name, slug: c.slug, description: c.description, icon: c.icon, sortOrder: c.sort_order, isActive: c.is_active, ...(count !== undefined ? { templates: count } : {}) };
}

function present(t, { withDesign = true } = {}) {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    slug: t.slug,
    description: t.description,
    category: t.category ? { id: t.category.id, name: t.category.name, slug: t.category.slug } : null,
    orientation: t.orientation,
    widthMm: num(t.width_mm),
    heightMm: num(t.height_mm),
    bleedMm: num(t.bleed_mm),
    safeMarginMm: num(t.safe_margin_mm),
    isDoubleSided: t.is_double_sided,
    hasQr: t.has_qr,
    tags: t.tags || [],
    status: t.status,
    isFeatured: t.is_featured,
    sortOrder: t.sort_order,
    usageCount: t.usage_count,
    publishedAt: t.published_at,
    updatedAt: t.updated_at,
    ...(withDesign ? { design: t.design } : {}),
  };
}

const INCLUDE = [{ model: VcTemplateCategory, as: "category", attributes: ["id", "name", "slug", "is_active"] }];

function filters(q) {
  const where = {};
  if (q.orientation) where.orientation = q.orientation;
  if (q.doubleSided) where.is_double_sided = q.doubleSided === "true";
  if (q.qr) where.has_qr = q.qr === "true";
  if (q.q) {
    const term = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
    where[Op.or] = [{ name: { [Op.iLike]: term } }, { description: { [Op.iLike]: term } }, sequelize.where(sequelize.fn("array_to_string", sequelize.col("tags"), " "), { [Op.iLike]: term })];
  }
  return where;
}

// ---------------------------------------------------------------- customer gallery
async function gallery(q = {}) {
  const where = { ...filters(q), status: "published" };
  const include = [{ ...INCLUDE[0], required: false }];
  const rows = await VcTemplate.findAll({ where, include, order: [["is_featured", "DESC"], ["sort_order", "ASC"], ["name", "ASC"]] });
  // Templates in a deactivated category are hidden with it.
  return rows.filter((t) => !t.category || t.category.is_active).filter((t) => !q.category || t.category?.slug === q.category).map((t) => present(t));
}

async function publishedTemplate(id) {
  const t = await VcTemplate.findOne({ where: { id, status: "published" }, include: INCLUDE });
  if (!t || (t.category && !t.category.is_active)) throw ApiError.notFound("Template not found");
  return t;
}

async function galleryCategories() {
  const [rows] = await sequelize.query(
    `SELECT c.*, count(t.id)::int AS templates
       FROM vc_template_categories c
       LEFT JOIN vc_templates t ON t.category_id = c.id AND t.status = 'published' AND t.deleted_at IS NULL
      WHERE c.is_active GROUP BY c.id ORDER BY c.sort_order, c.name`
  );
  return rows.map((r) => presentCategory(r, r.templates));
}

// ---------------------------------------------------------------- admin: templates
async function adminList(q = {}) {
  const where = filters(q);
  if (q.status) where.status = q.status;
  const rows = await VcTemplate.findAll({ where, include: INCLUDE, order: [["sort_order", "ASC"], ["name", "ASC"]] });
  return rows.filter((t) => !q.category || t.category?.slug === q.category).map((t) => present(t));
}

async function adminGet(id) {
  const t = await VcTemplate.findByPk(id, { include: INCLUDE });
  if (!t) throw ApiError.notFound("Template not found");
  return t;
}

async function uniqueSlug(base, excludeId, transaction) {
  const root = base || "template";
  for (let n = 1; ; n++) {
    const slug = n === 1 ? root : `${root}-${n}`;
    const where = { slug };
    if (excludeId) where.id = { [Op.ne]: excludeId };
    if (!(await VcTemplate.findOne({ where, transaction }))) return slug;
  }
}

function checkGeometry(data) {
  const landscape = data.widthMm >= data.heightMm;
  if ((data.orientation === "landscape") !== landscape) {
    throw ApiError.unprocessable(
      data.orientation === "landscape" ? "A landscape card must be at least as wide as it is tall" : "A portrait card must be taller than it is wide",
      "VALIDATION_FAILED",
      { orientation: "Does not match the width and height" }
    );
  }
}

async function save(auth, data, id) {
  checkGeometry(data);
  if (data.categoryId && !(await VcTemplateCategory.findByPk(data.categoryId))) {
    throw ApiError.unprocessable("Choose an existing category", "VALIDATION_FAILED", { categoryId: "Not found" });
  }
  try {
    return await sequelize.transaction(async (transaction) => {
      const existing = id ? await VcTemplate.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
      if (id && !existing) throw ApiError.notFound("Template not found");
      let slug = data.slug;
      if (slug) {
        const taken = await VcTemplate.findOne({ where: { slug, ...(id ? { id: { [Op.ne]: id } } : {}) }, transaction });
        if (taken) throw ApiError.conflict("Another template already uses this URL slug", "SLUG_TAKEN", { slug: "Already in use" });
      } else {
        slug = existing && existing.name === data.name ? existing.slug : await uniqueSlug(slugify(data.name).slice(0, 120), id, transaction);
      }
      const values = {
        name: data.name,
        slug,
        description: data.description,
        category_id: data.categoryId ?? null,
        orientation: data.orientation,
        width_mm: data.widthMm,
        height_mm: data.heightMm,
        bleed_mm: data.bleedMm,
        safe_margin_mm: data.safeMarginMm,
        tags: [...new Set(data.tags.map((t) => t.toLowerCase()))],
        design: data.design,
        ...derived(data.design),
        updated_by: auth.user.id,
      };
      if (data.isFeatured !== undefined) values.is_featured = data.isFeatured;
      if (data.sortOrder !== undefined) values.sort_order = data.sortOrder;
      const before = existing ? present(existing, { withDesign: false }) : null;
      const template = existing ? await existing.update(values, { transaction }) : await VcTemplate.create({ ...values, status: "draft", created_by: auth.user.id }, { transaction });
      return { template, before };
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw ApiError.conflict("Another template already uses this URL slug", "SLUG_TAKEN", { slug: "Already in use" });
    throw error;
  }
}

async function setStatus(auth, id, status) {
  const t = await adminGet(id);
  const before = t.status;
  await t.update({ status, updated_by: auth.user.id, ...(status === "published" && !t.published_at ? { published_at: new Date() } : {}) });
  return { template: t, before };
}

async function duplicate(auth, id) {
  const source = await adminGet(id);
  const copy = await VcTemplate.create({
    name: `${source.name} (copy)`.slice(0, 120),
    slug: await uniqueSlug(`${source.slug}-copy`.slice(0, 130)),
    description: source.description,
    category_id: source.category_id,
    orientation: source.orientation,
    width_mm: source.width_mm,
    height_mm: source.height_mm,
    bleed_mm: source.bleed_mm,
    safe_margin_mm: source.safe_margin_mm,
    is_double_sided: source.is_double_sided,
    has_qr: source.has_qr,
    tags: source.tags,
    design: source.design,
    status: "draft",
    sort_order: source.sort_order + 1,
    created_by: auth.user.id,
    updated_by: auth.user.id,
  });
  return copy;
}

async function remove(id) {
  const t = await adminGet(id);
  const before = present(t, { withDesign: false });
  await t.destroy();
  return { before };
}

// ---------------------------------------------------------------- admin: categories
async function listCategories() {
  const [rows] = await sequelize.query(
    `SELECT c.*, count(t.id)::int AS templates
       FROM vc_template_categories c LEFT JOIN vc_templates t ON t.category_id = c.id AND t.deleted_at IS NULL
      GROUP BY c.id ORDER BY c.sort_order, c.name`
  );
  return rows.map((r) => presentCategory(r, r.templates));
}

async function saveCategory(data, id) {
  const values = {
    name: data.name,
    slug: data.slug || slugify(data.name).slice(0, 100) || "category",
    description: data.description,
    icon: data.icon ?? null,
    ...(data.sortOrder !== undefined ? { sort_order: data.sortOrder } : {}),
    ...(data.isActive !== undefined ? { is_active: data.isActive } : {}),
  };
  try {
    if (id) {
      const category = await VcTemplateCategory.findByPk(id);
      if (!category) throw ApiError.notFound("Category not found");
      const before = presentCategory(category);
      await category.update(values);
      return { category: presentCategory(category), before };
    }
    return { category: presentCategory(await VcTemplateCategory.create(values)), before: null };
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw ApiError.conflict("A category with this name or slug already exists", "DUPLICATE", { name: "Already in use" });
    throw error;
  }
}

async function deleteCategory(id) {
  const category = await VcTemplateCategory.findByPk(id);
  if (!category) throw ApiError.notFound("Category not found");
  const templates = await VcTemplate.count({ where: { category_id: id }, paranoid: false });
  const before = presentCategory(category);
  await category.destroy();
  return { before, templatesAffected: templates };
}

module.exports = { present, presentCategory, gallery, publishedTemplate, galleryCategories, adminList, adminGet, save, setStatus, duplicate, remove, listCategories, saveCategory, deleteCategory, derived };

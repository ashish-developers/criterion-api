// Blog administration: categories, tags, blog settings, and the individual blog permissions
// the Platform Admin grants to platform users (stored in user_permissions).
const { Op, UniqueConstraintError } = require("sequelize");
const { sequelize, BlogCategory, BlogTag, Permission, UserPermission } = require("../Models");
const ApiError = require("../Utils/ApiError");
const settingsService = require("./settingsService");
const { slugify } = require("./blogContent");
const { PERMISSIONS, BLOG_PERMISSIONS, BLOG_GRANTABLE, BLOG_PRESETS } = require("../Config/roles");

function conflictOnDuplicate(error, what) {
  if (error instanceof UniqueConstraintError) throw ApiError.conflict(`A ${what} with this name or slug already exists`, "DUPLICATE");
  throw error;
}

// ------------------------------------------------------------------ categories
async function listCategories() {
  const [rows] = await sequelize.query(
    `SELECT c.id, c.name, c.slug, c.description, c.sort_order, c.is_active, c.updated_at,
            count(p.id)::int AS posts, count(p.id) FILTER (WHERE p.status = 'published')::int AS published
       FROM blog_categories c LEFT JOIN blog_posts p ON p.category_id = c.id
      GROUP BY c.id ORDER BY c.sort_order, c.name`
  );
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, description: r.description, sortOrder: r.sort_order, isActive: r.is_active, posts: r.posts, published: r.published, updatedAt: r.updated_at }));
}

async function saveCategory(data, id) {
  const slug = slugify(data.slug || data.name);
  if (!slug) throw ApiError.unprocessable("Enter a valid name", "VALIDATION_FAILED", { name: "Use letters or numbers" });
  const fields = { name: data.name, slug, description: data.description, sort_order: data.sortOrder ?? 0, is_active: data.isActive !== false };
  try {
    if (id) {
      const category = await BlogCategory.findByPk(id);
      if (!category) throw ApiError.notFound("Category not found");
      const before = category.toJSON();
      await category.update(fields);
      return { category, before };
    }
    return { category: await BlogCategory.create(fields), before: null };
  } catch (error) {
    return conflictOnDuplicate(error, "category");
  }
}

async function deleteCategory(id) {
  const category = await BlogCategory.findByPk(id);
  if (!category) throw ApiError.notFound("Category not found");
  const before = category.toJSON();
  // Posts keep existing and become uncategorised (ON DELETE SET NULL).
  const [[{ n }]] = await sequelize.query("SELECT count(*)::int AS n FROM blog_posts WHERE category_id = :id", { replacements: { id } });
  await category.destroy();
  return { before, postsAffected: n };
}

// ------------------------------------------------------------------ tags
async function listTags({ q } = {}) {
  const [rows] = await sequelize.query(
    `SELECT t.id, t.name, t.slug, count(pt.post_id)::int AS posts
       FROM blog_tags t LEFT JOIN blog_post_tags pt ON pt.tag_id = t.id
      ${q ? "WHERE t.name ILIKE :q" : ""}
      GROUP BY t.id ORDER BY t.name`,
    { replacements: { q: `%${String(q || "").replace(/[\\%_]/g, (c) => `\\${c}`)}%` } }
  );
  return rows;
}

async function saveTag(data, id) {
  const slug = slugify(data.slug || data.name);
  if (!slug) throw ApiError.unprocessable("Enter a valid name", "VALIDATION_FAILED", { name: "Use letters or numbers" });
  try {
    if (id) {
      const tag = await BlogTag.findByPk(id);
      if (!tag) throw ApiError.notFound("Tag not found");
      const before = tag.toJSON();
      await tag.update({ name: data.name, slug });
      return { tag, before };
    }
    return { tag: await BlogTag.create({ name: data.name, slug }), before: null };
  } catch (error) {
    return conflictOnDuplicate(error, "tag");
  }
}

async function deleteTag(id) {
  const tag = await BlogTag.findByPk(id);
  if (!tag) throw ApiError.notFound("Tag not found");
  const before = tag.toJSON();
  await tag.destroy();
  return { before };
}

// ------------------------------------------------------------------ settings
async function saveSettings(auth, { approvalRequired }) {
  const before = await settingsService.get("blog");
  const after = await settingsService.set("blog", { ...before, approval_required: approvalRequired }, auth.user.id);
  return { before, after };
}

// ------------------------------------------------------------------ permissions
/** Platform users (staff with a platform role) with their blog access from roles and grants. */
async function listPermissions({ q } = {}) {
  const [users] = await sequelize.query(
    `SELECT u.id, u.name, u.email, u.status, u.last_login_at,
            array_agg(DISTINCT r.code) AS roles,
            COALESCE(array_agg(DISTINCT rp_p.code) FILTER (WHERE rp_p.module = 'blog'), '{}') AS via_role,
            COALESCE((SELECT array_agg(p.code ORDER BY p.code) FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
                       WHERE up.user_id = u.id AND p.module = 'blog'), '{}') AS granted
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.scope_type = 'platform'
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions rp_p ON rp_p.id = rp.permission_id
      WHERE u.deleted_at IS NULL ${q ? "AND (u.name ILIKE :q OR u.email ILIKE :q)" : ""}
      GROUP BY u.id
      ORDER BY u.name`,
    { replacements: { q: `%${String(q || "").replace(/[\\%_]/g, (c) => `\\${c}`)}%` } }
  );
  return {
    permissions: BLOG_PERMISSIONS.map((code) => ({ code, description: PERMISSIONS[code][1], grantable: BLOG_GRANTABLE.includes(code) })),
    presets: Object.entries(BLOG_PRESETS).map(([code, p]) => ({ code, ...p })),
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      status: u.status,
      lastLoginAt: u.last_login_at,
      roles: u.roles,
      viaRole: u.via_role,
      granted: u.granted,
      // Platform admins already hold every blog permission through their role.
      managedByRole: BLOG_GRANTABLE.every((p) => u.via_role.includes(p)),
    })),
  };
}

/** Replaces a platform user's individually granted blog permissions. */
async function setUserPermissions(auth, userId, codes) {
  const wanted = [...new Set(codes)];
  const invalid = wanted.filter((c) => !BLOG_GRANTABLE.includes(c));
  if (invalid.length) throw ApiError.unprocessable(`These permissions cannot be assigned individually: ${invalid.join(", ")}`, "VALIDATION_FAILED", { permissions: "Not assignable" });

  return sequelize.transaction(async (transaction) => {
    const [target] = await sequelize.query(
      `SELECT u.id, u.name, u.email FROM users u
        WHERE u.id = :userId AND u.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.scope_type = 'platform')`,
      { replacements: { userId }, transaction }
    );
    // Only platform users can be given blog access; others look the same as missing users.
    if (!target.length) throw ApiError.notFound("Platform user not found");

    const blogPerms = await Permission.findAll({ where: { module: "blog" }, transaction });
    const idByCode = new Map(blogPerms.map((p) => [p.code, p.id]));
    const current = await UserPermission.findAll({ where: { user_id: userId, permission_id: { [Op.in]: [...idByCode.values()] } }, transaction });
    const codeById = new Map(blogPerms.map((p) => [p.id, p.code]));
    const before = current.map((c) => codeById.get(c.permission_id)).sort();

    await UserPermission.destroy({ where: { user_id: userId, permission_id: { [Op.in]: [...idByCode.values()] } }, transaction });
    const rows = wanted.filter((c) => idByCode.has(c)).map((c) => ({ user_id: userId, permission_id: idByCode.get(c), granted_by: auth.user.id }));
    if (rows.length) await UserPermission.bulkCreate(rows, { transaction });
    return { user: target[0], before, after: wanted.filter((c) => idByCode.has(c)).sort() };
  });
}

module.exports = { listCategories, saveCategory, deleteCategory, listTags, saveTag, deleteTag, saveSettings, listPermissions, setUserPermissions };

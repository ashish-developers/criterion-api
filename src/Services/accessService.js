// Builds the request's authorisation context: user, roles with scopes, and the
// effective permission set. Role → permission mappings are cached in memory and
// refreshed whenever an admin edits role permissions.
const { sequelize } = require("../Config/database");
const { ROLES } = require("../Config/roles");

let rolePermissionCache = null;

async function rolePermissions() {
  if (rolePermissionCache) return rolePermissionCache;
  const [rows] = await sequelize.query(
    `SELECT r.code AS role, p.code AS permission
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id`
  );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.role)) map.set(row.role, new Set());
    if (row.permission) map.get(row.role).add(row.permission);
  }
  rolePermissionCache = map;
  return map;
}

function invalidateRoleCache() {
  rolePermissionCache = null;
}

async function loadContext(userId) {
  const [rows] = await sequelize.query(
    `SELECT u.id, u.name, u.email, u.phone, u.account_type, u.status, u.avatar_url, u.email_verified_at,
            r.code AS role_code, ur.scope_type, ur.scope_id
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.id = :userId AND u.deleted_at IS NULL`,
    { replacements: { userId } }
  );
  if (!rows.length) return null;
  const first = rows[0];
  const user = {
    id: first.id,
    name: first.name,
    email: first.email,
    phone: first.phone,
    account_type: first.account_type,
    status: first.status,
    avatar_url: first.avatar_url,
    email_verified_at: first.email_verified_at,
  };
  const roles = rows.filter((r) => r.role_code).map((r) => ({ code: r.role_code, scopeType: r.scope_type, scopeId: r.scope_id }));

  const map = await rolePermissions();
  const permissions = new Set();
  for (const role of roles) for (const p of map.get(role.code) || []) permissions.add(p);

  const companyRole = roles.find((r) => r.scopeType === "company");
  const vendorRole = roles.find((r) => r.scopeType === "vendor");
  const portals = [...new Set(roles.map((r) => ROLES[r.code]?.portal).filter(Boolean))];

  return {
    user,
    roles,
    permissions,
    companyId: companyRole?.scopeId || null,
    companyRole: companyRole?.code || null,
    vendorId: vendorRole?.scopeId || null,
    vendorRole: vendorRole?.code || null,
    isStaff: roles.some((r) => r.scopeType === "platform"),
    portals,
  };
}

// Where to send a user after sign-in, in priority order.
function homePath(context) {
  if (!context) return "/login";
  if (context.portals.includes("admin")) return "/admin/dashboard";
  if (context.user.account_type === "vendor") {
    return context.vendorId ? "/vendor/dashboard" : "/vendor/onboarding";
  }
  if (context.portals.includes("vendor")) return "/vendor/dashboard";
  if (context.portals.includes("business")) return "/business/dashboard";
  return "/account";
}

function publicContext(context) {
  return {
    user: context.user,
    roles: context.roles.map((r) => r.code),
    permissions: [...context.permissions].sort(),
    companyId: context.companyId,
    companyRole: context.companyRole,
    vendorId: context.vendorId,
    vendorRole: context.vendorRole,
    portals: context.portals,
    homePath: homePath(context),
  };
}

module.exports = { loadContext, invalidateRoleCache, homePath, publicContext };

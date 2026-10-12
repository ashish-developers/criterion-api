// User management for organisation administrators:
//   company  - Business Admin manages Business Approvers and Buyers of their own company
//   vendor   - Vendor Admin manages Vendor Staff of their own vendor
//   platform - Platform Admin manages Support Agents and Production Staff
//
// The organisation always comes from the administrator's session (auth.companyId /
// auth.vendorId), never from the request. Every lookup is filtered by it, so an admin can
// neither see nor change another organisation's users (they get 404, as if they did not exist).
const { Op, UniqueConstraintError } = require("sequelize");
const { sequelize, User, Company, CompanyMember, Vendor, VendorUser, Role, UserRole, UserBatch, UserInvitation, Session } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { hashPassword, randomToken } = require("../Utils/crypto");
const { config } = require("../Config/env");
const authService = require("./authService");
const notificationService = require("./notificationService");
const emailOutbox = require("./emailOutboxService");
const auditService = require("./auditService");
const { toCsv } = require("./reportService");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^(\+91[\s-]?)?[6-9]\d{9}$/;

// assignable: roles this admin may create/assign. listed: every role shown in the list.
const SCOPES = {
  company: {
    accountType: "business",
    entityLabel: "company",
    assignable: [
      { code: "business_approver", member: "approver", label: "Business Approver" },
      { code: "business_buyer", member: "buyer", label: "Business Buyer" },
    ],
    protectedRoles: [{ code: "business_admin", member: "admin", label: "Business Admin" }],
  },
  vendor: {
    accountType: "vendor",
    entityLabel: "vendor",
    assignable: [{ code: "vendor_staff", member: "staff", label: "Vendor Staff" }],
    protectedRoles: [{ code: "vendor_admin", member: "admin", label: "Vendor Admin" }],
  },
  platform: {
    accountType: "staff",
    entityLabel: "platform",
    assignable: [
      { code: "support_agent", label: "Support Agent" },
      { code: "production_staff", label: "Production Staff" },
    ],
    protectedRoles: [{ code: "platform_admin", label: "Platform Admin" }],
  },
};

const allRoles = (scope) => [...SCOPES[scope].assignable, ...SCOPES[scope].protectedRoles];
const roleLabel = (scope, code) => allRoles(scope).find((r) => r.code === code)?.label || code;

function scopeId(auth, scope) {
  if (scope === "company") {
    if (!auth.companyId) throw ApiError.forbidden("A company account is required", "COMPANY_REQUIRED");
    return auth.companyId;
  }
  if (scope === "vendor") {
    if (!auth.vendorId) throw ApiError.forbidden("A vendor account is required", "VENDOR_REQUIRED");
    return auth.vendorId;
  }
  return null;
}

async function entityOf(auth, scope) {
  if (scope === "company") {
    const c = await Company.findByPk(scopeId(auth, scope), { attributes: ["id", "name"] });
    return { id: c.id, name: c.name, refs: [c.id, c.name] };
  }
  if (scope === "vendor") {
    const v = await Vendor.findByPk(scopeId(auth, scope), { attributes: ["id", "business_name"] });
    return { id: v.id, name: v.business_name, refs: [v.id, v.business_name] };
  }
  return { id: null, name: config.brandName, refs: [config.brandName, "platform"] };
}

/** Accepts a role code ("business_buyer"), label ("Business Buyer") or short name ("buyer"). */
function parseRole(scope, value) {
  const key = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return null;
  return SCOPES[scope].assignable.find((r) => [r.code, r.label, r.member].filter(Boolean).some((v) => v.toLowerCase().replace(/[^a-z]/g, "") === key)) || null;
}

function parseBool(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const v = String(value).trim().toLowerCase();
  if (["yes", "y", "true", "1", "on"].includes(v)) return true;
  if (["no", "n", "false", "0", "off"].includes(v)) return false;
  return null;
}

// ------------------------------------------------------------------ listing
// One row per member of the admin's organisation, with platform roles aggregated.
function memberSql(scope) {
  if (scope === "company") {
    return `SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at, u.last_login_at, u.must_change_password, u.deactivated_scope,
                   ARRAY[CASE m.member_role WHEN 'admin' THEN 'business_admin' WHEN 'approver' THEN 'business_approver' ELSE 'business_buyer' END] AS roles
              FROM company_members m JOIN users u ON u.id = m.user_id
             WHERE m.company_id = :scopeId AND m.status <> 'removed' AND u.deleted_at IS NULL`;
  }
  if (scope === "vendor") {
    return `SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at, u.last_login_at, u.must_change_password, u.deactivated_scope,
                   ARRAY[CASE m.member_role WHEN 'admin' THEN 'vendor_admin' ELSE 'vendor_staff' END] AS roles
              FROM vendor_users m JOIN users u ON u.id = m.user_id
             WHERE m.vendor_id = :scopeId AND u.deleted_at IS NULL`;
  }
  return `SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at, u.last_login_at, u.must_change_password, u.deactivated_scope,
                 array_agg(DISTINCT r.code ORDER BY r.code) AS roles
            FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.scope_type = 'platform' JOIN roles r ON r.id = ur.role_id
           WHERE u.account_type = 'staff' AND u.deleted_at IS NULL AND r.code IN ('platform_admin','support_agent','production_staff')
           GROUP BY u.id`;
}

const STATUS_FILTER = { active: "active", invited: "pending", inactive: "suspended" };
const displayStatus = (s) => ({ pending: "invited", suspended: "inactive" })[s] || s;

async function list(auth, scope, { q, role, status, page = 1, limit = 20 } = {}) {
  const replacements = { scopeId: scopeId(auth, scope) };
  const where = [];
  if (q) {
    where.push("(b.name ILIKE :q OR b.email ILIKE :q)");
    replacements.q = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  }
  if (role) {
    where.push(":role = ANY(b.roles)");
    replacements.role = role;
  }
  if (status && STATUS_FILTER[status]) {
    where.push("b.status = :status");
    replacements.status = STATUS_FILTER[status];
  }
  const base = `FROM (${memberSql(scope)}) b ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const [[{ total }]] = await sequelize.query(`SELECT count(*)::int AS total ${base}`, { replacements });
  const [rows] = await sequelize.query(`SELECT b.* ${base} ORDER BY b.created_at DESC LIMIT :limit OFFSET :offset`, {
    replacements: { ...replacements, limit, offset: (page - 1) * limit },
  });
  const emails = await emailOutbox.latestForUsers(rows.map((r) => r.id));
  const protectedCodes = SCOPES[scope].protectedRoles.map((r) => r.code);
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      roles: r.roles,
      roleLabels: r.roles.map((c) => roleLabel(scope, c)),
      status: displayStatus(r.status),
      mustChangePassword: r.must_change_password,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      inviteEmail: emails.get(r.id) || null,
      // Admin accounts and the signed-in admin are view-only here.
      manageable: r.id !== auth.user.id && !r.roles.some((c) => protectedCodes.includes(c)),
      deactivatedElsewhere: r.status === "suspended" && r.deactivated_scope !== scope,
    })),
  };
}

async function exportCsv(auth, scope, filters) {
  const { items } = await list(auth, scope, { ...filters, page: 1, limit: 5000 });
  return toCsv(
    items.map((u) => ({
      name: u.name,
      email: u.email,
      phone: u.phone || "",
      role: u.roleLabels.join("; "),
      status: u.status,
      created_at: u.createdAt ? new Date(u.createdAt).toISOString() : "",
      last_login_at: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : "",
      invite_email: u.inviteEmail?.status || "",
    }))
  );
}

// ------------------------------------------------------------------ validation
/**
 * Validates submitted rows without saving anything. Returns each row with its normalised
 * data and field errors. Used for the preview step and again, authoritatively, on submit.
 */
async function validateRows(auth, scope, rows) {
  if (!Array.isArray(rows) || !rows.length) throw ApiError.badRequest("Add at least one user");
  if (rows.length > config.users.maxBulkRows) throw ApiError.badRequest(`At most ${config.users.maxBulkRows} users can be added at once`);
  const entity = await entityOf(auth, scope);
  const refs = entity.refs.filter(Boolean).map((r) => String(r).trim().toLowerCase());

  const checked = rows.map((input, index) => {
    const raw = input || {};
    const row = Number.isInteger(raw.row) && raw.row > 0 ? raw.row : index + 1;
    const errors = {};
    const name = String(raw.name ?? "").trim();
    const email = String(raw.email ?? "").trim().toLowerCase();
    const phone = String(raw.phone ?? "").trim();
    if (name.length < 2) errors.name = "Full name is required";
    else if (name.length > 120) errors.name = "Full name is too long";
    if (!email) errors.email = "Email address is required";
    else if (email.length > 190 || !EMAIL_RE.test(email)) errors.email = "Enter a valid email address";
    if (phone && !PHONE_RE.test(phone)) errors.phone = "Enter a valid 10-digit Indian mobile number";
    const role = parseRole(scope, raw.role);
    if (!raw.role) errors.role = "Role is required";
    else if (!role) errors.role = `Role must be one of: ${SCOPES[scope].assignable.map((r) => r.label).join(", ")}`;
    const sendInvite = parseBool(raw.sendInvite, true);
    if (sendInvite === null) errors.sendInvite = "Send invite must be Yes or No";
    const org = String(raw.organization ?? "").trim();
    if (org && !refs.includes(org.toLowerCase())) {
      errors.organization = `Users can only be added to your own ${SCOPES[scope].entityLabel} (${entity.name})`;
    }
    return { row, data: { name, email, phone: phone || null, role: role?.code || null, roleLabel: role?.label || null, sendInvite: sendInvite !== false }, errors };
  });

  // Duplicate emails inside the submission (later rows are the duplicates).
  const seen = new Map();
  for (const r of checked) {
    if (!r.data.email || r.errors.email) continue;
    if (seen.has(r.data.email)) r.errors.email = `Duplicate of row ${seen.get(r.data.email)}`;
    else seen.set(r.data.email, r.row);
  }
  // Emails that already have an account anywhere in the system.
  const emails = [...seen.keys()];
  if (emails.length) {
    const existing = await User.findAll({
      where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), { [Op.in]: emails }),
      attributes: ["email"],
      paranoid: false,
    });
    const taken = new Set(existing.map((u) => u.email.toLowerCase()));
    for (const r of checked) if (!r.errors.email && taken.has(r.data.email)) r.errors.email = "An account with this email already exists";
  }
  const valid = checked.filter((r) => !Object.keys(r.errors).length).length;
  return { entity: { name: entity.name }, roles: SCOPES[scope].assignable.map(({ code, label }) => ({ code, label })), rows: checked, summary: { total: checked.length, valid, invalid: checked.length - valid } };
}

// ------------------------------------------------------------------ creation
async function createOne(auth, scope, entity, data, { batchId, transaction }) {
  const devPassword = config.users.devDefaultPassword;
  const user = await User.create(
    {
      name: data.name,
      email: data.email,
      phone: data.phone,
      // A temporary development password, or an unusable random one until the invitation is accepted.
      password_hash: await hashPassword(devPassword || randomToken(32)),
      account_type: SCOPES[scope].accountType,
      status: devPassword ? "active" : "pending",
      must_change_password: Boolean(devPassword),
      created_by: auth.user.id,
    },
    { transaction }
  );
  const role = allRoles(scope).find((r) => r.code === data.role);
  if (scope === "company") {
    await CompanyMember.create({ company_id: entity.id, user_id: user.id, member_role: role.member, status: devPassword ? "active" : "invited" }, { transaction });
  } else if (scope === "vendor") {
    await VendorUser.create({ vendor_id: entity.id, user_id: user.id, member_role: role.member }, { transaction });
  }
  await authService.assignRole(user.id, role.code, scope, entity.id, transaction);
  const invitation = await UserInvitation.create(
    { user_id: user.id, scope_type: scope, scope_id: entity.id, role_code: role.code, invited_by: auth.user.id, batch_id: batchId || null },
    { transaction }
  );
  await notificationService.notify(
    user.id,
    { type: "team_invite", title: `Welcome to ${entity.name}`, body: `${auth.user.name} added you as ${role.label}.`, link: "/account/settings", email: false },
    { transaction }
  );
  return { user, invitation, role };
}

function invitePayload(auth, entity, user, role) {
  return { name: user.name, roleLabel: role.label, orgName: entity.name, invitedBy: auth.user.name };
}

/**
 * Creates every valid row (each in its own transaction, so one failure never blocks the rest)
 * and reports invalid rows as failed. Retrying with the same idempotency key returns the
 * original result and creates nothing.
 */
async function createBulk(req, scope, { rows, idempotencyKey, source = "manual" }) {
  const auth = req.auth;
  const sid = scopeId(auth, scope);
  let batch;
  try {
    batch = await UserBatch.create({ actor_id: auth.user.id, scope_type: scope, scope_id: sid, idempotency_key: idempotencyKey, source, status: "processing" });
  } catch (error) {
    if (!(error instanceof UniqueConstraintError)) throw error;
    const previous = await UserBatch.findOne({ where: { actor_id: auth.user.id, idempotency_key: idempotencyKey } });
    if (previous.status !== "completed") throw ApiError.conflict("This request is still being processed", "BATCH_IN_PROGRESS");
    return { ...(await presentBatch(previous)), replayed: true };
  }

  const checked = await validateRows(auth, scope, rows);
  const entity = await entityOf(auth, scope);
  const results = [];
  for (const r of checked.rows) {
    const base = { row: r.row, name: r.data.name, email: r.data.email, role: r.data.roleLabel || null };
    if (Object.keys(r.errors).length) {
      results.push({ ...base, status: "failed", errors: r.errors });
      continue;
    }
    try {
      const created = await sequelize.transaction(async (transaction) => {
        const { user, invitation, role } = await createOne(auth, scope, entity, r.data, { batchId: batch.id, transaction });
        let emailKey = null;
        if (r.data.sendInvite) {
          emailKey = `batch:${batch.id}:row:${r.row}`;
          await emailOutbox.enqueue(
            { userId: user.id, invitationId: invitation.id, to: user.email, template: "user_invite", payload: invitePayload(auth, entity, user, role), dedupeKey: emailKey },
            { transaction }
          );
        }
        return { userId: user.id, emailKey };
      });
      results.push({ ...base, status: "created", userId: created.userId, emailKey: created.emailKey });
    } catch (error) {
      const message = error instanceof UniqueConstraintError ? "An account with this email already exists" : error.message || "Could not create this user";
      results.push({ ...base, status: "failed", errors: { email: message } });
    }
  }

  const createdCount = results.filter((r) => r.status === "created").length;
  await batch.update({ status: "completed", total: results.length, created_count: createdCount, failed_count: results.length - createdCount, results });
  await auditService.record(req, "users.bulk_create", "user_batch", batch.id, { after: { scope, total: results.length, created: createdCount } });
  if (results.some((r) => r.emailKey)) emailOutbox.kick();
  return { ...(await presentBatch(batch)), replayed: false };
}

/** Batch summary with live email delivery status per created user. */
async function presentBatch(batch) {
  const results = batch.results || [];
  const statuses = await emailOutbox.byDedupeKeys(results.map((r) => r.emailKey).filter(Boolean));
  const rows = results.map(({ emailKey, ...r }) => ({
    ...r,
    email_delivery: r.status !== "created" ? null : emailKey ? statuses.get(emailKey) || { status: "queued" } : { status: "not_requested" },
  }));
  const emailCounts = rows.reduce((acc, r) => {
    if (r.email_delivery) acc[r.email_delivery.status] = (acc[r.email_delivery.status] || 0) + 1;
    return acc;
  }, {});
  return { batchId: batch.id, source: batch.source, total: batch.total, created: batch.created_count, failed: batch.failed_count, emails: emailCounts, results: rows, createdAt: batch.created_at };
}

async function getBatch(auth, scope, batchId) {
  const batch = await UserBatch.findOne({ where: { id: batchId, scope_type: scope, scope_id: scopeId(auth, scope) } });
  if (!batch) throw ApiError.notFound("Batch not found");
  return presentBatch(batch);
}

// ------------------------------------------------------------------ single-user actions
/** Loads a member of the admin's own organisation that the admin is allowed to manage. */
async function manageable(auth, scope, userId, { transaction } = {}) {
  const [rows] = await sequelize.query(`SELECT b.* FROM (${memberSql(scope)}) b WHERE b.id = :userId`, {
    replacements: { scopeId: scopeId(auth, scope), userId },
    transaction,
  });
  if (!rows.length) throw ApiError.notFound("User not found");
  if (userId === auth.user.id) throw ApiError.forbidden("You cannot change your own account here");
  const protectedCodes = SCOPES[scope].protectedRoles.map((r) => r.code);
  if (rows[0].roles.some((c) => protectedCodes.includes(c))) throw ApiError.forbidden("Administrator accounts cannot be changed here", "PROTECTED_ACCOUNT");
  return rows[0];
}

async function update(req, scope, userId, { name, phone, role }) {
  const auth = req.auth;
  return sequelize.transaction(async (transaction) => {
    const member = await manageable(auth, scope, userId, { transaction });
    const user = await User.findByPk(userId, { transaction });
    const changes = {};
    if (name !== undefined) changes.name = name;
    if (phone !== undefined) changes.phone = phone || null;
    if (Object.keys(changes).length) await user.update(changes, { transaction });

    if (role && !member.roles.includes(role)) {
      const next = SCOPES[scope].assignable.find((r) => r.code === role);
      if (!next) throw ApiError.unprocessable("This role cannot be assigned here", "ROLE_INVALID");
      const sid = scopeId(auth, scope);
      const codes = SCOPES[scope].assignable.map((r) => r.code);
      const roleRows = await Role.findAll({ where: { code: codes }, transaction });
      await UserRole.destroy({ where: { user_id: userId, scope_type: scope, ...(sid ? { scope_id: sid } : {}), role_id: roleRows.map((r) => r.id) }, transaction });
      await authService.assignRole(userId, next.code, scope, sid, transaction);
      if (scope === "company") await CompanyMember.update({ member_role: next.member }, { where: { company_id: sid, user_id: userId }, transaction });
      if (scope === "vendor") await VendorUser.update({ member_role: next.member }, { where: { vendor_id: sid, user_id: userId }, transaction });
    }
    await auditService.record(req, "users.update", "user", userId, { before: { name: member.name, phone: member.phone, roles: member.roles }, after: { ...changes, role }, transaction });
    return { id: userId };
  });
}

async function setActive(req, scope, userId, active) {
  const auth = req.auth;
  return sequelize.transaction(async (transaction) => {
    await manageable(auth, scope, userId, { transaction });
    const user = await User.findByPk(userId, { transaction });
    if (!active) {
      if (user.status === "suspended") return { id: userId, status: "inactive" };
      await user.update({ status: "suspended", status_before_deactivation: user.status, deactivated_scope: scope, deactivated_at: new Date() }, { transaction });
      await Session.update({ revoked_at: new Date() }, { where: { user_id: userId, revoked_at: null }, transaction });
    } else {
      if (user.status !== "suspended") return { id: userId, status: displayStatus(user.status) };
      // Only the level that deactivated the account can reactivate it (platform admins can always).
      if (user.deactivated_scope && user.deactivated_scope !== scope && scope !== "platform") {
        throw ApiError.forbidden("This account was suspended by the platform. Contact support.", "SUSPENDED_BY_PLATFORM");
      }
      await user.update({ status: user.status_before_deactivation || "active", status_before_deactivation: null, deactivated_scope: null, deactivated_at: null }, { transaction });
    }
    await auditService.record(req, active ? "users.activate" : "users.deactivate", "user", userId, { transaction });
    return { id: userId, status: displayStatus(user.status) };
  });
}

const RESEND_COOLDOWN_MS = 60 * 1000;

async function resendInvite(req, scope, userId) {
  const auth = req.auth;
  const member = await manageable(auth, scope, userId);
  if (member.status === "suspended") throw ApiError.unprocessable("Activate this user before sending an invitation", "USER_INACTIVE");
  const sid = scopeId(auth, scope);
  const entity = await entityOf(auth, scope);
  const role = allRoles(scope).find((r) => member.roles.includes(r.code)) || SCOPES[scope].assignable[0];
  let invitation = await UserInvitation.findOne({ where: { user_id: userId, scope_type: scope, ...(sid ? { scope_id: sid } : {}) }, order: [["created_at", "DESC"]] });
  if (!invitation) {
    // Members added before invitations existed.
    invitation = await UserInvitation.create({ user_id: userId, scope_type: scope, scope_id: sid, role_code: role.code, invited_by: auth.user.id });
  }
  // Avoid stacking duplicates: wait while one is pending or was just delivered. A failed email
  // can be resent straight away.
  const last = (await emailOutbox.latestForUsers([userId])).get(userId);
  if (last && last.status !== "failed" && Date.now() - new Date(last.queuedAt).getTime() < RESEND_COOLDOWN_MS) {
    throw ApiError.tooMany("Please wait a minute before sending another invitation", 60);
  }
  const user = await User.findByPk(userId);
  await emailOutbox.enqueue({
    userId,
    invitationId: invitation.id,
    to: user.email,
    template: "user_invite",
    payload: invitePayload(auth, entity, user, role),
    dedupeKey: `resend:${invitation.id}:${Date.now()}`,
  });
  emailOutbox.kick();
  await auditService.record(req, "users.resend_invite", "user", userId);
  return { id: userId, inviteEmail: { status: "queued" } };
}

module.exports = { SCOPES, list, exportCsv, validateRows, createBulk, getBatch, update, setActive, resendInvite, parseRole };

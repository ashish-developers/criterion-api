const jwt = require("jsonwebtoken");
const ApiError = require("../Utils/ApiError");
const { config } = require("../Config/env");
const { Session } = require("../Models");
const accessService = require("../Services/accessService");

const ACCESS_COOKIE = "access_token";

function tokenFrom(req) {
  const header = req.get("authorization");
  if (header && header.startsWith("Bearer ")) return header.slice(7);
  return req.cookies?.[ACCESS_COOKIE] || null;
}

async function resolve(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, config.auth.accessSecret, { algorithms: ["HS256"] });
  } catch (error) {
    if (error.name === "TokenExpiredError") throw ApiError.unauthorized("Session expired", "TOKEN_EXPIRED");
    throw ApiError.unauthorized("Invalid session", "TOKEN_INVALID");
  }
  if (payload.typ !== "access") throw ApiError.unauthorized("Invalid session", "TOKEN_INVALID");

  // Revoked sessions (logout, password reset) stop working immediately.
  const session = await Session.findByPk(payload.sid, { attributes: ["id", "revoked_at", "expires_at"] });
  if (!session || session.revoked_at || session.expires_at < new Date()) {
    throw ApiError.unauthorized("Session ended. Please sign in again.", "SESSION_REVOKED");
  }

  const context = await accessService.loadContext(payload.sub);
  if (!context) throw ApiError.unauthorized("Account not found", "TOKEN_INVALID");
  if (context.user.status !== "active") throw ApiError.forbidden("This account is not active", "ACCOUNT_INACTIVE");
  context.sessionId = payload.sid;
  return context;
}

// While an account still uses a temporary password, the API only allows reading the session,
// changing the password and signing out (enforced here, not just hidden in the UI).
const PASSWORD_CHANGE_ALLOWED = ["/auth/me", "/auth/change-password", "/auth/logout"].map((p) => `${config.apiPrefix}${p}`);

async function requireAuth(req, res, next) {
  const context = await resolve(req);
  if (!context) throw ApiError.unauthorized();
  if (context.user.must_change_password && !PASSWORD_CHANGE_ALLOWED.includes(req.originalUrl.split("?")[0])) {
    throw ApiError.forbidden("Change your temporary password to continue", "PASSWORD_CHANGE_REQUIRED");
  }
  req.auth = context;
  next();
}

async function optionalAuth(req, res, next) {
  try {
    req.auth = (await resolve(req)) || null;
  } catch {
    req.auth = null;
  }
  // A temporary-password session acts as anonymous on optional-auth routes (except sign-out).
  if (req.auth?.user.must_change_password && !PASSWORD_CHANGE_ALLOWED.includes(req.originalUrl.split("?")[0])) req.auth = null;
  next();
}

// Passes when the user holds ANY of the listed permissions.
function requirePermission(...codes) {
  return (req, res, next) => {
    if (!req.auth) return next(ApiError.unauthorized());
    if (!codes.some((c) => req.auth.permissions.has(c))) return next(ApiError.forbidden());
    next();
  };
}

function requireCompany(req, res, next) {
  if (!req.auth?.companyId) return next(ApiError.forbidden("A company account is required", "COMPANY_REQUIRED"));
  next();
}

function requireVendor({ approved = true } = {}) {
  return async (req, res, next) => {
    if (!req.auth?.vendorId) return next(ApiError.forbidden("A vendor account is required", "VENDOR_REQUIRED"));
    if (approved) {
      const { Vendor } = require("../Models");
      const vendor = await Vendor.findByPk(req.auth.vendorId, { attributes: ["id", "status"] });
      if (!vendor || vendor.status !== "approved") {
        return next(ApiError.forbidden("Your vendor account is not approved yet", "VENDOR_NOT_APPROVED"));
      }
    }
    next();
  };
}

function can(req, code) {
  return Boolean(req.auth?.permissions.has(code));
}

module.exports = { requireAuth, optionalAuth, requirePermission, requireCompany, requireVendor, can, ACCESS_COOKIE };

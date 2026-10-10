const { define, T } = require("./define");

const Role = define("Role", "roles", {
  id: T.intPk,
  code: T.str,
  name: T.str,
  description: T.text,
  scope_type: T.str,
});

const Permission = define("Permission", "permissions", {
  id: T.intPk,
  code: T.str,
  module: T.str,
  description: T.text,
});

const RolePermission = define(
  "RolePermission",
  "role_permissions",
  { role_id: { type: T.int, primaryKey: true }, permission_id: { type: T.int, primaryKey: true } },
  { timestamps: false }
);

const User = define(
  "User",
  "users",
  {
    id: T.uuidPk,
    name: T.str,
    email: T.str,
    phone: T.str,
    password_hash: T.text,
    account_type: T.str,
    status: T.str,
    avatar_url: T.text,
    email_verified_at: T.time,
    last_login_at: T.time,
    marketing_opt_in: T.bool,
    is_demo: T.bool,
  },
  {
    paranoid: true,
    defaultScope: { attributes: { exclude: ["password_hash"] } },
    scopes: { withPassword: { attributes: { include: ["password_hash"] } } },
  }
);

const UserRole = define(
  "UserRole",
  "user_roles",
  { id: T.intPk, user_id: T.uuid, role_id: T.int, scope_type: T.str, scope_id: T.uuid },
  { timestamps: "created" }
);

const Session = define(
  "Session",
  "sessions",
  {
    id: T.uuidPk,
    user_id: T.uuid,
    refresh_token_hash: T.str,
    user_agent: T.text,
    ip: T.str,
    expires_at: T.time,
    revoked_at: T.time,
    last_used_at: T.time,
  },
  { timestamps: "created" }
);

const VerificationChallenge = define(
  "VerificationChallenge",
  "verification_challenges",
  {
    id: T.uuidPk,
    user_id: T.uuid,
    purpose: T.str,
    channel: T.str,
    otp_hash: T.str,
    expires_at: T.time,
    attempts: T.int,
    max_attempts: T.int,
    resend_count: T.int,
    last_sent_at: T.time,
    consumed_at: T.time,
    invalidated_at: T.time,
    reset_token_hash: T.str,
    ip: T.str,
    user_agent: T.text,
  },
  { timestamps: "created" }
);

module.exports = { Role, Permission, RolePermission, User, UserRole, Session, VerificationChallenge };

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
    must_change_password: T.bool,
    created_by: T.uuid,
    deactivated_scope: T.str,
    status_before_deactivation: T.str,
    deactivated_at: T.time,
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

// Bulk user-creation requests (idempotent per actor + key).
const UserBatch = define("UserBatch", "user_batches", {
  id: T.uuidPk,
  actor_id: T.uuid,
  scope_type: T.str,
  scope_id: T.uuid,
  idempotency_key: T.str,
  source: T.str,
  status: T.str,
  total: T.int,
  created_count: T.int,
  failed_count: T.int,
  results: T.json,
});

// Organisation invitations; token_hash is set when the invitation email is sent.
const UserInvitation = define("UserInvitation", "user_invitations", {
  id: T.uuidPk,
  user_id: T.uuid,
  scope_type: T.str,
  scope_id: T.uuid,
  role_code: T.str,
  invited_by: T.uuid,
  batch_id: T.uuid,
  token_hash: T.str,
  expires_at: T.time,
  accepted_at: T.time,
});

// Queued transactional email (delivered by emailOutbox worker with retries).
const EmailOutbox = define("EmailOutbox", "email_outbox", {
  id: T.uuidPk,
  user_id: T.uuid,
  invitation_id: T.uuid,
  to_email: T.str,
  template: T.str,
  payload: T.json,
  dedupe_key: T.str,
  status: T.str,
  attempts: T.int,
  next_attempt_at: T.time,
  last_error: T.text,
  sent_at: T.time,
});

module.exports = { Role, Permission, RolePermission, User, UserRole, Session, VerificationChallenge, UserBatch, UserInvitation, EmailOutbox };

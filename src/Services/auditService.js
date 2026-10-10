const { AuditLog } = require("../Models");
const { clientIp } = require("../Utils/http");

const SENSITIVE = ["password", "password_hash", "otp_hash", "refresh_token_hash", "bank_account_number", "bank_account_number_enc"];

function scrub(value) {
  if (!value || typeof value !== "object") return value;
  const plain = typeof value.toJSON === "function" ? value.toJSON() : value;
  const out = Array.isArray(plain) ? [] : {};
  for (const [k, v] of Object.entries(plain)) out[k] = SENSITIVE.includes(k) ? "[redacted]" : v;
  return out;
}

// Records admin, finance, pricing and refund actions (FR-AD-08). Never throws:
// a failed audit write is logged but must not break the action itself.
async function record(req, action, entityType, entityId, { before, after, transaction } = {}) {
  try {
    await AuditLog.create(
      {
        actor_user_id: req?.auth?.user?.id || null,
        action,
        entity_type: entityType,
        entity_id: entityId ? String(entityId) : null,
        before: before ? scrub(before) : null,
        after: after ? scrub(after) : null,
        ip: req ? clientIp(req) : null,
        user_agent: req?.get?.("user-agent")?.slice(0, 300) || null,
      },
      { transaction }
    );
  } catch (error) {
    console.error("Audit log write failed:", error.message);
  }
}

module.exports = { record };

// Durable transactional email: messages are queued in email_outbox (inside the caller's
// transaction, so nothing is sent for rolled-back work) and delivered by a background worker
// with retries and exponential backoff. Delivery status is tracked per message.
//
// Payloads hold template data only. Secrets are added at send time and never stored:
//  - invitation set-password tokens (generated per send; only their HMAC is persisted)
//  - the development default password (DEV_EMAIL_DEFAULT_PASSWORD, never in production)
const { Op } = require("sequelize");
const { sequelize, EmailOutbox, UserInvitation, User } = require("../Models");
const mailService = require("./mailService");
const { config } = require("../Config/env");
const { hmac, randomToken } = require("../Utils/crypto");

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 15, 60]; // after attempt 1, 2, 3, 4
const STALE_SENDING_MINUTES = 5;
const BATCH_SIZE = 20;

/** Queues an email. A repeated dedupe key is ignored, so retried requests never email twice. */
async function enqueue({ userId, invitationId = null, to, template, payload, dedupeKey }, { transaction } = {}) {
  const [row] = await EmailOutbox.findOrCreate({
    where: { dedupe_key: dedupeKey },
    defaults: { user_id: userId, invitation_id: invitationId, to_email: to, template, payload, status: "queued", next_attempt_at: new Date() },
    transaction,
  });
  return row;
}

/** Starts delivery soon after the current request (the scheduler also sweeps every 30 s). */
function kick() {
  if (config.isTest) return;
  setTimeout(() => processDue().catch((e) => console.error(`[email-outbox] ${e.message}`)), 250).unref();
}

// ------------------------------------------------------------------ templates
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * user_invite: account created by an organisation admin.
 * payload: { name, roleLabel, orgName, invitedBy }
 */
async function renderUserInvite(row) {
  const p = row.payload || {};
  const user = row.user_id ? await User.findByPk(row.user_id, { attributes: ["id", "email", "status", "must_change_password"] }) : null;
  if (!user) return null; // account deleted since queueing: nothing to send
  const loginUrl = `${config.webAppUrl}/login`;

  // A fresh single-use link for accounts that have not set their own password yet.
  let setupUrl = null;
  if (row.invitation_id) {
    const invitation = await UserInvitation.findByPk(row.invitation_id);
    if (invitation && !invitation.accepted_at && (user.status === "pending" || user.must_change_password)) {
      const token = randomToken(32);
      await invitation.update({ token_hash: hmac(`invite:${token}`), expires_at: new Date(Date.now() + config.users.inviteTtlHours * 3600 * 1000) });
      setupUrl = `${config.webAppUrl}/accept-invite?token=${encodeURIComponent(token)}`;
    }
  }
  // Development only, and only while the account still uses the temporary password.
  const devPassword = config.users.devEmailIncludesPassword && config.users.devDefaultPassword && user.must_change_password ? config.users.devDefaultPassword : null;

  const subject = `You have been added to ${p.orgName} on ${config.brandName}`;
  const lines = [
    `Hello ${p.name},`,
    ``,
    `${p.invitedBy || "An administrator"} has created a ${config.brandName} account for you.`,
    ``,
    `Organisation: ${p.orgName}`,
    `Role: ${p.roleLabel}`,
    `Username: ${user.email}`,
    `Sign in at: ${loginUrl}`,
    ``,
  ];
  const steps = [];
  if (setupUrl) {
    steps.push(`Set your password using this secure link (valid for ${config.users.inviteTtlHours} hours, single use): ${setupUrl}`);
  }
  if (devPassword) {
    steps.push(`Or sign in with the temporary development password: ${devPassword}`);
    steps.push(`You will be asked to choose a new password straight after signing in.`);
  }
  if (!setupUrl && !devPassword) {
    steps.push(`Sign in with your email and password. If you have not set a password yet, choose "Forgot password" on the sign-in page.`);
  }
  steps.push(`After you enter your password we email you a one-time code to complete sign-in.`);
  steps.push(`To change your password later, open Profile & security after signing in.`);
  const text = [...lines, "How to sign in:", ...steps.map((s, i) => `${i + 1}. ${s}`), "", "If you were not expecting this, you can ignore this email."].join("\n");
  const html =
    `<p>Hello ${esc(p.name)},</p><p>${esc(p.invitedBy || "An administrator")} has created a ${esc(config.brandName)} account for you.</p>` +
    `<table cellpadding="4"><tr><td>Organisation</td><td><strong>${esc(p.orgName)}</strong></td></tr><tr><td>Role</td><td><strong>${esc(p.roleLabel)}</strong></td></tr>` +
    `<tr><td>Username</td><td>${esc(user.email)}</td></tr><tr><td>Sign in</td><td><a href="${esc(loginUrl)}">${esc(loginUrl)}</a></td></tr></table>` +
    `<p><strong>How to sign in</strong></p><ol>${steps
      .map((s) => `<li>${setupUrl && s.startsWith("Set your password") ? `Set your password using this secure link (valid for ${config.users.inviteTtlHours} hours, single use): <a href="${esc(setupUrl)}">Set my password</a>` : esc(s)}</li>`)
      .join("")}</ol><p>If you were not expecting this, you can ignore this email.</p>`;
  return { to: row.to_email, subject, text, html };
}

const TEMPLATES = { user_invite: renderUserInvite };

// ------------------------------------------------------------------ worker
/** Claims due messages (safe with several workers) and delivers them. */
async function processDue() {
  const [claimed] = await sequelize.query(
    `UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM email_outbox
         WHERE (status IN ('queued','failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
            OR (status = 'sending' AND updated_at < now() - interval '${STALE_SENDING_MINUTES} minutes')
         ORDER BY created_at
         LIMIT ${BATCH_SIZE}
         FOR UPDATE SKIP LOCKED)
      RETURNING id`
  );
  for (const { id } of claimed) await deliver(id);
  return claimed.length;
}

async function deliver(id) {
  const row = await EmailOutbox.findByPk(id);
  if (!row) return;
  try {
    const render = TEMPLATES[row.template];
    if (!render) throw Object.assign(new Error(`Unknown email template ${row.template}`), { permanent: true });
    const message = await render(row);
    if (!message) {
      await row.update({ status: "failed", last_error: "Recipient no longer exists", next_attempt_at: null });
      return;
    }
    const result = await mailService.send(message);
    if (result.error) throw new Error(result.error);
    await row.update({
      status: result.delivered ? "sent" : "logged",
      sent_at: new Date(),
      last_error: result.delivered ? null : "MAIL_DRIVER=log: written to the API console, not emailed",
      next_attempt_at: null,
    });
  } catch (error) {
    const final = error.permanent || row.attempts >= MAX_ATTEMPTS;
    const delay = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)];
    await row.update({
      status: "failed",
      last_error: String(error.message).slice(0, 500),
      next_attempt_at: final ? null : new Date(Date.now() + delay * 60 * 1000),
    });
  }
}

/** Latest email per user, for status columns in user lists. */
async function latestForUsers(userIds) {
  if (!userIds.length) return new Map();
  const rows = await EmailOutbox.findAll({
    where: { user_id: { [Op.in]: userIds } },
    attributes: ["id", "user_id", "status", "attempts", "last_error", "sent_at", "created_at", "dedupe_key"],
    order: [["created_at", "DESC"]],
  });
  const map = new Map();
  for (const r of rows) if (!map.has(r.user_id)) map.set(r.user_id, present(r));
  return map;
}

function present(r) {
  return r ? { status: r.status, attempts: r.attempts, error: r.status === "failed" || r.status === "logged" ? r.last_error : null, sentAt: r.sent_at, queuedAt: r.created_at } : null;
}

async function byDedupeKeys(keys) {
  if (!keys.length) return new Map();
  const rows = await EmailOutbox.findAll({ where: { dedupe_key: { [Op.in]: keys } } });
  return new Map(rows.map((r) => [r.dedupe_key, present(r)]));
}

module.exports = { enqueue, kick, processDue, latestForUsers, byDedupeKeys, MAX_ATTEMPTS };

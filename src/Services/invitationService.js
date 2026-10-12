// Set-password invitations for accounts created by organisation admins. The link token is
// single-use and time-limited; only its HMAC is stored (see emailOutboxService).
const { sequelize, User, UserInvitation, CompanyMember, Company, Vendor, Session } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { hashPassword, hmac } = require("../Utils/crypto");
const { config } = require("../Config/env");
const { SCOPES } = require("./userAdminService");

const INVALID = () => ApiError.badRequest("This invitation link is invalid or has expired. Ask your administrator to send a new one.", undefined, "INVITE_INVALID");

async function findValid(token, transaction) {
  if (!token || typeof token !== "string" || token.length > 200) throw INVALID();
  const invitation = await UserInvitation.findOne({ where: { token_hash: hmac(`invite:${token}`) }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!invitation || invitation.accepted_at || !invitation.expires_at || invitation.expires_at < new Date()) throw INVALID();
  const user = await User.findByPk(invitation.user_id, { transaction });
  if (!user) throw INVALID();
  if (user.status === "suspended") throw ApiError.forbidden("This account has been deactivated. Contact your administrator.", "ACCOUNT_SUSPENDED");
  return { invitation, user };
}

async function organisationName(invitation) {
  if (invitation.scope_type === "company") return (await Company.findByPk(invitation.scope_id, { attributes: ["name"] }))?.name;
  if (invitation.scope_type === "vendor") return (await Vendor.findByPk(invitation.scope_id, { attributes: ["business_name"] }))?.business_name;
  return config.brandName;
}

/** What the set-password page shows before the user chooses a password. */
async function preview(token) {
  const { invitation, user } = await findValid(token);
  const role = [...SCOPES[invitation.scope_type].assignable, ...SCOPES[invitation.scope_type].protectedRoles].find((r) => r.code === invitation.role_code);
  return { name: user.name, email: user.email, role: role?.label || invitation.role_code, organisation: await organisationName(invitation), expiresAt: invitation.expires_at };
}

/** Sets the user's own password, activates the account and consumes the link. */
async function accept(token, password) {
  return sequelize.transaction(async (transaction) => {
    const { invitation, user } = await findValid(token, transaction);
    await user.update(
      {
        password_hash: await hashPassword(password),
        must_change_password: false,
        status: "active",
        // Following the emailed link proves the address belongs to them.
        email_verified_at: user.email_verified_at || new Date(),
      },
      { transaction }
    );
    if (invitation.scope_type === "company") {
      await CompanyMember.update({ status: "active" }, { where: { user_id: user.id, company_id: invitation.scope_id, status: "invited" }, transaction });
    }
    await invitation.update({ accepted_at: new Date(), token_hash: null }, { transaction });
    await Session.update({ revoked_at: new Date() }, { where: { user_id: user.id, revoked_at: null }, transaction });
    return { email: user.email };
  });
}

module.exports = { preview, accept };

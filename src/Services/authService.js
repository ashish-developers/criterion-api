// Two-step authentication: password + email OTP for both registration and login.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Op } = require("sequelize");
const { sequelize, User, Role, UserRole, Session, VerificationChallenge, Company, CompanyMember } = require("../Models");
const { config } = require("../Config/env");
const ApiError = require("../Utils/ApiError");
const { hashPassword, verifyPassword, hmac, safeEqualHex, randomOtp, randomToken } = require("../Utils/crypto");
const mailService = require("./mailService");
const accessService = require("./accessService");

// Used to keep login timing similar whether or not the email exists.
const DUMMY_HASH = "scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$" + Buffer.alloc(64).toString("base64");

const PURPOSE_COPY = {
  register: { subject: "Verify your email address", action: "complete your registration" },
  login: { subject: "Your sign-in code", action: "sign in" },
  password_reset: { subject: "Reset your password", action: "reset your password" },
};

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function otpDigest(challengeId, otp) {
  return hmac(`${challengeId}:${otp}`);
}

function maskEmail(email) {
  const [local, domain] = email.split("@");
  const visible = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

async function sendOtpEmail(user, purpose, otp) {
  const copy = PURPOSE_COPY[purpose];
  return mailService.send({
    to: user.email,
    subject: `${copy.subject} - ${config.appName}`,
    text: `Your verification code is ${otp}. It expires in ${config.otp.ttlMinutes} minutes. Use it to ${copy.action}. If you did not request this, ignore this email.`,
    html: `<p>Your verification code is <strong style="font-size:20px">${otp}</strong>.</p><p>It expires in ${config.otp.ttlMinutes} minutes. Use it to ${copy.action}.</p><p>If you did not request this, ignore this email.</p>`,
  });
}

function challengeResponse(challenge, user, otp) {
  const response = {
    challengeId: challenge.id,
    purpose: challenge.purpose,
    destination: maskEmail(user.email),
    expiresAt: challenge.expires_at,
    resendAvailableAt: new Date(challenge.last_sent_at.getTime() + config.otp.resendCooldownSeconds * 1000),
    emailDelivery: mailService.isConfigured(),
  };
  // Development/demo only: the real OTP for this challenge, never in production.
  if (config.otp.showDevOtp) response.devOtp = otp;
  return response;
}

async function createChallenge(user, purpose, req, transaction) {
  // Only one open challenge per user and purpose.
  await VerificationChallenge.update(
    { invalidated_at: new Date() },
    { where: { user_id: user.id, purpose, consumed_at: null, invalidated_at: null }, transaction }
  );
  const id = crypto.randomUUID();
  const otp = randomOtp(config.otp.length);
  const challenge = await VerificationChallenge.create(
    {
      id,
      user_id: user.id,
      purpose,
      otp_hash: otpDigest(id, otp),
      expires_at: new Date(Date.now() + config.otp.ttlMinutes * 60 * 1000),
      max_attempts: config.otp.maxAttempts,
      last_sent_at: new Date(),
      ip: req ? (req.ip || "").slice(0, 64) : null,
      user_agent: req ? (req.get("user-agent") || "").slice(0, 300) : null,
    },
    { transaction }
  );
  const send = () => sendOtpEmail(user, purpose, otp).catch(() => {});
  if (transaction) transaction.afterCommit(send);
  else send();
  return challengeResponse(challenge, user, otp);
}

async function assignRole(userId, roleCode, scopeType = "platform", scopeId = null, transaction) {
  const role = await Role.findOne({ where: { code: roleCode }, transaction });
  if (!role) throw new Error(`Role ${roleCode} is not seeded`);
  const existing = await UserRole.findOne({ where: { user_id: userId, role_id: role.id, scope_type: scopeType, scope_id: scopeId }, transaction });
  if (!existing) await UserRole.create({ user_id: userId, role_id: role.id, scope_type: scopeType, scope_id: scopeId }, { transaction });
}

// ---------------------------------------------------------------- registration
async function register(input, req) {
  const email = normaliseEmail(input.email);
  return sequelize.transaction(async (transaction) => {
    let user = await User.scope("withPassword").findOne({
      where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), email),
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (user && user.status !== "pending") {
      throw ApiError.conflict("An account with this email already exists. Please sign in.", "EMAIL_TAKEN");
    }
    const passwordHash = await hashPassword(input.password);
    const fields = {
      name: input.name.trim(),
      email,
      phone: input.phone,
      password_hash: passwordHash,
      account_type: input.accountType,
      status: "pending",
      marketing_opt_in: Boolean(input.marketingOptIn),
    };
    if (user) await user.update(fields, { transaction });
    else user = await User.create(fields, { transaction });

    if (input.accountType === "business") {
      // The company is created now and activated with its admin on verification.
      const membership = await CompanyMember.findOne({ where: { user_id: user.id }, transaction });
      if (membership) {
        await Company.update({ name: input.companyName, gstin: input.gstin || null }, { where: { id: membership.company_id }, transaction });
      } else {
        if (input.gstin) {
          const taken = await Company.findOne({ where: { gstin: input.gstin }, transaction });
          if (taken) throw ApiError.conflict("A company with this GSTIN is already registered. Ask its admin to invite you.", "GSTIN_TAKEN");
        }
        const company = await Company.create(
          { name: input.companyName, gstin: input.gstin || null, billing_email: email, billing_phone: input.phone },
          { transaction }
        );
        await CompanyMember.create({ company_id: company.id, user_id: user.id, member_role: "admin" }, { transaction });
      }
    }
    return createChallenge(user, "register", req, transaction);
  });
}

async function activateUser(user, transaction) {
  await user.update({ status: "active", email_verified_at: new Date() }, { transaction });
  if (user.account_type === "individual") {
    await assignRole(user.id, "customer", "self", null, transaction);
  } else if (user.account_type === "business") {
    const membership = await CompanyMember.findOne({ where: { user_id: user.id, status: { [Op.ne]: "removed" } }, transaction });
    if (membership) {
      const role = { admin: "business_admin", approver: "business_approver", buyer: "business_buyer" }[membership.member_role];
      await assignRole(user.id, role, "company", membership.company_id, transaction);
      if (membership.status === "invited") await membership.update({ status: "active" }, { transaction });
    }
  }
  // Vendors receive vendor_admin when they submit their vendor application.
}

// ----------------------------------------------------------------------- login
async function login({ email, password }, req) {
  const user = await User.scope("withPassword").findOne({
    where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), normaliseEmail(email)),
  });
  const valid = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid) throw ApiError.unauthorized("Incorrect email or password", "INVALID_CREDENTIALS");
  if (user.status === "suspended") throw ApiError.forbidden("This account has been suspended. Contact support.", "ACCOUNT_SUSPENDED");
  // An unverified account finishes registration verification instead.
  const purpose = user.status === "pending" ? "register" : "login";
  return sequelize.transaction((transaction) => createChallenge(user, purpose, req, transaction));
}

// ------------------------------------------------------------- OTP verification
async function consumeChallenge(challengeId, otp, purposes) {
  const challenge = await VerificationChallenge.findByPk(challengeId);
  if (!challenge || !purposes.includes(challenge.purpose)) {
    throw ApiError.badRequest("This verification request is not valid. Start again.", undefined, "CHALLENGE_INVALID");
  }
  if (challenge.consumed_at) throw ApiError.badRequest("This code has already been used. Request a new one.", undefined, "OTP_USED");
  if (challenge.invalidated_at) throw ApiError.badRequest("This code is no longer valid. Request a new one.", undefined, "OTP_INVALIDATED");
  if (challenge.expires_at < new Date()) throw ApiError.badRequest("This code has expired. Request a new one.", undefined, "OTP_EXPIRED");

  // Count the attempt atomically before comparing, so parallel guesses cannot exceed the limit.
  const [rows] = await sequelize.query(
    `UPDATE verification_challenges SET attempts = attempts + 1
      WHERE id = :id AND attempts < max_attempts AND consumed_at IS NULL AND invalidated_at IS NULL
      RETURNING attempts, max_attempts`,
    { replacements: { id: challengeId } }
  );
  if (!rows.length) {
    await challenge.update({ invalidated_at: new Date() });
    throw ApiError.tooMany("Too many incorrect attempts. Request a new code.");
  }
  const { attempts, max_attempts: maxAttempts } = rows[0];

  if (!/^\d{6}$/.test(String(otp)) || !safeEqualHex(otpDigest(challengeId, otp), challenge.otp_hash)) {
    const remaining = maxAttempts - attempts;
    if (remaining <= 0) {
      await VerificationChallenge.update({ invalidated_at: new Date() }, { where: { id: challengeId } });
      throw ApiError.tooMany("Too many incorrect attempts. Request a new code.");
    }
    throw ApiError.badRequest(`Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`, { remaining }, "OTP_INCORRECT");
  }

  // Mark consumed only if still unconsumed: a concurrent second use loses the race.
  const [consumed] = await sequelize.query(
    `UPDATE verification_challenges SET consumed_at = now() WHERE id = :id AND consumed_at IS NULL RETURNING id`,
    { replacements: { id: challengeId } }
  );
  if (!consumed.length) throw ApiError.badRequest("This code has already been used.", undefined, "OTP_USED");
  challenge.consumed_at = new Date();
  return challenge;
}

async function verifyOtp({ challengeId, otp }, req) {
  const challenge = await consumeChallenge(challengeId, otp, ["register", "login"]);
  const user = await User.findByPk(challenge.user_id);
  if (!user) throw ApiError.badRequest("Account not found", undefined, "CHALLENGE_INVALID");
  if (user.status === "suspended") throw ApiError.forbidden("This account has been suspended.", "ACCOUNT_SUSPENDED");

  await sequelize.transaction(async (transaction) => {
    if (challenge.purpose === "register" && user.status === "pending") await activateUser(user, transaction);
    await user.update({ last_login_at: new Date() }, { transaction });
  });
  const session = await createSession(user, req);
  const context = await accessService.loadContext(user.id);
  return { ...session, context: accessService.publicContext(context) };
}

async function resendOtp({ challengeId }) {
  const challenge = await VerificationChallenge.findByPk(challengeId);
  if (!challenge || challenge.consumed_at) {
    throw ApiError.badRequest("This verification request is not valid. Start again.", undefined, "CHALLENGE_INVALID");
  }
  const waitMs = challenge.last_sent_at.getTime() + config.otp.resendCooldownSeconds * 1000 - Date.now();
  if (waitMs > 0) {
    const seconds = Math.ceil(waitMs / 1000);
    throw ApiError.tooMany(`Please wait ${seconds} seconds before requesting a new code.`, seconds);
  }
  if (challenge.resend_count >= config.otp.maxResends) {
    throw ApiError.tooMany("Too many codes requested. Start again later.");
  }
  // Session-less flows can be abandoned for long periods; refuse to revive very old challenges.
  if (Date.now() - challenge.created_at.getTime() > 60 * 60 * 1000) {
    throw ApiError.badRequest("This verification request has expired. Start again.", undefined, "CHALLENGE_INVALID");
  }
  const user = await User.findByPk(challenge.user_id);
  const otp = randomOtp(config.otp.length);
  await challenge.update({
    otp_hash: otpDigest(challenge.id, otp),
    expires_at: new Date(Date.now() + config.otp.ttlMinutes * 60 * 1000),
    attempts: 0,
    invalidated_at: null,
    resend_count: challenge.resend_count + 1,
    last_sent_at: new Date(),
  });
  sendOtpEmail(user, challenge.purpose, otp).catch(() => {});
  return challengeResponse(challenge, user, otp);
}

async function challengeStatus(challengeId) {
  const challenge = await VerificationChallenge.findByPk(challengeId);
  if (!challenge || challenge.consumed_at || challenge.invalidated_at) {
    throw ApiError.notFound("This verification request is no longer active", "CHALLENGE_INVALID");
  }
  const user = await User.findByPk(challenge.user_id);
  return {
    challengeId: challenge.id,
    purpose: challenge.purpose,
    destination: maskEmail(user.email),
    expiresAt: challenge.expires_at,
    resendAvailableAt: new Date(challenge.last_sent_at.getTime() + config.otp.resendCooldownSeconds * 1000),
    attemptsLeft: Math.max(0, challenge.max_attempts - challenge.attempts),
    emailDelivery: mailService.isConfigured(),
  };
}

// --------------------------------------------------------------- password reset
async function forgotPassword({ email }, req) {
  const user = await User.findOne({
    where: { [Op.and]: [sequelize.where(sequelize.fn("lower", sequelize.col("email")), normaliseEmail(email))], status: { [Op.ne]: "suspended" } },
  });
  if (!user) {
    // Same response shape for unknown emails so accounts cannot be enumerated.
    return {
      challengeId: crypto.randomUUID(),
      purpose: "password_reset",
      destination: maskEmail(normaliseEmail(email)),
      expiresAt: new Date(Date.now() + config.otp.ttlMinutes * 60 * 1000),
      resendAvailableAt: new Date(Date.now() + config.otp.resendCooldownSeconds * 1000),
      emailDelivery: mailService.isConfigured(),
    };
  }
  return createChallenge(user, "password_reset", req);
}

async function verifyResetOtp({ challengeId, otp }) {
  const challenge = await consumeChallenge(challengeId, otp, ["password_reset"]);
  const resetToken = randomToken(32);
  await VerificationChallenge.update({ reset_token_hash: hmac(resetToken) }, { where: { id: challenge.id } });
  return { challengeId: challenge.id, resetToken };
}

async function resetPassword({ challengeId, resetToken, password }) {
  const challenge = await VerificationChallenge.findByPk(challengeId);
  const fresh = challenge && challenge.consumed_at && Date.now() - challenge.consumed_at.getTime() < 15 * 60 * 1000;
  if (!challenge || challenge.purpose !== "password_reset" || !fresh || !challenge.reset_token_hash ||
      !safeEqualHex(hmac(resetToken), challenge.reset_token_hash)) {
    throw ApiError.badRequest("This reset link has expired. Start again.", undefined, "RESET_INVALID");
  }
  await sequelize.transaction(async (transaction) => {
    await User.update({ password_hash: await hashPassword(password) }, { where: { id: challenge.user_id }, transaction });
    // One use only, and sign out every existing session.
    await challenge.update({ reset_token_hash: null }, { transaction });
    await Session.update({ revoked_at: new Date() }, { where: { user_id: challenge.user_id, revoked_at: null }, transaction });
  });
  return { reset: true };
}

async function changePassword(userId, { currentPassword, newPassword }, currentSessionId) {
  const user = await User.scope("withPassword").findByPk(userId);
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw ApiError.badRequest("Current password is incorrect", { currentPassword: "Current password is incorrect" }, "INVALID_PASSWORD");
  }
  await user.update({ password_hash: await hashPassword(newPassword) });
  await Session.update(
    { revoked_at: new Date() },
    { where: { user_id: userId, revoked_at: null, id: { [Op.ne]: currentSessionId } } }
  );
}

// --------------------------------------------------------------------- sessions
function signAccess(userId, sessionId) {
  return jwt.sign({ sub: userId, sid: sessionId, typ: "access" }, config.auth.accessSecret, {
    algorithm: "HS256",
    expiresIn: config.auth.accessExpiresIn,
  });
}

async function createSession(user, req) {
  const refreshToken = randomToken(48);
  const session = await Session.create({
    user_id: user.id,
    refresh_token_hash: hmac(refreshToken),
    user_agent: req ? (req.get("user-agent") || "").slice(0, 300) : null,
    ip: req ? (req.ip || "").slice(0, 64) : null,
    expires_at: new Date(Date.now() + config.auth.refreshExpiresDays * 86400 * 1000),
    last_used_at: new Date(),
  });
  return { accessToken: signAccess(user.id, session.id), refreshToken, sessionId: session.id };
}

// Rotates the refresh token on every use.
async function refresh(refreshToken, req) {
  if (!refreshToken) throw ApiError.unauthorized("Session expired", "REFRESH_MISSING");
  const session = await Session.findOne({ where: { refresh_token_hash: hmac(refreshToken) } });
  if (!session || session.revoked_at || session.expires_at < new Date()) {
    throw ApiError.unauthorized("Session expired. Please sign in again.", "REFRESH_INVALID");
  }
  const context = await accessService.loadContext(session.user_id);
  if (!context || context.user.status !== "active") {
    await session.update({ revoked_at: new Date() });
    throw ApiError.unauthorized("Account is not active", "ACCOUNT_INACTIVE");
  }
  const next = randomToken(48);
  await session.update({
    refresh_token_hash: hmac(next),
    last_used_at: new Date(),
    ip: req ? (req.ip || "").slice(0, 64) : session.ip,
  });
  return { accessToken: signAccess(session.user_id, session.id), refreshToken: next, context: accessService.publicContext(context) };
}

async function logout(sessionId) {
  if (sessionId) await Session.update({ revoked_at: new Date() }, { where: { id: sessionId, revoked_at: null } });
}

async function logoutByRefresh(refreshToken) {
  if (!refreshToken) return;
  await Session.update({ revoked_at: new Date() }, { where: { refresh_token_hash: hmac(refreshToken), revoked_at: null } });
}

module.exports = {
  register,
  login,
  verifyOtp,
  resendOtp,
  challengeStatus,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
  changePassword,
  refresh,
  logout,
  logoutByRefresh,
  assignRole,
  createSession,
  maskEmail,
};

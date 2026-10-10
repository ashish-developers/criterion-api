const authService = require("../Services/authService");
const accessService = require("../Services/accessService");
const { config } = require("../Config/env");
const { ACCESS_COOKIE } = require("../Middleware/auth");
const { issueCsrfCookie } = require("../Middleware/csrf");
const { ok, created } = require("../Utils/http");

const REFRESH_COOKIE = "refresh_token";

function cookieBase() {
  return { httpOnly: true, sameSite: "lax", secure: config.auth.cookieSecure, domain: config.auth.cookieDomain };
}

function setSessionCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...cookieBase(), path: "/", maxAge: 60 * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...cookieBase(),
    path: `${config.apiPrefix}/auth`,
    maxAge: config.auth.refreshExpiresDays * 86400 * 1000,
  });
  // Non-secret hint so the web app's proxy can redirect signed-out visitors early.
  // Authorisation never relies on it: the API checks the real session on every request.
  res.cookie("signed_in", "1", { ...cookieBase(), path: "/", maxAge: config.auth.refreshExpiresDays * 86400 * 1000 });
  // Rotate the CSRF token with each new session.
  issueCsrfCookie(res);
}

function clearSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase(), path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase(), path: `${config.apiPrefix}/auth` });
  res.clearCookie("signed_in", { ...cookieBase(), path: "/" });
}

const register = async (req, res) => {
  const challenge = await authService.register(req.body, req);
  return created(res, challenge, "Account created. Enter the verification code to activate it.");
};

const login = async (req, res) => {
  const challenge = await authService.login(req.body, req);
  const message =
    challenge.purpose === "register"
      ? "Your email is not verified yet. Enter the code to activate your account."
      : "Password accepted. Enter the verification code to finish signing in.";
  return ok(res, challenge, message);
};

const verifyOtp = async (req, res) => {
  const result = await authService.verifyOtp(req.body, req);
  setSessionCookies(res, result);
  return ok(res, result.context, "Verification successful");
};

const resendOtp = async (req, res) => {
  const challenge = await authService.resendOtp(req.body);
  return ok(res, challenge, "A new code has been sent");
};

const challengeStatus = async (req, res) => {
  return ok(res, await authService.challengeStatus(req.params.challengeId));
};

const forgotPassword = async (req, res) => {
  const challenge = await authService.forgotPassword(req.body, req);
  return ok(res, challenge, "If an account exists for this email, a reset code has been sent.");
};

const verifyResetOtp = async (req, res) => {
  return ok(res, await authService.verifyResetOtp(req.body), "Code verified. Choose a new password.");
};

const resetPassword = async (req, res) => {
  await authService.resetPassword(req.body);
  clearSessionCookies(res);
  return ok(res, { reset: true }, "Password updated. Sign in with your new password.");
};

const refresh = async (req, res) => {
  try {
    const result = await authService.refresh(req.cookies?.[REFRESH_COOKIE], req);
    setSessionCookies(res, result);
    return ok(res, result.context, "Session refreshed");
  } catch (error) {
    clearSessionCookies(res);
    throw error;
  }
};

const me = async (req, res) => ok(res, accessService.publicContext(req.auth));

const logout = async (req, res) => {
  await authService.logout(req.auth?.sessionId);
  await authService.logoutByRefresh(req.cookies?.[REFRESH_COOKIE]);
  clearSessionCookies(res);
  return ok(res, null, "Signed out");
};

const changePassword = async (req, res) => {
  await authService.changePassword(req.auth.user.id, req.body, req.auth.sessionId);
  return ok(res, null, "Password changed. Other devices have been signed out.");
};

const csrf = async (req, res) => {
  const token = issueCsrfCookie(res, req.cookies?.csrf_token);
  return ok(res, { csrfToken: token });
};

module.exports = {
  register,
  login,
  verifyOtp,
  resendOtp,
  challengeStatus,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
  refresh,
  me,
  logout,
  changePassword,
  csrf,
};

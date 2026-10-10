// Double-submit CSRF protection for cookie-authenticated requests. The API sets a
// readable csrf_token cookie; the web app echoes it in the X-CSRF-Token header.
// A cross-site page can neither read the cookie nor set the header.
const crypto = require("crypto");
const ApiError = require("../Utils/ApiError");
const { config } = require("../Config/env");

const COOKIE = "csrf_token";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

function issueCsrfCookie(res, existing) {
  const token = existing || crypto.randomBytes(24).toString("base64url");
  res.cookie(COOKIE, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: config.auth.cookieSecure,
    domain: config.auth.cookieDomain,
    path: "/",
    maxAge: config.auth.refreshExpiresDays * 86400 * 1000,
  });
  return token;
}

function csrfProtection(req, res, next) {
  if (SAFE.has(req.method)) {
    if (!req.cookies?.[COOKIE]) issueCsrfCookie(res);
    return next();
  }
  const cookieToken = req.cookies?.[COOKIE];
  const headerToken = req.get("x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken.length !== headerToken.length ||
      !crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))) {
    return next(ApiError.forbidden("Security token missing or invalid. Refresh the page and try again.", "CSRF_FAILED"));
  }
  next();
}

module.exports = { csrfProtection, issueCsrfCookie, CSRF_COOKIE: COOKIE };

const router = require("express").Router();
const authController = require("../Controllers/authController");
const v = require("../Validators/authValidators");
const { validate } = require("../Middleware/validate");
const { rateLimit } = require("../Middleware/rateLimit");
const { requireAuth, optionalAuth } = require("../Middleware/auth");

const MIN = 60 * 1000;
const byEmail = (req) => String(req.body?.email || "").toLowerCase();
const byChallenge = (req) => String(req.body?.challengeId || req.params?.challengeId || "");

router.get("/csrf", authController.csrf);
router.post("/register", rateLimit({ name: "register", windowMs: 60 * MIN, max: 10 }), validate({ body: v.register }), authController.register);
router.post("/login", rateLimit({ name: "login", windowMs: 15 * MIN, max: 10, by: byEmail }), validate({ body: v.login }), authController.login);
router.post("/verify-otp", rateLimit({ name: "verify", windowMs: 10 * MIN, max: 15, by: byChallenge }), validate({ body: v.verifyOtp }), authController.verifyOtp);
router.post("/resend-otp", rateLimit({ name: "resend", windowMs: 60 * MIN, max: 10 }), validate({ body: v.challenge }), authController.resendOtp);
router.get("/challenges/:challengeId", rateLimit({ name: "challenge", windowMs: MIN, max: 30 }), validate({ params: v.challenge }), authController.challengeStatus);
router.post("/forgot-password", rateLimit({ name: "forgot", windowMs: 60 * MIN, max: 5, by: byEmail }), validate({ body: v.forgotPassword }), authController.forgotPassword);
router.post("/forgot-password/verify", rateLimit({ name: "reset-verify", windowMs: 10 * MIN, max: 15, by: byChallenge }), validate({ body: v.verifyOtp }), authController.verifyResetOtp);
router.post("/reset-password", rateLimit({ name: "reset", windowMs: 15 * MIN, max: 10 }), validate({ body: v.resetPassword }), authController.resetPassword);
// Set-password invitations for accounts created by organisation admins.
router.post("/invitations/preview", rateLimit({ name: "invite-preview", windowMs: MIN, max: 20 }), validate({ body: v.inviteToken }), authController.invitationPreview);
router.post("/invitations/accept", rateLimit({ name: "invite-accept", windowMs: 15 * MIN, max: 10 }), validate({ body: v.acceptInvite }), authController.acceptInvitation);
router.post("/refresh", rateLimit({ name: "refresh", windowMs: MIN, max: 30 }), authController.refresh);
router.get("/me", requireAuth, authController.me);
router.post("/logout", optionalAuth, authController.logout);
router.post("/change-password", requireAuth, validate({ body: v.changePassword }), authController.changePassword);

module.exports = router;

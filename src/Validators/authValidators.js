const { z, email, phone, password, gstin, otp, uuid } = require("./common");

const register = z
  .object({
    name: z.string().trim().min(2, "Enter your full name").max(120),
    email,
    phone,
    password,
    confirmPassword: z.string(),
    accountType: z.enum(["individual", "business", "vendor"], { message: "Choose an account type" }),
    companyName: z.string().trim().max(160).optional(),
    gstin: gstin.optional().or(z.literal("")).transform((v) => v || undefined),
    acceptTerms: z.literal(true, { message: "You must accept the terms to continue" }),
    marketingOptIn: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.password !== data.confirmPassword) {
      ctx.addIssue({ code: "custom", path: ["confirmPassword"], message: "Passwords do not match" });
    }
    if (data.accountType === "business" && (!data.companyName || data.companyName.length < 2)) {
      ctx.addIssue({ code: "custom", path: ["companyName"], message: "Enter your company name" });
    }
  });

const login = z.object({ email, password: z.string().min(1, "Enter your password").max(128) });
const verifyOtp = z.object({ challengeId: uuid, otp });
const challenge = z.object({ challengeId: uuid });
const forgotPassword = z.object({ email });
const resetPassword = z
  .object({ challengeId: uuid, resetToken: z.string().min(20).max(200), password, confirmPassword: z.string() })
  .refine((d) => d.password === d.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match" });
const changePassword = z
  .object({ currentPassword: z.string().min(1, "Enter your current password"), newPassword: password, confirmPassword: z.string() })
  .refine((d) => d.newPassword === d.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match" });

module.exports = { register, login, verifyOtp, challenge, forgotPassword, resetPassword, changePassword };

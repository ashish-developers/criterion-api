const { z } = require("zod");

const uuid = z.string().uuid("Invalid identifier");
const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(190);
const phone = z
  .string()
  .trim()
  .regex(/^(\+91[\s-]?)?[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number");
const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password is too long")
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/\d/, "Password must contain a number");
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN");
const pan = z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "Enter a valid PAN");
const pincode = z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit PIN code");
const ifsc = z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid IFSC code");
const otp = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");
const optionalText = (max = 500) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const rupeesToPaise = z.coerce.number().min(0).max(100000000).transform((v) => Math.round(v * 100));
const sizeBreakdown = z.record(z.string().max(10), z.coerce.number().int().min(0).max(100000)).optional().nullable();

const address = z.object({
  label: optionalText(60),
  type: z.enum(["shipping", "billing"]).default("shipping"),
  contact_name: z.string().trim().min(2, "Enter the contact name").max(120),
  phone,
  line1: z.string().trim().min(3, "Enter the address").max(200),
  line2: optionalText(200),
  city: z.string().trim().min(2, "Enter the city").max(80),
  state: z.string().trim().min(2, "Select the state").max(80),
  pincode,
  is_default: z.boolean().optional().default(false),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional(),
  sort: z.string().trim().max(40).optional(),
});

module.exports = { z, uuid, email, phone, password, gstin, pan, pincode, ifsc, otp, optionalText, rupeesToPaise, sizeBreakdown, address, listQuery };

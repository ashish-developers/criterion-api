const { z, uuid, optionalText } = require("./common");
const { isAllowedImageUrl } = require("../Services/blogContent");

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens")
  .optional()
  .nullable()
  .or(z.literal("").transform(() => null));

const imageUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => !v || isAllowedImageUrl(v), "Upload an image, or use an https:// image address")
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional();

const post = z.object({
  title: z.string().trim().min(3, "Enter a title of at least 3 characters").max(200),
  slug,
  excerpt: optionalText(500),
  content: z.string().max(500_000, "The post is too long").default(""),
  featuredImageUrl: imageUrl,
  featuredImageAlt: optionalText(200),
  socialImageUrl: imageUrl,
  authorId: uuid.optional().nullable(),
  categoryId: z.coerce.number().int().positive().optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(60)).max(15, "Use at most 15 tags").default([]),
  metaTitle: optionalText(70),
  metaDescription: optionalText(170),
  metaKeywords: optionalText(300),
  isFeatured: z.boolean().optional(),
});

const list = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.string().trim().max(200).regex(/^[a-z_,]*$/, "Invalid status filter").optional(),
  categoryId: z.coerce.number().int().min(0).optional(),
  authorId: uuid.optional(),
  featured: z.enum(["true", "false"]).optional().transform((v) => (v === undefined ? undefined : v === "true")),
  createdFrom: isoDate,
  createdTo: isoDate,
  publishedFrom: isoDate,
  publishedTo: isoDate,
  sort: z.enum(["newest", "oldest", "updated", "published", "title", "views"]).optional(),
});

const action = z.object({
  action: z.enum(["submit", "approve", "reject", "publish", "schedule", "unpublish", "archive", "restore", "feature"]),
});

const actionBody = z
  .object({
    note: optionalText(1000),
    scheduledAt: z.string().datetime({ offset: true, message: "Choose a valid date and time" }).optional(),
    featured: z.boolean().optional(),
  })
  .default({});

const slugCheck = z.object({ slug: z.string().trim().max(220).optional(), title: z.string().trim().max(200).optional(), excludeId: uuid.optional() });

const category = z.object({
  name: z.string().trim().min(2, "Enter a name").max(80),
  slug,
  description: optionalText(300),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
});

const tag = z.object({ name: z.string().trim().min(1, "Enter a name").max(60), slug });

const permissions = z.object({ permissions: z.array(z.string().max(80)).max(30) });
const settings = z.object({ approvalRequired: z.boolean() });

const publicList = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(24).optional(),
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(100).regex(/^[a-z0-9-]*$/).optional(),
  tag: z.string().trim().max(80).regex(/^[a-z0-9-]*$/).optional(),
  featured: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  featuredFirst: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

// Any unknown slug is simply a 404 from the query, so only the length is checked here.
const publicSlug = z.object({ slug: z.string().trim().min(1).max(220) });
const publicDetailQuery = z.object({ view: z.enum(["1", "0"]).optional() });

module.exports = {
  post,
  list,
  action,
  actionBody,
  slugCheck,
  category,
  tag,
  permissions,
  settings,
  publicList,
  publicSlug,
  publicDetailQuery,
  idParam: z.object({ id: uuid }),
  intId: z.object({ id: z.coerce.number().int().positive() }),
  userId: z.object({ userId: uuid }),
  tagQuery: z.object({ q: z.string().trim().max(60).optional() }),
};

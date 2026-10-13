// Blog endpoints: management (/admin/blog) and the public website (/blog).
const blogService = require("../Services/blogService");
const blogAdmin = require("../Services/blogAdminService");
const audit = require("../Services/auditService");
const ApiError = require("../Utils/ApiError");
const { ok, created, pageParams, pageMeta } = require("../Utils/http");

const ACTION_MESSAGES = {
  submit: "Submitted for approval",
  approve: "Post approved",
  reject: "Post rejected",
  publish: "Post published",
  schedule: "Publication scheduled",
  unpublish: "Post unpublished",
  archive: "Post archived",
  restore: "Post restored to drafts",
  feature: "Featured setting updated",
};

module.exports = {
  // ---- Management
  meta: async (req, res) => ok(res, await blogService.meta(req.auth)),
  stats: async (req, res) => ok(res, await blogService.stats(req.auth)),
  list: async (req, res) => {
    const paging = pageParams(req.validatedQuery);
    const result = await blogService.list(req.auth, { ...req.validatedQuery, ...paging });
    return ok(res, result.items, "OK", pageMeta(paging, result.total));
  },
  detail: async (req, res) => ok(res, await blogService.adminPost(req.auth, req.params.id)),
  history: async (req, res) => ok(res, await blogService.postHistory(req.auth, req.params.id)),
  slugCheck: async (req, res) => ok(res, await blogService.slugCheck(req.auth, req.validatedQuery)),
  create: async (req, res) => {
    const { post, after } = await blogService.save(req.auth, req.body);
    await audit.record(req, "blog.created", "blog_post", post.id, { after });
    return created(res, post, "Draft saved");
  },
  update: async (req, res) => {
    const { post, before, after } = await blogService.save(req.auth, req.body, req.params.id);
    await audit.record(req, "blog.updated", "blog_post", post.id, { before, after });
    return ok(res, post, "Post saved");
  },
  transition: async (req, res) => {
    const { action } = req.params;
    if (action === "reject" && !req.body.note) {
      throw ApiError.unprocessable("Tell the author why the post was rejected", "VALIDATION_FAILED", { note: "Enter a reason" });
    }
    if (action === "schedule" && !req.body.scheduledAt) {
      throw ApiError.unprocessable("Choose a publication date and time", "VALIDATION_FAILED", { scheduledAt: "Required" });
    }
    if (action === "feature" && typeof req.body.featured !== "boolean") {
      throw ApiError.unprocessable("Say whether the post is featured", "VALIDATION_FAILED", { featured: "Required" });
    }
    const result = await blogService.transition(req.auth, req.params.id, action, req.body);
    await audit.record(req, `blog.${action === "feature" && !req.body.featured ? "unfeatured" : result.label}`, "blog_post", req.params.id, {
      before: result.before,
      after: { ...result.after, note: req.body.note || undefined },
    });
    return ok(res, result.post, ACTION_MESSAGES[action]);
  },
  remove: async (req, res) => {
    const { before } = await blogService.remove(req.auth, req.params.id);
    await audit.record(req, "blog.deleted", "blog_post", req.params.id, { before });
    return ok(res, null, "Post deleted");
  },
  analytics: async (req, res) => ok(res, await blogService.analytics()),

  // ---- Categories and tags
  categories: async (req, res) => ok(res, await blogAdmin.listCategories()),
  saveCategory: async (req, res) => {
    const { category, before } = await blogAdmin.saveCategory(req.body, req.params.id);
    await audit.record(req, req.params.id ? "blog.category_updated" : "blog.category_created", "blog_category", category.id, { before, after: category });
    return req.params.id ? ok(res, category, "Category saved") : created(res, category, "Category added");
  },
  deleteCategory: async (req, res) => {
    const { before, postsAffected } = await blogAdmin.deleteCategory(req.params.id);
    await audit.record(req, "blog.category_deleted", "blog_category", req.params.id, { before });
    return ok(res, null, postsAffected ? `Category deleted; ${postsAffected} post(s) are now uncategorised` : "Category deleted");
  },
  tags: async (req, res) => ok(res, await blogAdmin.listTags(req.validatedQuery)),
  saveTag: async (req, res) => {
    const { tag, before } = await blogAdmin.saveTag(req.body, req.params.id);
    await audit.record(req, req.params.id ? "blog.tag_updated" : "blog.tag_created", "blog_tag", tag.id, { before, after: tag });
    return req.params.id ? ok(res, tag, "Tag saved") : created(res, tag, "Tag added");
  },
  deleteTag: async (req, res) => {
    const { before } = await blogAdmin.deleteTag(req.params.id);
    await audit.record(req, "blog.tag_deleted", "blog_tag", req.params.id, { before });
    return ok(res, null, "Tag deleted");
  },

  // ---- Permissions and settings (Platform Admin)
  permissions: async (req, res) => ok(res, await blogAdmin.listPermissions(req.validatedQuery)),
  setPermissions: async (req, res) => {
    const result = await blogAdmin.setUserPermissions(req.auth, req.params.userId, req.body.permissions);
    await audit.record(req, "blog.permissions_changed", "user", req.params.userId, { before: { permissions: result.before }, after: { permissions: result.after, email: result.user.email } });
    return ok(res, { userId: req.params.userId, granted: result.after }, result.after.length ? `Blog access updated for ${result.user.name}` : `Blog access removed for ${result.user.name}`);
  },
  saveSettings: async (req, res) => {
    const { before, after } = await blogAdmin.saveSettings(req.auth, req.body);
    await audit.record(req, "blog.settings", "setting", "blog", { before, after });
    return ok(res, { approvalRequired: after.approval_required }, after.approval_required ? "Approval is now required before publishing" : "Approval is no longer required");
  },

  // ---- Public website
  publicList: async (req, res) => {
    const q = req.validatedQuery;
    const paging = pageParams(q, { defaultLimit: 9, maxLimit: 24 });
    const result = await blogService.publicList({ ...q, ...paging });
    res.setHeader("Cache-Control", "public, max-age=60");
    return ok(res, result.items, "OK", pageMeta(paging, result.total));
  },
  publicPost: async (req, res) => {
    const post = await blogService.publicPost(req.params.slug, { countView: req.validatedQuery.view === "1" });
    res.setHeader("Cache-Control", "public, max-age=60");
    return ok(res, post);
  },
  publicCategories: async (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    return ok(res, await blogService.publicCategories());
  },
  sitemap: async (req, res) => ok(res, await blogService.sitemapEntries()),
};

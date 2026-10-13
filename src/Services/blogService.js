// Blog posts: permission-checked authoring, the publication workflow, the management
// listing and statistics, and the public (published-only) queries.
//
// Access is decided here, on the server, for every request:
//   - "own" posts are those the user authored or created;
//   - blog.view / edit_all / delete_all / approve see every post, everyone else only their own;
//   - each workflow action has a permission rule and a status rule (see rules()), and the
//     same rules produce the per-post `actions` the dashboard uses to show buttons.
const { Op, UniqueConstraintError } = require("sequelize");
const { sequelize, BlogPost, BlogCategory, BlogTag, BlogPostTag, BlogPostHistory, User } = require("../Models");
const ApiError = require("../Utils/ApiError");
const settingsService = require("./settingsService");
const auditService = require("./auditService");
const blogContent = require("./blogContent");

const STATUSES = ["draft", "pending_approval", "approved", "published", "scheduled", "rejected", "archived"];

// A post is public when it is published, or scheduled and its time has come. The scheduler
// moves due posts to "published" every minute; this condition makes them visible on time
// even if the job has not run yet.
const LIVE = `(p.status = 'published' OR (p.status = 'scheduled' AND p.scheduled_at <= now()))`;
const LIVE_AT = `(CASE WHEN p.status = 'published' THEN p.published_at ELSE p.scheduled_at END)`;

async function approvalRequired() {
  const settings = await settingsService.get("blog");
  return settings?.approval_required !== false;
}

// ------------------------------------------------------------------ access rules
function access(auth) {
  const has = (code) => auth.permissions.has(code);
  const uid = auth.user.id;
  const own = (post) => post.author_id === uid || post.created_by === uid;
  const viewAll = ["blog.view", "blog.edit_all", "blog.delete_all", "blog.approve"].some(has);
  return {
    has,
    uid,
    own,
    viewAll,
    canSee: (post) => viewAll || own(post),
    canEdit: (post) => has("blog.edit_all") || (has("blog.edit_own") && own(post)),
    canDelete: (post) => has("blog.delete_all") || (has("blog.delete_own") && own(post)),
  };
}

/**
 * Every action on a post: `perm` (does the user hold the right permissions for this post)
 * and `state` (does the post's status allow it). Failing perm is a 403, failing state a 409.
 */
function rules(a, post, needsApprovalSetting) {
  const s = post.status;
  const canEdit = a.canEdit(post);
  const live = s === "published" || s === "scheduled";
  const needsApproval = needsApprovalSetting && !a.has("blog.approve");
  const cleared = !needsApproval || s === "approved" || s === "scheduled";
  const rule = (perm, state, message, code = "BLOG_INVALID_STATE") => ({ perm: Boolean(perm), state: Boolean(state), message, code });
  const goLiveMessage = (verb) =>
    s === "published" ? "This post is already published" : `This post must be approved before it can be ${verb}`;
  return {
    edit: rule(
      canEdit,
      !live || (a.has("blog.publish") && !needsApproval),
      "This post is live. Unpublish it before editing, or ask someone who can publish without approval.",
      "BLOG_LIVE_LOCKED"
    ),
    submit: rule(canEdit, ["draft", "rejected"].includes(s), "Only drafts and rejected posts can be submitted for approval"),
    approve: rule(a.has("blog.approve"), s === "pending_approval", "Only posts awaiting approval can be approved"),
    reject: rule(a.has("blog.approve"), ["pending_approval", "approved"].includes(s), "Only posts awaiting approval, or approved, can be rejected"),
    publish: rule(canEdit && a.has("blog.publish"), s !== "published" && cleared, goLiveMessage("published"), s === "published" ? "BLOG_INVALID_STATE" : "BLOG_APPROVAL_REQUIRED"),
    schedule: rule(canEdit && a.has("blog.schedule"), s !== "published" && cleared, goLiveMessage("scheduled"), s === "published" ? "BLOG_INVALID_STATE" : "BLOG_APPROVAL_REQUIRED"),
    unpublish: rule(canEdit && a.has("blog.unpublish"), live, "Only published or scheduled posts can be unpublished"),
    archive: rule(canEdit && (!live || a.has("blog.unpublish")), s !== "archived", "This post is already archived"),
    restore: rule(canEdit, s === "archived", "Only archived posts can be restored"),
    delete: rule(a.canDelete(post) && (!live || a.has("blog.unpublish") || a.has("blog.delete_all")), true, ""),
    feature: rule(a.has("blog.feature") && a.canSee(post), s !== "archived", "Archived posts cannot be featured"),
  };
}

function actionsFor(a, post, needsApproval) {
  return Object.fromEntries(Object.entries(rules(a, post, needsApproval)).map(([k, r]) => [k, r.perm && r.state]));
}

function assertRule(a, post, needsApproval, action) {
  const r = rules(a, post, needsApproval)[action];
  if (!r.perm) throw ApiError.forbidden();
  if (!r.state) throw ApiError.conflict(r.message, r.code);
}

// ------------------------------------------------------------------ queries
const likeParam = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const TAGS_JSON = `COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'slug', t.slug) ORDER BY t.name)
                              FROM blog_post_tags pt JOIN blog_tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id), '[]'::json)`;

async function selectPosts({ where = [], replacements = {}, order = "p.created_at DESC", limit = 20, offset = 0, withContent = false }) {
  const [rows] = await sequelize.query(
    `SELECT p.id, p.title, p.slug, p.excerpt, ${withContent ? "p.content," : ""} left(p.content_text, 400) AS text_head,
            cardinality(regexp_split_to_array(btrim(p.content_text), '\\s+')) AS word_count,
            p.featured_image_url, p.featured_image_alt, p.social_image_url, p.author_id, p.category_id, p.status, p.is_featured,
            p.meta_title, p.meta_description, p.meta_keywords, p.review_note, p.view_count, p.created_by, p.updated_by,
            p.submitted_at, p.reviewed_at, p.published_at, p.scheduled_at, p.created_at, p.updated_at,
            ${LIVE} AS is_live, ${LIVE_AT} AS live_at,
            u.name AS author_name, u.avatar_url AS author_avatar,
            c.name AS category_name, c.slug AS category_slug,
            ${TAGS_JSON} AS tags,
            count(*) OVER () AS total_count
       FROM blog_posts p
       JOIN users u ON u.id = p.author_id
       LEFT JOIN blog_categories c ON c.id = p.category_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${order}
      LIMIT :limit OFFSET :offset`,
    { replacements: { ...replacements, limit, offset } }
  );
  return { rows, total: rows.length ? Number(rows[0].total_count) : 0 };
}

const readingMinutes = (row) => Math.max(1, Math.ceil((Number(row.word_count) || 0) / 200));

function presentAdmin(row, a, needsApproval) {
  const out = {
    id: row.id,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    featuredImageUrl: row.featured_image_url,
    featuredImageAlt: row.featured_image_alt,
    socialImageUrl: row.social_image_url,
    author: { id: row.author_id, name: row.author_name },
    category: row.category_id ? { id: row.category_id, name: row.category_name, slug: row.category_slug } : null,
    tags: row.tags || [],
    status: row.status,
    isFeatured: row.is_featured,
    isLive: row.is_live,
    metaTitle: row.meta_title,
    metaDescription: row.meta_description,
    metaKeywords: row.meta_keywords,
    reviewNote: row.review_note,
    viewCount: row.view_count,
    readingMinutes: readingMinutes(row),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    publishedAt: row.published_at,
    scheduledAt: row.scheduled_at,
    actions: actionsFor(a, row, needsApproval),
  };
  if (row.content !== undefined) out.content = row.content;
  return out;
}

async function adminPost(auth, id, { needsApproval } = {}) {
  const a = access(auth);
  const { rows } = await selectPosts({ where: ["p.id = :id"], replacements: { id }, limit: 1, withContent: true });
  const row = rows[0];
  // Same answer for missing and not-yours, so post IDs cannot be probed.
  if (!row || !a.canSee(row)) throw ApiError.notFound("Blog post not found");
  return presentAdmin(row, a, needsApproval ?? (await approvalRequired()));
}

const SORTS = {
  newest: "p.created_at DESC",
  oldest: "p.created_at ASC",
  updated: "p.updated_at DESC",
  published: `${LIVE_AT} DESC NULLS LAST, p.created_at DESC`,
  title: "lower(p.title) ASC",
  views: "p.view_count DESC, p.created_at DESC",
};

function scopeWhere(a) {
  return a.viewAll ? [] : ["(p.author_id = :uid OR p.created_by = :uid)"];
}

async function list(auth, { q, status, categoryId, authorId, featured, createdFrom, createdTo, publishedFrom, publishedTo, sort = "newest", page = 1, limit = 20 }) {
  await publishDue();
  const a = access(auth);
  const where = scopeWhere(a);
  const replacements = { uid: a.uid };
  if (q) {
    where.push(`(p.title ILIKE :q OR p.excerpt ILIKE :q OR p.content_text ILIKE :q OR p.meta_keywords ILIKE :q OR u.name ILIKE :q
                 OR EXISTS (SELECT 1 FROM blog_post_tags pt JOIN blog_tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id AND t.name ILIKE :q))`);
    replacements.q = likeParam(q);
  }
  if (status) {
    where.push("p.status IN (:statuses)");
    replacements.statuses = status.split(",").filter((s) => STATUSES.includes(s));
    if (!replacements.statuses.length) replacements.statuses = ["__none__"];
  }
  if (categoryId === 0) where.push("p.category_id IS NULL");
  else if (categoryId) {
    where.push("p.category_id = :categoryId");
    replacements.categoryId = categoryId;
  }
  if (authorId) {
    where.push("p.author_id = :authorId");
    replacements.authorId = authorId;
  }
  if (featured !== undefined) {
    where.push("p.is_featured = :featured");
    replacements.featured = featured;
  }
  const range = (column, from, to, key) => {
    if (from) {
      where.push(`${column} >= CAST(:${key}From AS date)`);
      replacements[`${key}From`] = from;
    }
    if (to) {
      where.push(`${column} < CAST(:${key}To AS date) + 1`);
      replacements[`${key}To`] = to;
    }
  };
  range("p.created_at", createdFrom, createdTo, "created");
  range("p.published_at", publishedFrom, publishedTo, "published");

  const needsApproval = await approvalRequired();
  const { rows, total } = await selectPosts({ where, replacements, order: SORTS[sort] || SORTS.newest, limit, offset: (page - 1) * limit });
  return { items: rows.map((r) => presentAdmin(r, a, needsApproval)), total };
}

async function stats(auth) {
  await publishDue();
  const a = access(auth);
  const where = scopeWhere(a);
  const [rows] = await sequelize.query(
    `SELECT p.status, count(*)::int AS n, count(*) FILTER (WHERE p.is_featured)::int AS featured, COALESCE(sum(p.view_count), 0)::int AS views
       FROM blog_posts p ${where.length ? `WHERE ${where.join(" AND ")}` : ""} GROUP BY p.status`,
    { replacements: { uid: a.uid } }
  );
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let total = 0;
  let featured = 0;
  let views = 0;
  for (const r of rows) {
    byStatus[r.status] = r.n;
    total += r.n;
    featured += r.featured;
    views += r.views;
  }
  return { total, featured, views, byStatus, scope: a.viewAll ? "all" : "own" };
}

// ------------------------------------------------------------------ authoring
async function uniqueSlug(base, excludeId, transaction) {
  const root = (base || "post").slice(0, 200).replace(/-+$/g, "") || "post";
  const taken = new Set(
    (
      await BlogPost.findAll({
        attributes: ["slug"],
        where: { slug: { [Op.or]: [root, { [Op.like]: `${root}-%` }] }, ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}) },
        transaction,
      })
    ).map((p) => p.slug)
  );
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
}

async function slugCheck(auth, { slug, title, excludeId }) {
  const base = blogContent.slugify(slug || title);
  if (!base) return { slug: "", available: false, suggestion: "" };
  const suggestion = await uniqueSlug(base, excludeId);
  return { slug: base, available: suggestion === base, suggestion };
}

/** Authors must be active platform users (staff); customers and vendors cannot be credited. */
async function assertAuthor(userId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.id = :userId AND u.deleted_at IS NULL AND u.status = 'active' AND ur.scope_type = 'platform' LIMIT 1`,
    { replacements: { userId }, transaction }
  );
  if (!rows.length) throw ApiError.unprocessable("Choose an active platform user as the author", "VALIDATION_FAILED", { authorId: "Choose an active platform user" });
}

/** Tag names → ids. New tags are created only for users who manage the taxonomy. */
async function resolveTags(a, names, transaction) {
  const wanted = [];
  const seen = new Set();
  for (const raw of names) {
    const name = String(raw).trim().replace(/\s+/g, " ");
    const slug = blogContent.slugify(name);
    if (!name || !slug || seen.has(slug)) continue;
    seen.add(slug);
    wanted.push({ name, slug });
  }
  if (!wanted.length) return [];
  const existing = await BlogTag.findAll({ where: { slug: wanted.map((w) => w.slug) }, transaction });
  const bySlug = new Map(existing.map((t) => [t.slug, t.id]));
  const missing = wanted.filter((w) => !bySlug.has(w.slug));
  if (missing.length && !a.has("blog.taxonomy.manage")) {
    throw ApiError.unprocessable(`These tags do not exist yet: ${missing.map((m) => m.name).join(", ")}. Choose existing tags or ask an editor to add them.`, "VALIDATION_FAILED", { tags: "Unknown tag" });
  }
  for (const m of missing) {
    const [tag] = await BlogTag.findOrCreate({ where: { slug: m.slug }, defaults: { name: m.name.slice(0, 60), slug: m.slug }, transaction });
    bySlug.set(m.slug, tag.id);
  }
  return wanted.map((w) => bySlug.get(w.slug));
}

async function history(postId, actorId, action, fromStatus, toStatus, note, transaction) {
  await BlogPostHistory.create({ post_id: postId, actor_user_id: actorId, action, from_status: fromStatus, to_status: toStatus, note: note || null }, { transaction });
}

const AUDITED = ["title", "slug", "excerpt", "status", "category_id", "author_id", "is_featured", "featured_image_url", "meta_title", "meta_description", "published_at", "scheduled_at"];
const snapshot = (post) => (post ? Object.fromEntries(AUDITED.map((k) => [k, post[k] ?? null])) : null);

/** Create (id = undefined) or update a post. Returns { post, before, after }. */
async function save(auth, data, id) {
  const a = access(auth);
  const needsApproval = await approvalRequired();
  try {
    const result = await sequelize.transaction(async (transaction) => {
      let post = null;
      if (id) {
        post = await BlogPost.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!post || !a.canSee(post)) throw ApiError.notFound("Blog post not found");
        assertRule(a, post, needsApproval, "edit");
      } else if (!a.has("blog.create")) {
        throw ApiError.forbidden();
      }
      const before = snapshot(post);

      let authorId = post ? post.author_id : a.uid;
      if (data.authorId && data.authorId !== authorId) {
        if (!a.has("blog.edit_all")) throw ApiError.forbidden("You cannot change the author of a post");
        await assertAuthor(data.authorId, transaction);
        authorId = data.authorId;
      }
      const isFeatured = data.isFeatured ?? post?.is_featured ?? false;
      if (isFeatured !== (post?.is_featured ?? false) && !a.has("blog.feature")) throw ApiError.forbidden("You cannot change whether a post is featured");

      if (data.categoryId) {
        const category = await BlogCategory.findByPk(data.categoryId, { transaction });
        if (!category) throw ApiError.unprocessable("Choose a valid category", "VALIDATION_FAILED", { categoryId: "Unknown category" });
      }

      let slug;
      if (data.slug) {
        slug = blogContent.slugify(data.slug);
        if (!slug) throw ApiError.unprocessable("Enter a valid URL slug", "VALIDATION_FAILED", { slug: "Use letters, numbers and hyphens" });
        const clash = await BlogPost.findOne({ attributes: ["id"], where: { slug, ...(post ? { id: { [Op.ne]: post.id } } : {}) }, transaction });
        if (clash) {
          const suggestion = await uniqueSlug(slug, post?.id, transaction);
          throw ApiError.conflict(`The URL slug "${slug}" is already used by another post. Try "${suggestion}".`, "SLUG_TAKEN", { slug: "Already in use", suggestion });
        }
      } else {
        slug = post ? post.slug : await uniqueSlug(blogContent.slugify(data.title), null, transaction);
      }

      const html = blogContent.sanitize(data.content);
      const fields = {
        title: data.title,
        slug,
        excerpt: data.excerpt,
        content: html,
        content_text: blogContent.toText(html),
        featured_image_url: data.featuredImageUrl,
        featured_image_alt: data.featuredImageAlt,
        social_image_url: data.socialImageUrl,
        author_id: authorId,
        category_id: data.categoryId || null,
        is_featured: isFeatured,
        meta_title: data.metaTitle,
        meta_description: data.metaDescription,
        meta_keywords: data.metaKeywords,
        updated_by: a.uid,
      };

      if (post) {
        const fromStatus = post.status;
        // An edit by someone who cannot approve voids an earlier approval.
        if (post.status === "approved" && needsApproval && !a.has("blog.approve")) fields.status = "draft";
        await post.update(fields, { transaction });
        await history(post.id, a.uid, "updated", fromStatus, post.status, fields.status === "draft" ? "Edited after approval; approval needs to be requested again" : null, transaction);
      } else {
        post = await BlogPost.create({ ...fields, status: "draft", created_by: a.uid }, { transaction });
        await history(post.id, a.uid, "created", null, "draft", null, transaction);
      }

      const tagIds = await resolveTags(a, data.tags || [], transaction);
      await BlogPostTag.destroy({ where: { post_id: post.id }, transaction });
      if (tagIds.length) await BlogPostTag.bulkCreate(tagIds.map((tag_id) => ({ post_id: post.id, tag_id })), { transaction });
      return { id: post.id, before, after: snapshot(post) };
    });
    return { ...result, post: await adminPost(auth, result.id, { needsApproval }) };
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw ApiError.conflict("That URL slug is already in use. Choose another.", "SLUG_TAKEN", { slug: "Already in use" });
    throw error;
  }
}

// ------------------------------------------------------------------ workflow
const ACTION_LABEL = {
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  publish: "published",
  schedule: "scheduled",
  unpublish: "unpublished",
  archive: "archived",
  restore: "restored",
  feature: "featured",
};

function assertComplete(post) {
  const missing = {};
  if (!post.title || post.title.trim().length < 3) missing.title = "Add a title";
  if (!post.content_text || post.content_text.trim().length < 1) missing.content = "Add the post content";
  if (Object.keys(missing).length) throw ApiError.unprocessable("Complete the post before sending it on", "VALIDATION_FAILED", missing);
}

/** Runs one workflow action. Returns { post, before, after, action }. */
async function transition(auth, id, action, body = {}) {
  const a = access(auth);
  const needsApproval = await approvalRequired();
  const result = await sequelize.transaction(async (transaction) => {
    const post = await BlogPost.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!post || !a.canSee(post)) throw ApiError.notFound("Blog post not found");
    assertRule(a, post, needsApproval, action);
    const before = snapshot(post);
    const from = post.status;
    const now = new Date();
    let changes;
    let note = body.note || null;
    switch (action) {
      case "submit":
        assertComplete(post);
        changes = { status: "pending_approval", submitted_at: now, review_note: null };
        break;
      case "approve":
        changes = { status: "approved", reviewed_by: a.uid, reviewed_at: now, review_note: note };
        break;
      case "reject":
        changes = { status: "rejected", reviewed_by: a.uid, reviewed_at: now, review_note: note };
        break;
      case "publish":
        assertComplete(post);
        changes = { status: "published", published_at: now, scheduled_at: null };
        break;
      case "schedule": {
        assertComplete(post);
        const at = new Date(body.scheduledAt);
        if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime() + 60_000) {
          throw ApiError.unprocessable("Choose a publication time at least a minute from now", "VALIDATION_FAILED", { scheduledAt: "Must be in the future" });
        }
        changes = { status: "scheduled", scheduled_at: at, published_at: null };
        note = note || `Scheduled for ${at.toISOString()}`;
        break;
      }
      case "unpublish":
        changes = { status: "draft", published_at: null, scheduled_at: null };
        break;
      case "archive":
        changes = { status: "archived", scheduled_at: null };
        break;
      case "restore":
        changes = { status: "draft", published_at: null };
        break;
      case "feature":
        changes = { is_featured: Boolean(body.featured) };
        note = body.featured ? "Marked as featured" : "Removed from featured";
        break;
      default:
        throw ApiError.badRequest("Unknown action");
    }
    await post.update({ ...changes, updated_by: a.uid }, { transaction });
    await history(post.id, a.uid, action === "feature" && !body.featured ? "unfeature" : action, from, post.status, note, transaction);
    return { id: post.id, before, after: snapshot(post) };
  });
  return { ...result, action, label: ACTION_LABEL[action], post: await adminPost(auth, id, { needsApproval }) };
}

async function remove(auth, id) {
  const a = access(auth);
  const needsApproval = await approvalRequired();
  return sequelize.transaction(async (transaction) => {
    const post = await BlogPost.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!post || !a.canSee(post)) throw ApiError.notFound("Blog post not found");
    assertRule(a, post, needsApproval, "delete");
    const before = snapshot(post);
    await post.destroy({ transaction });
    return { before };
  });
}

async function postHistory(auth, id) {
  const a = access(auth);
  const post = await BlogPost.findByPk(id, { attributes: ["id", "author_id", "created_by"] });
  if (!post || !a.canSee(post)) throw ApiError.notFound("Blog post not found");
  const rows = await BlogPostHistory.findAll({
    where: { post_id: id },
    include: [{ model: User, as: "actor", attributes: ["id", "name"] }],
    order: [["created_at", "DESC"], ["id", "DESC"]],
    limit: 100,
  });
  return rows.map((h) => ({ id: Number(h.id), action: h.action, fromStatus: h.from_status, toStatus: h.to_status, note: h.note, actor: h.actor ? { id: h.actor.id, name: h.actor.name } : null, createdAt: h.created_at }));
}

/** Scheduler task: publishes posts whose scheduled time has passed. Idempotent. */
async function publishDue() {
  const [rows] = await sequelize.query(
    `WITH due AS (
       UPDATE blog_posts SET status = 'published', published_at = scheduled_at, scheduled_at = NULL
        WHERE status = 'scheduled' AND scheduled_at <= now()
        RETURNING id
     )
     INSERT INTO blog_post_history (post_id, action, from_status, to_status, note)
     SELECT id, 'auto_published', 'scheduled', 'published', 'Published at the scheduled time' FROM due
     RETURNING post_id`
  );
  for (const r of rows) await auditService.record(null, "blog.auto_published", "blog_post", r.post_id, { after: { status: "published" } });
  return rows.length;
}

// ------------------------------------------------------------------ dashboard metadata
async function meta(auth) {
  const a = access(auth);
  const [categories, tags, [authors]] = await Promise.all([
    BlogCategory.findAll({ order: [["sort_order", "ASC"], ["name", "ASC"]] }),
    BlogTag.findAll({ order: [["name", "ASC"]] }),
    // Platform users who can write, plus anyone already credited on a post.
    sequelize.query(
      `SELECT DISTINCT u.id, u.name FROM users u
        WHERE u.deleted_at IS NULL AND (
              EXISTS (SELECT 1 FROM blog_posts p WHERE p.author_id = u.id)
           OR (u.status = 'active' AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.scope_type = 'platform')
               AND (EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions pm ON pm.id = rp.permission_id
                             WHERE ur.user_id = u.id AND pm.code IN ('blog.create', 'blog.edit_all'))
                 OR EXISTS (SELECT 1 FROM user_permissions up JOIN permissions pm ON pm.id = up.permission_id
                             WHERE up.user_id = u.id AND pm.code IN ('blog.create', 'blog.edit_all')))))
        ORDER BY u.name`
    ),
  ]);
  return {
    approvalRequired: await approvalRequired(),
    permissions: [...auth.permissions].filter((p) => p.startsWith("blog.")).sort(),
    canSeeAll: a.viewAll,
    categories: categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug, isActive: c.is_active })),
    tags: tags.map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
    authors: a.has("blog.edit_all") || a.viewAll ? authors : authors.filter((u) => u.id === a.uid),
    statuses: STATUSES,
  };
}

// ------------------------------------------------------------------ analytics
async function analytics() {
  await publishDue();
  const [totals, topPosts, byCategory, byMonth, byAuthor] = await Promise.all([
    sequelize.query(
      `SELECT count(*)::int AS posts, count(*) FILTER (WHERE status = 'published')::int AS published,
              COALESCE(sum(view_count), 0)::int AS views,
              COALESCE(round(avg(view_count) FILTER (WHERE status = 'published')), 0)::int AS avg_views
         FROM blog_posts`
    ).then(([rows]) => rows),
    sequelize.query(
      `SELECT p.id, p.title, p.slug, p.view_count AS views, p.published_at, u.name AS author
         FROM blog_posts p JOIN users u ON u.id = p.author_id
        WHERE p.status = 'published' ORDER BY p.view_count DESC, p.published_at DESC LIMIT 10`
    ).then(([rows]) => rows),
    sequelize.query(
      `SELECT COALESCE(c.name, 'Uncategorised') AS category, count(*)::int AS posts, COALESCE(sum(p.view_count), 0)::int AS views
         FROM blog_posts p LEFT JOIN blog_categories c ON c.id = p.category_id
        WHERE p.status = 'published' GROUP BY 1 ORDER BY views DESC, posts DESC`
    ).then(([rows]) => rows),
    sequelize.query(
      `SELECT to_char(m, 'YYYY-MM') AS month,
              (SELECT count(*) FROM blog_posts p WHERE p.status = 'published' AND date_trunc('month', p.published_at) = m)::int AS published
         FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS m
        ORDER BY m`
    ).then(([rows]) => rows),
    sequelize.query(
      `SELECT u.id, u.name, count(*)::int AS posts, count(*) FILTER (WHERE p.status = 'published')::int AS published, COALESCE(sum(p.view_count), 0)::int AS views
         FROM blog_posts p JOIN users u ON u.id = p.author_id GROUP BY u.id, u.name ORDER BY views DESC, posts DESC LIMIT 10`
    ).then(([rows]) => rows),
  ]);
  return { totals: totals[0], topPosts, byCategory, byMonth, byAuthor };
}

// ------------------------------------------------------------------ public website
function presentPublic(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt || blogContent.summarise(row.text_head, 200),
    featuredImageUrl: row.featured_image_url,
    featuredImageAlt: row.featured_image_alt || row.title,
    category: row.category_id ? { name: row.category_name, slug: row.category_slug } : null,
    author: { name: row.author_name, avatarUrl: row.author_avatar },
    tags: (row.tags || []).map((t) => ({ name: t.name, slug: t.slug })),
    isFeatured: row.is_featured,
    publishedAt: row.live_at,
    updatedAt: row.updated_at,
    readingMinutes: readingMinutes(row),
  };
}

async function publicList({ q, category, tag, featured, featuredFirst, page = 1, limit = 9 }) {
  const where = [LIVE];
  const replacements = {};
  if (q) {
    where.push(`(p.title ILIKE :q OR p.excerpt ILIKE :q OR p.content_text ILIKE :q OR p.meta_keywords ILIKE :q OR c.name ILIKE :q
                 OR EXISTS (SELECT 1 FROM blog_post_tags pt JOIN blog_tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id AND t.name ILIKE :q))`);
    replacements.q = likeParam(q);
  }
  if (category) {
    where.push("c.slug = :category AND c.is_active");
    replacements.category = category;
  }
  if (tag) {
    where.push("EXISTS (SELECT 1 FROM blog_post_tags pt JOIN blog_tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id AND t.slug = :tag)");
    replacements.tag = tag;
  }
  if (featured) where.push("p.is_featured");
  const order = featuredFirst ? `p.is_featured DESC, ${LIVE_AT} DESC` : `${LIVE_AT} DESC`;
  const { rows, total } = await selectPosts({ where, replacements, order, limit, offset: (page - 1) * limit });
  return { items: rows.map(presentPublic), total };
}

async function publicPost(slug, { countView = false } = {}) {
  const { rows } = await selectPosts({ where: [LIVE, "p.slug = :slug"], replacements: { slug }, limit: 1, withContent: true });
  const row = rows[0];
  if (!row) throw ApiError.notFound("Blog post not found");
  if (countView) await sequelize.query("UPDATE blog_posts SET view_count = view_count + 1 WHERE id = :id", { replacements: { id: row.id } });

  // Related: same category or shared tags, newest first.
  const { rows: related } = await selectPosts({
    where: [
      LIVE,
      "p.id <> :id",
      `(p.category_id = :categoryId OR EXISTS (SELECT 1 FROM blog_post_tags a JOIN blog_post_tags b ON b.tag_id = a.tag_id WHERE a.post_id = p.id AND b.post_id = :id))`,
    ],
    replacements: { id: row.id, categoryId: row.category_id || -1 },
    order: `${LIVE_AT} DESC`,
    limit: 3,
  });

  return {
    ...presentPublic(row),
    // Sanitised again on the way out, in case a row was written by anything other than save().
    content: blogContent.sanitize(row.content),
    socialImageUrl: row.social_image_url,
    seo: {
      title: row.meta_title || row.title,
      description: row.meta_description || row.excerpt || blogContent.summarise(row.text_head, 160),
      keywords: row.meta_keywords,
    },
    related: related.map(presentPublic),
  };
}

async function publicCategories() {
  const [rows] = await sequelize.query(
    `SELECT c.name, c.slug, c.description, count(p.id)::int AS posts
       FROM blog_categories c
       LEFT JOIN blog_posts p ON p.category_id = c.id AND ${LIVE}
      WHERE c.is_active
      GROUP BY c.id ORDER BY c.sort_order, c.name`
  );
  return rows;
}

async function sitemapEntries() {
  const [rows] = await sequelize.query(
    `SELECT p.slug, p.updated_at, ${LIVE_AT} AS published_at FROM blog_posts p WHERE ${LIVE} ORDER BY ${LIVE_AT} DESC LIMIT 50000`
  );
  return rows.map((r) => ({ slug: r.slug, updatedAt: r.updated_at, publishedAt: r.published_at }));
}

module.exports = {
  STATUSES,
  access,
  rules,
  list,
  stats,
  meta,
  adminPost,
  save,
  transition,
  remove,
  postHistory,
  slugCheck,
  publishDue,
  analytics,
  publicList,
  publicPost,
  publicCategories,
  sitemapEntries,
};

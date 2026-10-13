const { define, T } = require("./define");

const UserPermission = define(
  "UserPermission",
  "user_permissions",
  {
    user_id: { type: T.uuid, primaryKey: true },
    permission_id: { type: T.int, primaryKey: true },
    granted_by: T.uuid,
  },
  { timestamps: "created" }
);

const BlogCategory = define("BlogCategory", "blog_categories", {
  id: T.intPk,
  name: T.str,
  slug: T.str,
  description: T.str,
  sort_order: T.int,
  is_active: T.bool,
});

const BlogTag = define("BlogTag", "blog_tags", {
  id: T.intPk,
  name: T.str,
  slug: T.str,
});

const BlogPost = define("BlogPost", "blog_posts", {
  id: T.uuidPk,
  title: T.str,
  slug: T.str,
  excerpt: T.str,
  content: T.text,
  content_text: T.text,
  featured_image_url: T.text,
  featured_image_alt: T.str,
  social_image_url: T.text,
  author_id: T.uuid,
  category_id: T.int,
  status: T.str,
  is_featured: T.bool,
  meta_title: T.str,
  meta_description: T.str,
  meta_keywords: T.str,
  review_note: T.str,
  view_count: T.int,
  created_by: T.uuid,
  updated_by: T.uuid,
  submitted_at: T.time,
  reviewed_by: T.uuid,
  reviewed_at: T.time,
  published_at: T.time,
  scheduled_at: T.time,
});

const BlogPostTag = define(
  "BlogPostTag",
  "blog_post_tags",
  { post_id: { type: T.uuid, primaryKey: true }, tag_id: { type: T.int, primaryKey: true } },
  { timestamps: false }
);

const BlogPostHistory = define(
  "BlogPostHistory",
  "blog_post_history",
  {
    id: T.bigPk,
    post_id: T.uuid,
    actor_user_id: T.uuid,
    action: T.str,
    from_status: T.str,
    to_status: T.str,
    note: T.str,
  },
  { timestamps: "created" }
);

module.exports = { UserPermission, BlogCategory, BlogTag, BlogPost, BlogPostTag, BlogPostHistory };

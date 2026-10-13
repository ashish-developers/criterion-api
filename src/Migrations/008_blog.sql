-- Blog module: posts, categories, tags, approval history, and per-user permission grants.
--
-- user_permissions extends the existing RBAC: a user's effective permissions are those of
-- their roles plus any granted to them individually (used by the Platform Admin to give
-- selected platform users blog permissions without creating new roles).

CREATE TABLE user_permissions (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id INT  NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_id)
);
CREATE INDEX user_permissions_permission_idx ON user_permissions (permission_id);

CREATE TABLE blog_categories (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(80)  NOT NULL,
  slug        VARCHAR(100) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description VARCHAR(300),
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX blog_categories_name_unique ON blog_categories (lower(name));
CREATE TRIGGER blog_categories_updated BEFORE UPDATE ON blog_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE blog_tags (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(60) NOT NULL,
  slug       VARCHAR(80) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX blog_tags_name_unique ON blog_tags (lower(name));
CREATE TRIGGER blog_tags_updated BEFORE UPDATE ON blog_tags FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- content holds sanitised HTML (allow-listed on save and again when served);
-- content_text is its plain-text form, used for search and reading time.
CREATE TABLE blog_posts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title              VARCHAR(200) NOT NULL,
  slug               VARCHAR(220) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  excerpt            VARCHAR(500),
  content            TEXT NOT NULL DEFAULT '',
  content_text       TEXT NOT NULL DEFAULT '',
  featured_image_url TEXT,
  featured_image_alt VARCHAR(200),
  social_image_url   TEXT,
  author_id          UUID NOT NULL REFERENCES users(id),
  category_id        INT REFERENCES blog_categories(id) ON DELETE SET NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','pending_approval','approved','published','scheduled','rejected','archived')),
  is_featured        BOOLEAN NOT NULL DEFAULT false,
  meta_title         VARCHAR(70),
  meta_description   VARCHAR(170),
  meta_keywords      VARCHAR(300),
  review_note        VARCHAR(1000),
  view_count         INT NOT NULL DEFAULT 0,
  created_by         UUID NOT NULL REFERENCES users(id),
  updated_by         UUID REFERENCES users(id),
  submitted_at       TIMESTAMPTZ,
  reviewed_by        UUID REFERENCES users(id),
  reviewed_at        TIMESTAMPTZ,
  published_at       TIMESTAMPTZ,
  scheduled_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE TRIGGER blog_posts_updated BEFORE UPDATE ON blog_posts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX blog_posts_status_idx ON blog_posts (status);
CREATE INDEX blog_posts_public_idx ON blog_posts (published_at DESC) WHERE status = 'published';
CREATE INDEX blog_posts_scheduled_idx ON blog_posts (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX blog_posts_author_idx ON blog_posts (author_id);
CREATE INDEX blog_posts_category_idx ON blog_posts (category_id);
CREATE INDEX blog_posts_created_idx ON blog_posts (created_at DESC);
CREATE INDEX blog_posts_title_trgm ON blog_posts USING gin (title gin_trgm_ops);
CREATE INDEX blog_posts_text_trgm ON blog_posts USING gin (content_text gin_trgm_ops);

CREATE TABLE blog_post_tags (
  post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  tag_id  INT  NOT NULL REFERENCES blog_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX blog_post_tags_tag_idx ON blog_post_tags (tag_id);

-- Workflow trail: creation, submission, approval/rejection, publication and so on.
CREATE TABLE blog_post_history (
  id            BIGSERIAL PRIMARY KEY,
  post_id       UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(40) NOT NULL,
  from_status   VARCHAR(20),
  to_status     VARCHAR(20),
  note          VARCHAR(1000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX blog_post_history_post_idx ON blog_post_history (post_id, created_at DESC);

-- Blog images are stored like other uploads (artwork_assets, served from /assets/:id).
ALTER TABLE artwork_assets DROP CONSTRAINT artwork_assets_kind_check;
ALTER TABLE artwork_assets ADD CONSTRAINT artwork_assets_kind_check
  CHECK (kind IN ('artwork','preview','proof','print_file','production_photo','qc_photo','complaint_photo','product_image','document','blog_image'));

-- Register the blog permissions and give them to the platform admin role straight away, so
-- the module works before the next `npm run seed:reference` (which keeps them in sync).
INSERT INTO permissions (code, module, description) VALUES
  ('blog.view',              'blog', 'View blog posts in the management dashboard'),
  ('blog.create',            'blog', 'Create blog posts and save drafts'),
  ('blog.edit_own',          'blog', 'Edit own blog posts'),
  ('blog.edit_all',          'blog', 'Edit any blog post'),
  ('blog.delete_own',        'blog', 'Delete own blog posts'),
  ('blog.delete_all',        'blog', 'Delete any blog post'),
  ('blog.publish',           'blog', 'Publish blog posts'),
  ('blog.unpublish',         'blog', 'Unpublish and archive blog posts'),
  ('blog.schedule',          'blog', 'Schedule blog posts for future publication'),
  ('blog.approve',           'blog', 'Approve or reject blog posts submitted for review'),
  ('blog.taxonomy.manage',   'blog', 'Manage blog categories and tags'),
  ('blog.feature',           'blog', 'Mark blog posts as featured'),
  ('blog.analytics.view',    'blog', 'View blog statistics and engagement'),
  ('blog.permissions.manage','blog', 'Assign blog permissions to platform users')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code = 'platform_admin' AND p.module = 'blog'
ON CONFLICT DO NOTHING;

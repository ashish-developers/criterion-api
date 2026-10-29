-- Visiting card module: template gallery, customer designs (drafts), bulk orders with one
-- card per person, quantity-slab pricing, print options, payments, invoices and receipts.
--
-- Orders keep a snapshot of the template, design, card details, print options and prices, so
-- later edits to templates, pricing or a saved design never change an order already placed.

-- Job title used to pre-fill a visiting card. Edited under Profile & security.
ALTER TABLE users ADD COLUMN designation VARCHAR(120);

-- ---------------------------------------------------------------- templates
CREATE TABLE vc_template_categories (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(80)  NOT NULL,
  slug        VARCHAR(100) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description VARCHAR(300),
  icon        VARCHAR(40),
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vc_template_categories_name_unique ON vc_template_categories (lower(name));
CREATE TRIGGER vc_template_categories_updated BEFORE UPDATE ON vc_template_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- design holds the layout of both sides (see Validators/vcValidators.js). is_double_sided and
-- has_qr are derived from it on save and kept as columns for gallery filters.
-- code identifies seeded templates so re-seeding never duplicates or overwrites them.
CREATE TABLE vc_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            VARCHAR(60) UNIQUE,
  category_id     INT REFERENCES vc_template_categories(id) ON DELETE SET NULL,
  name            VARCHAR(120) NOT NULL,
  slug            VARCHAR(140) NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description     VARCHAR(500),
  orientation     VARCHAR(10) NOT NULL CHECK (orientation IN ('landscape','portrait')),
  width_mm        NUMERIC(6,2) NOT NULL CHECK (width_mm BETWEEN 40 AND 120),
  height_mm       NUMERIC(6,2) NOT NULL CHECK (height_mm BETWEEN 40 AND 120),
  bleed_mm        NUMERIC(4,2) NOT NULL DEFAULT 3 CHECK (bleed_mm BETWEEN 0 AND 10),
  safe_margin_mm  NUMERIC(4,2) NOT NULL DEFAULT 3 CHECK (safe_margin_mm BETWEEN 0 AND 10),
  is_double_sided BOOLEAN NOT NULL DEFAULT false,
  has_qr          BOOLEAN NOT NULL DEFAULT false,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  design          JSONB NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished')),
  is_featured     BOOLEAN NOT NULL DEFAULT false,
  sort_order      INT NOT NULL DEFAULT 0,
  usage_count     INT NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CHECK ((orientation = 'landscape') = (width_mm >= height_mm))
);
CREATE UNIQUE INDEX vc_templates_slug_unique ON vc_templates (slug) WHERE deleted_at IS NULL;
CREATE INDEX vc_templates_gallery_idx ON vc_templates (status, category_id, sort_order) WHERE deleted_at IS NULL;
CREATE TRIGGER vc_templates_updated BEFORE UPDATE ON vc_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- designs (drafts)
-- One saved design per card project. Corporate designs belong to the company and are shared
-- by its admins; employees holds the people a corporate order prints cards for.
-- template_design is the template's layout when the draft was started ("reset to template").
CREATE TABLE vc_designs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  customer_type   VARCHAR(20) NOT NULL CHECK (customer_type IN ('individual','corporate')),
  template_id     UUID REFERENCES vc_templates(id) ON DELETE SET NULL,
  name            VARCHAR(120) NOT NULL,
  orientation     VARCHAR(10) NOT NULL CHECK (orientation IN ('landscape','portrait')),
  width_mm        NUMERIC(6,2) NOT NULL,
  height_mm       NUMERIC(6,2) NOT NULL,
  design          JSONB NOT NULL,
  template_design JSONB NOT NULL,
  fields          JSONB NOT NULL DEFAULT '{}'::jsonb,
  employees       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered')),
  -- Set when an order using this design has its artwork approved: approved company branding.
  approved_at     TIMESTAMPTZ,
  last_ordered_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CHECK (customer_type <> 'corporate' OR company_id IS NOT NULL)
);
CREATE INDEX vc_designs_user_idx ON vc_designs (user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX vc_designs_company_idx ON vc_designs (company_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER vc_designs_updated BEFORE UPDATE ON vc_designs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- pricing
-- Base price per card by total quantity in the order. max_qty NULL = and above.
CREATE TABLE vc_price_slabs (
  id               SERIAL PRIMARY KEY,
  min_qty          INT NOT NULL CHECK (min_qty >= 1),
  max_qty          INT CHECK (max_qty IS NULL OR max_qty >= min_qty),
  unit_price_paise INT NOT NULL CHECK (unit_price_paise > 0),
  label            VARCHAR(60),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER vc_price_slabs_updated BEFORE UPDATE ON vc_price_slabs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Printing specifications (paper stock, finish, corners): one choice per group, each adding
-- a per-card surcharge. One active default per group.
CREATE TABLE vc_print_options (
  id                   SERIAL PRIMARY KEY,
  group_code           VARCHAR(20) NOT NULL CHECK (group_code IN ('paper','finish','corners')),
  code                 VARCHAR(40) NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  name                 VARCHAR(80) NOT NULL,
  description          VARCHAR(300),
  price_per_card_paise INT NOT NULL DEFAULT 0 CHECK (price_per_card_paise >= 0),
  is_default           BOOLEAN NOT NULL DEFAULT false,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  sort_order           INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT is_default OR is_active)
);
CREATE UNIQUE INDEX vc_print_options_one_default ON vc_print_options (group_code) WHERE is_default;
CREATE TRIGGER vc_print_options_updated BEFORE UPDATE ON vc_print_options FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- orders
-- status is the fulfilment stage; artwork_status the review sub-state:
--   pending (unpaid) -> artwork_review (submitted / rejected -> resubmitted) -> approved
--   -> in_production -> dispatched -> delivered;  cancelled from any stage before delivery.
-- idempotency_key is generated by the browser per checkout, so a retried or double-clicked
-- "Place order" returns the first order instead of creating a second one.
CREATE TABLE vc_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number        VARCHAR(20) NOT NULL UNIQUE,
  user_id             UUID NOT NULL REFERENCES users(id),
  company_id          UUID REFERENCES companies(id),
  customer_type       VARCHAR(20) NOT NULL CHECK (customer_type IN ('individual','corporate')),
  design_id           UUID REFERENCES vc_designs(id) ON DELETE SET NULL,
  template_id         UUID REFERENCES vc_templates(id) ON DELETE SET NULL,
  template_snapshot   JSONB NOT NULL,
  design_snapshot     JSONB NOT NULL,
  fields_snapshot     JSONB NOT NULL,
  is_double_sided     BOOLEAN NOT NULL,
  card_count          INT NOT NULL CHECK (card_count >= 1),
  total_quantity      INT NOT NULL CHECK (total_quantity >= 1),
  print_options       JSONB NOT NULL DEFAULT '[]'::jsonb,
  pricing             JSONB NOT NULL,
  unit_price_paise    INT NOT NULL CHECK (unit_price_paise > 0),
  subtotal_paise      BIGINT NOT NULL,
  shipping_paise      BIGINT NOT NULL DEFAULT 0,
  taxable_paise       BIGINT NOT NULL,
  cgst_paise          BIGINT NOT NULL DEFAULT 0,
  sgst_paise          BIGINT NOT NULL DEFAULT 0,
  igst_paise          BIGINT NOT NULL DEFAULT 0,
  tax_paise           BIGINT NOT NULL DEFAULT 0,
  total_paise         BIGINT NOT NULL CHECK (total_paise > 0),
  amount_paid_paise   BIGINT NOT NULL DEFAULT 0,
  gst_rate            NUMERIC(5,2) NOT NULL,
  hsn_code            VARCHAR(10) NOT NULL,
  is_interstate       BOOLEAN NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','artwork_review','approved','in_production','dispatched','delivered','cancelled')),
  payment_status      VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
  artwork_status      VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (artwork_status IN ('pending','submitted','approved','rejected')),
  artwork_note        VARCHAR(1000),
  artwork_reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  artwork_reviewed_at TIMESTAMPTZ,
  contact             JSONB NOT NULL,
  shipping_address    JSONB NOT NULL,
  billing_address     JSONB,
  gstin               VARCHAR(15),
  customer_note       VARCHAR(500),
  estimated_dispatch  DATE,
  estimated_delivery  DATE,
  courier             VARCHAR(80),
  tracking_number     VARCHAR(80),
  tracking_url        VARCHAR(300),
  idempotency_key     VARCHAR(80) NOT NULL,
  placed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at             TIMESTAMPTZ,
  approved_at         TIMESTAMPTZ,
  production_started_at TIMESTAMPTZ,
  dispatched_at       TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       VARCHAR(500),
  is_demo             BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (amount_paid_paise >= 0),
  CHECK (status <> 'dispatched' OR tracking_number IS NOT NULL)
);
CREATE INDEX vc_orders_user_idx ON vc_orders (user_id, placed_at DESC);
CREATE INDEX vc_orders_company_idx ON vc_orders (company_id, placed_at DESC) WHERE company_id IS NOT NULL;
CREATE INDEX vc_orders_status_idx ON vc_orders (status, placed_at DESC);
CREATE INDEX vc_orders_placed_idx ON vc_orders (placed_at DESC);
CREATE TRIGGER vc_orders_updated BEFORE UPDATE ON vc_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per person printed (a single row for an individual order).
CREATE TABLE vc_order_cards (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES vc_orders(id) ON DELETE CASCADE,
  line_no    INT NOT NULL,
  fields     JSONB NOT NULL,
  quantity   INT NOT NULL CHECK (quantity >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, line_no)
);
CREATE TRIGGER vc_order_cards_updated BEFORE UPDATE ON vc_order_cards FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vc_order_events (
  id            BIGSERIAL PRIMARY KEY,
  order_id      UUID NOT NULL REFERENCES vc_orders(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(40) NOT NULL,
  from_status   VARCHAR(20),
  to_status     VARCHAR(20),
  note          VARCHAR(1000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vc_order_events_order_idx ON vc_order_events (order_id, created_at);

-- ---------------------------------------------------------------- money
-- Payment attempts. Gateway order and payment ids are unique, so the same gateway payment can
-- never be recorded twice (checkout callback and webhook racing each other).
CREATE TABLE vc_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES vc_orders(id),
  receipt_number      VARCHAR(20) UNIQUE,
  provider            VARCHAR(20) NOT NULL CHECK (provider IN ('mock','razorpay','offline')),
  provider_order_id   VARCHAR(100),
  provider_payment_id VARCHAR(100),
  provider_refund_id  VARCHAR(100),
  amount_paise        BIGINT NOT NULL CHECK (amount_paise > 0),
  currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
  status              VARCHAR(20) NOT NULL DEFAULT 'created' CHECK (status IN ('created','captured','failed','refunded')),
  method              VARCHAR(30),
  signature_verified  BOOLEAN NOT NULL DEFAULT false,
  failure_reason      VARCHAR(300),
  raw                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at         TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vc_payments_provider_order_unique ON vc_payments (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX vc_payments_provider_payment_unique ON vc_payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX vc_payments_order_idx ON vc_payments (order_id);
CREATE INDEX vc_payments_created_idx ON vc_payments (created_at DESC);
CREATE TRIGGER vc_payments_updated BEFORE UPDATE ON vc_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- GST tax invoice, issued once the order is paid. Numbers share the platform invoice series.
CREATE TABLE vc_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  VARCHAR(20) NOT NULL UNIQUE,
  order_id        UUID NOT NULL UNIQUE REFERENCES vc_orders(id),
  seller          JSONB NOT NULL,
  buyer           JSONB NOT NULL,
  place_of_supply VARCHAR(80) NOT NULL,
  is_interstate   BOOLEAN NOT NULL,
  lines           JSONB NOT NULL,
  taxable_paise   BIGINT NOT NULL,
  cgst_paise      BIGINT NOT NULL DEFAULT 0,
  sgst_paise      BIGINT NOT NULL DEFAULT 0,
  igst_paise      BIGINT NOT NULL DEFAULT 0,
  total_paise     BIGINT NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Register the module's permissions and give them to the platform admin role straight away,
-- so the module works before the next `npm run seed:reference` (which keeps them in sync).
INSERT INTO permissions (code, module, description) VALUES
  ('vc.view',             'visiting_cards', 'View the visiting card dashboard, orders and customers'),
  ('vc.orders.manage',    'visiting_cards', 'Review artwork and update visiting card orders, status and tracking'),
  ('vc.templates.manage', 'visiting_cards', 'Manage visiting card templates and categories'),
  ('vc.pricing.manage',   'visiting_cards', 'Manage visiting card pricing, print specifications, shipping and module settings'),
  ('vc.payments.view',    'visiting_cards', 'View visiting card payments, invoices and receipts'),
  ('vc.payments.manage',  'visiting_cards', 'Record offline payments and refund visiting card orders'),
  ('vc.reports.view',     'visiting_cards', 'View visiting card reports and analytics')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code = 'platform_admin' AND p.module = 'visiting_cards'
ON CONFLICT DO NOTHING;

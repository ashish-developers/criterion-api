-- Companies (B2B), addresses, brand kits, vendors and the product catalogue.

CREATE TABLE companies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 VARCHAR(160) NOT NULL,
  legal_name           VARCHAR(200),
  gstin                VARCHAR(15),
  pan                  VARCHAR(10),
  industry             VARCHAR(80),
  company_size         VARCHAR(40),
  website              VARCHAR(200),
  billing_email        VARCHAR(190),
  billing_phone        VARCHAR(20),
  billing_address      JSONB NOT NULL DEFAULT '{}'::jsonb,
  credit_limit_paise   BIGINT NOT NULL DEFAULT 0,
  approval_limit_paise BIGINT NOT NULL DEFAULT 0,   -- 0 = no approval needed
  payment_terms        VARCHAR(20) NOT NULL DEFAULT 'advance_50' CHECK (payment_terms IN ('prepaid','advance_50','credit_15','credit_30')),
  credit_approved      BOOLEAN NOT NULL DEFAULT false,
  status               VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  is_key_account       BOOLEAN NOT NULL DEFAULT false,
  preferred_vendor_id  UUID,
  is_demo              BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_gstin_unique ON companies (gstin) WHERE gstin IS NOT NULL;
CREATE TRIGGER companies_updated BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE company_members (
  id          SERIAL PRIMARY KEY,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role VARCHAR(20) NOT NULL DEFAULT 'buyer' CHECK (member_role IN ('admin','approver','buyer')),
  status      VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','removed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id)
);
CREATE INDEX company_members_user_idx ON company_members (user_id);

CREATE TABLE addresses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  company_id   UUID REFERENCES companies(id) ON DELETE CASCADE,
  label        VARCHAR(60),
  type         VARCHAR(20) NOT NULL DEFAULT 'shipping' CHECK (type IN ('shipping','billing')),
  contact_name VARCHAR(120) NOT NULL,
  phone        VARCHAR(20) NOT NULL,
  line1        VARCHAR(200) NOT NULL,
  line2        VARCHAR(200),
  city         VARCHAR(80) NOT NULL,
  state        VARCHAR(80) NOT NULL,
  pincode      VARCHAR(6) NOT NULL,
  country      VARCHAR(60) NOT NULL DEFAULT 'India',
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  CHECK (user_id IS NOT NULL OR company_id IS NOT NULL)
);
CREATE INDEX addresses_user_idx ON addresses (user_id) WHERE deleted_at IS NULL;
CREATE INDEX addresses_company_idx ON addresses (company_id) WHERE deleted_at IS NULL;
CREATE TRIGGER addresses_updated BEFORE UPDATE ON addresses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE brand_kits (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       VARCHAR(120) NOT NULL,
  colors     JSONB NOT NULL DEFAULT '[]'::jsonb,
  fonts      JSONB NOT NULL DEFAULT '[]'::jsonb,
  guidelines TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX brand_kits_company_idx ON brand_kits (company_id);
CREATE TRIGGER brand_kits_updated BEFORE UPDATE ON brand_kits FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE decoration_methods (
  id                    SERIAL PRIMARY KEY,
  code                  VARCHAR(40) NOT NULL UNIQUE,
  name                  VARCHAR(80) NOT NULL,
  description           TEXT,
  default_cost_paise    BIGINT NOT NULL DEFAULT 0,   -- decoration cost per unit per print area
  default_setup_paise   BIGINT NOT NULL DEFAULT 0,   -- one-time setup/digitising per print area
  default_moq           INT NOT NULL DEFAULT 1,
  in_house              BOOLEAN NOT NULL DEFAULT false,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vendors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     UUID NOT NULL REFERENCES users(id),
  business_name     VARCHAR(160) NOT NULL,
  legal_name        VARCHAR(200),
  vendor_type       VARCHAR(20) NOT NULL DEFAULT 'fulfilment_partner' CHECK (vendor_type IN ('fulfilment_partner','marketplace_seller','both')),
  gstin             VARCHAR(15),
  pan               VARCHAR(10),
  bank_account_name VARCHAR(160),
  bank_account_last4 VARCHAR(4),
  bank_account_number_enc TEXT,
  bank_ifsc         VARCHAR(11),
  contact_email     VARCHAR(190),
  contact_phone     VARCHAR(20),
  address           JSONB NOT NULL DEFAULT '{}'::jsonb,
  pincode           VARCHAR(6),
  service_pincode_prefixes TEXT[] NOT NULL DEFAULT '{}',
  machines          TEXT,
  daily_capacity    INT NOT NULL DEFAULT 0,
  status            VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','applied','under_review','approved','suspended','rejected')),
  commission_pct    NUMERIC(5,2) NOT NULL DEFAULT 15.00,
  quality_score     NUMERIC(3,2) NOT NULL DEFAULT 4.50,
  rejection_reason  TEXT,
  approved_at       TIMESTAMPTZ,
  approved_by       UUID REFERENCES users(id),
  is_demo           BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vendors_status_idx ON vendors (status);
CREATE UNIQUE INDEX vendors_owner_unique ON vendors (owner_user_id);
CREATE TRIGGER vendors_updated BEFORE UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE companies ADD CONSTRAINT companies_preferred_vendor_fk FOREIGN KEY (preferred_vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;

CREATE TABLE vendor_users (
  id          SERIAL PRIMARY KEY,
  vendor_id   UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role VARCHAR(20) NOT NULL DEFAULT 'staff' CHECK (member_role IN ('admin','staff')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, user_id)
);
CREATE INDEX vendor_users_user_idx ON vendor_users (user_id);

CREATE TABLE vendor_capabilities (
  id             SERIAL PRIMARY KEY,
  vendor_id      UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  method_id      INT  NOT NULL REFERENCES decoration_methods(id),
  min_qty        INT  NOT NULL DEFAULT 1,
  max_qty        INT  NOT NULL DEFAULT 10000,
  daily_capacity INT  NOT NULL DEFAULT 100,
  lead_time_days INT  NOT NULL DEFAULT 5,
  cost_per_unit_paise BIGINT NOT NULL DEFAULT 0,
  quality_score  NUMERIC(3,2) NOT NULL DEFAULT 4.50,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, method_id)
);

CREATE TABLE vendor_holidays (
  id         SERIAL PRIMARY KEY,
  vendor_id  UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  holiday    DATE NOT NULL,
  note       VARCHAR(160),
  UNIQUE (vendor_id, holiday)
);

CREATE TABLE categories (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id              UUID REFERENCES categories(id) ON DELETE SET NULL,
  name                   VARCHAR(120) NOT NULL,
  slug                   VARCHAR(140) NOT NULL UNIQUE,
  description            TEXT,
  image                  TEXT,
  default_lead_time_days INT NOT NULL DEFAULT 5,
  sort_order             INT NOT NULL DEFAULT 0,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  is_demo                BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX categories_parent_idx ON categories (parent_id);
CREATE TRIGGER categories_updated BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE products (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id           UUID NOT NULL REFERENCES categories(id),
  vendor_id             UUID REFERENCES vendors(id),           -- set for marketplace vendor listings
  source_type           VARCHAR(20) NOT NULL DEFAULT 'own' CHECK (source_type IN ('own','vendor_listing','kit')),
  name                  VARCHAR(200) NOT NULL,
  slug                  VARCHAR(220) NOT NULL UNIQUE,
  short_description     VARCHAR(300),
  description           TEXT,
  images                JSONB NOT NULL DEFAULT '[]'::jsonb,
  base_cost_paise       BIGINT NOT NULL CHECK (base_cost_paise >= 0),   -- C_base (landed blank cost, or vendor price for listings)
  packaging_cost_paise  BIGINT NOT NULL DEFAULT 0,
  express_uplift_pct    NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  hsn_code              VARCHAR(10) NOT NULL,
  gst_rate              NUMERIC(5,2) NOT NULL DEFAULT 18.00,
  moq                   INT NOT NULL DEFAULT 1 CHECK (moq >= 1),
  max_instant_qty       INT NOT NULL DEFAULT 499,
  lead_time_days        INT NOT NULL DEFAULT 5,
  weight_grams          INT NOT NULL DEFAULT 250,
  dimensions            JSONB NOT NULL DEFAULT '{}'::jsonb,
  specifications        JSONB NOT NULL DEFAULT '{}'::jsonb,
  care_instructions     TEXT,
  occasions             TEXT[] NOT NULL DEFAULT '{}',
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  is_customisable       BOOLEAN NOT NULL DEFAULT true,
  supports_live_preview BOOLEAN NOT NULL DEFAULT true,
  min_dpi               INT NOT NULL DEFAULT 150,
  block_below_dpi       INT NOT NULL DEFAULT 72,
  allowed_file_types    TEXT[] NOT NULL DEFAULT '{png,jpg,svg,pdf}',
  max_text_lines        INT NOT NULL DEFAULT 3,
  status                VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','active','inactive','rejected')),
  is_featured           BOOLEAN NOT NULL DEFAULT false,
  rating_avg            NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count          INT NOT NULL DEFAULT 0,
  is_demo               BOOLEAN NOT NULL DEFAULT false,
  search_vector         TSVECTOR GENERATED ALWAYS AS (
                          setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
                          setweight(to_tsvector('english', coalesce(short_description,'')), 'B') ||
                          setweight(to_tsvector('english', coalesce(description,'')), 'C')
                        ) STORED,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);
CREATE INDEX products_category_idx ON products (category_id) WHERE deleted_at IS NULL;
CREATE INDEX products_vendor_idx ON products (vendor_id);
CREATE INDEX products_status_idx ON products (status);
CREATE INDEX products_search_idx ON products USING GIN (search_vector);
CREATE INDEX products_name_trgm_idx ON products USING GIN (name gin_trgm_ops);
CREATE TRIGGER products_updated BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_variants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku                 VARCHAR(60) NOT NULL UNIQUE,
  attributes          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {size, color, material, capacity}
  color_hex           VARCHAR(7),
  image               TEXT,
  cost_adjust_paise   BIGINT NOT NULL DEFAULT 0,          -- added to product base cost
  track_inventory     BOOLEAN NOT NULL DEFAULT true,
  stock_qty           INT NOT NULL DEFAULT 0,
  low_stock_threshold INT NOT NULL DEFAULT 10,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX product_variants_product_idx ON product_variants (product_id);
CREATE TRIGGER product_variants_updated BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Named decoration zones. Box coordinates are percentages of the mock-up image.
CREATE TABLE print_areas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code           VARCHAR(40) NOT NULL,
  name           VARCHAR(80) NOT NULL,
  width_mm       NUMERIC(7,2) NOT NULL,
  height_mm      NUMERIC(7,2) NOT NULL,
  safe_margin_mm NUMERIC(5,2) NOT NULL DEFAULT 3,
  box            JSONB NOT NULL DEFAULT '{"x":30,"y":25,"w":40,"h":40}'::jsonb,
  allowed_methods TEXT[] NOT NULL DEFAULT '{}',
  max_text_chars INT NOT NULL DEFAULT 40,
  sort_order     INT NOT NULL DEFAULT 0,
  UNIQUE (product_id, code)
);

CREATE TABLE product_methods (
  id                  SERIAL PRIMARY KEY,
  product_id          UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  method_id           INT  NOT NULL REFERENCES decoration_methods(id),
  cost_per_unit_paise BIGINT NOT NULL,   -- C_decoration per print area
  setup_fee_paise     BIGINT NOT NULL DEFAULT 0,
  moq                 INT NOT NULL DEFAULT 1,
  is_default          BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (product_id, method_id)
);

CREATE TABLE price_tiers (
  id            SERIAL PRIMARY KEY,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_qty       INT NOT NULL CHECK (min_qty >= 1),
  max_qty       INT,
  margin_pct    NUMERIC(5,2) NOT NULL,
  checkout_path VARCHAR(20) NOT NULL DEFAULT 'instant' CHECK (checkout_path IN ('instant','instant_or_quote','quote_only')),
  UNIQUE (product_id, min_qty)
);

CREATE TABLE bundle_items (
  id                   SERIAL PRIMARY KEY,
  kit_product_id       UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id UUID NOT NULL REFERENCES products(id),
  component_variant_id UUID REFERENCES product_variants(id),
  quantity             INT NOT NULL DEFAULT 1
);

-- Eligible fulfilment sources per product (in-house and/or vendors) with cost and lead time.
CREATE TABLE product_sources (
  id             SERIAL PRIMARY KEY,
  product_id     UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source         VARCHAR(20) NOT NULL CHECK (source IN ('in_house','vendor')),
  vendor_id      UUID REFERENCES vendors(id) ON DELETE CASCADE,
  cost_paise     BIGINT NOT NULL DEFAULT 0,
  lead_time_days INT NOT NULL DEFAULT 5,
  is_default     BOOLEAN NOT NULL DEFAULT false,
  CHECK ((source = 'vendor') = (vendor_id IS NOT NULL))
);
CREATE UNIQUE INDEX product_sources_unique ON product_sources (product_id, source, COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE inventory_movements (
  id             BIGSERIAL PRIMARY KEY,
  variant_id     UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  change_qty     INT NOT NULL,
  balance_after  INT NOT NULL,
  reason         VARCHAR(30) NOT NULL CHECK (reason IN ('initial','purchase','adjustment','order','order_cancel','damage','return')),
  reference_type VARCHAR(30),
  reference_id   UUID,
  note           TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_variant_idx ON inventory_movements (variant_id, created_at DESC);

CREATE TABLE wishlists (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

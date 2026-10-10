-- Artwork, designs, proofs, carts, coupons, quotations and orders.

CREATE TABLE artwork_assets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  company_id     UUID REFERENCES companies(id) ON DELETE SET NULL,
  brand_kit_id   UUID REFERENCES brand_kits(id) ON DELETE SET NULL,
  kind           VARCHAR(20) NOT NULL DEFAULT 'artwork' CHECK (kind IN ('artwork','preview','proof','print_file','production_photo','qc_photo','complaint_photo','product_image','document')),
  original_name  VARCHAR(255) NOT NULL,
  storage_key    VARCHAR(300) NOT NULL UNIQUE,
  mime_type      VARCHAR(100) NOT NULL,
  size_bytes     BIGINT NOT NULL,
  width_px       INT,
  height_px      INT,
  checksum       VARCHAR(64) NOT NULL,
  scan_status    VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','skipped')),
  is_public      BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX artwork_assets_owner_idx ON artwork_assets (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX artwork_assets_company_idx ON artwork_assets (company_id) WHERE deleted_at IS NULL;

CREATE TABLE designs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id         UUID REFERENCES companies(id) ON DELETE SET NULL,
  product_id         UUID NOT NULL REFERENCES products(id),
  variant_id         UUID REFERENCES product_variants(id),
  name               VARCHAR(160) NOT NULL,
  is_brand_template  BOOLEAN NOT NULL DEFAULT false,
  current_version_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX designs_user_idx ON designs (user_id) WHERE deleted_at IS NULL;
CREATE TRIGGER designs_updated BEFORE UPDATE ON designs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A design version is immutable once created: edits always create a new version.
CREATE TABLE design_versions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id        UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  version_no       INT NOT NULL,
  canvas           JSONB NOT NULL,              -- {areas: {front: {layers: [...]}}}
  asset_ids        UUID[] NOT NULL DEFAULT '{}',
  preview_asset_id UUID REFERENCES artwork_assets(id),
  method_id        INT REFERENCES decoration_methods(id),
  variant_id       UUID REFERENCES product_variants(id),
  warnings         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (design_id, version_no)
);
ALTER TABLE designs ADD CONSTRAINT designs_current_version_fk FOREIGN KEY (current_version_id) REFERENCES design_versions(id) ON DELETE SET NULL;

CREATE TABLE carts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  coupon_code VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER carts_updated BEFORE UPDATE ON carts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cart_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id           UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id        UUID NOT NULL REFERENCES products(id),
  variant_id        UUID NOT NULL REFERENCES product_variants(id),
  method_id         INT REFERENCES decoration_methods(id),
  design_version_id UUID REFERENCES design_versions(id),
  quantity          INT NOT NULL CHECK (quantity >= 1),
  size_breakdown    JSONB,
  print_area_count  INT NOT NULL DEFAULT 0,
  express           BOOLEAN NOT NULL DEFAULT false,
  options           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cart_items_cart_idx ON cart_items (cart_id);
CREATE TRIGGER cart_items_updated BEFORE UPDATE ON cart_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE coupons (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code               VARCHAR(40) NOT NULL,
  description        VARCHAR(200),
  discount_type      VARCHAR(10) NOT NULL CHECK (discount_type IN ('percent','flat')),
  value              NUMERIC(10,2) NOT NULL CHECK (value > 0),  -- percent, or rupees for flat
  min_order_paise    BIGINT NOT NULL DEFAULT 0,
  max_discount_paise BIGINT,
  applies_to         VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all','b2c','b2b')),
  starts_at          TIMESTAMPTZ,
  ends_at            TIMESTAMPTZ,
  usage_limit        INT,
  per_user_limit     INT NOT NULL DEFAULT 1,
  used_count         INT NOT NULL DEFAULT 0,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX coupons_code_unique ON coupons (upper(code));
CREATE TRIGGER coupons_updated BEFORE UPDATE ON coupons FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE quotes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number       VARCHAR(20) NOT NULL UNIQUE,
  requester_user_id  UUID NOT NULL REFERENCES users(id),
  company_id         UUID REFERENCES companies(id),
  status             VARCHAR(20) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','under_review','sent','revision_requested','accepted','rejected','expired','converted','cancelled')),
  title              VARCHAR(200) NOT NULL,
  deadline           DATE,
  budget_paise       BIGINT,
  delivery_locations TEXT,
  delivery_pincode   VARCHAR(6),
  notes              TEXT,
  current_version_id UUID,
  assigned_admin_id  UUID REFERENCES users(id),
  order_id           UUID,
  is_repeat_of       UUID REFERENCES quotes(id),
  first_response_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX quotes_requester_idx ON quotes (requester_user_id);
CREATE INDEX quotes_company_idx ON quotes (company_id);
CREATE INDEX quotes_status_idx ON quotes (status);
CREATE TRIGGER quotes_updated BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE quote_request_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id          UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id        UUID NOT NULL REFERENCES products(id),
  variant_id        UUID REFERENCES product_variants(id),
  method_id         INT REFERENCES decoration_methods(id),
  quantity          INT NOT NULL CHECK (quantity >= 1),
  size_breakdown    JSONB,
  print_area_count  INT NOT NULL DEFAULT 1,
  artwork_asset_ids UUID[] NOT NULL DEFAULT '{}',
  design_version_id UUID REFERENCES design_versions(id),
  notes             TEXT
);
CREATE INDEX quote_request_items_quote_idx ON quote_request_items (quote_id);

CREATE TABLE quote_versions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id         UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  version_no       INT NOT NULL,
  valid_until      DATE NOT NULL,
  production_days  INT NOT NULL,
  payment_terms    VARCHAR(20) NOT NULL DEFAULT 'advance_50',
  subtotal_paise   BIGINT NOT NULL,
  setup_fees_paise BIGINT NOT NULL DEFAULT 0,
  packaging_paise  BIGINT NOT NULL DEFAULT 0,
  shipping_paise   BIGINT NOT NULL DEFAULT 0,
  discount_paise   BIGINT NOT NULL DEFAULT 0,
  tax_paise        BIGINT NOT NULL,
  total_paise      BIGINT NOT NULL,
  notes            TEXT,
  created_by       UUID REFERENCES users(id),
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quote_id, version_no)
);
ALTER TABLE quotes ADD CONSTRAINT quotes_current_version_fk FOREIGN KEY (current_version_id) REFERENCES quote_versions(id) ON DELETE SET NULL;

CREATE TABLE quote_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_version_id UUID NOT NULL REFERENCES quote_versions(id) ON DELETE CASCADE,
  request_item_id  UUID REFERENCES quote_request_items(id) ON DELETE SET NULL,
  product_id       UUID NOT NULL REFERENCES products(id),
  variant_id       UUID REFERENCES product_variants(id),
  method_id        INT REFERENCES decoration_methods(id),
  description      VARCHAR(300) NOT NULL,
  quantity         INT NOT NULL CHECK (quantity >= 1),
  size_breakdown   JSONB,
  unit_price_paise BIGINT NOT NULL CHECK (unit_price_paise >= 0),
  setup_fee_paise  BIGINT NOT NULL DEFAULT 0,
  hsn_code         VARCHAR(10) NOT NULL,
  gst_rate         NUMERIC(5,2) NOT NULL,
  line_total_paise BIGINT NOT NULL,
  tax_paise        BIGINT NOT NULL
);

CREATE TABLE quote_messages (
  id         BIGSERIAL PRIMARY KEY,
  quote_id   UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number       VARCHAR(20) NOT NULL UNIQUE,
  user_id            UUID NOT NULL REFERENCES users(id),
  company_id         UUID REFERENCES companies(id),
  quote_id           UUID REFERENCES quotes(id),
  channel            VARCHAR(10) NOT NULL DEFAULT 'b2c' CHECK (channel IN ('b2c','b2b')),
  status             VARCHAR(20) NOT NULL DEFAULT 'placed' CHECK (status IN ('placed','awaiting_approval','payment_pending','confirmed','in_progress','partially_shipped','shipped','delivered','completed','cancelled','refunded')),
  payment_status     VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','partially_paid','paid','partially_refunded','refunded','failed','credit')),
  payment_terms      VARCHAR(20) NOT NULL DEFAULT 'prepaid',
  approval_status    VARCHAR(20) NOT NULL DEFAULT 'not_required' CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  approved_by        UUID REFERENCES users(id),
  approved_at        TIMESTAMPTZ,
  subtotal_paise     BIGINT NOT NULL,
  setup_fees_paise   BIGINT NOT NULL DEFAULT 0,
  discount_paise     BIGINT NOT NULL DEFAULT 0,
  shipping_paise     BIGINT NOT NULL DEFAULT 0,
  tax_paise          BIGINT NOT NULL,
  cgst_paise         BIGINT NOT NULL DEFAULT 0,
  sgst_paise         BIGINT NOT NULL DEFAULT 0,
  igst_paise         BIGINT NOT NULL DEFAULT 0,
  total_paise        BIGINT NOT NULL CHECK (total_paise >= 0),
  amount_paid_paise  BIGINT NOT NULL DEFAULT 0,
  amount_refunded_paise BIGINT NOT NULL DEFAULT 0,
  coupon_id          UUID REFERENCES coupons(id),
  coupon_code        VARCHAR(40),
  shipping_address   JSONB NOT NULL,
  billing_address    JSONB NOT NULL,
  gstin              VARCHAR(15),
  po_number          VARCHAR(60),
  gift_options       JSONB NOT NULL DEFAULT '{}'::jsonb,
  deliver_by         DATE,
  estimated_delivery DATE,
  notes              TEXT,
  idempotency_key    VARCHAR(80),
  reorder_of_order_id UUID REFERENCES orders(id),
  cancel_reason      TEXT,
  placed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at       TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  closed_at          TIMESTAMPTZ,
  is_demo            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX orders_idempotency_unique ON orders (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX orders_user_idx ON orders (user_id, placed_at DESC);
CREATE INDEX orders_company_idx ON orders (company_id);
CREATE INDEX orders_status_idx ON orders (status);
CREATE TRIGGER orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE quotes ADD CONSTRAINT quotes_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

CREATE TABLE order_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no            INT NOT NULL,
  product_id         UUID NOT NULL REFERENCES products(id),
  variant_id         UUID NOT NULL REFERENCES product_variants(id),
  method_id          INT REFERENCES decoration_methods(id),
  design_version_id  UUID REFERENCES design_versions(id),
  product_snapshot   JSONB NOT NULL,                 -- name, sku, attributes, image at time of order
  quantity           INT NOT NULL CHECK (quantity >= 1),
  size_breakdown     JSONB,
  print_area_count   INT NOT NULL DEFAULT 0,
  express            BOOLEAN NOT NULL DEFAULT false,
  unit_price_paise   BIGINT NOT NULL,
  setup_fee_paise    BIGINT NOT NULL DEFAULT 0,
  line_subtotal_paise BIGINT NOT NULL,
  discount_paise     BIGINT NOT NULL DEFAULT 0,
  taxable_paise      BIGINT NOT NULL,
  hsn_code           VARCHAR(10) NOT NULL,
  gst_rate           NUMERIC(5,2) NOT NULL,
  tax_paise          BIGINT NOT NULL,
  line_total_paise   BIGINT NOT NULL,
  unit_cost_paise    BIGINT NOT NULL DEFAULT 0,      -- cost snapshot for margin reporting
  requires_proof     BOOLEAN NOT NULL DEFAULT true,
  state              VARCHAR(20) NOT NULL DEFAULT 'placed' CHECK (state IN ('placed','payment_pending','artwork_pending','proof_sent','proof_approved','assigned','in_production','quality_check','qc_failed','packed','dispatched','delivered','closed','on_hold','cancelled','refunded','rto')),
  previous_state     VARCHAR(20),
  fulfilment_source  VARCHAR(20) CHECK (fulfilment_source IN ('in_house','vendor')),
  vendor_id          UUID REFERENCES vendors(id),
  approved_proof_id  UUID,
  due_date           DATE,
  reprint_of_item_id UUID REFERENCES order_items(id),
  delivered_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, line_no)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_state_idx ON order_items (state);
CREATE INDEX order_items_vendor_idx ON order_items (vendor_id);
CREATE TRIGGER order_items_updated BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_events (
  id            BIGSERIAL PRIMARY KEY,
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id UUID REFERENCES order_items(id) ON DELETE CASCADE,
  event         VARCHAR(60) NOT NULL,
  from_state    VARCHAR(20),
  to_state      VARCHAR(20),
  note          TEXT,
  is_customer_visible BOOLEAN NOT NULL DEFAULT true,
  actor_user_id UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

CREATE TABLE coupon_redemptions (
  id         BIGSERIAL PRIMARY KEY,
  coupon_id  UUID NOT NULL REFERENCES coupons(id),
  user_id    UUID NOT NULL REFERENCES users(id),
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_paise BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (coupon_id, order_id)
);

CREATE TABLE proofs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id      UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  design_version_id  UUID REFERENCES design_versions(id),
  version_no         INT NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('draft','sent','approved','changes_requested','superseded')),
  preview_asset_id   UUID REFERENCES artwork_assets(id),
  print_file_asset_id UUID REFERENCES artwork_assets(id),
  source             VARCHAR(20) NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','designer')),
  notes              TEXT,
  required_approvals INT NOT NULL DEFAULT 1,
  is_chargeable      BOOLEAN NOT NULL DEFAULT false,
  locked             BOOLEAN NOT NULL DEFAULT false,
  sent_at            TIMESTAMPTZ,
  approved_at        TIMESTAMPTZ,
  reminder_24_at     TIMESTAMPTZ,
  reminder_48_at     TIMESTAMPTZ,
  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_item_id, version_no)
);
CREATE TRIGGER proofs_updated BEFORE UPDATE ON proofs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE order_items ADD CONSTRAINT order_items_approved_proof_fk FOREIGN KEY (approved_proof_id) REFERENCES proofs(id);

-- Approved proofs are immutable: block any update to a locked proof other than superseding nothing.
CREATE OR REPLACE FUNCTION prevent_locked_proof_change() RETURNS trigger AS $$
BEGIN
  IF OLD.locked THEN
    RAISE EXCEPTION 'Proof % is approved and locked', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER proofs_locked BEFORE UPDATE ON proofs FOR EACH ROW EXECUTE FUNCTION prevent_locked_proof_change();

CREATE TABLE proof_approvals (
  id         BIGSERIAL PRIMARY KEY,
  proof_id   UUID NOT NULL REFERENCES proofs(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  decision   VARCHAR(20) NOT NULL CHECK (decision IN ('approved','changes_requested')),
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proof_id, user_id)
);

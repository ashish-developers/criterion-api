-- Production, QC, shipping, payments, refunds, invoices, commissions, settlements,
-- support tickets, notifications, settings, CMS, reviews and the audit log.

CREATE TABLE production_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number      VARCHAR(20) NOT NULL UNIQUE,
  order_item_id   UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  source          VARCHAR(20) NOT NULL CHECK (source IN ('in_house','vendor')),
  vendor_id       UUID REFERENCES vendors(id),
  proof_id        UUID REFERENCES proofs(id),
  method_id       INT REFERENCES decoration_methods(id),
  quantity        INT NOT NULL,
  due_date        DATE,
  agreed_cost_paise BIGINT NOT NULL DEFAULT 0,
  status          VARCHAR(30) NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','accepted','rejected','in_production','quality_check','qc_failed','ready_for_dispatch','dispatched','delivered','on_hold','cancelled')),
  rejection_code  VARCHAR(40),
  rejection_note  TEXT,
  is_reprint      BOOLEAN NOT NULL DEFAULT false,
  parent_job_id   UUID REFERENCES production_jobs(id),
  machine         VARCHAR(80),
  notes           TEXT,
  assigned_by     UUID REFERENCES users(id),
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at     TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  dispatched_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((source = 'vendor') = (vendor_id IS NOT NULL))
);
CREATE INDEX production_jobs_vendor_idx ON production_jobs (vendor_id, status);
CREATE INDEX production_jobs_item_idx ON production_jobs (order_item_id);
CREATE INDEX production_jobs_status_idx ON production_jobs (status, due_date);
CREATE TRIGGER production_jobs_updated BEFORE UPDATE ON production_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE job_events (
  id              BIGSERIAL PRIMARY KEY,
  job_id          UUID NOT NULL REFERENCES production_jobs(id) ON DELETE CASCADE,
  event           VARCHAR(40) NOT NULL,
  status          VARCHAR(30),
  note            TEXT,
  photo_asset_ids UUID[] NOT NULL DEFAULT '{}',
  actor_user_id   UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events (job_id, created_at);

CREATE TABLE qc_checks (
  id              BIGSERIAL PRIMARY KEY,
  job_id          UUID NOT NULL REFERENCES production_jobs(id) ON DELETE CASCADE,
  result          VARCHAR(10) NOT NULL CHECK (result IN ('pass','fail')),
  checklist       JSONB NOT NULL DEFAULT '{}'::jsonb,
  defect_qty      INT NOT NULL DEFAULT 0,
  decision        VARCHAR(20) CHECK (decision IN ('reprint','replace','refund','accept')),
  notes           TEXT,
  photo_asset_ids UUID[] NOT NULL DEFAULT '{}',
  checked_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_number VARCHAR(20) NOT NULL UNIQUE,
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  parent_shipment_id UUID REFERENCES shipments(id),
  vendor_id       UUID REFERENCES vendors(id),
  shipped_by      VARCHAR(20) NOT NULL DEFAULT 'platform' CHECK (shipped_by IN ('platform','vendor')),
  carrier         VARCHAR(80),
  tracking_number VARCHAR(80),
  tracking_url    TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'created' CHECK (status IN ('created','picked_up','in_transit','out_for_delivery','delivered','rto','cancelled')),
  address         JSONB NOT NULL,
  weight_grams    INT,
  dispatched_at   TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shipments_order_idx ON shipments (order_id);
CREATE UNIQUE INDEX shipments_tracking_unique ON shipments (carrier, tracking_number) WHERE tracking_number IS NOT NULL;
CREATE TRIGGER shipments_updated BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE shipment_items (
  shipment_id   UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  quantity      INT NOT NULL,
  PRIMARY KEY (shipment_id, order_item_id)
);

CREATE TABLE tracking_events (
  id          BIGSERIAL PRIMARY KEY,
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status      VARCHAR(20) NOT NULL,
  location    VARCHAR(120),
  description TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tracking_events_shipment_idx ON tracking_events (shipment_id, occurred_at);

CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider            VARCHAR(20) NOT NULL CHECK (provider IN ('mock','razorpay','offline')),
  purpose             VARCHAR(20) NOT NULL DEFAULT 'full' CHECK (purpose IN ('full','advance','balance')),
  provider_order_id   VARCHAR(100),
  provider_payment_id VARCHAR(100),
  amount_paise        BIGINT NOT NULL CHECK (amount_paise > 0),
  currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
  status              VARCHAR(20) NOT NULL DEFAULT 'created' CHECK (status IN ('created','captured','failed','refunded','partially_refunded')),
  method              VARCHAR(30),
  signature_verified  BOOLEAN NOT NULL DEFAULT false,
  failure_reason      TEXT,
  raw                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at         TIMESTAMPTZ,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_provider_order_unique ON payments (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_payment_unique ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE TRIGGER payments_updated BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment_webhook_events (
  id           BIGSERIAL PRIMARY KEY,
  provider     VARCHAR(20) NOT NULL,
  event_id     VARCHAR(120) NOT NULL,
  event_type   VARCHAR(80),
  payload      JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE TABLE refunds (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id         UUID REFERENCES payments(id),
  order_item_id      UUID REFERENCES order_items(id),
  ticket_id          UUID,
  amount_paise       BIGINT NOT NULL CHECK (amount_paise > 0),
  reason             TEXT NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','processed','rejected')),
  provider_refund_id VARCHAR(100),
  requested_by       UUID REFERENCES users(id),
  approved_by        UUID REFERENCES users(id),
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refunds_order_idx ON refunds (order_id);
CREATE TRIGGER refunds_updated BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  VARCHAR(20) NOT NULL UNIQUE,
  order_id        UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
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
  po_number       VARCHAR(60),
  irn             VARCHAR(80),
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date        DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settlements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_number VARCHAR(20) NOT NULL UNIQUE,
  vendor_id         UUID NOT NULL REFERENCES vendors(id),
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  gross_paise       BIGINT NOT NULL,
  commission_paise  BIGINT NOT NULL,
  fees_paise        BIGINT NOT NULL DEFAULT 0,
  adjustments_paise BIGINT NOT NULL DEFAULT 0,
  tcs_paise         BIGINT NOT NULL DEFAULT 0,
  tds_paise         BIGINT NOT NULL DEFAULT 0,
  payout_paise      BIGINT NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid')),
  payout_reference  VARCHAR(100),
  paid_at           TIMESTAMPTZ,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX settlements_vendor_idx ON settlements (vendor_id, period_end DESC);
CREATE TRIGGER settlements_updated BEFORE UPDATE ON settlements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE commissions (
  id               BIGSERIAL PRIMARY KEY,
  order_item_id    UUID NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE CASCADE,
  vendor_id        UUID NOT NULL REFERENCES vendors(id),
  model            VARCHAR(20) NOT NULL CHECK (model IN ('marketplace','job_rate')),
  item_value_paise BIGINT NOT NULL,
  commission_pct   NUMERIC(5,2) NOT NULL DEFAULT 0,
  commission_paise BIGINT NOT NULL DEFAULT 0,
  vendor_earning_paise BIGINT NOT NULL,
  adjustment_paise BIGINT NOT NULL DEFAULT 0,
  settlement_id    UUID REFERENCES settlements(id),
  eligible_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commissions_vendor_idx ON commissions (vendor_id, settlement_id);

CREATE TABLE settlement_lines (
  id                BIGSERIAL PRIMARY KEY,
  settlement_id     UUID NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  order_item_id     UUID NOT NULL REFERENCES order_items(id),
  item_value_paise  BIGINT NOT NULL,
  commission_paise  BIGINT NOT NULL,
  adjustment_paise  BIGINT NOT NULL DEFAULT 0,
  net_paise         BIGINT NOT NULL,
  UNIQUE (order_item_id)
);

CREATE TABLE tickets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number      VARCHAR(20) NOT NULL UNIQUE,
  user_id            UUID NOT NULL REFERENCES users(id),
  order_id           UUID REFERENCES orders(id),
  order_item_id      UUID REFERENCES order_items(id),
  type               VARCHAR(20) NOT NULL DEFAULT 'query' CHECK (type IN ('query','change_request','complaint','refund','cancellation')),
  subject            VARCHAR(200) NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','awaiting_customer','resolved','closed')),
  priority           VARCHAR(10) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  decision           VARCHAR(20) CHECK (decision IN ('reprint','replace','refund','reject')),
  liability          VARCHAR(20) CHECK (liability IN ('vendor','courier','platform','customer')),
  resolution_note    TEXT,
  reprint_order_item_id UUID REFERENCES order_items(id),
  assigned_to        UUID REFERENCES users(id),
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tickets_user_idx ON tickets (user_id);
CREATE INDEX tickets_status_idx ON tickets (status);
CREATE TRIGGER tickets_updated BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE refunds ADD CONSTRAINT refunds_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;

CREATE TABLE ticket_messages (
  id                   BIGSERIAL PRIMARY KEY,
  ticket_id            UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id),
  body                 TEXT NOT NULL,
  attachment_asset_ids UUID[] NOT NULL DEFAULT '{}',
  is_internal          BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ticket_messages_ticket_idx ON ticket_messages (ticket_id, created_at);

CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(40) NOT NULL,
  title      VARCHAR(200) NOT NULL,
  body       TEXT,
  link       VARCHAR(300),
  channels   TEXT[] NOT NULL DEFAULT '{in_app}',
  email_status VARCHAR(20),
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  order_item_id   UUID REFERENCES order_items(id),
  rating          INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title           VARCHAR(160),
  body            TEXT,
  photo_asset_ids UUID[] NOT NULL DEFAULT '{}',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);
CREATE TRIGGER reviews_updated BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE settings (
  key        VARCHAR(80) PRIMARY KEY,
  value      JSONB NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cms_pages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         VARCHAR(120) NOT NULL UNIQUE,
  type         VARCHAR(20) NOT NULL DEFAULT 'page' CHECK (type IN ('page','policy','faq','banner')),
  title        VARCHAR(200) NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  sort_order   INT NOT NULL DEFAULT 0,
  is_published BOOLEAN NOT NULL DEFAULT true,
  updated_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER cms_pages_updated BEFORE UPDATE ON cms_pages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id),
  action        VARCHAR(80) NOT NULL,
  entity_type   VARCHAR(40) NOT NULL,
  entity_id     VARCHAR(64),
  before        JSONB,
  after         JSONB,
  ip            VARCHAR(64),
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);

-- Human-readable document numbers (ORD-000001 etc.)
CREATE TABLE number_sequences (
  name  VARCHAR(20) PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);

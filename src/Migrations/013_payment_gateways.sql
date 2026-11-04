-- Payment gateways managed from the admin panel (Razorpay, PayPal) instead of .env.
-- Each gateway keeps separate test and live credentials, so switching mode never loses keys.
-- Secret values are AES-256-GCM encrypted with APP_KEY (Utils/crypto encrypt) and never
-- returned by the API; key ids / client ids are public by design (the browser SDK needs them).
CREATE TABLE payment_gateways (
  code                      VARCHAR(20) PRIMARY KEY CHECK (code IN ('razorpay','paypal')),
  name                      VARCHAR(60) NOT NULL,
  is_enabled                BOOLEAN NOT NULL DEFAULT false,
  mode                      VARCHAR(4) NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  is_default                BOOLEAN NOT NULL DEFAULT false,
  sort_order                INTEGER NOT NULL DEFAULT 0,
  -- Razorpay Key ID / PayPal Client ID
  test_key_id               VARCHAR(200),
  live_key_id               VARCHAR(200),
  -- Razorpay Key Secret / PayPal Client Secret (encrypted)
  test_secret_enc           TEXT,
  live_secret_enc           TEXT,
  -- Razorpay webhook secret (encrypted) / PayPal webhook ID (not a secret, stored encrypted
  -- anyway so both gateways are handled alike)
  test_webhook_secret_enc   TEXT,
  live_webhook_secret_enc   TEXT,
  -- Currency the gateway charges in. Orders are priced in INR; for any other currency the
  -- amount is converted with exchange_rate (INR per 1 unit of that currency).
  currency                  VARCHAR(3) NOT NULL DEFAULT 'INR',
  exchange_rate             NUMERIC(14,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  last_test_status          VARCHAR(10) CHECK (last_test_status IN ('ok','failed')),
  last_test_message         VARCHAR(300),
  last_tested_at            TIMESTAMPTZ,
  last_test_mode            VARCHAR(4),
  updated_by                UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_gateways_one_default ON payment_gateways (is_default) WHERE is_default;
CREATE TRIGGER payment_gateways_updated BEFORE UPDATE ON payment_gateways FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO payment_gateways (code, name, sort_order, currency, exchange_rate) VALUES
  ('razorpay', 'Razorpay', 1, 'INR', 1),
  ('paypal', 'PayPal', 2, 'USD', 85);

-- The existing payment ledgers record PayPal transactions too. A payment remembers the mode
-- it was created in (verification, capture and refunds use that mode's credentials even after
-- the admin switches) and the amount actually charged in the gateway's currency.
ALTER TABLE payments DROP CONSTRAINT payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('mock','razorpay','paypal','offline'));
ALTER TABLE payments
  ADD COLUMN gateway_mode     VARCHAR(4) CHECK (gateway_mode IN ('test','live')),
  ADD COLUMN gateway_currency VARCHAR(3),
  ADD COLUMN gateway_amount   BIGINT;
CREATE INDEX payments_created_idx ON payments (created_at DESC);

ALTER TABLE vc_payments DROP CONSTRAINT vc_payments_provider_check;
ALTER TABLE vc_payments ADD CONSTRAINT vc_payments_provider_check CHECK (provider IN ('mock','razorpay','paypal','offline'));
ALTER TABLE vc_payments
  ADD COLUMN gateway_mode     VARCHAR(4) CHECK (gateway_mode IN ('test','live')),
  ADD COLUMN gateway_currency VARCHAR(3),
  ADD COLUMN gateway_amount   BIGINT;

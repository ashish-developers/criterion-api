-- Tax master: GST rates and HSN/SAC codes managed by platform admins.
-- Products link to a rate (tax_rate_id) and keep products.gst_rate in sync with it, so pricing,
-- quotes and invoices keep reading gst_rate unchanged. Order and quote lines store their own
-- copy of hsn_code/gst_rate at checkout, so changing the master never alters past documents.

CREATE TABLE tax_rates (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(60) NOT NULL UNIQUE,
  rate        NUMERIC(5,2) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  description VARCHAR(300),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One active entry per percentage, so pickers never show two "18%" options.
CREATE UNIQUE INDEX tax_rates_active_rate_idx ON tax_rates (rate) WHERE is_active;

CREATE TABLE hsn_codes (
  id          SERIAL PRIMARY KEY,
  -- HSN (goods) and SAC (services) codes: 4, 6 or 8 digits.
  code        VARCHAR(8) NOT NULL UNIQUE CHECK (code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  kind        VARCHAR(3) NOT NULL DEFAULT 'HSN' CHECK (kind IN ('HSN','SAC')),
  description VARCHAR(300) NOT NULL,
  tax_rate_id INT NOT NULL REFERENCES tax_rates(id),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hsn_codes_rate_idx ON hsn_codes (tax_rate_id);

ALTER TABLE products ADD COLUMN tax_rate_id INT REFERENCES tax_rates(id);
CREATE INDEX products_tax_rate_idx ON products (tax_rate_id);
ALTER TABLE categories ADD COLUMN default_tax_rate_id INT REFERENCES tax_rates(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- backfill existing data
-- One rate per percentage already used by products.
INSERT INTO tax_rates (name, rate, sort_order)
SELECT CASE WHEN p.gst_rate = 0 THEN 'Nil rated (0%)' ELSE 'GST ' || rtrim(rtrim(p.gst_rate::text, '0'), '.') || '%' END,
       p.gst_rate,
       (p.gst_rate * 100)::int
  FROM (SELECT DISTINCT gst_rate FROM products) p
ON CONFLICT (name) DO NOTHING;

UPDATE products p SET tax_rate_id = t.id FROM tax_rates t WHERE t.rate = p.gst_rate AND t.is_active;

-- One HSN entry per code already used, mapped to the rate most products with that code use.
INSERT INTO hsn_codes (code, description, tax_rate_id)
SELECT DISTINCT ON (x.hsn_code) x.hsn_code, 'HSN ' || x.hsn_code, x.tax_rate_id
  FROM (SELECT hsn_code, tax_rate_id, count(*) AS n FROM products
         WHERE tax_rate_id IS NOT NULL AND hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'
         GROUP BY hsn_code, tax_rate_id) x
 ORDER BY x.hsn_code, x.n DESC
ON CONFLICT (code) DO NOTHING;

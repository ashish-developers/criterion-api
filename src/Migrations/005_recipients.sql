-- Recipient lists for bulk/multi-address B2B orders (FR-BB-06): name, size, address per person.
ALTER TABLE quotes ADD COLUMN recipients JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN recipients JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE shipments ADD COLUMN recipient_ref VARCHAR(60);

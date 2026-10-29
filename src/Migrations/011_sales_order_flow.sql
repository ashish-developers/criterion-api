-- Quotation-to-delivery flow: an accepted quotation becomes a sales order that staff confirm
-- before the customer is asked to pay.
--
--   pending  created from an accepted quotation, waiting for staff confirmation
--   confirmed  staff confirmed the sales order (payment, artwork and production follow)
--   cancelled  cancelled before or after confirmation
--   not_required  orders placed through checkout (confirmed by the purchase itself)

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'placed','pending_confirmation','awaiting_approval','payment_pending','confirmed','in_progress',
  'partially_shipped','shipped','delivered','completed','cancelled','refunded'
));

ALTER TABLE orders ADD COLUMN confirmation_status VARCHAR(20) NOT NULL DEFAULT 'not_required'
  CHECK (confirmation_status IN ('not_required','pending','confirmed','cancelled'));
ALTER TABLE orders ADD COLUMN confirmed_by UUID REFERENCES users(id);
ALTER TABLE orders ADD COLUMN confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN confirmation_note TEXT;
ALTER TABLE orders ADD COLUMN closed_by UUID REFERENCES users(id);

-- Orders already converted from quotations went straight to payment: treat them as confirmed.
UPDATE orders SET confirmation_status = CASE WHEN status IN ('cancelled','refunded') THEN 'cancelled' ELSE 'confirmed' END,
                  confirmed_at = placed_at
 WHERE quote_id IS NOT NULL;

CREATE INDEX orders_confirmation_idx ON orders (confirmation_status) WHERE confirmation_status = 'pending';

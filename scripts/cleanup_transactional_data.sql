-- =============================================================================================
-- MingoKart: transactional data cleanup (PostgreSQL)
-- =============================================================================================
-- Removes orders, payments, quotations, production, shipping, support, settlements, visiting card
-- orders, carts, customer designs, notifications, logs and temporary records.
-- Keeps every master, reference, content and configuration table untouched.
--
-- REVIEW BEFORE RUNNING. Not executed by the author.
--   1. Back up first:   pg_dump -Fc -U <user> <database> > before_cleanup.dump
--   2. Run with psql so any error stops and rolls back the whole script:
--        psql -U <user> -d <database> -v ON_ERROR_STOP=1 -f cleanup_transactional_data.sql
--   3. Stop the API while it runs (the scheduler and live requests write to these tables).
--   4. Uploaded files of deleted assets stay in storage (api/storage/uploads or the S3 bucket);
--      remove them separately if wanted.
--
-- PRESERVED (not touched, except the counters noted in section 9):
--   Identity & access : users, roles, permissions, role_permissions, user_roles, user_permissions,
--                       user_invitations, user_batches, addresses, wishlists
--   Companies/vendors : companies, company_members, brand_kits, vendors, vendor_users,
--                       vendor_capabilities, vendor_holidays
--   Catalogue         : categories, products, product_variants, price_tiers, print_areas,
--                       product_methods, product_sources, bundle_items, decoration_methods
--   Tax & reference   : tax_rates, hsn_codes, coupons (definitions)
--   Visiting cards    : vc_templates, vc_template_categories, vc_price_slabs, vc_print_options
--   Content           : cms_pages, blog_posts, blog_categories, blog_tags, blog_post_tags,
--                       blog_post_history
--   Configuration     : settings (incl. SMTP), payment_gateways, number_sequences, schema_migrations
--   Assets kept       : product images, blog images, documents, brand kit files, and any asset
--                       referenced by a product, category, blog post, CMS page, template or setting
--   Stock movements   : initial / purchase / adjustment / damage / return entries
-- =============================================================================================

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Refunds and support tickets (refunds reference tickets, payments, orders and order items)
-- ---------------------------------------------------------------------------------------------
DELETE FROM refunds;
DELETE FROM ticket_assignments;
DELETE FROM ticket_messages;
DELETE FROM tickets;

-- ---------------------------------------------------------------------------------------------
-- 2. Vendor settlements and commissions (commissions reference settlements and order items)
-- ---------------------------------------------------------------------------------------------
DELETE FROM settlement_lines;
DELETE FROM commissions;
DELETE FROM settlements;

-- ---------------------------------------------------------------------------------------------
-- 3. Production (jobs reference proofs and order items)
-- ---------------------------------------------------------------------------------------------
DELETE FROM qc_checks;
DELETE FROM job_events;
DELETE FROM production_jobs;

-- ---------------------------------------------------------------------------------------------
-- 4. Shipping
-- ---------------------------------------------------------------------------------------------
DELETE FROM tracking_events;
DELETE FROM shipment_items;
DELETE FROM shipments;

-- ---------------------------------------------------------------------------------------------
-- 5. Orders: stock given back, then payments, invoices, reviews, proofs, items and orders
-- ---------------------------------------------------------------------------------------------
-- Return the stock that orders took (order movements are negative; cancellations positive), so
-- product stock matches the kept initial/purchase/adjustment entries.
UPDATE product_variants v
   SET stock_qty = v.stock_qty - m.total
  FROM (SELECT variant_id, SUM(change_qty) AS total
          FROM inventory_movements
         WHERE reference_type = 'order'
         GROUP BY variant_id) m
 WHERE v.id = m.variant_id;
DELETE FROM inventory_movements WHERE reference_type = 'order';

DELETE FROM coupon_redemptions;
DELETE FROM invoices;
DELETE FROM payments;
DELETE FROM order_events;
DELETE FROM reviews;                                   -- product reviews are tied to order items

UPDATE order_items SET approved_proof_id = NULL WHERE approved_proof_id IS NOT NULL;
DELETE FROM proof_approvals;
DELETE FROM proofs;

DELETE FROM order_items;                               -- self-reference (reprints) cleared in one statement
DELETE FROM orders;                                    -- self-reference (re-orders) cleared in one statement

-- ---------------------------------------------------------------------------------------------
-- 6. Quotations (RFQs, versions, messages)
-- ---------------------------------------------------------------------------------------------
DELETE FROM quote_items;
DELETE FROM quote_request_items;
DELETE FROM quote_messages;
DELETE FROM quote_events;
UPDATE quotes SET current_version_id = NULL WHERE current_version_id IS NOT NULL;
DELETE FROM quote_versions;
DELETE FROM quotes;

-- ---------------------------------------------------------------------------------------------
-- 7. Carts, customer designs and their uploaded artwork
-- ---------------------------------------------------------------------------------------------
DELETE FROM cart_items;
DELETE FROM carts;

UPDATE designs SET current_version_id = NULL WHERE current_version_id IS NOT NULL;
DELETE FROM design_versions;
DELETE FROM designs;

-- Customer artwork, previews, proofs and print/production/QC/complaint photos only.
-- Kept: product_image, blog_image, document, brand kit files, and anything referenced elsewhere.
DELETE FROM artwork_assets a
 WHERE a.kind IN ('artwork', 'preview', 'proof', 'print_file', 'production_photo', 'qc_photo', 'complaint_photo')
   AND a.brand_kit_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM products     p WHERE p::text LIKE '%' || a.id::text || '%')
   AND NOT EXISTS (SELECT 1 FROM categories   c WHERE c::text LIKE '%' || a.id::text || '%')
   AND NOT EXISTS (SELECT 1 FROM blog_posts   b WHERE b::text LIKE '%' || a.id::text || '%')
   AND NOT EXISTS (SELECT 1 FROM cms_pages    m WHERE m::text LIKE '%' || a.id::text || '%')
   AND NOT EXISTS (SELECT 1 FROM vc_templates t WHERE t::text LIKE '%' || a.id::text || '%')
   AND NOT EXISTS (SELECT 1 FROM settings     s WHERE s::text LIKE '%' || a.id::text || '%');

-- ---------------------------------------------------------------------------------------------
-- 8. Visiting card orders and customer card designs (templates are kept)
-- ---------------------------------------------------------------------------------------------
DELETE FROM vc_invoices;
DELETE FROM vc_payments;
DELETE FROM vc_order_cards;
DELETE FROM vc_order_events;
DELETE FROM vc_orders;
DELETE FROM vc_designs;

-- ---------------------------------------------------------------------------------------------
-- 9. Counters derived from the deleted records (master rows kept, usage reset)
-- ---------------------------------------------------------------------------------------------
UPDATE coupons      SET used_count = 0 WHERE used_count <> 0;
UPDATE products     SET rating_avg = 0, rating_count = 0 WHERE rating_count <> 0 OR rating_avg <> 0;
UPDATE vc_templates SET usage_count = 0 WHERE usage_count <> 0;

-- ---------------------------------------------------------------------------------------------
-- 10. Logs, notifications and temporary records
-- ---------------------------------------------------------------------------------------------
DELETE FROM notifications;
DELETE FROM email_outbox;                              -- sent/queued email log (unsent mail is dropped)
DELETE FROM payment_webhook_events;                    -- gateway webhook log / idempotency keys
DELETE FROM verification_challenges;                   -- OTP challenges
DELETE FROM sessions;                                  -- signs every user out
DELETE FROM audit_logs;                                -- remove this line to keep the audit trail

-- ---------------------------------------------------------------------------------------------
-- 11. OPTIONAL: restart document numbers (orders, invoices, quotes, tickets, ...).
-- Only if no real invoice was ever issued: GST invoice numbers must not be reused.
-- ---------------------------------------------------------------------------------------------
-- UPDATE number_sequences SET value = 0;

-- ---------------------------------------------------------------------------------------------
-- Check: every cleaned table should show 0 rows.
-- ---------------------------------------------------------------------------------------------
SELECT 'orders' AS table_name, COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'invoices', COUNT(*) FROM invoices
UNION ALL SELECT 'quotes', COUNT(*) FROM quotes
UNION ALL SELECT 'tickets', COUNT(*) FROM tickets
UNION ALL SELECT 'production_jobs', COUNT(*) FROM production_jobs
UNION ALL SELECT 'shipments', COUNT(*) FROM shipments
UNION ALL SELECT 'settlements', COUNT(*) FROM settlements
UNION ALL SELECT 'vc_orders', COUNT(*) FROM vc_orders
UNION ALL SELECT 'carts', COUNT(*) FROM carts
UNION ALL SELECT 'designs', COUNT(*) FROM designs
UNION ALL SELECT 'notifications', COUNT(*) FROM notifications
UNION ALL SELECT 'sessions', COUNT(*) FROM sessions;

-- Everything above runs as one transaction. If any statement fails (with ON_ERROR_STOP=1) nothing
-- is changed. To dry-run, replace COMMIT with ROLLBACK, check the counts, and run again with COMMIT.
COMMIT;

-- Listings that a vendor suspension took off the storefront, so reinstating the vendor brings
-- back exactly those (and not listings the vendor had paused itself).
ALTER TABLE products ADD COLUMN paused_by_suspension BOOLEAN NOT NULL DEFAULT false;

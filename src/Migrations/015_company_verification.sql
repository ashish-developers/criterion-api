-- Verification of self-registered business accounts. A new company starts 'pending': its users
-- can sign in, browse, build a cart and request quotations, but cannot place orders or accept
-- quotations until a platform admin verifies it. Existing companies are already trusted.
-- Separate from companies.status (active/suspended), which an admin uses to block an account.
ALTER TABLE companies
  ADD COLUMN verification_status VARCHAR(10) NOT NULL DEFAULT 'verified' CHECK (verification_status IN ('pending','verified','rejected')),
  ADD COLUMN verification_note   VARCHAR(500),
  ADD COLUMN verified_at         TIMESTAMPTZ,
  ADD COLUMN verified_by         UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX companies_verification_idx ON companies (verification_status) WHERE verification_status <> 'verified';

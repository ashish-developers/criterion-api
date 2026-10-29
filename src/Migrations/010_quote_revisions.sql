-- Quotation revisions: staff can return a request to the customer for correction, the customer
-- corrects and resubmits it, and every step is kept in an append-only history.
--
--   correction_requested  staff returned the request to the customer (reason + category)
--   resubmitted           the customer corrected the request and sent it back for review
--
-- ("revision_requested" already exists and means the opposite direction: the customer asks
-- staff to re-price a quotation they were sent.)

ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check CHECK (status IN (
  'requested','under_review','sent','revision_requested','correction_requested','resubmitted',
  'accepted','rejected','expired','converted','cancelled'
));

-- Revision of the customer's request: 1 as first submitted, +1 on every resubmission.
ALTER TABLE quotes ADD COLUMN request_revision INT NOT NULL DEFAULT 1 CHECK (request_revision >= 1);
-- The request revision each priced version was prepared from.
ALTER TABLE quote_versions ADD COLUMN request_revision INT NOT NULL DEFAULT 1 CHECK (request_revision >= 1);

-- Append-only audit trail of a quotation: status transitions, who acted and why, and for
-- request edits the changed fields (before / after) plus a full snapshot of the request as it
-- was before the change, so every earlier revision can be reproduced. Rows are never updated
-- or deleted by the application.
CREATE TABLE quote_events (
  id               BIGSERIAL PRIMARY KEY,
  quote_id         UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  actor_user_id    UUID REFERENCES users(id),
  actor_role       VARCHAR(10) NOT NULL CHECK (actor_role IN ('customer','staff','system')),
  event            VARCHAR(30) NOT NULL,
  from_status      VARCHAR(20),
  to_status        VARCHAR(20),
  request_revision INT NOT NULL,
  version_no       INT,
  category         VARCHAR(20) CHECK (category IN ('pricing','quantity','product','artwork','customization','tax','delivery','payment_terms','other')),
  reason           TEXT,
  instructions     TEXT,
  -- Staff only: never returned to customers.
  internal_note    TEXT,
  changes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  snapshot         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX quote_events_quote_idx ON quote_events (quote_id, id);

-- History for quotations created before this migration: their creation, and the versions
-- already sent (both were the only recorded steps).
INSERT INTO quote_events (quote_id, actor_user_id, actor_role, event, to_status, request_revision, created_at)
SELECT id, requester_user_id, 'customer', 'created', 'requested', 1, created_at FROM quotes;
INSERT INTO quote_events (quote_id, actor_user_id, actor_role, event, to_status, request_revision, version_no, created_at)
SELECT quote_id, created_by, 'staff', 'version_sent', 'sent', 1, version_no, COALESCE(sent_at, created_at) FROM quote_versions;

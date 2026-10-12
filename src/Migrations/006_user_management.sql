-- User management for organisation admins: bulk creation, invitations, forced password
-- change on first login, and a durable email outbox with delivery tracking and retries.

-- ---------------------------------------------------------------- users
-- Accounts created with a development default password must choose their own on first login.
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
-- Who created the account (organisation admin), for audit and support.
ALTER TABLE users ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- Deactivation by an organisation admin. Only the same level (or a platform admin) can undo it,
-- and the account returns to the status it had before (active, or pending if never set up).
ALTER TABLE users ADD COLUMN deactivated_scope VARCHAR(20) CHECK (deactivated_scope IN ('company','vendor','platform'));
ALTER TABLE users ADD COLUMN status_before_deactivation VARCHAR(20) CHECK (status_before_deactivation IN ('pending','active'));
ALTER TABLE users ADD COLUMN deactivated_at TIMESTAMPTZ;

-- ---------------------------------------------------------------- bulk batches
-- One row per bulk request. The idempotency key makes a retried request return the original
-- result instead of creating accounts (and sending emails) twice.
CREATE TABLE user_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type      VARCHAR(20) NOT NULL CHECK (scope_type IN ('company','vendor','platform')),
  scope_id        UUID,
  idempotency_key VARCHAR(80) NOT NULL,
  source          VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv')),
  status          VARCHAR(20) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed')),
  total           INT NOT NULL DEFAULT 0,
  created_count   INT NOT NULL DEFAULT 0,
  failed_count    INT NOT NULL DEFAULT 0,
  results         JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (actor_id, idempotency_key)
);

-- ---------------------------------------------------------------- invitations
-- The set-password token is generated when the email is sent; only its HMAC is stored.
-- Sending a new invitation email replaces the token, so older links stop working.
CREATE TABLE user_invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type  VARCHAR(20) NOT NULL CHECK (scope_type IN ('company','vendor','platform')),
  scope_id    UUID,
  role_code   VARCHAR(40) NOT NULL,
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  batch_id    UUID REFERENCES user_batches(id) ON DELETE SET NULL,
  token_hash  VARCHAR(128) UNIQUE,
  expires_at  TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_invitations_user_idx ON user_invitations (user_id);

-- ---------------------------------------------------------------- email outbox
-- Emails are queued here and delivered by a background worker with retries. The payload holds
-- template data only; secrets (default passwords, invitation tokens) are added at send time
-- and never stored.
CREATE TABLE email_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  invitation_id   UUID REFERENCES user_invitations(id) ON DELETE SET NULL,
  to_email        VARCHAR(190) NOT NULL,
  template        VARCHAR(40) NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  dedupe_key      VARCHAR(160) NOT NULL UNIQUE,
  -- logged = accepted by the development log driver (nothing was actually emailed)
  status          VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','logged','failed')),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ DEFAULT now(),
  last_error      TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_due_idx ON email_outbox (status, next_attempt_at);
CREATE INDEX email_outbox_user_idx ON email_outbox (user_id, created_at DESC);

-- Identity, roles, permissions, sessions and OTP verification challenges.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE roles (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(40)  NOT NULL UNIQUE,
  name        VARCHAR(80)  NOT NULL,
  description TEXT,
  scope_type  VARCHAR(20)  NOT NULL DEFAULT 'platform' CHECK (scope_type IN ('platform','company','vendor','self')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(80) NOT NULL UNIQUE,
  module      VARCHAR(40) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id       INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(120) NOT NULL,
  email             VARCHAR(190) NOT NULL,
  phone             VARCHAR(20),
  password_hash     TEXT NOT NULL,
  account_type      VARCHAR(20) NOT NULL CHECK (account_type IN ('individual','business','vendor','staff')),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  avatar_url        TEXT,
  email_verified_at TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  marketing_opt_in  BOOLEAN NOT NULL DEFAULT false,
  is_demo           BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX users_status_idx ON users (status);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- scope_type/scope_id restrict a role to one company or vendor (NULL = platform-wide or self).
CREATE TABLE user_roles (
  id         SERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    INT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type VARCHAR(20) NOT NULL DEFAULT 'platform',
  scope_id   UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_roles_unique ON user_roles (user_id, role_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(128) NOT NULL UNIQUE,
  user_agent         TEXT,
  ip                 VARCHAR(64),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  last_used_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- One row per OTP challenge. The OTP itself is stored only as a keyed hash.
CREATE TABLE verification_challenges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       VARCHAR(20) NOT NULL CHECK (purpose IN ('register','login','password_reset')),
  channel       VARCHAR(10) NOT NULL DEFAULT 'email',
  otp_hash      VARCHAR(128) NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  max_attempts  INT NOT NULL DEFAULT 5,
  resend_count  INT NOT NULL DEFAULT 0,
  last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at   TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  reset_token_hash VARCHAR(128),
  ip            VARCHAR(64),
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX verification_challenges_user_idx ON verification_challenges (user_id, purpose, created_at DESC);

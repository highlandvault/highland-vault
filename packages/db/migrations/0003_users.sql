-- 0003_users
--
-- Customer and staff accounts (ADR-0003, Revision 2 B6 and D-1).
--
-- * Users are NOT assigned to a market: there is deliberately no market_id.
--   Market context lives on draws, orders, payments, terms and consents.
-- * Email is globally unique. It is stored normalized (trimmed, lower case;
--   no provider-specific dot or plus stripping, Revision 2 B9) and compared
--   case-insensitively through citext.
-- * Only Argon2id password hashes are accepted. Legacy WordPress hashes
--   (Phase 13, ADR-0018) will need a new migration that extends the check.
-- * Columns for later phases (DOB, anonymisation, profile) are added by those
--   phases.

CREATE TABLE users (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  email             citext      NOT NULL,
  email_verified_at timestamptz,
  password_hash     text        NOT NULL,
  status            text        NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_normalized CHECK (email::text = lower(btrim(email::text))),
  CONSTRAINT users_email_format CHECK (
    char_length(email::text) BETWEEN 3 AND 254
    AND email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  ),
  CONSTRAINT users_password_hash_argon2id CHECK (password_hash LIKE '$argon2id$%'),
  -- 'disabled' blocks sign-in. Further states (for example anonymised) arrive
  -- with the features that need them.
  CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled'))
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

COMMENT ON TABLE users IS
  'Accounts. No market_id by design (ADR-0003): one account spans UK and IE.';
COMMENT ON COLUMN users.email IS
  'Normalized (trim + lower case) and globally unique (case-insensitive via citext).';

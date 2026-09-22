-- 0005_sessions_and_mfa
--
-- Server-side sessions and TOTP MFA (Revision 2 B6, ADR-0010).
--
-- * The session cookie carries an opaque random token. Only its SHA-256 hash
--   is stored, so a database leak does not leak usable sessions.
-- * A session for a user with confirmed MFA starts with mfa_required = true
--   and is not fully authenticated until a second factor is verified.
--   mfa_verified_at is also the step-up timestamp for sensitive operations.
-- * The TOTP secret is stored encrypted (AES-256-GCM, key outside the
--   database). last_used_step makes every TOTP code single-use.
-- * Recovery codes are stored as SHA-256 hashes and are single-use.
--
-- Guest sessions (verified guest email, ADR-0020) are Phase 5.

CREATE TABLE sessions (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  token_hash      bytea       NOT NULL,
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mfa_required    boolean     NOT NULL,
  mfa_verified_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  ip              inet,
  user_agent      text,

  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_token_hash_sha256 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT sessions_user_agent_length CHECK (user_agent IS NULL OR char_length(user_agent) <= 512)
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE user_mfa (
  user_id               uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- nonce (12 bytes) || auth tag (16 bytes) || ciphertext
  totp_secret_encrypted bytea       NOT NULL,
  -- Identifies the encryption key, so keys can be rotated.
  encryption_key_id     text        NOT NULL,
  -- NULL while enrolment is pending (secret issued, first code not yet verified).
  confirmed_at          timestamptz,
  -- Highest TOTP time step accepted so far; a code is accepted only for a later step.
  last_used_step        bigint,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_mfa_secret_length CHECK (octet_length(totp_secret_encrypted) > 28),
  CONSTRAINT user_mfa_key_id_not_blank CHECK (btrim(encryption_key_id) <> ''),
  CONSTRAINT user_mfa_last_used_step_non_negative CHECK (last_used_step IS NULL OR last_used_step >= 0)
);

CREATE TRIGGER user_mfa_set_updated_at
  BEFORE UPDATE ON user_mfa
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

CREATE TABLE mfa_recovery_codes (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  bytea       NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mfa_recovery_codes_user_code_key UNIQUE (user_id, code_hash),
  CONSTRAINT mfa_recovery_codes_code_hash_sha256 CHECK (octet_length(code_hash) = 32)
);

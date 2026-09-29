-- 0012_guest_sessions
--
-- Guest identity for checkout (Phase 5, task P5-3; ADR-0020, ADR-0029).
--
-- A guest is someone buying without an account. They still need a stable
-- identity across the few requests a checkout takes, and somewhere to hold the
-- email address they have verified.
--
-- This is a SEPARATE table from `sessions`, not a relaxation of it. An
-- authenticated session has `user_id NOT NULL`, and making that nullable would
-- weaken the strongest statement the schema makes about who a session belongs
-- to. Two tables keep the boundary obvious: nothing here grants authenticated
-- access, and no join from here reaches a user's permissions.
--
-- What a guest session is NOT:
--   * it is not an account. No `users` row is created for being a guest, and
--     there is no foreign key to one;
--   * it is not authentication. The API attaches it only on public routes;
--   * it is not a ticket-cap identity. That is the VERIFIED EMAIL (ADR-0008),
--     which is why the address is recorded here with the moment it was
--     verified rather than merely a boolean.
--
-- Token handling matches `sessions` exactly (Revision 2 B6): the value in the
-- cookie is opaque and random, and only its SHA-256 is stored, so the table
-- cannot be used to impersonate anybody even if it is read.

CREATE TABLE guest_sessions (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  token_hash        bytea       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  -- The address this guest has proved they can read (ADR-0020). Set together
  -- with the moment it happened, because the binding is only good for a short
  -- window and "verified at some point" is not the same question.
  verified_email    citext,
  verified_email_at timestamptz,
  ip                inet,
  user_agent        text,

  CONSTRAINT guest_sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT guest_sessions_token_hash_sha256 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT guest_sessions_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT guest_sessions_revoked_after_created CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  -- An address and the time it was verified travel together or not at all.
  CONSTRAINT guest_sessions_verified_consistent CHECK (
    (verified_email IS NULL) = (verified_email_at IS NULL)
  ),
  -- Normalized exactly as users.email is, so the same person cannot end up
  -- with two cap identities by capitalising differently (ADR-0008).
  CONSTRAINT guest_sessions_verified_email_normalized CHECK (
    verified_email IS NULL OR verified_email::text = lower(btrim(verified_email::text))
  ),
  CONSTRAINT guest_sessions_verified_email_format CHECK (
    verified_email IS NULL OR (
      char_length(verified_email::text) BETWEEN 3 AND 254
      AND verified_email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    )
  ),
  CONSTRAINT guest_sessions_user_agent_length CHECK (
    user_agent IS NULL OR char_length(user_agent) <= 512
  )
);

-- Every request with a guest cookie is this lookup: hash, still live.
CREATE INDEX guest_sessions_live_idx ON guest_sessions (token_hash) WHERE revoked_at IS NULL;
-- Operator view, and the basis of any later pruning of lapsed sessions.
CREATE INDEX guest_sessions_expiry_idx ON guest_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE FUNCTION hv_guest_sessions_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a guest session is created live'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_sessions_created_live';
    END IF;
    RETURN NEW;
  END IF;

  -- What the session IS never changes; only its verification and its end do.
  IF ROW(NEW.id, NEW.token_hash, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.token_hash, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'a guest session''s identity and lifetime are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_sessions_immutable';
  END IF;
  -- A verified address is not swapped for another one. Re-verifying a
  -- different address is a new session, so a cap identity cannot be changed
  -- underneath a basket that was built with the first one.
  IF OLD.verified_email IS NOT NULL AND NEW.verified_email IS DISTINCT FROM OLD.verified_email THEN
    RAISE EXCEPTION 'a guest session''s verified email cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_sessions_verified_email_final';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a guest session is revoked once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_sessions_revoked_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guest_sessions_guard
  BEFORE INSERT OR UPDATE ON guest_sessions
  FOR EACH ROW EXECUTE FUNCTION hv_guest_sessions_guard();

-- Sessions end by expiring or being revoked, never by disappearing: a deleted
-- row would take the record of a verified address with it.
REVOKE DELETE, TRUNCATE ON guest_sessions FROM hv_app;

COMMENT ON TABLE guest_sessions IS
  'Identity for a guest checkout: an opaque token (stored hashed) and, once proved, the verified email that is their ticket-cap key. Never an account, never authentication.';

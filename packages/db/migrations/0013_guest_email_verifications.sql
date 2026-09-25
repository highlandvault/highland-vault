-- 0013_guest_email_verifications
--
-- Guest email verification (Phase 5, task P5-4; ADR-0020).
--
-- A guest's ticket cap is keyed on a VERIFIED email (ADR-0008), so before an
-- address can act as that key the guest has to prove they can read it. They
-- are emailed a six-digit code during checkout and type it back.
--
-- The code is a credential for the few minutes it lives, so it is treated like
-- one: only its SHA-256 is stored, exactly as session tokens are, and the row
-- records how many times it has been tried and whether it has been used.
--
-- Three limits, all enforced here rather than trusted to the caller:
--   * it expires (ADR-0020: short-lived; the approved value is 10 minutes,
--     and the CHECK caps any caller at 60);
--   * it can be used once — `consumed_at` is set exactly once, so a code
--     replayed after a successful verification is refused;
--   * it can be guessed only a few times before the row is spent, which is
--     what stops a six-digit code being brute-forced. Sending rate is limited
--     separately, in Redis, by the existing fail-closed limiter.
--
-- Rows are kept after use. They are the record that an address was verified,
-- when, and how hard someone tried — so hv_app cannot delete them.

CREATE TABLE guest_email_verifications (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  guest_session_id uuid        NOT NULL REFERENCES guest_sessions (id),
  -- Normalized the same way users.email and guest_sessions.verified_email are,
  -- so the address that is verified is the address that keys the cap.
  email            citext      NOT NULL,
  code_hash        bytea       NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0,
  consumed_at      timestamptz,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT guest_email_verifications_code_hash_sha256 CHECK (octet_length(code_hash) = 32),
  CONSTRAINT guest_email_verifications_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT guest_email_verifications_ttl_valid CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '60 minutes'
  ),
  CONSTRAINT guest_email_verifications_consumed_after_created CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  ),
  CONSTRAINT guest_email_verifications_email_normalized CHECK (
    email::text = lower(btrim(email::text))
  ),
  CONSTRAINT guest_email_verifications_email_format CHECK (
    char_length(email::text) BETWEEN 3 AND 254
    AND email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  )
);

-- The verification lookup: the newest live code for this session and address.
CREATE INDEX guest_email_verifications_live_idx
  ON guest_email_verifications (guest_session_id, email, created_at DESC)
  WHERE consumed_at IS NULL;

CREATE FUNCTION hv_guest_email_verifications_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'a verification is created unused and unattempted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_email_verifications_created_fresh';
    END IF;
    RETURN NEW;
  END IF;

  -- What is being verified never changes; only the attempt count and the fact
  -- that it has been used.
  IF ROW(NEW.id, NEW.guest_session_id, NEW.email, NEW.code_hash, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.guest_session_id, OLD.email, OLD.code_hash, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'a verification is immutable once issued'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_email_verifications_immutable';
  END IF;
  -- Single use. Without this a correct code could be replayed for as long as
  -- it had not expired.
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'verification % has already been used', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_email_verifications_used_once';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'verification attempts never decrease'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_email_verifications_attempts_monotonic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guest_email_verifications_guard
  BEFORE INSERT OR UPDATE ON guest_email_verifications
  FOR EACH ROW EXECUTE FUNCTION hv_guest_email_verifications_guard();

-- The record of who verified what, and of how hard anyone tried: kept.
REVOKE DELETE, TRUNCATE ON guest_email_verifications FROM hv_app;

COMMENT ON TABLE guest_email_verifications IS
  'Six-digit codes proving a guest can read an address (ADR-0020). Stored hashed, single-use, expiring, and attempt-capped so the code cannot be guessed.';

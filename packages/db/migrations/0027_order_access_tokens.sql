-- 0027_order_access_tokens
--
-- The return link (Revision 2 OD-2; Phase 6, task P6-8; owner decisions
-- D18 = B, D19 = A, D19a in docs/PHASE_6_SCOPE_LOCK.md).
--
-- THE PROBLEM THIS SOLVES
--
-- A guest proves their email address and that proof lasts 30 minutes
-- (GUEST_VERIFIED_EMAIL_TTL_MINUTES). They then leave for a payment provider.
-- By the time they come back the binding may have lapsed, their browser may
-- have been closed, or they may be on another device entirely — and they still
-- have to be able to see what happened to the order they just paid for.
--
-- Extending the email binding was rejected (D18/D19): a window that stretches
-- to cover a payment is no longer a proof of address. So the return link
-- carries its own credential, scoped to one order and to reading.
--
-- WHAT THIS TOKEN IS NOT
--
-- It authenticates nobody. It is not a session, it confers no cap identity, it
-- touches `guest_sessions.verified_email` in neither direction, and it cannot
-- start a payment (D18 = B). A guest whose proof has lapsed can SEE that their
-- payment failed; to try again they must verify their address again. That is
-- the deliberate trade in choosing B over C.
--
-- Because it is bound to one order and grants only reading, "must not expose
-- arbitrary orders" is a property of the schema rather than a check somebody
-- has to remember to write.
--
-- STORAGE
--
-- SHA-256 of the token and nothing else, exactly as `guest_sessions` stores
-- its token (0012). The plaintext is handed to the client once, in the
-- provider return URL, and exists in no table and no log. A leaked database
-- yields no usable link.
--
-- LIFETIME — ITS OWN VALUE, DELIBERATELY
--
-- `orders.expires_at + 30 minutes` (D19a). Thirty is arithmetically equal to
-- GUEST_VERIFIED_EMAIL_TTL_MINUTES and that is a coincidence, not a
-- dependency: the two must never be derived from one another, or a future
-- change to the email-proof window would silently change how long a return
-- link works. The application supplies the value from its own configuration;
-- this table only insists the result is after the row was created.

CREATE TABLE order_access_tokens (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),

  -- Exactly one order. D3 = B allows one live payment attempt per order, so a
  -- per-attempt token would buy nothing and would multiply the credentials in
  -- circulation.
  order_id   uuid        NOT NULL REFERENCES orders (id),

  -- SHA-256 only. Never the token itself.
  token_hash bytea       NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  -- orders.expires_at + the configured tail (D19a).
  expires_at timestamptz NOT NULL,
  -- Mirrors guest_sessions: a link can be withdrawn without deleting the row.
  revoked_at timestamptz,

  CONSTRAINT order_access_tokens_order_key UNIQUE (order_id),
  CONSTRAINT order_access_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT order_access_tokens_token_hash_sha256 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT order_access_tokens_expires_after_created CHECK (expires_at > created_at)
);

-- Presentation looks a token up by its hash, and only a live one is any use.
CREATE INDEX order_access_tokens_live_idx
  ON order_access_tokens (token_hash) WHERE revoked_at IS NULL;

/**
 * A link is issued once and only ever withdrawn.
 *
 * `guest_sessions` is protected the same way and for the same reason: a
 * credential whose subject or secret can be rewritten in place is a credential
 * that can be quietly pointed at somebody else's order. Revoking is the one
 * change allowed, and it happens once.
 */
CREATE FUNCTION hv_order_access_tokens_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.id, NEW.order_id, NEW.token_hash, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.order_id, OLD.token_hash, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'an order access token is fixed when it is issued'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_access_tokens_immutable';
  END IF;

  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'an order access token is revoked once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_access_tokens_revoked_once';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_access_tokens_guard
  BEFORE UPDATE ON order_access_tokens
  FOR EACH ROW EXECUTE FUNCTION hv_order_access_tokens_guard();

-- A credential is revoked, never erased: the record that a link existed and
-- when it stopped working is part of the order's story. The same rule
-- guest_sessions follows.
REVOKE DELETE, TRUNCATE ON order_access_tokens FROM hv_app;

COMMENT ON TABLE order_access_tokens IS
  'Read-only return link for one order (OD-2, D18 = B). Authenticates nobody, confers no session or cap identity, and cannot start a payment. SHA-256 of the token only.';
COMMENT ON COLUMN order_access_tokens.expires_at IS
  'orders.expires_at + the configured tail (D19a, 30 minutes). Its own value: never derived from GUEST_VERIFIED_EMAIL_TTL_MINUTES.';

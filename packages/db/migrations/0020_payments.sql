-- 0020_payments
--
-- Payment attempts (Phase 6, task P6-2; Revision 2 B10 and B18; owner
-- decisions D3 = B, D3a, D3b and OD-4 in docs/PHASE_6_SCOPE_LOCK.md).
--
-- An order may be attempted several times over its life — a first attempt
-- fails, the customer tries again — but only ONE may be live at a time, and
-- only one may ever succeed. Both of those are enforced here by partial unique
-- indexes rather than by application code, because they are the two facts that
-- must hold even when a bug does not.
--
-- The attempt is not the order. Nothing in this table marks an order paid:
-- that transition belongs to `orders`, it happens only through a verified
-- webhook or a trusted provider status check (ADR-0006, D6), and a browser
-- coming back from a provider is neither.

CREATE TABLE payments (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),

  order_id             uuid        NOT NULL,
  -- Carried rather than joined for, so the composite foreign keys below can
  -- pin this attempt to its order's market and currency.
  market_id            uuid        NOT NULL,

  -- The provider's own code ('fake', later a real one). Never a provider name
  -- in this schema's own vocabulary: O13 is open and ADR-0006 exists so it can
  -- be answered late.
  provider             text        NOT NULL,
  -- The provider's identifier for this attempt. NULL until the provider has
  -- been asked and has answered; set once thereafter.
  provider_reference   text,

  -- What the customer is being asked to pay. Not a copy of the order's total
  -- the application chose to make: the foreign key below makes it the same
  -- number as `orders.external_due_minor`, or the row does not exist.
  amount_minor         bigint      NOT NULL,
  currency             text        NOT NULL,

  status               text        NOT NULL DEFAULT 'pending',

  -- B10 REQ: a retried create returns the first attempt rather than opening a
  -- second session at the provider. Mirrors orders.idempotency_key.
  idempotency_key      text        NOT NULL,

  -- When this attempt stops being usable (D3a): min(created_at + 120s,
  -- orders.expires_at). The order's clock always wins, so an attempt started
  -- close to the deadline is cut short by it rather than outliving it.
  expires_at           timestamptz NOT NULL,

  -- Why it failed, for support and for the customer-facing state. Set once.
  failure_code         text,
  failure_message      text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- B10 REQ: unique provider references. Scoped by provider, because two
  -- providers may legitimately mint the same string.
  CONSTRAINT payments_provider_reference_key UNIQUE (provider, provider_reference),
  CONSTRAINT payments_idempotency_key_key UNIQUE (idempotency_key),

  -- An attempt cannot belong to an order from another market (I7).
  CONSTRAINT payments_order_market_fkey
    FOREIGN KEY (order_id, market_id) REFERENCES orders (id, market_id),
  -- And it trades in the market's currency, like everything else that is
  -- priced or paid (ADR-0004, I6).
  CONSTRAINT payments_market_currency_fkey
    FOREIGN KEY (market_id, currency) REFERENCES markets (id, currency),
  -- ★ The amount is the ORDER's amount, structurally (I4, I5).
  --
  -- This is the constraint that makes "never trust the client about money"
  -- true rather than merely intended. The application reads
  -- `orders.external_due_minor` inside the transaction; this makes it
  -- impossible for any code path — present, future or hand-written SQL — to
  -- record an attempt for a different number. `external_due_minor` is frozen
  -- by `hv_orders_guard`, so the target cannot move underneath it either.
  CONSTRAINT payments_order_amount_fkey
    FOREIGN KEY (order_id, currency, amount_minor)
    REFERENCES orders (id, currency, external_due_minor),

  CONSTRAINT payments_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT payments_status_valid CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed', 'expired'
  )),
  CONSTRAINT payments_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT payments_idempotency_key_format CHECK (
    idempotency_key = btrim(idempotency_key) AND char_length(idempotency_key) BETWEEN 8 AND 255
  ),
  -- A reference is either absent or meaningful; an empty string is neither.
  CONSTRAINT payments_provider_reference_present CHECK (
    provider_reference IS NULL OR char_length(btrim(provider_reference)) > 0
  ),
  CONSTRAINT payments_provider_present CHECK (char_length(btrim(provider)) > 0)
);

-- ★ At most one SUCCEEDED attempt per order (I11).
--
-- The single most valuable constraint in the phase. A duplicated webhook, two
-- workers finalising at once, or a second attempt completing after the first
-- cannot produce two successful payments for one order — not because the code
-- is careful, but because the row cannot be written.
CREATE UNIQUE INDEX payments_one_succeeded_per_order_idx
  ON payments (order_id) WHERE status = 'succeeded';

-- ★ At most one LIVE attempt per order (D3 = B).
--
-- A customer cannot have several provider sessions open for one order, which
-- is what makes a double charge hard to reach rather than merely unlikely. A
-- new attempt is possible only once the current one is terminal — including
-- when it timed out, which the application settles before inserting.
CREATE UNIQUE INDEX payments_one_live_per_order_idx
  ON payments (order_id) WHERE status IN ('pending', 'processing');

-- The reconciler (P6-5) asks for non-terminal attempts by age.
CREATE INDEX payments_status_created_idx ON payments (status, created_at);
-- Reading an order's attempts, newest first.
CREATE INDEX payments_order_created_idx ON payments (order_id, created_at DESC);

CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

/**
 * A payment attempt is a historical record.
 *
 * What it is for — which order, which market, which currency, how much, under
 * which idempotency key, and until when — is fixed when it is created. Only
 * its outcome may move.
 *
 * `provider_reference` is the one exception, and it may be set exactly once:
 * it does not exist until the provider has answered, and once it does it
 * identifies this attempt for the rest of its life. Allowing it to change
 * would let one attempt quietly become another.
 *
 * The status machine is enforced here too, for the same reason orders' is
 * (D4 = C): an attempt's outcome decides whether a customer was charged, and
 * `succeeded` must not become anything else.
 */
CREATE FUNCTION hv_payments_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.id, NEW.order_id, NEW.market_id, NEW.provider, NEW.amount_minor, NEW.currency,
         NEW.idempotency_key, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.order_id, OLD.market_id, OLD.provider, OLD.amount_minor, OLD.currency,
         OLD.idempotency_key, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'a payment attempt is fixed when it is created'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_snapshot_immutable';
  END IF;

  IF OLD.provider_reference IS NOT NULL
     AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
    RAISE EXCEPTION 'a payment attempt keeps the provider reference it was given'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_reference_set_once';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       OLD.status IN ('pending', 'processing')
       AND NEW.status IN ('processing', 'succeeded', 'failed', 'expired')
       AND NOT (OLD.status = 'processing' AND NEW.status = 'processing')
     ) THEN
    RAISE EXCEPTION 'payment status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_status_transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_guard
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION hv_payments_guard();

-- Payments are financial records. The application creates them and moves their
-- status; it does not erase them.
REVOKE DELETE, TRUNCATE ON payments FROM hv_app;

COMMENT ON TABLE payments IS
  'One attempt to pay an order through a provider (B10, B18). At most one live and at most one succeeded per order, both structurally. Nothing here marks an order paid.';
COMMENT ON COLUMN payments.amount_minor IS
  'Equal to orders.external_due_minor by foreign key, not by copy: the client never contributes an amount (I4, I5).';
COMMENT ON COLUMN payments.expires_at IS
  'When this attempt stops being usable (D3a): min(created_at + 120s, orders.expires_at). The order deadline always wins.';
COMMENT ON COLUMN payments.provider_reference IS
  'The provider''s identifier for this attempt. NULL until the provider answers, then fixed. Never shown to a customer.';

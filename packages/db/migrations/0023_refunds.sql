-- 0023_refunds
--
-- Money going back (Phase 6, task P6-4; Revision 2 B18; owner decisions D15a,
-- D15b, D21, D22.3 and D23 in docs/PHASE_6_SCOPE_LOCK.md).
--
-- WHY THIS ARRIVES IN P6-4 RATHER THAN P6-6
--
-- The scope lock reserved this table for P6-6. D21, D22.3 and D23 then locked
-- three outcomes that all require a refund at the moment finalisation decides
-- them, so the table has to exist a slice earlier. Nothing about its shape is
-- new: it is B18's, with D15a and D15b already applied. P6-6 keeps refund
-- EXECUTION and the wider O7 policy; this is the record.
--
-- WHAT A ROW MEANS
--
-- A row is a decision that money must go back, taken inside the transaction
-- that caused it. It is not proof the money HAS gone back — that is `status`,
-- and only a provider can move it there.
--
--   raised     -> the system decided, transactionally, with the change that
--                 caused it. Always the starting state in Phase 6.
--   succeeded  -> the provider confirmed it.
--   failed     -> the provider refused. The row stays; nothing is silently
--                 dropped.
--
-- ★ `idempotency_key UNIQUE` is what makes a refund happen once. Every caller
-- derives it deterministically from the authoritative identity of the thing
-- being refunded — an order for an unfulfillable outcome, a provider event for
-- a duplicate capture — so a webhook delivered ten times, or a reconciliation
-- action invoked twice, claims the same key and writes one row. The provider's
-- own `refund()` is idempotent on the same key (B10), so one row means one
-- refund even if the call is attempted again.
--
-- Phase 6 writes only full refunds to the original instrument. The amount is
-- deliberately NOT tied to the order's total by a foreign key the way
-- `payments.amount_minor` is: P10 adds partial refunds, and a constraint that
-- had to be dropped to allow them would be a worse record than a test that
-- asserts what this phase actually writes.

CREATE TABLE refunds (
  id                        uuid        PRIMARY KEY DEFAULT uuidv7(),

  order_id                  uuid        NOT NULL,
  market_id                 uuid        NOT NULL,
  -- The payment whose instrument the money goes back to. Nullable in B18's
  -- shape for refunds with no originating payment; Phase 6 always sets it,
  -- because "the original instrument" has no meaning without it (D15a).
  payment_id                uuid        REFERENCES payments (id),

  provider                  text        NOT NULL,
  -- The provider's own identifier for the refund. NULL until it answers.
  provider_refund_reference text,

  amount_minor              bigint      NOT NULL,
  currency                  text        NOT NULL,

  -- D15a: Phase 6 writes only 'provider'. 'wallet' exists in the shape for P7
  -- and is unreachable until a wallet does.
  destination               text        NOT NULL DEFAULT 'provider',
  status                    text        NOT NULL DEFAULT 'raised',
  -- Why this refund exists, as a short code. Not free prose: it is read by
  -- support and counted in reports.
  reason                    text        NOT NULL,
  -- D15b: NULL means the system raised it with no human involved, which is
  -- every refund Phase 6 writes. P10's staff-initiated refunds set it.
  actor_id                  uuid        REFERENCES users (id),

  idempotency_key           text        NOT NULL,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- ★ One refund per decision, whatever asks for it and however often.
  CONSTRAINT refunds_idempotency_key_key UNIQUE (idempotency_key),
  -- B18: a provider's refund reference is unique to that provider.
  CONSTRAINT refunds_provider_reference_key UNIQUE (provider, provider_refund_reference),

  -- A refund cannot belong to an order from another market, and trades in the
  -- market's currency like everything else that is priced or paid.
  CONSTRAINT refunds_order_market_fkey
    FOREIGN KEY (order_id, market_id) REFERENCES orders (id, market_id),
  CONSTRAINT refunds_market_currency_fkey
    FOREIGN KEY (market_id, currency) REFERENCES markets (id, currency),

  CONSTRAINT refunds_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT refunds_destination_valid CHECK (destination IN ('provider', 'wallet')),
  CONSTRAINT refunds_status_valid CHECK (status IN ('raised', 'succeeded', 'failed')),
  CONSTRAINT refunds_reason_present CHECK (char_length(btrim(reason)) > 0),
  CONSTRAINT refunds_provider_present CHECK (char_length(btrim(provider)) > 0),
  CONSTRAINT refunds_idempotency_key_format CHECK (
    idempotency_key = btrim(idempotency_key) AND char_length(idempotency_key) BETWEEN 8 AND 255
  )
);

CREATE INDEX refunds_order_created_idx ON refunds (order_id, created_at DESC);
-- What a retry or an operator report reads: refunds the provider has not yet
-- confirmed.
CREATE INDEX refunds_unsettled_idx ON refunds (created_at) WHERE status = 'raised';

CREATE TRIGGER refunds_set_updated_at
  BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

/**
 * A refund is a financial record.
 *
 * What it is for — which order, which payment, how much, in which currency,
 * where it goes, why, and under which idempotency key — is fixed when it is
 * raised. Rewriting any of that would turn the record of a decision into a
 * record of whatever somebody last thought.
 *
 * `status` moves once, out of `raised`. A provider that answers twice cannot
 * flip a refund between outcomes, and a failed refund is not quietly retried
 * into a success on the same row — a new decision needs a new key.
 *
 * `provider_refund_reference` is set once, from NULL, when the provider names
 * it. `actor_id` never changes: who raised a refund is part of what it is.
 */
CREATE FUNCTION hv_refunds_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.id, NEW.order_id, NEW.market_id, NEW.payment_id, NEW.provider,
         NEW.amount_minor, NEW.currency, NEW.destination, NEW.reason,
         NEW.actor_id, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.order_id, OLD.market_id, OLD.payment_id, OLD.provider,
         OLD.amount_minor, OLD.currency, OLD.destination, OLD.reason,
         OLD.actor_id, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'a refund is fixed when it is raised'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_snapshot_immutable';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'raised' AND NEW.status IN ('succeeded', 'failed')) THEN
    RAISE EXCEPTION 'refund status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_status_transition';
  END IF;

  IF OLD.provider_refund_reference IS NOT NULL
     AND NEW.provider_refund_reference IS DISTINCT FROM OLD.provider_refund_reference THEN
    RAISE EXCEPTION 'a refund keeps the reference the provider gave it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_reference_set_once';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER refunds_guard
  BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION hv_refunds_guard();

-- Refunds are financial records. The application raises them and records what
-- the provider said; it does not erase them.
REVOKE DELETE, TRUNCATE ON refunds FROM hv_app;

COMMENT ON TABLE refunds IS
  'A decision that money must go back (B18). Raised inside the transaction that caused it; idempotency_key UNIQUE is what makes it happen once. A row is not proof the money moved — status is.';
COMMENT ON COLUMN refunds.idempotency_key IS
  'Derived deterministically from what is being refunded (an order, or a provider event), so a repeated webhook or reconciliation action writes one row and the provider issues one refund.';
COMMENT ON COLUMN refunds.destination IS
  'Where the money goes. Phase 6 writes only ''provider'' — back to the instrument it came from (D15a).';
COMMENT ON COLUMN refunds.actor_id IS
  'NULL for a refund the system raised with no human involved, which is every refund Phase 6 writes (D15b).';

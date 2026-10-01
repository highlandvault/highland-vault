-- 0019_order_payment_deadline
--
-- The order payment deadline, and the order state machine (Phase 6, task
-- P6-2; owner decisions D1 = B, D1a, D1b and D4 = C in docs/PHASE_6_SCOPE_LOCK.md).
--
-- WHAT THE DEADLINE IS
--
-- An order gets its own authoritative, immutable deadline for paying. It is
-- deliberately NOT the reservation TTL and must never be derived from it by
-- accident: the hold decides whether the tickets are still ours, and the
-- deadline decides whether the customer may still pay. They are different
-- questions with different answers.
--
--   orders.expires_at = min(created_at + 600s, min(reservation.expires_at) - 90s)
--
-- The 90 seconds is the locked safety margin (D1a). With it, the hold always
-- outlives the deadline, so a customer who pays inside their window still has
-- their tickets — and the margin is exactly how much provider lag is absorbed
-- before a confirmation arrives too late to fulfil.
--
-- The first term never binds in practice. `reservations_ttl_valid` (0009) caps
-- a hold at ten minutes from its own creation, and an order is always created
-- after that, so `created_at + 600s` is always the later of the two. It is
-- kept because it states the intended window, and because a future change to
-- either value should not silently produce a deadline with no upper bound.
--
-- This arithmetic is a dependency, not a detail. `hv_expire_reservations` is
-- deliberately left alone (D11a = B) precisely because the margin guarantees a
-- hold whose order is still payable is never due for sweeping. If the rule
-- above ever changes, that decision has to be revisited with it.
--
-- EXISTING ORDERS
--
-- The column is NOT NULL, so orders written before Phase 6 need a value.
-- Rather than invent one, the rule above is applied retroactively: reservations
-- are never deleted (0009 revokes DELETE), so every historical order can still
-- be asked when its holds expired. All of them are long past whatever this
-- produces, which is the truthful outcome.
--
-- One clamp is needed. Before this migration nothing stopped an order being
-- created in the last ninety seconds of its hold, so the subtraction can land
-- at or before `created_at`. Those rows are pinned one second after creation:
-- already expired, which is exactly what they are.

ALTER TABLE orders ADD COLUMN expires_at timestamptz;

UPDATE orders o
   SET expires_at = GREATEST(
         o.created_at + interval '1 second',
         LEAST(
           o.created_at + interval '600 seconds',
           COALESCE(
             (SELECT min(r.expires_at)
                FROM order_items oi
                JOIN reservations r ON r.id = oi.reservation_id
               WHERE oi.order_id = o.id),
             -- An order with no lines cannot exist (order_items is written in
             -- the same transaction), but NOT NULL does not take "cannot" for
             -- an answer.
             o.created_at + interval '600 seconds'
           ) - interval '90 seconds'
         )
       )
 WHERE expires_at IS NULL;

ALTER TABLE orders
  ALTER COLUMN expires_at SET NOT NULL,
  ADD CONSTRAINT orders_expires_after_created CHECK (expires_at > created_at);

COMMENT ON COLUMN orders.expires_at IS
  'The payment deadline (D1 = B): min(created_at + 600s, earliest reservation expiry - 90s). Immutable. Not the reservation TTL, and never to be derived from it.';

-- The target for the amount foreign key that `payments` carries (0020).
--
-- `id` is already unique, so this places no new restriction on orders. It
-- exists so another table can point at an order AND the amount payable on it
-- in a single constraint, the way `orders_id_market_key` (0016) lets a line
-- point at an order and its market together. It is what makes "a payment is
-- for the order's own amount" a fact about the schema rather than a habit of
-- the code.
ALTER TABLE orders
  ADD CONSTRAINT orders_id_currency_due_key UNIQUE (id, currency, external_due_minor);

-- The sweep that will move a lapsed order to `expired` (P6-5) reads exactly
-- this. Partial, because no other status is ever due.
CREATE INDEX orders_awaiting_expiry_idx
  ON orders (expires_at) WHERE status = 'awaiting_payment';

/**
 * The order snapshot, now including the deadline.
 *
 * Replaces the 0016 guard by adding `expires_at` to the frozen set. An order's
 * payment window is part of what was agreed when it was placed: extending it
 * afterwards would hand tickets to someone whose hold had already gone, and
 * shortening it would take back time the customer was promised.
 *
 * Applied migrations are never edited (DEVELOPMENT_RULES §3), so this replaces
 * the function rather than changing 0016.
 */
CREATE OR REPLACE FUNCTION hv_orders_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.id, NEW.order_number, NEW.market_id, NEW.currency, NEW.user_id, NEW.guest_email,
         NEW.terms_version_id, NEW.total_minor, NEW.external_due_minor,
         NEW.idempotency_key, NEW.idempotency_digest, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.order_number, OLD.market_id, OLD.currency, OLD.user_id, OLD.guest_email,
         OLD.terms_version_id, OLD.total_minor, OLD.external_due_minor,
         OLD.idempotency_key, OLD.idempotency_digest, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'an order''s terms are fixed when it is placed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_snapshot_immutable';
  END IF;
  RETURN NEW;
END;
$$;

/**
 * The order state machine, in the database (D4 = C).
 *
 * `draws`, `reservations` and `tickets` each enforce their own transitions in
 * a trigger. Orders did not, because Phase 5 only ever wrote one value; Phase 6
 * introduces every transition there is, and this is the one state machine that
 * decides whether money was taken and tickets were sold.
 *
 * The application performs conditional updates and produces the customer-facing
 * refusals. This is the backstop underneath: it holds whatever wrote the row,
 * including raw SQL and a future code path that forgets. An order cannot be
 * un-sold here.
 *
 * What is permitted here is B7's machine for the status Phase 6 owns, which is
 * not the same list as the transitions Phase 6 writes code for. Phase 6
 * implements `paid`, `paid_unfulfillable`, `failed` and `expired`; B7 also
 * allows an order awaiting payment to be cancelled, and a guard that refused
 * that would be narrowing the specification rather than enforcing it.
 *
 * Transitions out of the other statuses belong to later phases, and each adds
 * its own in its own migration:
 *
 *   P7  wallet-only orders, `created -> paid` in the checkout transaction
 *   P10 refunds, `paid -> partially_refunded | refunded`
 *       and `paid_unfulfillable -> refunded`
 *
 * Note what is absent: no transition leaves `paid`, `failed`, `expired`,
 * `cancelled` or `refunded`. Terminal means terminal, and a late provider
 * event arriving after an outcome cannot reopen it.
 */
CREATE FUNCTION hv_orders_status_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    OLD.status = 'awaiting_payment'
    AND NEW.status IN ('paid', 'paid_unfulfillable', 'failed', 'expired', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'order status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_status_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_status_guard
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION hv_orders_status_guard();

COMMENT ON FUNCTION hv_orders_status_guard() IS
  'The B7 order state machine for the status Phase 6 owns: awaiting_payment -> paid | paid_unfulfillable | failed | expired | cancelled. Later phases add transitions out of created, paid and paid_unfulfillable; no transition ever leaves a terminal state.';

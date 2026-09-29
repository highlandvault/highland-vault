-- 0024_expired_order_unfulfillable
--
-- An expired order can become paid-and-unfulfillable (Phase 6, task P6-4;
-- owner decision D23 in docs/PHASE_6_SCOPE_LOCK.md).
--
-- THE EXACT INVARIANT BEING CHANGED
--
-- `hv_orders_status_guard` (0019) permitted transitions only out of
-- `awaiting_payment`, and treated `expired` as terminal:
--
--     awaiting_payment -> paid | paid_unfulfillable | failed | expired | cancelled
--
-- That was right when the only thing that could move an order was a customer
-- paying inside their window. D23 settles the case where a provider confirms a
-- payment AFTER the deadline has passed and the holds have gone: the money is
-- real, nothing can be delivered, and the order has to say so rather than
-- stand as a record that the customer never paid.
--
-- So exactly one transition is added:
--
--     expired -> paid_unfulfillable
--
-- and nothing else. In particular `expired` does not become a general starting
-- point: it still cannot reach `paid`, because by definition the tickets are
-- gone, and it still cannot reach `failed` or `cancelled`.
--
-- WHY THIS IS NOT A WEAKENING
--
-- `expired` stops being terminal, which is a real loss of strictness, and it
-- buys something worth more: an order that took a customer's money can no
-- longer be left asserting the opposite. The refund that follows is raised in
-- the same transaction as this transition, so an order in
-- `paid_unfulfillable` always has a refund record behind it.
--
-- The other direction is still refused. Nothing may leave `paid`,
-- `paid_unfulfillable`, `failed`, `cancelled` or `refunded`, so a late
-- provider event cannot reopen an outcome, and P10 still adds its own refund
-- transitions in its own migration.
--
-- Applied migrations are never edited (DEVELOPMENT_RULES §3), so this replaces
-- the function rather than changing 0019.

CREATE OR REPLACE FUNCTION hv_orders_status_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'awaiting_payment'
     AND NEW.status IN ('paid', 'paid_unfulfillable', 'failed', 'expired', 'cancelled'))
    -- D23: a payment confirmed after the deadline. The money is real and
    -- nothing can be delivered, so the order records that instead of standing
    -- as a record of a customer who never paid.
    OR (OLD.status = 'expired' AND NEW.status = 'paid_unfulfillable')
  ) THEN
    RAISE EXCEPTION 'order status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_status_transition';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION hv_orders_status_guard() IS
  'The B7 order state machine as Phase 6 uses it: awaiting_payment -> paid | paid_unfulfillable | failed | expired | cancelled, and since 0024 expired -> paid_unfulfillable for a payment confirmed after the deadline (D23). Nothing leaves paid, paid_unfulfillable, failed, cancelled or refunded; later phases add their own transitions.';

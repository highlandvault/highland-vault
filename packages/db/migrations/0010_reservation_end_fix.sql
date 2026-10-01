-- 0010_reservation_end_fix
--
-- Structural correction to hv_end_reservation (Phase 4 review finding NB-1).
--
-- Migration 0009 frees a reservation's tickets with
--
--   UPDATE tickets SET status = 'available', reservation_id = NULL
--    WHERE reservation_id = r.id AND status = 'reserved';
--
-- which correctly leaves sold tickets alone, and then gives the entrant's cap
-- allowance back with
--
--   UPDATE draw_entrant_counts SET count = count - r.quantity
--
-- The two disagree as soon as a reservation holds anything that is not
-- 'reserved'. A reservation that holds a sold ticket and then expires or is
-- released would free fewer tickets than its quantity but still return the
-- whole quantity of allowance: the entrant keeps the sold ticket AND gets
-- their cap back, which is a cap bypass.
--
-- Nothing in Phase 4 or Phase 5 can reach this: no code sets a ticket to
-- 'sold'. Phase 6 introduces reserved -> sold, so the invariant is made
-- structural here, before anything depends on it. The allowance returned is
-- now the number of ticket rows this call actually moved back to 'available',
-- taken from the statement's own row count, so it cannot drift from what the
-- UPDATE did.
--
-- Unchanged on purpose:
--   * the signature and return value (callers and the public API are untouched);
--   * idempotency — ending is still conditional on status = 'active' and a
--     second call still returns false and changes nothing;
--   * statement order (reservation, then tickets, then counter), so the lock
--     ordering the Phase 4 concurrency tests rely on is exactly as it was.
--
-- Applied migrations are never edited (DEVELOPMENT_RULES §3), so this replaces
-- the function in a new migration rather than changing 0009.

CREATE OR REPLACE FUNCTION hv_end_reservation(p_reservation_id uuid, p_status text) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  r      reservations%ROWTYPE;
  freed  integer;
BEGIN
  IF p_status NOT IN ('released', 'expired') THEN
    RAISE EXCEPTION 'a reservation ends as released or expired, not %', p_status;
  END IF;
  UPDATE reservations SET status = p_status, ended_at = now()
   WHERE id = p_reservation_id AND status = 'active'
  RETURNING * INTO r;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE tickets SET status = 'available', reservation_id = NULL
   WHERE reservation_id = r.id AND status = 'reserved';
  GET DIAGNOSTICS freed = ROW_COUNT;

  -- Give back exactly what was freed. A reservation whose tickets have been
  -- sold frees nothing and returns no allowance: sold tickets keep counting
  -- against the entrant's cap.
  IF freed > 0 THEN
    UPDATE draw_entrant_counts SET count = count - freed
     WHERE draw_id = r.draw_id AND entrant_type = r.entrant_type AND entrant_ref = r.entrant_ref;
  END IF;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION hv_end_reservation(uuid, text) IS
  'Ends an active reservation exactly once. Frees its reserved tickets and returns the cap allowance for those tickets only — never for tickets that are already sold (NB-1, migration 0010).';

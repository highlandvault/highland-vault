-- 0022_sale_requires_live_hold
--
-- The database refuses to sell a ticket from a hold that is no longer live
-- (Phase 6, task P6-4; owner decision D10 = B in docs/PHASE_6_SCOPE_LOCK.md).
--
-- WHAT WAS WRONG
--
-- `hv_tickets_guard` (0009) permits `reserved -> sold` whenever the ticket
-- keeps the same reservation, and checks that a reservation is `active` and
-- unexpired only when a ticket is being RESERVED:
--
--     IF NEW.status = 'reserved' AND NOT EXISTS (… r.status = 'active' AND r.expires_at > now())
--
-- Nothing in Phases 1 to 5 could reach the gap, because nothing sold a ticket.
-- Phase 6 does, and the gap matters: expiry is logical, not physical. A hold is
-- expired the instant `expires_at` passes, but the row still says `active`
-- until a sweep collects it — up to thirty seconds later, longer if the worker
-- is behind. In that window the database would have allowed a sale from a hold
-- the system considers dead, and those same ticket numbers are freed moments
-- afterwards and sold again to somebody else. Two customers, one ticket.
--
-- WHY IT IS FIXED HERE RATHER THAN ONLY IN THE APPLICATION
--
-- Finalisation checks this itself, under `FOR UPDATE`, and that is where the
-- business decision belongs. This is the backstop underneath it (D10 = B): it
-- holds whatever wrote the row, including hand-written SQL and a future code
-- path that forgets, and it is the difference between an invariant and a habit.
--
-- WHAT THIS DOES NOT CHANGE
--
--   * `reserved -> available` is untouched, so the expiry sweep and
--     `hv_end_reservation` behave exactly as before — including the case that
--     matters most, a sweep freeing the tickets of a hold it has just marked
--     expired;
--   * allocation is untouched: the `reserved` rule is the same rule, under the
--     same constraint name, so every Phase 4 test that asserts on it still
--     asserts on it;
--   * `hv_end_reservation` is untouched (D9 = A). Closing a hold whose tickets
--     are already sold frees nothing, because its UPDATE looks for `reserved`
--     rows, so this guard is never consulted on that path.
--
-- The order of operations in finalisation follows from this and is not
-- stylistic: sell the tickets while the hold is still live, and only then close
-- it. Closing first would make the sale fail here.
--
-- Applied migrations are never edited (DEVELOPMENT_RULES §3), so this replaces
-- the function rather than changing 0009.

CREATE OR REPLACE FUNCTION hv_tickets_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'available' THEN
      RAISE EXCEPTION 'tickets are created available'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'tickets_created_available';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.draw_id <> OLD.draw_id OR NEW.ticket_number <> OLD.ticket_number THEN
    RAISE EXCEPTION 'ticket % identity is immutable', OLD.ticket_number
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tickets_identity_immutable';
  END IF;
  IF ROW(NEW.status, NEW.reservation_id) IS NOT DISTINCT FROM ROW(OLD.status, OLD.reservation_id) THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'available' AND NEW.status = 'reserved')
    OR (OLD.status = 'reserved' AND NEW.status = 'available')
    OR (OLD.status = 'reserved' AND NEW.status = 'sold' AND NEW.reservation_id = OLD.reservation_id)
  ) THEN
    RAISE EXCEPTION 'ticket % cannot change from % to %', OLD.ticket_number, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tickets_status_transition';
  END IF;
  -- Only an active, unexpired reservation may take a ticket.
  IF NEW.status = 'reserved' AND NOT EXISTS (
       SELECT 1 FROM reservations r
        WHERE r.id = NEW.reservation_id AND r.status = 'active' AND r.expires_at > now()
     ) THEN
    RAISE EXCEPTION 'ticket % can only be reserved by an active reservation', OLD.ticket_number
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tickets_reservation_active';
  END IF;
  -- And only an active, unexpired reservation may sell one (D10 = B).
  --
  -- Its own rule and its own constraint name, rather than a wider version of
  -- the one above: a refusal should say whether a hold could not TAKE a ticket
  -- or could not SELL one, because the two happen in different places and mean
  -- different things.
  --
  -- `now()` is transaction_timestamp(), so this and the caller's own check see
  -- the same instant inside one transaction. A sale cannot slip through because
  -- the clock moved between them.
  IF NEW.status = 'sold' AND NOT EXISTS (
       SELECT 1 FROM reservations r
        WHERE r.id = NEW.reservation_id AND r.status = 'active' AND r.expires_at > now()
     ) THEN
    RAISE EXCEPTION 'ticket % can only be sold by a live reservation', OLD.ticket_number
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tickets_sale_reservation_live';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION hv_tickets_guard() IS
  'Ticket identity and state machine. Since 0022 a sale, like a reservation, requires the hold to be active and unexpired (D10 = B): expiry is logical, so a hold can be dead while its row still says active, and the database refuses the sale independently of whatever the application checked.';

-- 0017_entrant_rekey
--
-- Guest → account ticket-cap bridging (Phase 5, task P5-8; ADR-0008,
-- ADR-0021).
--
-- ADR-0021: when a guest later registers with the address they verified,
-- their email-keyed cap counters are merged into the user key in one
-- transaction. Without it, someone buys up to the cap as a guest and then
-- again as the account with the same address.
--
-- WHY THIS MIGRATION EXISTS AT ALL. Merging the counters is not enough on its
-- own, because `hv_end_reservation` (0010) gives the allowance back using the
-- key stored ON THE RESERVATION:
--
--     UPDATE draw_entrant_counts SET count = count - freed
--      WHERE draw_id = r.draw_id AND entrant_type = r.entrant_type
--        AND entrant_ref = r.entrant_ref;
--
-- Move the counts and leave the reservation saying 'email', and that UPDATE
-- matches ZERO rows — silently. The tickets come back but the allowance never
-- does, and the merged counter is inflated for ever. That is NB-1 in reverse,
-- and it is exactly the class of bug 0010 was written to make impossible.
--
-- So the live reservations have to move with their counter, which means
-- relaxing the immutability `hv_reservations_guard` (0009) placed on the
-- entrant columns. THIS IS THE ONLY REASON THIS MIGRATION EXISTS, and the
-- relaxation is deliberately as narrow as the rule it replaces:
--
--   * only 'email' → 'user', never the reverse and never user → user;
--   * only onto a real account (`user_id` NOT NULL);
--   * `entrant_ref` must become exactly that account's id;
--   * every other column stays immutable, as before.
--
-- A reservation still cannot change draw, market, currency, quantity, price,
-- expiry or creation time, and its status transitions are untouched.

CREATE OR REPLACE FUNCTION hv_reservations_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  d       record;
  rekeyed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'a reservation is created active'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_created_active';
    END IF;
    SELECT dr.status, dr.opens_at, dr.closes_at, dr.ticket_price_minor, m.is_enabled
      INTO d
      FROM draws dr JOIN markets m ON m.id = dr.market_id
     WHERE dr.id = NEW.draw_id;
    IF NOT (d.status IN ('scheduled', 'live') AND d.opens_at <= now() AND d.closes_at > now()) THEN
      RAISE EXCEPTION 'draw is not open for entries'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_draw_open';
    END IF;
    IF NOT d.is_enabled THEN
      RAISE EXCEPTION 'market is not enabled'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_market_enabled';
    END IF;
    IF NEW.unit_price_minor <> d.ticket_price_minor THEN
      RAISE EXCEPTION 'reservation price must be the draw''s ticket price'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_price_snapshot';
    END IF;
    RETURN NEW;
  END IF;

  -- The one permitted change of entrant: a guest's hold becoming the account's
  -- when they register with the address they verified (ADR-0021).
  rekeyed :=
    OLD.entrant_type = 'email'
    AND NEW.entrant_type = 'user'
    AND NEW.user_id IS NOT NULL
    AND OLD.user_id IS NULL
    AND NEW.entrant_ref = NEW.user_id::text;

  -- Everything except the entrant columns is immutable, exactly as before.
  IF ROW(NEW.draw_id, NEW.market_id, NEW.currency,
         NEW.quantity, NEW.unit_price_minor, NEW.total_minor, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.draw_id, OLD.market_id, OLD.currency,
         OLD.quantity, OLD.unit_price_minor, OLD.total_minor, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'a reservation''s terms are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_immutable';
  END IF;

  -- The entrant columns are immutable too, unless this is that one re-key.
  IF NOT rekeyed
     AND ROW(NEW.entrant_type, NEW.entrant_ref, NEW.user_id)
         IS DISTINCT FROM
         ROW(OLD.entrant_type, OLD.entrant_ref, OLD.user_id) THEN
    RAISE EXCEPTION 'a reservation''s entrant can only change from a verified email to that email''s account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_entrant_rekey_only';
  END IF;

  -- A hold that has already ended is history; bridging must not touch it,
  -- because its tickets have been given back under the old key already.
  IF rekeyed AND OLD.status <> 'active' THEN
    RAISE EXCEPTION 'only an active reservation can be re-keyed to an account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_rekey_active_only';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status IN ('released', 'expired')) THEN
    RAISE EXCEPTION 'reservation status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_status_transition';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION hv_reservations_guard() IS
  'Reservation invariants (0009). Since 0017 the entrant may change once, from a verified email to that email''s account, so ADR-0021 bridging can move a live hold and its counter together.';

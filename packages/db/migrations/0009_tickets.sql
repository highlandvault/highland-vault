-- 0009_tickets
--
-- Ticket engine (ADR-0011, ADR-0027, Revision 2 B9): the pre-generated ticket
-- pool, reservations and per-entrant caps.
--
-- Invariants enforced here, independently of the API:
--   1. Every published draw has exactly one pool of tickets numbered 1..N
--      (N = total_tickets), created in the same transaction as the publish
--      (O15: sequential numbers). UNIQUE (draw_id, ticket_number).
--   2. Ticket states: available → reserved → sold, and reserved → available
--      (expiry or release). A sold ticket never changes here (refunds are a
--      later phase). "sold" is the specification's name for "purchased".
--   3. A ticket is held by at most one reservation, and only by a reservation
--      of the same draw (composite FK), which is active while it holds it.
--   4. A reservation belongs to exactly one draw and so to exactly one market;
--      its currency is the market's; it snapshots the draw's ticket price and
--      stores the exact total (unit × quantity) in integer minor units.
--   5. Reservations last at most 10 minutes (D11) and end exactly once
--      (active → released | expired).
--   6. An entrant never holds more tickets in a draw than the draw's cap:
--      draw_entrant_counts.count ≤ max_per_person.
--   7. New reservations only for an open draw (published, opening time
--      reached, not closed) in an enabled market.
--
-- Orders and payment (Phase 5/6) will turn reservations into purchases; the
-- reserved → sold transition exists for them but nothing in this phase uses it.

-- Engineering safeguard: a pool is generated in one statement at publish.
ALTER TABLE draws
  ADD CONSTRAINT draws_total_tickets_max CHECK (total_tickets <= 1000000);

CREATE TABLE reservations (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  draw_id          uuid        NOT NULL,
  market_id        uuid        NOT NULL,
  currency         text        NOT NULL,
  -- Cap identity (ADR-0008): 'user' → user id; 'email' → normalized verified email.
  entrant_type     text        NOT NULL,
  entrant_ref      text        NOT NULL,
  user_id          uuid        REFERENCES users (id),
  quantity         integer     NOT NULL,
  unit_price_minor bigint      NOT NULL,
  total_minor      bigint      NOT NULL,
  status           text        NOT NULL DEFAULT 'active',
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,

  CONSTRAINT reservations_draw_market_fkey
    FOREIGN KEY (draw_id, market_id) REFERENCES draws (id, market_id),
  CONSTRAINT reservations_market_currency_fkey
    FOREIGN KEY (market_id, currency) REFERENCES markets (id, currency),
  CONSTRAINT reservations_id_draw_key UNIQUE (id, draw_id),

  CONSTRAINT reservations_status_valid CHECK (status IN ('active', 'released', 'expired')),
  CONSTRAINT reservations_ended_consistent CHECK ((status = 'active') = (ended_at IS NULL)),
  CONSTRAINT reservations_quantity_positive CHECK (quantity > 0),
  CONSTRAINT reservations_unit_price_positive CHECK (unit_price_minor > 0),
  CONSTRAINT reservations_total_exact CHECK (total_minor = unit_price_minor * quantity),
  CONSTRAINT reservations_entrant_type_valid CHECK (entrant_type IN ('user', 'email')),
  CONSTRAINT reservations_user_entrant_consistent CHECK (
    (entrant_type = 'user') = (user_id IS NOT NULL)
    AND (entrant_type <> 'user' OR entrant_ref = user_id::text)
  ),
  CONSTRAINT reservations_email_entrant_normalized CHECK (
    entrant_type <> 'email' OR (entrant_ref = lower(btrim(entrant_ref)) AND entrant_ref LIKE '%@%')
  ),
  CONSTRAINT reservations_ttl_valid CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
  )
);

CREATE INDEX reservations_active_expiry_idx ON reservations (expires_at) WHERE status = 'active';
CREATE INDEX reservations_draw_active_idx ON reservations (draw_id, expires_at) WHERE status = 'active';
CREATE INDEX reservations_user_idx ON reservations (user_id, created_at) WHERE user_id IS NOT NULL;

CREATE TABLE tickets (
  -- Internal key only; customers see (draw, ticket_number).
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draw_id        uuid        NOT NULL REFERENCES draws (id),
  ticket_number  integer     NOT NULL,
  status         text        NOT NULL DEFAULT 'available',
  reservation_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tickets_draw_number_key UNIQUE (draw_id, ticket_number),
  CONSTRAINT tickets_reservation_same_draw_fkey
    FOREIGN KEY (reservation_id, draw_id) REFERENCES reservations (id, draw_id),
  CONSTRAINT tickets_number_positive CHECK (ticket_number > 0),
  CONSTRAINT tickets_status_valid CHECK (status IN ('available', 'reserved', 'sold')),
  CONSTRAINT tickets_holder_consistent CHECK ((status = 'available') = (reservation_id IS NULL))
);

-- Allocation: lowest available numbers of one draw (ADR-0027).
CREATE INDEX tickets_available_idx ON tickets (draw_id, ticket_number) WHERE status = 'available';
CREATE INDEX tickets_reservation_idx ON tickets (reservation_id) WHERE reservation_id IS NOT NULL;

CREATE TABLE draw_entrant_counts (
  draw_id      uuid    NOT NULL REFERENCES draws (id),
  entrant_type text    NOT NULL,
  entrant_ref  text    NOT NULL,
  -- Tickets this entrant currently holds in the draw (reserved or sold).
  count        integer NOT NULL DEFAULT 0,

  PRIMARY KEY (draw_id, entrant_type, entrant_ref),
  CONSTRAINT draw_entrant_counts_type_valid CHECK (entrant_type IN ('user', 'email')),
  CONSTRAINT draw_entrant_counts_non_negative CHECK (count >= 0)
);

-- ---------------------------------------------------------------- guards

CREATE FUNCTION hv_reservations_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  d record;
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

  IF ROW(NEW.draw_id, NEW.market_id, NEW.currency, NEW.entrant_type, NEW.entrant_ref, NEW.user_id,
         NEW.quantity, NEW.unit_price_minor, NEW.total_minor, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.draw_id, OLD.market_id, OLD.currency, OLD.entrant_type, OLD.entrant_ref, OLD.user_id,
         OLD.quantity, OLD.unit_price_minor, OLD.total_minor, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'a reservation''s terms are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status IN ('released', 'expired')) THEN
    RAISE EXCEPTION 'reservation status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_status_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservations_guard
  BEFORE INSERT OR UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION hv_reservations_guard();

CREATE FUNCTION hv_tickets_guard() RETURNS trigger
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER tickets_guard
  BEFORE INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION hv_tickets_guard();

CREATE TRIGGER tickets_set_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

-- The cap, as a final net under the application's check.
CREATE FUNCTION hv_draw_entrant_counts_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cap integer;
BEGIN
  SELECT max_per_person INTO cap FROM draws WHERE id = NEW.draw_id;
  IF NEW.count > cap THEN
    RAISE EXCEPTION 'entrant would hold % tickets; the cap is %', NEW.count, cap
      USING ERRCODE = 'check_violation', CONSTRAINT = 'draw_entrant_counts_cap';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER draw_entrant_counts_guard
  BEFORE INSERT OR UPDATE ON draw_entrant_counts
  FOR EACH ROW EXECUTE FUNCTION hv_draw_entrant_counts_guard();

-- ----------------------------------------------------------- ticket pool

-- Creates tickets 1..total_tickets for a draw that has none (ADR-0027).
CREATE FUNCTION hv_generate_ticket_pool(p_draw_id uuid) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  created integer;
BEGIN
  INSERT INTO tickets (draw_id, ticket_number)
  SELECT d.id, n
    FROM draws d, generate_series(1, d.total_tickets) AS n
   WHERE d.id = p_draw_id
     AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.draw_id = d.id);
  GET DIAGNOSTICS created = ROW_COUNT;
  RETURN created;
END;
$$;

-- Publishing a draw creates its pool in the same transaction, whatever the
-- publish path. total_tickets is frozen from then on (hv_draws_guard).
CREATE FUNCTION hv_draws_generate_pool() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM hv_generate_ticket_pool(NEW.id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER draws_generate_pool
  AFTER UPDATE OF status ON draws
  FOR EACH ROW
  WHEN (OLD.status = 'draft' AND NEW.status = 'scheduled')
  EXECUTE FUNCTION hv_draws_generate_pool();

-- Draws published before this migration get their pool now.
SELECT hv_generate_ticket_pool(id) FROM draws WHERE status NOT IN ('draft', 'cancelled');

-- ---------------------------------------------------- ending reservations

-- Ends one active reservation exactly once ('released' or 'expired'): its
-- tickets become available again and the entrant's count drops by its
-- quantity. Returns false (and changes nothing) if it was not active. Shared
-- by customer release, the per-draw sweep and the worker.
CREATE FUNCTION hv_end_reservation(p_reservation_id uuid, p_status text) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  r reservations%ROWTYPE;
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
  UPDATE draw_entrant_counts SET count = count - r.quantity
   WHERE draw_id = r.draw_id AND entrant_type = r.entrant_type AND entrant_ref = r.entrant_ref;
  RETURN true;
END;
$$;

-- Expires up to p_limit reservations past their expiry (optionally of one
-- draw). Safe to run concurrently and repeatedly: due reservations are locked
-- with SKIP LOCKED, so two sweepers never take the same one, and ending one is
-- conditional. Counter rows are touched in entrant order, so concurrent
-- sweepers cannot deadlock on them.
CREATE FUNCTION hv_expire_reservations(p_draw_id uuid, p_limit integer) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  due uuid;
  expired integer := 0;
BEGIN
  FOR due IN
    SELECT id FROM reservations
     WHERE status = 'active' AND expires_at <= now()
       AND (p_draw_id IS NULL OR draw_id = p_draw_id)
     ORDER BY entrant_type, entrant_ref, id
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  LOOP
    IF hv_end_reservation(due, 'expired') THEN
      expired := expired + 1;
    END IF;
  END LOOP;
  RETURN expired;
END;
$$;

-- Tickets and reservations are never deleted: they change state.
REVOKE DELETE, TRUNCATE ON tickets, reservations, draw_entrant_counts FROM hv_app;

COMMENT ON TABLE tickets IS
  'Pre-generated ticket pool, numbered 1..N per draw (ADR-0027). available → reserved → sold; reserved → available.';
COMMENT ON TABLE reservations IS
  'Holds tickets for at most 10 minutes (ADR-0011). One draw, one market, exact total in minor units.';
COMMENT ON TABLE draw_entrant_counts IS
  'Tickets held per entrant (user id or verified email) per draw; the cap is enforced on this row.';

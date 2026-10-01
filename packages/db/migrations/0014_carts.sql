-- 0014_carts
--
-- The server-side basket (Phase 5, task P5-5; Revision 2 B4 and B18, ADR-0026,
-- ADR-0031).
--
-- A basket is one market's worth of shopping. It cannot mix markets, because
-- every order is single-currency (ADR-0026), and it belongs to exactly one
-- person: a signed-in customer or a guest session, never both (ADR-0031).
--
-- A cart item does NOT copy the quantity, price or currency of what it holds.
-- A reservation already records all three, under constraints that keep them
-- consistent with the draw and the market, and a second copy could only drift
-- from the first. An item is therefore the statement "this reservation is in
-- this basket", and the money is read from the reservation.
--
-- Market isolation is structural rather than remembered. The composite foreign
-- keys below force an item's market to equal its cart's market AND its draw's
-- market, and a reservation already carries the same pair (0009), so there is
-- no arrangement of rows in which a UK basket holds an IE draw. The API
-- refuses it as well, but it could not create one even if it tried.

CREATE TABLE carts (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  market_id        uuid        NOT NULL REFERENCES markets (id),
  -- Exactly one owner (ADR-0031). Deliberately two columns rather than a
  -- single polymorphic reference, so each one keeps its own foreign key and
  -- "both at once" is unrepresentable rather than merely discouraged.
  user_id          uuid        REFERENCES users (id),
  guest_session_id uuid        REFERENCES guest_sessions (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT carts_one_owner CHECK (
    (user_id IS NOT NULL AND guest_session_id IS NULL)
    OR (user_id IS NULL AND guest_session_id IS NOT NULL)
  ),
  -- Lets cart_items carry the market and have it checked against this row.
  CONSTRAINT carts_id_market_key UNIQUE (id, market_id)
);

-- One cart per owner per market. Two partial indexes rather than one
-- constraint, because the owning column differs between the two kinds of
-- owner; the same shape as skill_question_options_one_correct in 0008.
CREATE UNIQUE INDEX carts_user_market_idx
  ON carts (user_id, market_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX carts_guest_market_idx
  ON carts (guest_session_id, market_id) WHERE guest_session_id IS NOT NULL;

CREATE TRIGGER carts_set_updated_at
  BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

CREATE TABLE cart_items (
  id             uuid        PRIMARY KEY DEFAULT uuidv7(),
  cart_id        uuid        NOT NULL,
  market_id      uuid        NOT NULL,
  draw_id        uuid        NOT NULL,
  reservation_id uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Removed from the basket. Kept rather than deleted, like every other
  -- record in this schema: hv_app cannot DELETE here either.
  removed_at     timestamptz,

  CONSTRAINT cart_items_cart_market_fkey
    FOREIGN KEY (cart_id, market_id) REFERENCES carts (id, market_id),
  CONSTRAINT cart_items_draw_market_fkey
    FOREIGN KEY (draw_id, market_id) REFERENCES draws (id, market_id),
  -- Ties the item to the reservation holding the tickets, and to that
  -- reservation's own draw (0009 guarantees the reservation's market matches).
  CONSTRAINT cart_items_reservation_draw_fkey
    FOREIGN KEY (reservation_id, draw_id) REFERENCES reservations (id, draw_id),
  -- One reservation is in at most one basket, ever.
  CONSTRAINT cart_items_reservation_key UNIQUE (reservation_id),
  CONSTRAINT cart_items_removed_after_created CHECK (
    removed_at IS NULL OR removed_at >= created_at
  )
);

-- B18's UNIQUE(cart_id, draw_id), applied to what is actually in the basket.
-- Partial, because a draw removed and added again is two rows and only the
-- live one may be unique.
CREATE UNIQUE INDEX cart_items_cart_draw_idx
  ON cart_items (cart_id, draw_id) WHERE removed_at IS NULL;
CREATE INDEX cart_items_cart_live_idx
  ON cart_items (cart_id, created_at) WHERE removed_at IS NULL;

/**
 * A basket may only hold its owner's own reservations.
 *
 * Without this, putting someone else's reservation in your basket is a single
 * INSERT. The API checks it too, but ownership of tickets is not something to
 * leave to one layer, so it is checked here against the reservation's cap
 * identity (ADR-0008): a user's cart takes 'user' reservations with the same
 * user id, and a guest's cart takes 'email' reservations whose address is the
 * one that guest session verified.
 */
CREATE FUNCTION hv_cart_items_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cart        carts%ROWTYPE;
  reservation reservations%ROWTYPE;
  guest_email citext;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a cart item is created in the basket, not already removed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'cart_items_created_present';
    END IF;

    SELECT * INTO cart FROM carts WHERE id = NEW.cart_id;
    SELECT * INTO reservation FROM reservations WHERE id = NEW.reservation_id;

    IF cart.user_id IS NOT NULL THEN
      IF reservation.entrant_type <> 'user' OR reservation.user_id IS DISTINCT FROM cart.user_id THEN
        RAISE EXCEPTION 'a basket may only hold its own owner''s reservations'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'cart_items_owner_matches_entrant';
      END IF;
    ELSE
      SELECT verified_email INTO guest_email FROM guest_sessions WHERE id = cart.guest_session_id;
      IF guest_email IS NULL
         OR reservation.entrant_type <> 'email'
         OR reservation.entrant_ref <> guest_email::text THEN
        RAISE EXCEPTION 'a basket may only hold its own owner''s reservations'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'cart_items_owner_matches_entrant';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- What the item is never changes; only whether it is still in the basket.
  IF ROW(NEW.id, NEW.cart_id, NEW.market_id, NEW.draw_id, NEW.reservation_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.cart_id, OLD.market_id, OLD.draw_id, OLD.reservation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a cart item is immutable once added'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cart_items_immutable';
  END IF;
  IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    RAISE EXCEPTION 'a cart item is removed once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cart_items_removed_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cart_items_guard
  BEFORE INSERT OR UPDATE ON cart_items
  FOR EACH ROW EXECUTE FUNCTION hv_cart_items_guard();

/** A basket's owner and market are settled when it is created. */
CREATE FUNCTION hv_carts_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.id, NEW.market_id, NEW.user_id, NEW.guest_session_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.market_id, OLD.user_id, OLD.guest_session_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a basket cannot change owner or market'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carts_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER carts_guard
  BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION hv_carts_guard();

-- Baskets are emptied by removing items, not by deleting rows.
REVOKE DELETE, TRUNCATE ON carts, cart_items FROM hv_app;

COMMENT ON TABLE carts IS
  'One market''s server-side basket, owned by exactly one signed-in customer or one guest session (ADR-0026, ADR-0031).';
COMMENT ON TABLE cart_items IS
  'A reservation held in a basket. Quantity, price and currency live on the reservation, never copied here.';

-- 0018_cart_guard_bridged_entrant
--
-- The basket ownership guard, taught about ADR-0021 bridging (Phase 5, task
-- P5-8).
--
-- `hv_cart_items_guard` (0014) checks that a basket only holds its own owner's
-- reservations, and for a guest basket it did that by requiring the
-- reservation to be keyed on the address that guest session verified:
--
--     reservation.entrant_type = 'email' AND reservation.entrant_ref = guest_email
--
-- That was exactly right when it was written. ADR-0021 changed the premise: a
-- guest whose verified address already belongs to an account now has their
-- tickets charged to that ACCOUNT from the start, so a perfectly legitimate
-- guest basket can hold a 'user'-keyed reservation. The old rule rejected it,
-- and the checkout failed with a constraint violation.
--
-- The rule is therefore widened by exactly one case, and not a step further: a
-- guest basket may also hold a reservation keyed to the account that owns the
-- address that session verified. Someone else's reservation is still refused,
-- and an account's basket is untouched.

CREATE OR REPLACE FUNCTION hv_cart_items_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cart        carts%ROWTYPE;
  reservation reservations%ROWTYPE;
  guest_email citext;
  bridged     uuid;
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
      IF guest_email IS NULL THEN
        RAISE EXCEPTION 'a basket may only hold its own owner''s reservations'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'cart_items_owner_matches_entrant';
      END IF;

      -- The account that owns the verified address, if there is one. This is
      -- what ADR-0021 charges a guest's tickets to.
      SELECT id INTO bridged FROM users WHERE email = guest_email;

      IF NOT (
        (reservation.entrant_type = 'email' AND reservation.entrant_ref = guest_email::text)
        OR (bridged IS NOT NULL
            AND reservation.entrant_type = 'user'
            AND reservation.user_id = bridged)
      ) THEN
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

COMMENT ON FUNCTION hv_cart_items_guard() IS
  'A basket holds only its own owner''s reservations (0014). Since 0018 a guest basket may also hold one keyed to the account that owns the address that session verified (ADR-0021).';

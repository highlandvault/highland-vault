-- 0016_orders
--
-- Orders and their lines (Phase 5, task P5-7; Revision 2 B7, B18 and B20,
-- ADR-0026, ADR-0030, ADR-0031).
--
-- An order is the permanent record of a checkout. The basket is working state
-- and the reservation is a hold with an expiry; neither is evidence of what
-- somebody agreed to buy, at what price, under which terms, having answered
-- which question. That is what these two tables are, which is why almost every
-- column here is a SNAPSHOT and why a guard trigger refuses to let any of them
-- change afterwards.
--
-- PHASE 5 STOPS HERE. An order is created awaiting payment; nothing in this
-- migration takes a payment, records one, or moves a ticket to `sold`. The
-- reservation stays active and its tickets stay `reserved` (ADR-0006, Option
-- A). Phase 6 adds payments, webhooks and the `reserved → sold` transition.
--
-- ON THE STATUS NAME. Revision 2 B7 gives the state machine as
-- `created → awaiting_payment → paid`, and later transitions
-- (`awaiting_payment → failed | expired`) name the same value. The Phase 5
-- planning documents describe the boundary in prose as "ends at
-- pending_payment". The specification is the authority for a persisted value
-- and Phase 6 will implement its transitions literally, so the stored status
-- is `awaiting_payment`. The two names mean the same moment.

CREATE TABLE orders (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  -- Customer-facing and opaque (ADR-0031): "HV-" then 10 base32 characters.
  -- Never the primary key, and never sequential — a sequential number leaks
  -- how many orders exist and lets a holder guess its neighbours.
  order_number         text        NOT NULL,
  market_id            uuid        NOT NULL,
  currency             text        NOT NULL,

  -- Exactly one buyer (B18). A guest is recorded by the address they verified,
  -- not by their session: the session lasts a day, the order is permanent, and
  -- the address is what the ticket cap is counted against (ADR-0008). This is
  -- deliberately different from `carts`, which points at the session.
  user_id              uuid        REFERENCES users (id),
  guest_email          citext,

  -- What the customer agreed to. NOT NULL: an order without terms is not a
  -- record of an agreement (ADR-0031).
  terms_version_id     uuid        NOT NULL,

  status               text        NOT NULL DEFAULT 'awaiting_payment',

  -- Money, in integer minor units of `currency` (B5). One order is one market
  -- and one currency (ADR-0026), which is the only reason summing its lines is
  -- meaningful at all.
  total_minor          bigint      NOT NULL,
  -- Wallet is Phase 7; until then nothing is applied from one and everything
  -- is externally due. The columns exist now because B18 defines the total in
  -- terms of them, and a total that stops adding up later is worse than one
  -- that is trivially satisfied now.
  wallet_applied_minor bigint      NOT NULL DEFAULT 0,
  external_due_minor   bigint      NOT NULL,

  -- Idempotency (B5: every mutating endpoint accepts an Idempotency-Key).
  -- UNIQUE, so the database — not a cache, and not a read-then-insert — is
  -- what makes a retry return the first order instead of creating a second.
  idempotency_key      text        NOT NULL,
  -- SHA-256 of the canonicalised request the key was first used with. Without
  -- it, reusing a key for a DIFFERENT basket would silently return the earlier
  -- order, which is a wrong answer rather than a replay.
  idempotency_digest   bytea       NOT NULL,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orders_order_number_key UNIQUE (order_number),
  CONSTRAINT orders_idempotency_key_key UNIQUE (idempotency_key),
  -- The target for order_items, so a line can never belong to another market.
  CONSTRAINT orders_id_market_key UNIQUE (id, market_id),

  CONSTRAINT orders_market_currency_fkey
    FOREIGN KEY (market_id, currency) REFERENCES markets (id, currency),
  -- Composite, so an order cannot point at another market's terms.
  CONSTRAINT orders_terms_market_fkey
    FOREIGN KEY (terms_version_id, market_id) REFERENCES terms_versions (id, market_id),

  CONSTRAINT orders_one_buyer CHECK (
    (user_id IS NOT NULL AND guest_email IS NULL)
    OR (user_id IS NULL AND guest_email IS NOT NULL)
  ),
  CONSTRAINT orders_guest_email_normalized CHECK (
    guest_email IS NULL OR (
      guest_email::text = lower(btrim(guest_email::text))
      AND char_length(guest_email::text) BETWEEN 3 AND 254
      AND guest_email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    )
  ),
  -- The full B7 state machine, so Phase 6 adds transitions rather than values.
  -- Phase 5 only ever writes 'awaiting_payment'.
  CONSTRAINT orders_status_valid CHECK (status IN (
    'created', 'awaiting_payment', 'paid', 'cancelled', 'failed', 'expired',
    'paid_unfulfillable', 'partially_refunded', 'refunded'
  )),
  CONSTRAINT orders_order_number_format CHECK (order_number ~ '^HV-[A-Z2-7]{10}$'),
  CONSTRAINT orders_totals_add_up CHECK (
    total_minor = wallet_applied_minor + external_due_minor
  ),
  CONSTRAINT orders_total_positive CHECK (total_minor > 0),
  CONSTRAINT orders_parts_non_negative CHECK (
    wallet_applied_minor >= 0 AND external_due_minor >= 0
  ),
  CONSTRAINT orders_idempotency_key_format CHECK (
    idempotency_key = btrim(idempotency_key) AND char_length(idempotency_key) BETWEEN 8 AND 255
  ),
  CONSTRAINT orders_idempotency_digest_sha256 CHECK (octet_length(idempotency_digest) = 32)
);

CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX orders_guest_created_idx
  ON orders (guest_email, created_at DESC) WHERE guest_email IS NOT NULL;
CREATE INDEX orders_market_status_idx ON orders (market_id, status, created_at DESC);

CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

CREATE TABLE order_items (
  id                     uuid     PRIMARY KEY DEFAULT uuidv7(),
  order_id               uuid     NOT NULL,
  market_id              uuid     NOT NULL,
  draw_id                uuid     NOT NULL,
  -- The hold whose tickets this line is for. Composite, so the line, the
  -- reservation and the draw cannot disagree about which draw it is.
  reservation_id         uuid     NOT NULL,

  quantity               integer  NOT NULL,
  -- Snapshotted, so reporting never depends on what the draw says today (B18).
  currency               text     NOT NULL,
  unit_price_minor       bigint   NOT NULL,
  total_minor            bigint   NOT NULL,

  -- The option the customer chose (B20). Recorded whether or not it was right
  -- is not a question that arises: a wrong answer creates no order at all
  -- (ADR-0030), so every row here holds a correct answer at the time it was
  -- checked. Nullable only for a draw that has no question.
  skill_answer_option_id uuid     REFERENCES skill_question_options (id),

  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_items_order_market_fkey
    FOREIGN KEY (order_id, market_id) REFERENCES orders (id, market_id),
  CONSTRAINT order_items_draw_market_fkey
    FOREIGN KEY (draw_id, market_id) REFERENCES draws (id, market_id),
  CONSTRAINT order_items_reservation_draw_fkey
    FOREIGN KEY (reservation_id, draw_id) REFERENCES reservations (id, draw_id),
  CONSTRAINT order_items_market_currency_fkey
    FOREIGN KEY (market_id, currency) REFERENCES markets (id, currency),
  -- One line per draw, and one reservation sold once.
  CONSTRAINT order_items_order_draw_key UNIQUE (order_id, draw_id),
  CONSTRAINT order_items_reservation_key UNIQUE (reservation_id),

  CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT order_items_unit_price_positive CHECK (unit_price_minor > 0),
  CONSTRAINT order_items_total_exact CHECK (total_minor = unit_price_minor * quantity)
);

CREATE INDEX order_items_order_idx ON order_items (order_id, created_at);
CREATE INDEX order_items_draw_idx ON order_items (draw_id);

/**
 * An order is a record of what happened.
 *
 * Everything that describes the purchase is fixed when it is written: who
 * bought, in which market and currency, for how much, under which terms, and
 * with which idempotency key. Only the status and `updated_at` may move, and
 * moving the status is Phase 6's job.
 *
 * Without this, a later phase could quietly rewrite the price or the terms of
 * a completed order and nothing would notice.
 */
CREATE FUNCTION hv_orders_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.id, NEW.order_number, NEW.market_id, NEW.currency, NEW.user_id, NEW.guest_email,
         NEW.terms_version_id, NEW.total_minor, NEW.external_due_minor,
         NEW.idempotency_key, NEW.idempotency_digest, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.order_number, OLD.market_id, OLD.currency, OLD.user_id, OLD.guest_email,
         OLD.terms_version_id, OLD.total_minor, OLD.external_due_minor,
         OLD.idempotency_key, OLD.idempotency_digest, OLD.created_at) THEN
    RAISE EXCEPTION 'an order''s terms are fixed when it is placed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_snapshot_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_guard
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION hv_orders_guard();

/** A line never changes at all. There is no status on it to move. */
CREATE FUNCTION hv_order_items_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'an order line is fixed when the order is placed'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_immutable';
  RETURN NULL;
END;
$$;

CREATE TRIGGER order_items_guard
  BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION hv_order_items_guard();

-- Orders are financial records. The application creates them and moves their
-- status; it does not erase them, and it does not rewrite their lines.
REVOKE DELETE, TRUNCATE ON orders FROM hv_app;
REVOKE UPDATE, DELETE, TRUNCATE ON order_items FROM hv_app;

COMMENT ON TABLE orders IS
  'A completed checkout, awaiting payment (Phase 5 stops here). Snapshot of buyer, market, currency, totals and accepted terms; immutable apart from its status.';
COMMENT ON TABLE order_items IS
  'One draw on an order: the reservation holding its tickets, the price paid and the skill answer given (B18, B20). Immutable.';
COMMENT ON COLUMN orders.idempotency_digest IS
  'SHA-256 of the canonicalised request the idempotency key was first used with, so reusing a key for a different request is refused rather than answered with the earlier order.';

-- 0021_payment_events
--
-- Provider webhook events (Phase 6, task P6-3; Revision 2 B10 and B18; owner
-- decisions D7 = B and OD-7a in docs/PHASE_6_SCOPE_LOCK.md, recorded in
-- ADR-0033).
--
-- WHY THE ROW EXISTS AT ALL
--
-- ★ `UNIQUE (provider, provider_event_id)` is the replay protection for the
-- whole phase (invariant I3). A provider that delivers the same event ten
-- times — which they do, deliberately, when they are unsure we received it —
-- inserts once and conflicts nine times. Everything downstream can then be
-- written as "act on this event" without asking whether it has been seen
-- before.
--
-- That is also why these rows are NEVER deleted. OD-7a sets a ninety-day
-- retention on the encrypted payload, not on the row: dropping rows would
-- reopen replay protection for any event a provider re-sends afterwards, and a
-- provider re-sending something old is exactly the case this defends against.
--
-- WHAT IS STORED, AND IN WHICH FORM
--
-- Two representations, for two different jobs (D7 = B):
--
--   * the NORMALIZED facts, in columns — provider, event id, type, reference,
--     amount, currency, status. This is the working record. Everything the
--     application decides, it decides from these;
--   * the ORIGINAL bytes, SEALED. B18 asks for the raw payload, and it is
--     worth having: in a dispute it proves what the provider actually sent,
--     byte for byte, rather than what we understood. But `hv_app` cannot
--     delete these rows, so anything readable here is readable for ever, and a
--     provider payload carries personal data. It is therefore encrypted with
--     the same AES-256-GCM construction ADR-0028 uses for outbox payloads, for
--     exactly the same reason.
--
-- Nothing here holds card data. Under the SAQ-A model a card number never
-- reaches our servers at all, and the sealed payload is not an exception to
-- that — it is a copy of a notification, not of an instrument.
--
-- `processed_at` means "no longer waiting for anything". P6-3 stores events and
-- settles the ones that need nothing further: an unknown reference, an
-- informational status, a payload whose amount disagrees with its order. An
-- event that should move an order is left unprocessed on purpose, and the
-- partial index below is what P6-4 and the reconciler will read.

CREATE TABLE payment_events (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),

  provider             text        NOT NULL,
  -- The provider's own identifier for this event.
  provider_event_id    text        NOT NULL,
  -- The provider's own event type, stored as sent. Decisions are taken from
  -- `provider_status` below, which is normalised; this is kept so the record
  -- says what arrived rather than what we made of it.
  event_type           text        NOT NULL,

  -- How the event is matched to an attempt. Nullable: a provider may send an
  -- event for a reference we have never issued, and that is kept rather than
  -- dropped.
  provider_reference   text,
  payment_id           uuid        REFERENCES payments (id),

  -- The normalised working record. Nullable because an event need not be about
  -- money at all, and a malformed one never gets this far.
  amount_minor         bigint,
  currency             text,
  provider_status      text,

  -- The original bytes, sealed (D7 = B). Nullable by design: OD-7a clears it
  -- after ninety days, and it is absent for any event whose payload was not
  -- retained.
  payload_sealed       jsonb,

  received_at          timestamptz NOT NULL DEFAULT now(),
  -- NULL while the event still needs acting on. Set once nothing is owed.
  processed_at         timestamptz,
  -- Why an event could not be acted on, as a short code. Mirrors
  -- `outbox.last_error`, so a stuck event stays visible instead of silent.
  last_error           text,

  -- ★ Replay protection (I3).
  CONSTRAINT payment_events_provider_event_key UNIQUE (provider, provider_event_id),

  CONSTRAINT payment_events_provider_present CHECK (char_length(btrim(provider)) > 0),
  CONSTRAINT payment_events_event_id_present CHECK (char_length(btrim(provider_event_id)) > 0),
  CONSTRAINT payment_events_event_type_present CHECK (char_length(btrim(event_type)) > 0),
  CONSTRAINT payment_events_amount_non_negative CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CONSTRAINT payment_events_processed_after_received CHECK (
    processed_at IS NULL OR processed_at >= received_at
  )
);

-- What P6-4 and the reconciler read: events still waiting to be acted on.
CREATE INDEX payment_events_unprocessed_idx
  ON payment_events (received_at) WHERE processed_at IS NULL;
-- An attempt's own events, for support and for finalisation.
CREATE INDEX payment_events_payment_idx ON payment_events (payment_id, received_at);

/**
 * A provider event is a record of what arrived.
 *
 * Nothing about the event itself may change: not the provider, not its
 * identifier, not its type, not the amount it claimed, not the bytes it came
 * as. Rewriting any of that would destroy the only reason to keep it.
 *
 * Three fields may move, and only in one direction each:
 *
 *   * `processed_at`, once, from NULL — an event is settled once;
 *   * `last_error`, freely, because a retry may fail differently;
 *   * `payload_sealed`, from a value to NULL and no other way (OD-7a). That is
 *     retention clearing the original after ninety days. Replacing one sealed
 *     value with another, or putting one back, is refused: a payload that can
 *     be rewritten proves nothing about what the provider sent.
 */
CREATE FUNCTION hv_payment_events_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.id, NEW.provider, NEW.provider_event_id, NEW.event_type, NEW.provider_reference,
         NEW.payment_id, NEW.amount_minor, NEW.currency, NEW.provider_status, NEW.received_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.provider, OLD.provider_event_id, OLD.event_type, OLD.provider_reference,
         OLD.payment_id, OLD.amount_minor, OLD.currency, OLD.provider_status, OLD.received_at) THEN
    RAISE EXCEPTION 'a provider event is fixed as it arrived'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_events_immutable';
  END IF;

  IF OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at THEN
    RAISE EXCEPTION 'a provider event is settled once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_events_processed_once';
  END IF;

  -- Retention may clear the sealed payload. Nothing may set one, swap one, or
  -- put a cleared one back.
  IF NEW.payload_sealed IS DISTINCT FROM OLD.payload_sealed AND NEW.payload_sealed IS NOT NULL THEN
    RAISE EXCEPTION 'a sealed provider payload is cleared, never rewritten'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_events_payload_clear_only';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_events_guard
  BEFORE UPDATE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION hv_payment_events_guard();

-- B19 lists payment_events among the tables where hv_app has UPDATE and DELETE
-- revoked. UPDATE is kept, narrowed by the guard above to the three fields
-- that legitimately move; DELETE and TRUNCATE are not, because the row is the
-- replay record and retention clears the payload rather than the row (OD-7a).
REVOKE DELETE, TRUNCATE ON payment_events FROM hv_app;

COMMENT ON TABLE payment_events IS
  'Provider webhook events, stored as they arrived (B18). UNIQUE(provider, provider_event_id) is the replay protection for the phase (I3); rows are never deleted, and retention clears only the sealed payload (OD-7a).';
COMMENT ON COLUMN payment_events.payload_sealed IS
  'The original bytes, AES-256-GCM sealed (D7 = B, ADR-0033). Cleared after 90 days by the retention process; never rewritten. Readable only under the payments.reconcile authority.';
COMMENT ON COLUMN payment_events.processed_at IS
  'NULL while the event still needs acting on. P6-3 settles events that need nothing further; one that should move an order is left for finalisation.';
COMMENT ON COLUMN payment_events.provider_status IS
  'The event''s status normalised to Highland Vault''s vocabulary. Decisions are taken from this, never from event_type.';

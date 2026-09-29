-- 0011_outbox
--
-- Transactional outbox (Phase 5, task P5-1; Part F lists the outbox as P5
-- scope). Side effects that must follow a committed business transaction —
-- emails first (P5-2), provider calls later — are written here as a row in the
-- SAME transaction as the business change, and delivered afterwards by the
-- worker.
--
-- Why it exists: withTransaction retries a transaction on serialization
-- failure or deadlock, so `fn` must have no effects outside the database. An
-- outbox row is inside the database, so it rolls back with everything else.
-- That gives the two properties the mechanism exists for:
--
--   * the business transaction commits  -> the event is durably queued;
--   * the business transaction rolls back -> no event exists to deliver.
--
-- Delivery is AT LEAST ONCE. A worker can crash after delivering and before
-- recording success, and the event is then delivered again. Every consumer
-- must be idempotent.
--
-- Claiming (hv_claim_outbox below) takes due rows with FOR UPDATE SKIP LOCKED,
-- the same pattern as hv_expire_reservations: workers never wait on each other
-- and never take the same row, so concurrent workers cannot deadlock here.
-- A claim is a LEASE, not a hand-off: the claim pushes available_at forward by
-- the lease, so a worker that dies mid-delivery loses nothing — the lease
-- simply lapses and the event becomes claimable again.
--
-- No give-up policy is set. Attempts are counted and the last error is kept,
-- so a stuck event stays visible to operators instead of disappearing; nothing
-- here decides when to stop retrying, because that is a policy choice and not
-- one this migration should invent. Retry pacing is the caller's argument.

CREATE TABLE outbox (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  -- Dotted lower-case name of what happened, like audit_log.action.
  topic        text        NOT NULL,
  payload      jsonb       NOT NULL,
  -- Not before this time: the initial delay, the retry backoff, and the lease
  -- held by the worker that claimed the row, all in one column.
  available_at timestamptz NOT NULL DEFAULT now(),
  -- Delivery attempts started. Incremented by the claim, never reset.
  attempts     integer     NOT NULL DEFAULT 0,
  -- Set exactly once, when a consumer has accepted the event.
  published_at timestamptz,
  -- Why the most recent attempt failed. Kept after a later success? No: a
  -- successful publish clears it, so a published row reads as clean.
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outbox_topic_format CHECK (topic ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT outbox_last_error_not_blank CHECK (last_error IS NULL OR btrim(last_error) <> ''),
  CONSTRAINT outbox_published_after_created CHECK (published_at IS NULL OR published_at >= created_at),
  -- A published event is finished: it carries no error and no pending time.
  CONSTRAINT outbox_published_is_clean CHECK (published_at IS NULL OR last_error IS NULL)
);

-- The claim query's exact predicate: the due, unpublished rows, in order.
CREATE INDEX outbox_due_idx ON outbox (available_at, id) WHERE published_at IS NULL;
-- Operator view: what is failing, and what is stuck.
CREATE INDEX outbox_unpublished_topic_idx ON outbox (topic, attempts) WHERE published_at IS NULL;

CREATE FUNCTION hv_outbox_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.published_at IS NOT NULL OR NEW.attempts <> 0 OR NEW.last_error IS NOT NULL THEN
      RAISE EXCEPTION 'an outbox event is created unpublished, unattempted and without an error'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_created_pending';
    END IF;
    RETURN NEW;
  END IF;

  -- What the event IS never changes; only its delivery state does.
  IF ROW(NEW.id, NEW.topic, NEW.payload, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.topic, OLD.payload, OLD.created_at) THEN
    RAISE EXCEPTION 'an outbox event is immutable; only its delivery state may change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_event_immutable';
  END IF;
  -- Publishing happens once. Without this a redelivery could overwrite the
  -- record of the first success, and "published" would stop meaning anything.
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'outbox event % is already published' , OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_published_final';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'outbox attempts never decrease'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_attempts_monotonic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_guard
  BEFORE INSERT OR UPDATE ON outbox
  FOR EACH ROW EXECUTE FUNCTION hv_outbox_guard();

-- Claims up to p_limit due events for delivery and returns them.
--
-- Each claimed row has its attempt counted and its availability pushed
-- p_lease_seconds into the future, so no other worker takes it while this one
-- is working. The lease is not a guarantee of exclusivity forever: if delivery
-- outlives the lease the event can be delivered twice, which is why consumers
-- are idempotent. SKIP LOCKED means a second worker running at the same moment
-- takes the NEXT rows rather than waiting for these.
CREATE FUNCTION hv_claim_outbox(p_limit integer, p_lease_seconds integer)
RETURNS SETOF outbox
LANGUAGE sql
AS $$
  WITH due AS (
    SELECT id FROM outbox
     WHERE published_at IS NULL AND available_at <= now()
     ORDER BY available_at, id
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  )
  UPDATE outbox o
     SET attempts = o.attempts + 1,
         available_at = now() + make_interval(secs => p_lease_seconds)
    FROM due
   WHERE o.id = due.id
  RETURNING o.*;
$$;

-- Outbox rows are the record that a side effect was owed and whether it
-- happened. The application may add and update them; it may not remove them,
-- so a pending event cannot be lost by application code. Pruning published
-- rows is an owner/operator task; no retention policy is set here.
REVOKE DELETE, TRUNCATE ON outbox FROM hv_app;

COMMENT ON TABLE outbox IS
  'Transactional outbox: side effects queued in the same transaction as the business change, delivered at least once by the worker.';
COMMENT ON FUNCTION hv_claim_outbox(integer, integer) IS
  'Claims up to p_limit due outbox events with FOR UPDATE SKIP LOCKED, counting the attempt and leasing them for p_lease_seconds.';

-- 0015_market_terms
--
-- Market terms and the act of accepting them (Phase 5, task P5-6; Revision 2
-- B12 and B18, ADR-0031).
--
-- Terms belong to a market and are versioned, because what a customer agreed
-- to has to stay knowable after the wording changes. An order records the
-- version it was placed under (B18 puts `terms_version_id` on `orders`), and
-- that is only meaningful if the version is immutable once published.
--
-- THERE IS NO TERMS CONTENT HERE, deliberately. B12 marks the wording
-- "Content: legal" and Part F assigns per-market terms and templates to Phase
-- 12. This migration builds the mechanism that will carry the content: a
-- version identifier, when it was published, which one a market is currently
-- on, and who accepted what. Inventing legal wording is not this project's to
-- do, and a column for it would invite exactly that.
--
-- The active version gates CHECKOUT, not market enablement (ADR-0031).
-- `hv_market_missing_settings` is deliberately NOT extended: a market can be
-- enabled and browsable with no terms, it simply cannot take an order. That
-- keeps Phase 5 independent of the O12 compliance values, which block
-- enablement on their own terms.

CREATE TABLE terms_versions (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  market_id    uuid        NOT NULL REFERENCES markets (id),
  -- The publisher's label for this revision, unique within the market. Free
  -- text rather than a number: legal will have their own convention, and
  -- guessing it here would be wrong in a way that is hard to undo.
  version      text        NOT NULL,
  -- NULL until published. A draft can be prepared and only then made real.
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT terms_versions_market_version_key UNIQUE (market_id, version),
  -- Lets the market's active version, and every acceptance, be checked against
  -- the market they claim to belong to.
  CONSTRAINT terms_versions_id_market_key UNIQUE (id, market_id),
  CONSTRAINT terms_versions_version_format CHECK (
    version = btrim(version) AND char_length(version) BETWEEN 1 AND 64
  ),
  CONSTRAINT terms_versions_published_after_created CHECK (
    published_at IS NULL OR published_at >= created_at
  )
);

CREATE INDEX terms_versions_market_published_idx
  ON terms_versions (market_id, published_at DESC) WHERE published_at IS NOT NULL;

/**
 * A published version is settled.
 *
 * Its identity cannot change, and it cannot be unpublished: orders will point
 * at it as the thing the customer agreed to, and that record is worthless if
 * the thing it points at can be rewritten or withdrawn. A correction is a new
 * version, which is what versioning is for.
 */
CREATE FUNCTION hv_terms_versions_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.id, NEW.market_id, NEW.version, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.market_id, OLD.version, OLD.created_at) THEN
    RAISE EXCEPTION 'a terms version is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'terms_versions_immutable';
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'a terms version is published once and never withdrawn'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'terms_versions_published_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER terms_versions_guard
  BEFORE UPDATE ON terms_versions
  FOR EACH ROW EXECUTE FUNCTION hv_terms_versions_guard();

-- The market's current terms. Nullable, like every other compliance value in
-- this table (0004), and deliberately absent from hv_market_missing_settings:
-- this one gates checkout, not enablement.
ALTER TABLE market_settings
  ADD COLUMN active_terms_version_id uuid,
  -- Composite, so a market cannot point at another market's terms.
  ADD CONSTRAINT market_settings_active_terms_fkey
    FOREIGN KEY (active_terms_version_id, market_id) REFERENCES terms_versions (id, market_id);

COMMENT ON COLUMN market_settings.active_terms_version_id IS
  'The terms version a checkout in this market is placed under (ADR-0031). NULL means no order can be created; it does NOT stop the market being enabled or browsed.';

CREATE TABLE terms_acceptances (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  market_id        uuid        NOT NULL,
  terms_version_id uuid        NOT NULL,
  -- The checkout identity that accepted (ADR-0031): a signed-in customer or a
  -- guest session, never both, and never a user invented for a guest. B18 was
  -- written as "per user or order", before ADR-0029 separated guest sessions
  -- from authenticated ones; this is the same resolution ADR-0031 applied to
  -- cart ownership. P5-7 adds the link to the order, which carries its own
  -- terms_version_id.
  user_id          uuid        REFERENCES users (id),
  guest_session_id uuid        REFERENCES guest_sessions (id),
  accepted_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT terms_acceptances_version_market_fkey
    FOREIGN KEY (terms_version_id, market_id) REFERENCES terms_versions (id, market_id),
  CONSTRAINT terms_acceptances_one_identity CHECK (
    (user_id IS NOT NULL AND guest_session_id IS NULL)
    OR (user_id IS NULL AND guest_session_id IS NOT NULL)
  )
);

-- Accepting twice is the same acceptance, not a second one.
CREATE UNIQUE INDEX terms_acceptances_user_version_idx
  ON terms_acceptances (user_id, terms_version_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX terms_acceptances_guest_version_idx
  ON terms_acceptances (guest_session_id, terms_version_id) WHERE guest_session_id IS NOT NULL;

/** An acceptance is a record of something that happened; it never changes. */
CREATE FUNCTION hv_terms_acceptances_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'a terms acceptance is a record of what happened and cannot be changed'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'terms_acceptances_append_only';
  RETURN NULL;
END;
$$;

CREATE TRIGGER terms_acceptances_guard
  BEFORE UPDATE ON terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION hv_terms_acceptances_guard();

-- Terms and acceptances are evidence. The application adds to them and does
-- nothing else, the same treatment consents and the audit log get (B19).
REVOKE DELETE, TRUNCATE ON terms_versions FROM hv_app;
REVOKE UPDATE, DELETE, TRUNCATE ON terms_acceptances FROM hv_app;

COMMENT ON TABLE terms_versions IS
  'Per-market terms revisions (B12). Identity and publication only; the wording is legal''s and arrives in Phase 12.';
COMMENT ON TABLE terms_acceptances IS
  'Who accepted which market''s terms version, and when. Append-only: hv_app cannot UPDATE or DELETE.';

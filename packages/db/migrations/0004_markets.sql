-- 0004_markets
--
-- Markets, their compliance settings and the database layer of the market gate
-- (SPEC §7, ADR-0004, ADR-0005, ADR-0016, Revision 2 B8).
--
-- Invariants enforced here, independently of the API:
--   1. The market set and each market's currency and locale are fixed:
--      uk → GBP / en-GB, ie → EUR / en-IE, de → EUR / de-DE.
--   2. UNIQUE (id, currency) is the target of the composite foreign keys that
--      draws and orders will use (Phases 3 and 5), so their currency can never
--      drift from their market.
--   3. A market's identity (code, currency, locale, requires_legal_approval)
--      is immutable once created.
--   4. Germany gate: a market that requires legal approval cannot be enabled
--      without a recorded approval (the CHECK from Revision 2 B8).
--   5. Compliance gate: a market cannot be enabled while any required
--      compliance setting is NULL (= not yet decided, OPEN O12), and a
--      required setting cannot be cleared while its market is enabled.
--
-- All three markets are seeded DISABLED. The compliance values are OPEN (O12),
-- so no market can be enabled until the owner supplies them.

CREATE TABLE markets (
  id                      uuid        PRIMARY KEY DEFAULT uuidv7(),
  code                    text        NOT NULL,
  name                    text        NOT NULL,
  currency                text        NOT NULL,
  locale                  text        NOT NULL,
  is_enabled              boolean     NOT NULL DEFAULT false,
  requires_legal_approval boolean     NOT NULL,
  legal_approved_at       timestamptz,
  -- The staff user who recorded the approval in the platform.
  legal_approved_by       uuid        REFERENCES users (id),
  -- Reference to the approval itself (for example a legal document ID).
  legal_approval_ref      text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT markets_code_key UNIQUE (code),
  CONSTRAINT markets_id_currency_key UNIQUE (id, currency),
  CONSTRAINT markets_currency_supported CHECK (currency IN ('GBP', 'EUR')),
  CONSTRAINT markets_known_definition CHECK (
    ROW(code, currency, locale) IN (
      ROW('uk', 'GBP', 'en-GB'),
      ROW('ie', 'EUR', 'en-IE'),
      ROW('de', 'EUR', 'de-DE')
    )
  ),
  CONSTRAINT markets_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT markets_legal_approval_complete CHECK (
    (legal_approved_at IS NULL AND legal_approved_by IS NULL AND legal_approval_ref IS NULL)
    OR (
      legal_approved_at IS NOT NULL
      AND legal_approved_by IS NOT NULL
      AND legal_approval_ref IS NOT NULL
      AND btrim(legal_approval_ref) <> ''
    )
  ),
  -- Revision 2 B8, layer 1 of the Germany gate.
  CONSTRAINT markets_legal_approval_required CHECK (
    NOT (requires_legal_approval AND is_enabled AND legal_approved_at IS NULL)
  )
);

CREATE TRIGGER markets_set_updated_at
  BEFORE UPDATE ON markets
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

-- Typed, nullable compliance values (ADR-0016). NULL means "not yet decided".
-- Phase 2 holds the values that decide whether a market may operate at all.
-- Later phases add the settings for their own features (skill-answer
-- behaviour in Phase 5, consent, retention and masked names in Phase 12).
-- Each one that is required must also be added to hv_market_missing_settings().
CREATE TABLE market_settings (
  market_id               uuid        PRIMARY KEY REFERENCES markets (id),
  -- Minimum customer age for the market. OPEN O12.
  min_age                 smallint,
  -- Whether self-exclusion must be offered in the market. OPEN O12.
  self_exclusion_required boolean,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT market_settings_min_age_range CHECK (min_age IS NULL OR min_age BETWEEN 1 AND 99)
);

CREATE TRIGGER market_settings_set_updated_at
  BEFORE UPDATE ON market_settings
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

-- The single definition of "required compliance settings". Returns the names
-- of the required settings that are unset in the given row.
CREATE FUNCTION hv_missing_compliance_settings(s market_settings) RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN s.min_age IS NULL THEN 'min_age' END,
    CASE WHEN s.self_exclusion_required IS NULL THEN 'self_exclusion_required' END
  ], NULL);
$$;

-- Required settings still unset for a market. Every required setting is
-- missing if the market has no settings row at all.
CREATE FUNCTION hv_market_missing_settings(p_market_id uuid) RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  -- Without a settings row, s is NULL and every field reads as NULL.
  SELECT hv_missing_compliance_settings(s)
    FROM (SELECT p_market_id AS id) AS m
    LEFT JOIN market_settings AS s ON s.market_id = m.id;
$$;

CREATE FUNCTION hv_markets_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  missing text[];
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(NEW.code, NEW.currency, NEW.locale, NEW.requires_legal_approval)
         IS DISTINCT FROM ROW(OLD.code, OLD.currency, OLD.locale, OLD.requires_legal_approval) THEN
    RAISE EXCEPTION 'market "%": code, currency, locale and requires_legal_approval are immutable', OLD.code
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'markets_identity_immutable';
  END IF;

  IF NEW.is_enabled THEN
    missing := hv_market_missing_settings(NEW.id);
    IF cardinality(missing) > 0 THEN
      RAISE EXCEPTION 'market "%" cannot be enabled: required compliance settings are not set: %',
        NEW.code, array_to_string(missing, ', ')
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'markets_compliance_settings_required',
              DETAIL = array_to_string(missing, ',');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER markets_guard
  BEFORE INSERT OR UPDATE ON markets
  FOR EACH ROW EXECUTE FUNCTION hv_markets_guard();

CREATE FUNCTION hv_market_settings_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  market_enabled boolean;
  market_code text;
  missing text[];
BEGIN
  -- Lock the market row so this check cannot interleave with a concurrent
  -- enable (which holds the same row lock): no write skew between the two
  -- tables under READ COMMITTED.
  SELECT m.is_enabled, m.code INTO market_enabled, market_code
    FROM markets m
   WHERE m.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.market_id ELSE NEW.market_id END
     FOR SHARE;

  IF TG_OP = 'DELETE' THEN
    IF market_enabled THEN
      RAISE EXCEPTION 'market "%" is enabled: its settings cannot be deleted', market_code
        USING ERRCODE = 'check_violation', CONSTRAINT = 'markets_compliance_settings_required';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.market_id <> OLD.market_id THEN
    RAISE EXCEPTION 'market_settings.market_id is immutable'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'market_settings_market_immutable';
  END IF;

  IF market_enabled THEN
    missing := hv_missing_compliance_settings(NEW);
    IF cardinality(missing) > 0 THEN
      RAISE EXCEPTION 'market "%" is enabled: required compliance settings cannot be cleared: %',
        market_code, array_to_string(missing, ', ')
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'markets_compliance_settings_required',
              DETAIL = array_to_string(missing, ',');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER market_settings_guard
  BEFORE INSERT OR UPDATE OR DELETE ON market_settings
  FOR EACH ROW EXECUTE FUNCTION hv_market_settings_guard();

-- Markets and their settings rows are created only by migrations. The runtime
-- role may read them and change the gate and settings (through audited,
-- sensitive admin operations), but never create or delete them.
REVOKE INSERT, DELETE, TRUNCATE ON markets, market_settings FROM hv_app;

INSERT INTO markets (code, name, currency, locale, requires_legal_approval) VALUES
  ('uk', 'United Kingdom', 'GBP', 'en-GB', false),
  ('ie', 'Ireland',        'EUR', 'en-IE', false),
  ('de', 'Germany',        'EUR', 'de-DE', true);

INSERT INTO market_settings (market_id)
SELECT id FROM markets;

COMMENT ON TABLE markets IS
  'Markets (SPEC §7). Seeded disabled. Enabling requires the compliance settings (ADR-0016) and, for DE, a recorded legal approval (ADR-0005).';
COMMENT ON TABLE market_settings IS
  'Typed compliance settings per market. NULL = not yet decided (OPEN O12); blocks enabling the market.';

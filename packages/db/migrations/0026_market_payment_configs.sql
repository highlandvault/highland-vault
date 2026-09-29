-- 0026_market_payment_configs
--
-- Which provider a market pays through (Revision 2 B10; Phase 6, task P6-7;
-- owner decision D17 = A in docs/PHASE_6_SCOPE_LOCK.md).
--
-- Until now a deployment had at most one payment provider, built from the
-- environment and shared by every market. B10 says the provider is a property
-- of the MARKET: the United Kingdom and Ireland may settle through different
-- providers, in different currencies, under different agreements.
--
-- WHAT IS AND IS NOT IN THIS TABLE
--
-- `config_ref` is a REFERENCE, never a secret (I15). It names which credential
-- set the provider should use — a key in a secret manager, an account
-- identifier, a merchant id — and the credentials themselves stay in the
-- environment where every other key in this system lives. Nothing here is
-- usable on its own if the database leaks, and that is the point.
--
-- There is deliberately NO api_key, secret, token or private_key column, and
-- no column that could become one by a later widening.
--
-- NO PROVIDER IS NAMED HERE
--
-- `provider_code` carries a format CHECK and nothing else. Naming providers in
-- a migration would hard-code the very choice ADR-0006 exists to defer, and
-- Gate 4.9 forbids it outright. Whether a code can actually be built is the
-- application's question, asked against what the environment configured, and a
-- code it does not recognise fails closed.
--
-- ONE ROW PER MARKET, CREATED HERE
--
-- Exactly the shape `market_settings` uses (0004): the row exists from the
-- start with NULLs meaning "not configured", and the runtime role may only
-- UPDATE it. A market whose provider is NULL cannot take a payment, which is
-- the correct state for every market today — no production provider has been
-- chosen (OPEN O13).
--
-- BOTH COLUMNS MOVE TOGETHER
--
-- A provider without its configuration reference is not a configuration, and a
-- reference belonging to no provider is not either. The CHECK below makes the
-- pair all-or-nothing, so "half configured" is not a state this table can hold.

CREATE TABLE market_payment_configs (
  market_id     uuid        PRIMARY KEY REFERENCES markets (id),

  -- The provider's stable code, as `payments.provider` and
  -- `payment_events.provider` already record it. NULL = not configured.
  provider_code text,
  -- Which credential set that provider should use. A reference, NEVER a
  -- secret (I15). NULL = not configured.
  config_ref    text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A lowercase slug, the same shape `payments.provider` holds. No provider is
  -- named: this says what a code looks like, not which ones exist.
  CONSTRAINT market_payment_configs_provider_format CHECK (
    provider_code IS NULL OR provider_code ~ '^[a-z][a-z0-9_]{1,31}$'
  ),
  -- A reference somebody has to be able to read back and act on.
  CONSTRAINT market_payment_configs_ref_format CHECK (
    config_ref IS NULL
    OR (config_ref = btrim(config_ref) AND char_length(config_ref) BETWEEN 1 AND 200)
  ),
  -- Configured, or not. Never half.
  CONSTRAINT market_payment_configs_pair_complete CHECK (
    (provider_code IS NULL) = (config_ref IS NULL)
  )
);

CREATE TRIGGER market_payment_configs_set_updated_at
  BEFORE UPDATE ON market_payment_configs
  FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();

/**
 * The market a configuration belongs to never changes.
 *
 * `market_id` is the primary key, so PostgreSQL already refuses a duplicate;
 * this refuses the other move — repointing an existing row at another market,
 * which would silently transfer one market's provider agreement to another.
 * The same reasoning as `hv_orders_guard`'s frozen snapshot: identity is fixed
 * when the row is created, and only the decision on it may move.
 */
CREATE FUNCTION hv_market_payment_configs_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.market_id IS DISTINCT FROM OLD.market_id THEN
    RAISE EXCEPTION 'a payment configuration stays with its market'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'market_payment_configs_market_fixed';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payment configuration keeps its creation time'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'market_payment_configs_created_fixed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER market_payment_configs_guard
  BEFORE UPDATE ON market_payment_configs
  FOR EACH ROW EXECUTE FUNCTION hv_market_payment_configs_guard();

-- One row per market, created here and never by the application — the same
-- rule `markets` and `market_settings` follow. The runtime role changes the
-- configuration through an audited, sensitive admin operation (D17 = A); it
-- does not invent markets and does not erase their configuration history by
-- deleting a row.
INSERT INTO market_payment_configs (market_id) SELECT id FROM markets;

REVOKE INSERT, DELETE, TRUNCATE ON market_payment_configs FROM hv_app;

COMMENT ON TABLE market_payment_configs IS
  'Which provider each market pays through (B10, D17). One row per market, created by migration. NULL provider_code means not configured, which is the correct state until a provider is chosen (OPEN O13).';
COMMENT ON COLUMN market_payment_configs.provider_code IS
  'The provider''s stable code, matching payments.provider. Format-checked only: no provider is named in the schema (Gate 4.9, ADR-0006).';
COMMENT ON COLUMN market_payment_configs.config_ref IS
  'Which credential set the provider uses — a reference, NEVER a secret (I15). Credentials live in the environment.';

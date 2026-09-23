-- 0002_extensions_and_helpers
--
-- Phase 2 prerequisites that Phase 1 deferred (PROJECT_STATUS.md, decision 4):
--   * citext, for the globally unique, case-insensitive user email (ADR-0003);
--   * hv_set_updated_at(), the reusable updated_at trigger function.
--
-- citext is a trusted extension, so the database owner (hv_owner) can create it
-- without superuser rights.

CREATE EXTENSION citext;

-- Attach as:
--   CREATE TRIGGER <table>_set_updated_at
--     BEFORE UPDATE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION hv_set_updated_at();
CREATE FUNCTION hv_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION hv_set_updated_at() IS
  'Trigger function that stamps updated_at with the transaction time on every UPDATE.';

-- 0001_foundation
--
-- Phase 1 contains no business tables. The migration history table
-- (schema_migrations) is owned by the migration tool itself.
--
-- Reusable guard for append-only tables (wallet_entries, audit_log,
-- payment_events, consents — created in later phases). Attach both triggers:
--
--   CREATE TRIGGER <table>_no_update_delete
--     BEFORE UPDATE OR DELETE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION hv_forbid_update_delete();
--   CREATE TRIGGER <table>_no_truncate
--     BEFORE TRUNCATE ON <table>
--     FOR EACH STATEMENT EXECUTE FUNCTION hv_forbid_update_delete();
--
-- The trigger is the second layer; the first is revoking UPDATE/DELETE/TRUNCATE
-- from the runtime role (hv_app) on those tables.

CREATE FUNCTION hv_forbid_update_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'table "%" is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Write a new (reversing) row instead of changing history.';
END;
$$;

COMMENT ON FUNCTION hv_forbid_update_delete() IS
  'Trigger function that rejects UPDATE, DELETE and TRUNCATE on append-only tables.';

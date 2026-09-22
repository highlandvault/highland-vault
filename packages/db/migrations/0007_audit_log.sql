-- 0007_audit_log
--
-- Append-only audit log (ADR-0010, Revision 2 B15). Rows are written in the
-- same transaction as the action they record, so an action and its audit
-- entry commit or roll back together.
--
-- Two layers make it append-only:
--   1. the runtime role hv_app has no UPDATE, DELETE or TRUNCATE privilege;
--   2. the hv_forbid_update_delete() triggers from 0001 reject them for
--      every role, including the owner.

CREATE TABLE audit_log (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text        NOT NULL,
  actor_user_id uuid        REFERENCES users (id),
  action        text        NOT NULL,
  entity_type   text        NOT NULL,
  entity_id     text,
  market_id     uuid        REFERENCES markets (id),
  reason        text,
  before        jsonb,
  after         jsonb,
  ip            inet,
  request_id    text,

  CONSTRAINT audit_log_actor_type_valid CHECK (actor_type IN ('user', 'system')),
  CONSTRAINT audit_log_actor_consistent CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL)),
  CONSTRAINT audit_log_action_format CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  CONSTRAINT audit_log_reason_not_blank CHECK (reason IS NULL OR btrim(reason) <> ''),
  CONSTRAINT audit_log_request_id_length CHECK (request_id IS NULL OR char_length(request_id) <= 128)
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at);

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION hv_forbid_update_delete();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION hv_forbid_update_delete();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM hv_app;

COMMENT ON TABLE audit_log IS
  'Append-only record of sensitive and administrative actions, written in the same transaction as the action.';

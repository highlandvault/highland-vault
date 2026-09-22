-- 0006_rbac
--
-- Permission-based RBAC (ADR-0010, Revision 2 B7).
--
-- * Roles are bundles of permissions. The API checks permissions, never role
--   names, and denies by default.
-- * user_roles.market_id NULL means "all markets"; a value scopes the grant to
--   one market (market-scoped staff).
-- * The role→permission matrix below is the "proposed starting matrix" from
--   Revision 2 B7, seeded as written. It still needs owner confirmation;
--   changes are new migrations.
-- * Which roles must use MFA is OPEN O8, so nothing here makes MFA mandatory
--   for a role. Sensitive operations always require step-up MFA (D10).

CREATE TABLE roles (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL,

  CONSTRAINT roles_code_format CHECK (code ~ '^[a-z][a-z_]*$')
);

CREATE TABLE permissions (
  code        text PRIMARY KEY,
  description text NOT NULL,

  CONSTRAINT permissions_code_format CHECK (code ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$')
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles (code),
  permission_code text NOT NULL REFERENCES permissions (code),

  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE user_roles (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid        NOT NULL REFERENCES users (id),
  role_code  text        NOT NULL REFERENCES roles (code),
  market_id  uuid        REFERENCES markets (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  -- NULL when granted by the system (registration, operator CLI).
  granted_by uuid        REFERENCES users (id),

  CONSTRAINT user_roles_user_role_market_key UNIQUE NULLS NOT DISTINCT (user_id, role_code, market_id),
  CONSTRAINT user_roles_customer_not_market_scoped CHECK (role_code <> 'customer' OR market_id IS NULL)
);

-- Roles and permissions change only through migrations.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON roles, permissions, role_permissions FROM hv_app;

INSERT INTO roles (code, name, description) VALUES
  ('customer',    'Customer',    'Registered customer account.'),
  ('support',     'Support',     'Customer support staff.'),
  ('fulfilment',  'Fulfilment',  'Prize fulfilment staff.'),
  ('finance',     'Finance',     'Refunds, wallet adjustments and financial reports.'),
  ('admin',       'Admin',       'Draw, instant-win and settlement operations.'),
  ('super_admin', 'Super admin', 'Roles, market gates and major configuration.');

INSERT INTO permissions (code, description) VALUES
  ('admin.access',          'Open the admin back office (/admin).'),
  ('customers.read',        'View customers with masked PII.'),
  ('orders.read',           'View orders with masked PII.'),
  ('customers.pii.read',    'View full customer PII.'),
  ('fulfilment.write',      'Update prize fulfilment.'),
  ('postal_entries.write',  'Record and validate postal entries.'),
  ('refunds.create',        'Create refunds. Sensitive operation.'),
  ('wallet.adjust',         'Adjust wallet balances. Sensitive operation.'),
  ('draws.write',           'Create and manage draws.'),
  ('instant_wins.write',    'Manage instant-win prizes.'),
  ('settlement.retry',      'Retry settlement. Sensitive operation.'),
  ('reports.read',          'View reports.'),
  ('reports.export',        'Export reports as CSV (may contain PII; audited).'),
  ('roles.manage',          'Grant and revoke roles.'),
  ('markets.gate.manage',   'Change market settings, legal approval and enablement. Sensitive operation.'),
  ('config.manage',         'Change major configuration. Sensitive operation (list is OPEN O9).');

-- Revision 2 B7 proposed starting matrix. customer has no back-office permissions.
INSERT INTO role_permissions (role_code, permission_code) VALUES
  -- Every staff role can open the admin shell and view customers/orders with masked PII.
  ('support', 'admin.access'), ('fulfilment', 'admin.access'), ('finance', 'admin.access'),
  ('admin', 'admin.access'), ('super_admin', 'admin.access'),
  ('support', 'customers.read'), ('fulfilment', 'customers.read'), ('finance', 'customers.read'),
  ('admin', 'customers.read'), ('super_admin', 'customers.read'),
  ('support', 'orders.read'), ('fulfilment', 'orders.read'), ('finance', 'orders.read'),
  ('admin', 'orders.read'), ('super_admin', 'orders.read'),
  -- View full PII
  ('support', 'customers.pii.read'), ('finance', 'customers.pii.read'),
  ('admin', 'customers.pii.read'), ('super_admin', 'customers.pii.read'),
  -- Fulfilment updates
  ('fulfilment', 'fulfilment.write'), ('admin', 'fulfilment.write'), ('super_admin', 'fulfilment.write'),
  -- Postal entries
  ('support', 'postal_entries.write'), ('admin', 'postal_entries.write'), ('super_admin', 'postal_entries.write'),
  -- Refunds, wallet adjustments
  ('finance', 'refunds.create'), ('super_admin', 'refunds.create'),
  ('finance', 'wallet.adjust'), ('super_admin', 'wallet.adjust'),
  -- Draw/instant-win management, settlement retry
  ('admin', 'draws.write'), ('super_admin', 'draws.write'),
  ('admin', 'instant_wins.write'), ('super_admin', 'instant_wins.write'),
  ('admin', 'settlement.retry'), ('super_admin', 'settlement.retry'),
  -- Reports / CSV export
  ('finance', 'reports.read'), ('admin', 'reports.read'), ('super_admin', 'reports.read'),
  ('finance', 'reports.export'), ('admin', 'reports.export'), ('super_admin', 'reports.export'),
  -- Roles, market gates, major configuration
  ('super_admin', 'roles.manage'), ('super_admin', 'markets.gate.manage'), ('super_admin', 'config.manage');

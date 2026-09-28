-- 0025_payments_reconcile_permission
--
-- The authority to act on a payment outside the customer's own flow (Phase 6,
-- task P6-5; owner decision D13a in docs/PHASE_6_SCOPE_LOCK.md).
--
-- WHY A NEW PERMISSION, AND ONLY ONE
--
-- D13 = B separates viewing from acting, and D13a settles both halves:
--
--   * VIEWING a payment reuses `orders.read`, which 0006 already seeded and
--     already grants to all five staff roles. Nothing is added for it. A
--     payment is part of the story of an order, and somebody who may read the
--     order may read how it was paid for.
--
--   * ACTING on one — asking the provider what really happened and applying
--     the answer — is new, because until Phase 6 there was nothing to act on.
--     That is this permission.
--
-- It is also the authority for opening a sealed provider payload (OD-7a). There
-- is deliberately NO separate payload-access permission: a payload is opened to
-- reconcile a payment, so the two cannot sensibly be held apart, and a second
-- permission would only be a second thing to forget to revoke.
--
-- SENSITIVE, BUT NOT HERE
--
-- Every route carrying this permission is declared `sensitive: true`, so the
-- access guard demands step-up MFA inside STEP_UP_WINDOW_MS. That is a property
-- of the route, not of the row: `permissions` is (code, description) and has no
-- sensitivity column, exactly as `refunds.create`, `wallet.adjust` and
-- `config.manage` are already handled. The description says so in words for the
-- benefit of anyone reading the table.
--
-- WHO HOLDS IT
--
-- finance, admin and super_admin (D13a). Support and fulfilment do not: this
-- moves money and sells tickets, and neither role has any other permission that
-- does. `finance` already holds `refunds.create` and `wallet.adjust`, so this
-- sits with the authorities it belongs beside.
--
-- Nothing else is in this migration. No table, no column, no index, no state
-- transition, no refund schema.

INSERT INTO permissions (code, description) VALUES
  ('payments.reconcile',
   'Re-check a payment with the provider and apply the result; open a sealed provider payload. Sensitive operation.');

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('finance',     'payments.reconcile'),
  ('admin',       'payments.reconcile'),
  ('super_admin', 'payments.reconcile');

# ADR-0010: Roles, permission-based RBAC and MFA

## Status

Accepted — 2026-09-21 (decision D10, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D10.

## Decision

- Initial roles: `customer`, `support`, `fulfilment`, `finance`, `admin`, `super_admin`.
- RBAC is permission-based; roles are bundles of permissions.
- MFA is required for privileged administrative roles.
- Sensitive operations require a reason and generate an audit record. They include settlement, wallet adjustments, refunds, Germany activation and major configuration changes.

## Consequences

- Implemented in Phase 2.
- Which roles count as "privileged" is OPEN O8 (proposal: all staff roles).
- The exact list of "major configuration changes" is OPEN O9.

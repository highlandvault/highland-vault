# ADR-0018: Legacy data migration

## Status

Accepted — 2026-09-21 (decision D18, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D18.

## Decision

- Migration discovery begins early. The inventory covers:
  - WordPress, WooCommerce, competition plugins, wallet plugins and instant-win functionality;
  - users, orders, tickets, winners, wallet transactions, referrals, open draws, fulfilment and payment records.
- Migration must be deterministic and reproducible:
  inventory → mapping → test import → reconciliation → rehearsal → final delta → production cutover → rollback window.
- Production migration data is never modified manually.

## Consequences

- Tooling lives in `tools/migration` (Phase 13). The inventory lives in `docs/migration/INVENTORY.md` (started Phase 1).
- Target IDs are UUIDv5 derived from legacy identifiers.
- Discovery is blocked on legacy access (OPEN O17).

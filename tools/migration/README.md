# tools/migration

This will hold the legacy WordPress/WooCommerce → Highland Vault data migration tooling (ADR-0018, Phase 13).

**Phase 1 status:** placeholder only. No tooling is written, because it depends on the legacy data inventory (`docs/migration/INVENTORY.md`), which is blocked on access to the legacy system (OPEN O17).

The planned flow is inventory → mapping → test import → reconciliation → rehearsal → final delta → production cutover → rollback window.

Principles:

- **Deterministic.** The same input dump always produces the same output. Target IDs are UUIDv5 derived from `(source_system, source_table, legacy_id)`, and every run records its input checksum.
- **Read-only against the legacy source.** Extractors never write to WordPress.
- **No manual edits.** Corrections are code or mapping changes and re-runs, never hand edits to data.
- **Reconciled.** Counts and sums are compared per entity, market and currency. The tolerance for money and tickets is zero.

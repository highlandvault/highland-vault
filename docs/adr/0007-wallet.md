# ADR-0007: Wallet

## Status

Accepted — 2026-09-21 (decision D7, Project Initialization Report Revision 2, Part A)

## Context

Lost wallet credit is a critical incident to prevent (SPEC §3). The ledger is append-only and the balance is a cache (SPEC §4).

## Decision

- One wallet per currency: GBP and EUR.
- Initial credit sources: instant wins, refunds, referral rewards, Vault Meter rewards and approved admin credits.
- In V1 there are no arbitrary top-ups and no cash withdrawal.
- Wallet credit never expires automatically, unless a future approved business or legal requirement demands it.
- Wallet entries remain append-only, and corrections are reversing ledger entries.

## Consequences

- Every credit and debit carries a unique idempotency key derived from its source.
- The `hv_forbid_update_delete()` trigger function (migration 0001), plus revoking UPDATE/DELETE from the runtime role, make the ledger immutable.
- Implemented in Phase 7. Spending one EUR wallet across IE and DE is ADR-0023.

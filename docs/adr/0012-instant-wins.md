# ADR-0012: Instant wins

## Status

Accepted — 2026-09-21 (decision D12, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D12.

## Decision

- Winning ticket numbers are predefined.
- Initial prize types are wallet credit and physical prize. Cash instant-win prizes are not assumed.
- An instant-win ticket remains eligible for the main draw.
- Instant wins are kept separate from main-draw winners.
- Database uniqueness and idempotency guarantee that a prize cannot be awarded twice.

## Consequences

- Implemented in Phase 8: `UNIQUE(instant_win_prize_id)` on awards, with ledger key `instant_win_award:{id}`.
- A recipient without a wallet is ADR-0022.

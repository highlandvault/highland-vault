# ADR-0014: Settlement

## Status

Accepted — 2026-09-21 (decision D14, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D14.

## Decision

- Settlement runs automatically after the scheduled draw close.
- It uses:
  - draw row locking;
  - a cryptographically secure random seed;
  - deterministic winner selection;
  - a stored seed, algorithm version and eligible-ticket-set hash;
  - unique winner positions;
  - audit logging.
- Settlement is idempotent: if several settlement requests happen concurrently, only one performs it.
- When the scheduled close time arrives, the draw is settled even if it has not sold out.
- Winner positions are configurable per draw.
- No external or live draw mechanism in V1.

## Consequences

- Implemented in Phase 9 with critical gate 5 and the target of settling 50,000 tickets in under 5 s.
- The grace period is ADR-0024. Edge cases are ADR-0025.

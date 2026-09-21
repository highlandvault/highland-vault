# ADR-0011: Ticket engine

## Status

Accepted — 2026-09-21 (decision D11, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D11.

## Decision

- A pre-generated ticket pool is created when a draw is published.
- Invariant: `UNIQUE(draw_id, ticket_number)`.
- Allocation is transactional, with row locking and `FOR UPDATE SKIP LOCKED`.
- Tickets are reserved during checkout with an initial reservation TTL of **10 minutes**. Expired reservations are released safely through background processing.
- If more tickets are requested than are available, the request is **rejected**; it is never partially fulfilled.
- Postal entries use the same allocation mechanism.

## Consequences

- Implemented in Phase 4, with critical gates 1 (no double sale) and 2 (caps).
- The Phase 1 infrastructure test `packages/db/test/concurrency.int.test.ts` proves the harness exercises real `SKIP LOCKED` behaviour.
- Customer-visible numbering (random vs sequential) is OPEN O15.

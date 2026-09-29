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

## Amendment — 2026-09-25 (P5-8, ADR-0021 bridging)

The engine now takes **one advisory lock**, and only one. Everything else is unchanged: row locks, `FOR UPDATE SKIP LOCKED`, READ COMMITTED, and the entrant-counter-then-tickets lock order all stand.

`lockEntrantEmail` takes `pg_advisory_xact_lock` on a normalized email, and is taken by exactly two paths: a guest allocation, before it resolves whether that address belongs to an account, and registration, before it creates one.

It exists because row locks cannot serialise those two. The losing race is a row that **does not exist yet**: the guest resolves "no account", the registration commits and bridges, and the guest then writes a fresh email-keyed counter behind it — leaving the cap split across two keys, which is the thing ADR-0021 is for.

It is not a lock on tickets, reservations or draws. It orders two identity decisions, it is transaction-scoped so it is released however the transaction ends, and no allocation waits on another buyer because of it.

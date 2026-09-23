# ADR-0027: Sequential ticket numbers

## Status

Accepted — 2026-09-22 (owner decision on O15, Revision 2 Part G). Needed by Phase 4.

## Context

Revision 2 B9 pre-generates each draw's ticket pool with numbers 1..N and left open (O15) whether customers receive random or sequential numbers. The proposal was random allocation through a `shuffle_key`.

## Decision

- **Ticket numbers are sequential.** The pool holds 1..N (N = the draw's `total_tickets`), created once from the draw configuration when the draw is published.
- Allocation takes the **lowest available numbers** (`ORDER BY ticket_number`), still with `FOR UPDATE SKIP LOCKED` so concurrent buyers never wait for each other or receive the same ticket.
- Numbers are stored as integers. Zero-padding (for example `#00021`) is a presentation concern.

## Consequences

- There is no `shuffle_key` column.
- Because concurrent buyers skip each other's locked rows, one buyer's numbers are not necessarily contiguous.
- Settlement (Phase 9) is unaffected: it orders eligible tickets by `ticket_number` anyway.

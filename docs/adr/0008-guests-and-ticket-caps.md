# ADR-0008: Guests and ticket caps

## Status

Accepted — 2026-09-21 (decision D8, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D8.

## Decision

- Guests can browse, answer skill questions, purchase tickets and pay.
- Guests do not initially get wallet functionality, referral rewards or Vault Meter benefits.
- Ticket-cap identity:
  - authenticated user → user ID;
  - guest → normalized **verified** email.
- No address, card or device fingerprinting in V1. The design stays extensible for stronger identity or cap enforcement later.

## Consequences

- Cap counters are keyed by `(draw_id, entrant_type, entrant_ref)`. A new `entrant_type` can add stronger identity later.
- Guest email verification is ADR-0020. Guest → account bridging is ADR-0021.

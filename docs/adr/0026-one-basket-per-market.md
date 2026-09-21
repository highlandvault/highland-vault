# ADR-0026: One basket and order per market

## Status

Accepted — 2026-09-21 (owner approval of O18, Revision 2 Part G). Needed by Phase 5.

> The owner approved this item on 2026-09-21 without restating it, so it is recorded exactly as proposed in Revision 2 Part G. If the approved decision differs, amend this ADR.

## Context

ADR-0004 makes every draw single-market and single-currency.

## Decision

- A basket cannot mix UK and IE draws. There is **one basket (and order) per market**.

## Consequences

- Every order has a single currency. Cross-market baskets are rejected by the API.

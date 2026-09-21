# ADR-0022: Wallet-credit instant win for a recipient without a wallet

## Status

Accepted — 2026-09-21 (owner approval of O3, Revision 2 Part G). Needed by Phase 8.

> The owner approved this item on 2026-09-21 without restating it, so it is recorded exactly as proposed in Revision 2 Part G. If the approved decision differs, amend this ADR.

## Context

Guests and postal entrants without an account have no wallet (ADR-0008), but can hold instant-win tickets (ADR-0012, ADR-0013).

## Decision

- The award is recorded as `pending_claim` against the verified email.
- It is credited when an account with that email claims it.

## Consequences

- Crediting uses the same idempotency key (`instant_win_award:{id}`), so a claim can never double-credit.

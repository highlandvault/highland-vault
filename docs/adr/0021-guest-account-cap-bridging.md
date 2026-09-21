# ADR-0021: Guest → account ticket-cap bridging

## Status

Accepted — 2026-09-21 (owner approval of O2, Revision 2 Part G). Needed by Phases 4 and 5.

> The owner approved this item on 2026-09-21 without restating it, so it is recorded exactly as proposed in Revision 2 Part G. If the approved decision differs, amend this ADR.

## Context

Without bridging, someone could buy up to the cap as a guest and then again as a registered user with the same email.

## Decision

- If an account already exists for a guest's verified email, the purchase is attributed to that user ID.
- When a guest later registers with the same verified email, their email-keyed cap counters are **merged into the user key in one transaction**.

## Consequences

- A concurrency test of registration racing a guest purchase is required in Phase 4/5.

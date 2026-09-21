# ADR-0020: Guest email verification

## Status

Accepted — 2026-09-21 (owner approval of O1, Revision 2 Part G). Needed by Phase 5.

> The owner approved this item on 2026-09-21 without restating it, so it is recorded exactly as proposed in Revision 2 Part G. If the approved decision differs, amend this ADR.

## Context

ADR-0008 requires a **verified** email as the cap identity for guests.

## Decision

- Guest email is verified by a **6-digit one-time code emailed during checkout, before the order is created**.
- The verified email is bound to the session for a short time.

## Consequences

- Codes are stored hashed, with limited attempts and a short expiry. The exact values are implementation choices, documented in Phase 5.

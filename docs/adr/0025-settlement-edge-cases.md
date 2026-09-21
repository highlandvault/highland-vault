# ADR-0025: Settlement with too few eligible tickets

## Status

Accepted — 2026-09-21 (owner approval of O6, Revision 2 Part G). Needed by Phase 9.

> The owner approved this item on 2026-09-21 without restating it, so it is recorded exactly as proposed in Revision 2 Part G. If the approved decision differs, amend this ADR.

## Context

ADR-0014 settles at close even when a draw has not sold out.

## Decision

- Winner positions are filled **up to the number of eligible tickets**.
- The remaining positions are left unawarded and the draw is flagged for admin attention.
- Zero eligible tickets is a special case of this rule.

## Consequences

- **Still OPEN:** the policy for cancelling a draw that is already live needs a separate business rule, which Revision 2 did not propose.

# ADR-0023: One EUR wallet shared by Ireland and Germany

## Status

Accepted — 2026-09-21 (owner approval of O4, Revision 2 Part G). Needed by Phase 12 (before DE enablement).

> The owner approved this item on 2026-09-21 without restating it, so it is recorded exactly as proposed in Revision 2 Part G. If the approved decision differs, amend this ADR.

## Context

ADR-0007 defines one wallet per currency, and both IE and DE use EUR.

## Decision

- One EUR wallet is technically shared by IE and DE, so credit earned in IE could be spent on DE draws once Germany is enabled.
- Revision 2 proposed deciding this **before DE enablement**.

## Consequences

- Nothing Germany-related is enabled in the meantime.
- Every wallet entry records its origin `market_id`, which keeps any later restriction possible.

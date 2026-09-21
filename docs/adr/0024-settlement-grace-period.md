# ADR-0024: Settlement grace period after close

## Status

Accepted — 2026-09-21 (owner approval of O5, Revision 2 Part G). Needed by Phase 9.

> The owner approved this item on 2026-09-21 without restating it, so it is recorded exactly as proposed in Revision 2 Part G. If the approved decision differs, amend this ADR.

## Context

A customer who pays at the moment of close could otherwise miss the draw.

## Decision

- At `closes_at` the draw moves to `closed` and new reservations stop.
- **Settlement runs at `closes_at` + 10-minute reservation TTL + 2 minutes (12 minutes).** By then every in-flight checkout is either confirmed or released.

## Consequences

- Reserved tickets are never eligible for the draw.
- Payments confirmed after settlement follow the late-payment path (refund policy, OPEN O7).

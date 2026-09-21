# ADR-0005: Market routing and the Germany gate

## Status

Accepted — 2026-09-21 (decision D5, Project Initialization Report Revision 2, Part A)

## Context

Germany must remain disabled until legal approval (SPEC §7, §8).

## Decision

- Routes are `/uk`, `/ie` and `/de`.
- Germany stays disabled until legal approval.
- **The API must enforce the gate.** Hiding Germany in the frontend is not sufficient.

## Consequences

- Phase 1 (web only): the static route allow-list contains `uk` and `ie`, so `/de` returns 404.
- Phase 2 adds three layers:
  1. a DB CHECK that forbids enabling a legally-gated market without a recorded approval;
  2. the `ENABLED_MARKETS` environment kill switch;
  3. an API guard rejecting disabled markets.
- Activating Germany is a sensitive operation (ADR-0010).

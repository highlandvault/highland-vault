# ADR-0019: Days are phases, gated by the Definition of Done

## Status

Accepted — 2026-09-21 (decision D19, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D19.

## Decision

- Day 1–15 are development **phases**, not calendar deadlines.
- A phase is complete only when its Definition of Done (PLAN §6) is satisfied.
- Critical tests are never skipped to maintain a schedule.

## Consequences

- `docs/PROJECT_STATUS.md` reports phase status against the Definition of Done.
- Each phase stops for owner review before the next one begins.

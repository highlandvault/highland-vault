# ADR-0016: Compliance configuration

## Status

Accepted — 2026-09-21 (decision D16, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D16.

## Decision

- Legal rules are never invented.
- Market-specific compliance configuration must be possible for:
  - skill question and free postal entry;
  - DOB/age and self-exclusion where required;
  - marketing consent and deletion/anonymisation;
  - masked winner identity;
  - market-specific terms;
  - Germany legal approval.
- Germany stays disabled until legal approval.
- Any legal or business rule that is not defined is marked OPEN.

## Consequences

- Compliance values are typed, nullable settings. A market cannot be enabled while any required value is unset (Phases 2 and 12).
- The values themselves are OPEN O12.

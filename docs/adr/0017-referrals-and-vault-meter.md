# ADR-0017: Referrals and Vault Meter as configurable infrastructure

## Status

Accepted — 2026-09-21 (decision D17, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D17.

## Decision

- No reward amounts or qualification rules are hard-coded.
- Configurable infrastructure covers:
  - referral codes, referral attribution, qualifying actions and referral rewards;
  - milestone definitions, thresholds, progress and awards.
- `UNIQUE(user_id, milestone_id)` is enforced on milestone awards.

## Consequences

- Implemented in Phase 11. The strategies and values are OPEN O11.

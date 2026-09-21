# ADR-0003: Users and markets

## Status

Accepted — 2026-09-21 (decision D3, Project Initialization Report Revision 2, Part A)

## Context

Customers may take part in both the UK and Ireland markets.

## Decision

- A single user account can use both UK and IE. Users are **not** permanently assigned to a market.
- Email is **globally unique**.
- Market context belongs to the relevant draw, order, payment, currency, terms and consent.

## Consequences

- `users` has no `market_id`. Consents and terms acceptances are recorded per market.
- Implemented from Phase 2.

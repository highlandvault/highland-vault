# ADR-0004: Each draw belongs to exactly one market (V1)

## Status

Accepted — 2026-09-21 (decision D4, Project Initialization Report Revision 2, Part A)

## Context

Pricing, payment, terms, eligibility and reporting must stay isolated per market.

## Decision

- In V1 every draw belongs to exactly ONE market: UK draw → GBP, Ireland draw → EUR, Germany draw → EUR.
- A draw never sells tickets in several markets at once.
- The architecture stays extensible to multi-market draws if required later.

## Consequences

- The draw's currency is pinned to its market by a composite FK.
- `order_items` snapshot `market_id`, `currency` and unit price, so reporting never depends on `draws.market_id`.
- A future `draw_market_offers` table could add multi-market selling without changing the per-draw ticket pool. Nothing is built for this in V1.

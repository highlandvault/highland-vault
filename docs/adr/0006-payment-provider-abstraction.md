# ADR-0006: Provider-independent payments

## Status

Accepted — 2026-09-21 (decision D6, Project Initialization Report Revision 2, Part A)

## Context

The production payment provider will be chosen after merchant/provider approval (OPEN O13).

## Decision

- Commerce code depends on a provider-independent interface with four operations: **create payment**, **verify webhook**, **retrieve payment status** and **refund**.
- A **fake payment provider** is used for development and automated tests.
- No production provider is hard-coded into core commerce logic.
- The browser redirect **never** marks an order paid. Only a verified provider webhook or a trusted server-side provider status check can confirm payment.

## Consequences

- Implemented in Phase 6 (`packages/payments`).
- The fake provider simulates duplicate, late, out-of-order and missing webhooks for idempotency tests.

# ADR-0015: Initial reports

## Status

Accepted — 2026-09-21 (decision D15, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D15.

## Decision

Initial reports, all with CSV export:

- sales by draw, sales by market, sales by date
- orders, tickets
- wallet liability, wallet credits/debits
- refunds
- instant-win awards, main-draw winners
- fulfilment
- reconciliation
- compliance/audit activity

## Consequences

- Implemented in Phase 10.
- Amounts are grouped per currency and never summed across GBP and EUR.
- Exports are permission-gated and audit-logged.

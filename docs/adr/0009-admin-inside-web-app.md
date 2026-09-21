# ADR-0009: Admin inside the main Next.js application

## Status

Accepted — 2026-09-21 (decision D9, Project Initialization Report Revision 2, Part A)

## Context

See Project Initialization Report Revision 2, decision D9.

## Decision

- The admin UI is `/admin` inside the main Next.js application. There is no separate admin application in V1.
- The API remains the security boundary and enforces permissions independently of what the frontend shows.

## Consequences

- The admin shell is built in Phase 2.

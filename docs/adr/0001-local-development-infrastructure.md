# ADR-0001: Local development infrastructure

## Status

Accepted — 2026-09-21 (decision D1, Project Initialization Report Revision 2, Part A)

## Context

Business invariants (tickets, caps, wallet, settlement) can only be proven against real PostgreSQL locking behaviour. The environment must be reproducible for a single developer and for CI.

## Decision

- Docker Desktop and Docker Compose run PostgreSQL, Redis and Mailpit locally.
- pnpm workspaces, with pnpm provided by Corepack (version pinned in `package.json#packageManager`).
- The local environment must support real PostgreSQL concurrency testing. **No mocked databases (and no SQLite)** are used to validate ticket locking, wallet races or settlement concurrency.

## Consequences

- `docker-compose.yml` is the single definition of local infrastructure. CI uses the same file and the same bootstrap script.
- Integration tests require the stack (`pnpm infra:up`).
- Phase 1 images: `postgres:18.6-alpine`, `redis:7.4.11-alpine`, `axllent/mailpit:v1.31.2`. All ports bind to 127.0.0.1.

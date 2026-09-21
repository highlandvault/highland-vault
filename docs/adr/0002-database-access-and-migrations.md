# ADR-0002: Database access and plain-SQL migrations

## Status

Accepted — 2026-09-21 (decision D2 (tool design: Revision 2 Part H1 item 5), Project Initialization Report Revision 2, Part A)

## Context

The core invariants depend on explicit SQL: transactions, `FOR UPDATE`, `SKIP LOCKED`, UNIQUE/CHECK constraints, indexes and triggers. The schema must be exactly what is written.

## Decision

- PostgreSQL is the source of truth (SPEC §13).
- Application data access uses **Kysely**. **No Prisma, no TypeORM.** Explicit SQL is used where required.
- The schema is managed with **plain SQL migrations** through a small custom tool in `packages/db`, kept separate from Kysely:
  - files are `NNNN_name.sql`, contiguous from 0001, forward-only;
  - each file runs in its own transaction, unless its first line is `-- migrate:no-transaction` (single statement);
  - history is kept in `public.schema_migrations` with a SHA-256 checksum per file (line endings normalised first);
  - the tool refuses to run on any drift: an edited, renamed, deleted or out-of-order file, or an unexpected directory entry;
  - a PostgreSQL advisory lock serialises concurrent runners;
  - commands are `up`, `status` and `verify` (verify = no drift and nothing pending).
- Kysely types are generated from the migrated database (`pnpm db:codegen`) and committed.

## Consequences

- Applied migrations are immutable; corrections are new migrations.
- The migration role (`hv_owner`) is separate from the runtime role (`hv_app`, DML only).
- Engine is PostgreSQL 18. The fallback is 17 plus app-generated UUIDv7 if the production host lacks 18 (OPEN O14).

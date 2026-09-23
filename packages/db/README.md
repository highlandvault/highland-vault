# @hv/db

PostgreSQL access for Highland Vault (ADR-0002). This package contains:

| Path                  | Purpose                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client.ts`       | `createDb()`: Kysely over a `pg` pool with safe int8 parsing                                                                             |
| `src/int8.ts`         | `bigint` columns become JS numbers **only if exactly representable**; otherwise an error is thrown (money is never silently rounded)     |
| `src/transaction.ts`  | `withTransaction()`: retries the whole transaction on `40001` (serialization failure) and `40P01` (deadlock) only                        |
| `src/migrate/`        | The plain-SQL migration tool                                                                                                             |
| `migrations/`         | The migration files: `NNNN_name.sql`                                                                                                     |
| `src/generated/db.ts` | Kysely table types generated from the migrated DB. Do not edit.                                                                          |
| `src/testing/`        | Real-PostgreSQL integration test harness (template DB, throwaway DBs, barrier) and test-only fixtures (`fixtures.ts`, `e2e-database.ts`) |

## Migration tool

```bash
pnpm db:migrate up       # apply pending migrations (in order, each in its own transaction)
pnpm db:migrate status   # table of applied / pending / changed / missing migrations
pnpm db:migrate verify   # exit 1 unless the database matches the files exactly
pnpm db:codegen          # regenerate src/generated/db.ts after adding a migration
```

The tool connects with `MIGRATION_DATABASE_URL` (the owner role `hv_owner`). `--dir <path>` overrides the migrations directory.

### Rules

1. **Naming.** Files are `NNNN_snake_case.sql`, contiguous from `0001`. Anything else in `migrations/` makes the tool refuse to run.
2. **Applied migrations are immutable.** A SHA-256 checksum of each file is recorded in `schema_migrations`. If a file is edited, renamed or deleted after being applied, `up` refuses to run and `verify` fails. Fix mistakes with a new migration.
   - Line endings are normalised before hashing, so a Windows checkout matches CI.
3. **One transaction per file.** If any statement fails, the whole file is rolled back and not recorded, and earlier files stay applied.
4. **Non-transactional statements.** Some statements, such as `CREATE INDEX CONCURRENTLY`, cannot run in a transaction. Put `-- migrate:no-transaction` as the file's **first line**. The file must contain a single statement, and it should be idempotent (`IF NOT EXISTS`), because it is recorded only after it succeeds.
5. **Concurrency.** A PostgreSQL advisory lock serialises runners, so two deploys running `up` at once apply each migration exactly once.
6. **Forward-only.** There are no down migrations.

### Roles

- `hv_owner` owns the schema and runs migrations.
- `hv_app` is the runtime role (api and worker). Default privileges give it DML on new tables; append-only tables revoke UPDATE/DELETE from it in their own migrations.
- `hv_app` can only read `schema_migrations`.

## Schema

| Migration                   | Contents                                                                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001_foundation             | `hv_forbid_update_delete()` for append-only tables                                                                                                                                                                                                                         |
| 0002_extensions_and_helpers | `citext`, `hv_set_updated_at()`                                                                                                                                                                                                                                            |
| 0003_users                  | `users`: normalized, globally unique email (citext); Argon2id hashes only; no market column (ADR-0003)                                                                                                                                                                     |
| 0004_markets                | `markets`, `market_settings`; fixed market definitions; Germany legal-approval CHECK; compliance gate                                                                                                                                                                      |
| 0005_sessions_and_mfa       | `sessions` (token hash only), `user_mfa` (encrypted TOTP secret), `mfa_recovery_codes` (hashes)                                                                                                                                                                            |
| 0006_rbac                   | `roles`, `permissions`, `role_permissions` (Revision 2 B7 matrix), `user_roles` (optionally market-scoped)                                                                                                                                                                 |
| 0007_audit_log              | append-only `audit_log` (trigger + REVOKE)                                                                                                                                                                                                                                 |
| 0008_draws                  | `draws` (one market; currency pinned by the `(market_id, currency)` FK; lifecycle trigger; frozen once published), `draw_prizes` (one per winner position), `skill_questions` + options (same market; exactly one correct option)                                          |
| 0009_tickets                | `tickets` (pool 1..N created when a draw is published; `UNIQUE(draw_id, ticket_number)`; guarded state machine), `reservations` (at most 10 minutes, exact total, one market), `draw_entrant_counts` (per-entrant cap); `hv_end_reservation()`, `hv_expire_reservations()` |

`hv_draw_publish_blockers(draw_id)` is the single definition of what a draft still needs before it can be published.

`hv_market_missing_settings(market_id)` is the single definition of which compliance settings are required before a market can be enabled.

Test fixtures (`src/testing/fixtures.ts`) enable markets **in throwaway test databases only**. Their compliance values are placeholders for tests, not decisions (O12 is OPEN).

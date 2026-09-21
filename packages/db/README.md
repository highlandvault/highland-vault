# @hv/db

PostgreSQL access for Highland Vault (ADR-0002). This package contains:

| Path                  | Purpose                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/client.ts`       | `createDb()`: Kysely over a `pg` pool with safe int8 parsing                                                                         |
| `src/int8.ts`         | `bigint` columns become JS numbers **only if exactly representable**; otherwise an error is thrown (money is never silently rounded) |
| `src/transaction.ts`  | `withTransaction()`: retries the whole transaction on `40001` (serialization failure) and `40P01` (deadlock) only                    |
| `src/migrate/`        | The plain-SQL migration tool                                                                                                         |
| `migrations/`         | The migration files: `NNNN_name.sql`                                                                                                 |
| `src/generated/db.ts` | Kysely table types generated from the migrated DB. Do not edit.                                                                      |
| `src/testing/`        | Real-PostgreSQL integration test harness (template DB, throwaway DBs, barrier)                                                       |

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

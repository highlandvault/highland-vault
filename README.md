# Highland Vault

This is the native Highland Vault competition platform, replacing the WordPress/WooCommerce build.

- **Architecture and decisions:** [docs/PROJECT_INITIALIZATION_REPORT.md](docs/PROJECT_INITIALIZATION_REPORT.md) (Revision 2) and [docs/adr/](docs/adr/README.md)
- **Current status:** [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)
- **Working on the project (developers and Claude):** [docs/DEVELOPMENT_RULES.md](docs/DEVELOPMENT_RULES.md) and [docs/collaboration/](docs/collaboration/TASK_BOARD.md)

## Repository layout

```
apps/
  api/        NestJS (Fastify) HTTP API — health, markets (gate), draws, tickets + reservations, auth + MFA, RBAC, audit, admin APIs
  worker/     NestJS standalone + BullMQ background worker — heartbeat, draw lifecycle sweep, reservation expiry
  web/        Next.js App Router — /[market] customer site (draws, ticket reservations), sign-in, /admin (markets, draws)
packages/
  config/     shared tsconfig, ESLint and Prettier presets
  contracts/  Zod schemas shared by api and web
  db/         Kysely client, plain-SQL migration tool, migrations, real-PostgreSQL test harness
  domain/     pure business rules (Money, email identity, markets, draw lifecycle, tickets, market time zones)
tools/
  migration/  legacy data migration (Phase 13; placeholder)
infra/docker/ local-only PostgreSQL bootstrap (roles + database)
docs/         status, ADRs, initialization report, migration inventory
```

## Prerequisites

- **Node.js 24** (see `.nvmrc`)
- **Corepack** (ships with Node) for pnpm. If `corepack enable` fails with `EPERM` on Windows, install the shims into a user directory instead:
  `corepack enable --install-directory "%APPDATA%\npm"`
- **Docker Desktop** (WSL2 backend on Windows) with Docker Compose v2

## First-time setup

```bash
cp .env.example .env          # local-only placeholder values; never commit .env
pnpm install
pnpm infra:up                 # PostgreSQL 18, Redis 7.4, Mailpit — waits until healthy
pnpm db:migrate up
pnpm db:migrate verify
```

**Markets start disabled.** A market can only be enabled once its compliance settings exist, and those values are still OPEN (O12, ADR-0016). So on a fresh database `/uk` and `/ie` return 404, like `/de`. This is intended. The Playwright suite (`pnpm test:e2e`) runs against its own `hv_e2e` database, which enables UK and IE with labelled **test fixture** values.

**First staff account.** Register through the web app, then grant a role with the audited operator CLI:

```bash
pnpm --filter @hv/api build
pnpm --filter @hv/api cli:grant-role -- --email you@example.com --role super_admin --reason "Why this account needs the role"
```

Market gate changes (`/admin/markets/:market/...` on the API) are sensitive operations: they need `markets.gate.manage`, a second factor verified in the last 15 minutes (enrol TOTP via `/auth/mfa/totp/setup`), and a reason.

## Everyday commands

| Command                                              | What it does                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                           | Build the shared packages, then run the api (:4000), worker and web (:3000)                        |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` | Static checks                                                                                      |
| `pnpm test`                                          | Unit tests (no infrastructure needed)                                                              |
| `pnpm test:integration`                              | Integration tests against the **real** PostgreSQL and Redis containers                             |
| `pnpm test:e2e`                                      | Playwright smoke tests: built API (:4100) + web (:3100) on a throwaway DB (run `pnpm build` first) |
| `pnpm build`                                         | Build every workspace                                                                              |
| `pnpm verify`                                        | Everything CI runs, in order (except the secret scan and e2e)                                      |
| `pnpm db:migrate up \| status \| verify`             | Migration tool (see [packages/db/README.md](packages/db/README.md))                                |
| `pnpm db:codegen`                                    | Regenerate Kysely types after a migration                                                          |
| `pnpm infra:down` / `pnpm infra:reset`               | Stop the stack, or wipe its volumes and start it again                                             |

## Local services

| Service       | Address                            | Notes                                                                                        |
| ------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| PostgreSQL 18 | `127.0.0.1:5432`                   | DB `highland_vault`. Roles: `hv_owner` (migrations), `hv_app` (runtime, DML only)            |
| Redis 7.4     | `127.0.0.1:6379`                   | DB 0 for development, DB 15 for tests, DB 14 for e2e (emptied per run); AOF on, `noeviction` |
| Mailpit SMTP  | `127.0.0.1:1025`                   | Catches all outgoing mail                                                                    |
| Mailpit UI    | http://127.0.0.1:8025              |                                                                                              |
| API           | http://127.0.0.1:4000/health/ready | 200 when PostgreSQL and Redis are up, otherwise 503                                          |
| Web           | http://127.0.0.1:3000              |                                                                                              |

## Engineering rules (summary)

- PostgreSQL is the source of truth. Money is always integer minor units, never floats.
- Concurrency is proven only against real PostgreSQL. No mocked databases.
- Applied migrations are never edited.
- Never commit secrets. `.env.example` holds local-only placeholders.

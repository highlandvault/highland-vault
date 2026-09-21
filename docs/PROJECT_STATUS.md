# Highland Vault — Project Status

_Last updated: 2026-09-21_

## Current phase

**Phase 1 (Day 1): Foundation — complete, awaiting owner review.**

Every Definition of Done item below was verified by actually running it on the development machine: Windows 11, Docker Desktop 29.8.0, Compose v5.5.1, Node 24.11.1, pnpm 10.34.5. **Phase 2 has not started** and will not start without explicit approval.

## Day 1 Definition of Done

| Item                                                  | Status | Evidence                                                                                                                                        |
| ----------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo/workspace exists                             | ✅     | `apps/{api,worker,web}`, `packages/{config,contracts,db,domain}`, `tools/migration`                                                             |
| pnpm/Corepack configuration works                     | ✅     | pnpm 10.34.5 via Corepack (`packageManager` pin)                                                                                                |
| PostgreSQL 18 starts                                  | ✅     | `postgres:18.6-alpine` healthy; `PostgreSQL 18.6`; roles `hv_owner` (CREATEDB, not superuser) and `hv_app` created; DB owned by `hv_owner`      |
| Redis starts                                          | ✅     | `redis:7.4.11-alpine` healthy; `maxmemory-policy noeviction`, `appendonly yes`                                                                  |
| Mailpit starts                                        | ✅     | `axllent/mailpit:v1.31.2` healthy; `/readyz` 200; test mail sent over SMTP :1025 was captured (API shows 1 message)                             |
| Health checks work                                    | ✅     | Compose healthchecks all `healthy`; live API `/health/live` 200 and `/health/ready` 200; 503 paths covered by integration tests                 |
| Environment configuration exists                      | ✅     | `.env.example` (required / optional / dev-only / prod-only); Zod validation in api, worker and web                                              |
| Migration tool exists                                 | ✅     | `pnpm db:migrate up \| status \| verify`                                                                                                        |
| Migration tool works against clean PostgreSQL         | ✅     | Verified twice: on first start, and after `pnpm infra:reset` wiped the volumes                                                                  |
| Migration status works                                | ✅     | `0001 pending` → `0001 applied`; `status: 1 applied, 0 pending, 0 problem(s)`                                                                   |
| Migration verification works                          | ✅     | Before `up`: `FAIL — 0001_foundation.sql is pending` (exit 1). After: `OK — 1 migration(s) applied, all checksums match, none pending` (exit 0) |
| API starts                                            | ✅     | Built `dist/main.js` listening on 127.0.0.1:4000                                                                                                |
| Worker starts                                         | ✅     | Startup check passed, `system` queue ready, heartbeat processed                                                                                 |
| Web starts                                            | ✅     | `next start`; `/` shows "API ok — database up, redis up"; `/uk` and `/ie` 200; `/de` and `/xx` 404                                              |
| Database connectivity verified                        | ✅     | API readiness `database: up`; API sessions connect as `hv_app` (`pg_stat_activity`); worker startup `SELECT 1` passed                           |
| Redis connectivity verified                           | ✅     | API readiness `redis: up`; worker heartbeat written to `hv:worker:last-heartbeat`                                                               |
| Real 10-connection PostgreSQL concurrency test passes | ✅     | 4/4 tests; **10/10 consecutive repeat runs passed**                                                                                             |
| Test foundation works                                 | ✅     | Unit 19/19, integration 38/38, Playwright 5/5                                                                                                   |
| CI configuration exists and is valid                  | ✅     | `.github/workflows/ci.yml`; actionlint 1.7.12: 0 errors. Not yet run on GitHub (nothing pushed)                                                 |
| ADR decision notes exist                              | ✅     | ADR-0001 to ADR-0026 plus index                                                                                                                 |
| PROJECT_STATUS.md exists                              | ✅     | This file                                                                                                                                       |
| No secrets committed                                  | ✅     | Nothing committed. gitleaks v8.30.1 over all 116 committable files: no leaks. `.env` is git-ignored                                             |
| No business features implemented                      | ✅     | Only health endpoints, a heartbeat job and route shells                                                                                         |
| Repository understandable and reproducible            | ✅     | README setup steps; clean-volume rebuild reproduced the same result                                                                             |

## Verified results

### Infrastructure (`pnpm infra:up`)

| Service    | Image                   | Status  | Port (127.0.0.1 only)  |
| ---------- | ----------------------- | ------- | ---------------------- |
| PostgreSQL | postgres:18.6-alpine    | healthy | 5432                   |
| Redis      | redis:7.4.11-alpine     | healthy | 6379                   |
| Mailpit    | axllent/mailpit:v1.31.2 | healthy | 1025 (SMTP), 8025 (UI) |

### Migrations (clean database)

- `up` applied `0001_foundation.sql`. Running it again reported "nothing to apply".
- Resulting objects:
  - table `schema_migrations`, owned by the migration tool; `hv_app` has **SELECT only**;
  - function `hv_forbid_update_delete`.
- The recorded checksum `9c121ea4…0532e` equals `sha256sum` of the file.

### Codegen

- `pnpm db:codegen` introspected 0 application tables (correct for Phase 1; `schema_migrations` is excluded) and wrote `src/generated/db.ts`.
- `codegen:verify` reports: up to date.

### Integration tests (`pnpm test:integration`, real PostgreSQL + Redis): 38/38 passed

| File                                        | Tests |
| ------------------------------------------- | ----- |
| `packages/db/test/concurrency.int.test.ts`  | 4     |
| `packages/db/test/migrate.int.test.ts`      | 12    |
| `packages/db/test/foundation.int.test.ts`   | 11    |
| `apps/api/test/health.int.test.ts`          | 8     |
| `apps/worker/test/system-queue.int.test.ts` | 3     |

### PostgreSQL concurrency test (infrastructure verification)

This test uses 10 separate `pg.Client` connections, confirmed to be 10 distinct backend PIDs, against PostgreSQL 18. It proves four things:

1. **Distinct connections.** The 10 connections really are 10 separate backends.
2. **SKIP LOCKED gives disjoint rows.** 10 transactions hold `FOR UPDATE SKIP LOCKED` locks at the same moment and each receives 10 rows. The 100 rows are all distinct, with no overlap. While the locks are held, an 11th session finds 0 lockable rows but can still read all 100 (MVCC).
3. **The harness can catch races.** An unlocked read-modify-write loses updates: the final value is 1, not 10.
4. **Locking prevents lost updates.** The same read-modify-write with `FOR UPDATE` gives the correct final value of 10.

It passed **10 out of 10 consecutive runs**.

### API (built, running for real)

- `GET /health/live` → **200** `{"status":"ok"}`
- `GET /health/ready` → **200** `{"status":"ok","checks":{"database":{"status":"up",…},"redis":{"status":"up",…}}}`
- Structured JSON logs carry `reqId`. A supplied `x-request-id` (≤128 characters) is propagated and echoed on the response; otherwise a UUID is generated.

### Worker (built, running for real)

- Logged: `startup check passed: PostgreSQL and Redis reachable` → `worker ready: queue "system", heartbeat every 60s` → `processed heartbeat`.
- On restart, exactly **1** job scheduler exists, so the upsert is idempotent.

### Final static checks

`pnpm verify` exit 0: format ✅, lint ✅, typecheck (6 workspaces) ✅, unit 19/19 ✅, migrate up/verify ✅, integration 38/38 ✅, build (7 workspaces) ✅. Playwright 5/5 ✅.

## Fixes made during Docker verification

1. **Three integration-test assertions were wrong.** These were test bugs only; no production code changed.
   - `SHOW server_version` and `SHOW transaction_isolation` name their result columns after the setting. The tests now use `current_setting(...) AS alias`.
   - BullMQ `getJobCounts('waiting')` also returns `paused`. The assertion was relaxed to `toMatchObject`.
2. **Request IDs weren't propagated.** Under the Fastify adapter, pino-http's `genReqId` is ignored: logs showed Fastify's default `req-1`, `req-2`, and a supplied `x-request-id` was dropped.
   - Request-ID generation moved to the Fastify adapter in `apps/api/src/app.ts`, and the ID is echoed on the response.
   - Two integration tests were added.

## Important technical decisions made during Phase 1

These are implementation choices within the approved architecture, recorded for review.

1. **Toolchain versions.** The latest release in each major version known to be mutually compatible:
   - NestJS 11.2.5, TypeScript 5.9.3, BullMQ 5.81.5, Vitest 4.1.11, ESLint 9.39.5, Kysely 0.28.17, Zod 4.6.5, Next.js 16.3.5, React 19.3.
   - Newer majors exist but were **not** adopted: NestJS 12, TypeScript 7, BullMQ 6, Vitest 5, ESLint 10.
   - Reasons: `typescript-eslint` does not support TypeScript ≥ 6.1 yet, and BullMQ 6 changed its connection model. Upgrading is a separate, deliberate task.
2. **pnpm 10.34.5**, the latest 10.x, pinned via `packageManager`.
3. **Migration tool location.** It lives in `packages/db` (Revision 2 Parts C/H), not `tools/migrate`. `tools/migration` is reserved for the legacy WordPress import (ADR-0018).
4. **`0001_foundation.sql` is narrower than Revision 2 H1 item 6.** Per the Day 1 instruction to create only infrastructure objects, the `citext` extension and `hv_set_updated_at()` are **deferred to Phase 2**. Only the append-only guard is included.
5. **API tests use Fastify's in-process `inject`** instead of Supertest.
6. **Web route allow-list is `uk` and `ie` only.** `/de` is a 404 (ADR-0005). Germany is not active anywhere.
7. **Redis DB 15 is reserved for tests** and DB 0 for development.
8. **Integration tests connect as `hv_owner`** (they need CREATEDB for throwaway databases). The running API is verified to connect as `hv_app`.

## Known issues

- **Graceful shutdown on OS signals is not verified on Windows.** Windows cannot deliver SIGTERM/SIGINT to a Node process from outside, so the dev processes were stopped with a forced kill. The shutdown hooks (`app.close()`, worker/queue close, DB/Redis teardown) are exercised by the integration tests on every run.
- **`corepack enable` needs admin rights** on this machine (`EPERM` on `C:\Program Files\nodejs`). The workaround, `corepack enable --install-directory "%APPDATA%\npm"`, is in the README.
- **npm flags ESLint 9 as "deprecated"** because ESLint 10 exists. It is functional and supported by the configs in use.
- **Vite warns about loading the config as CommonJS**, cosmetic only. `vitest.config.mts` is ESM; the warning comes from the Vite native config loader preview.
- **CI has not run on GitHub yet**, because nothing is pushed. It was validated locally with actionlint only.

## Open decisions (Revision 2 Part G, still unresolved)

| ID        | Question                                                                                                                                      | Needed by                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| O6 (part) | Policy for cancelling a draw that is already live                                                                                             | Phase 9                          |
| O7        | Refund policy: destination, refunds after close/settlement, tickets and instant wins on refunded orders                                       | Phases 6/10                      |
| O8        | Which roles are "privileged" for mandatory MFA                                                                                                | Phase 2                          |
| O9        | Exact list of "major configuration changes"                                                                                                   | Phases 2/10                      |
| O10       | Postal-entry rule values; maker-checker threshold for admin wallet credits                                                                    | Phases 7/10                      |
| O11       | Referral qualifying actions/rewards; Vault Meter metric, scope, thresholds, rewards                                                           | Phase 11                         |
| O12       | Compliance values: minimum age per market, wrong skill answer behaviour, self-exclusion scope, consent wording, retention, masked-name format | Phase 12 (skill answer: Phase 5) |
| O13       | Production payment provider(s)                                                                                                                | Before Phase 14                  |
| O14       | Hosting (and PostgreSQL 18 availability), email provider, storage/CDN, monitoring, analytics                                                  | Before Phase 13                  |
| O15       | Customer-visible ticket numbering: random vs sequential                                                                                       | Phase 4                          |
| O16       | Cash alternative for physical prizes                                                                                                          | Phases 8/9                       |
| O17       | Legacy access: plugin list and a sanitized WordPress DB export                                                                                | Now (migration discovery)        |

O1–O6 and O18 were approved by the owner on 2026-09-21. They are recorded in ADR-0020 to ADR-0026 as the Revision 2 proposals, because the approval did not restate them. If any approval differs from the proposal, amend the ADR.

## Blockers

- **Phase 1:** none.
- **Migration discovery:** O17, legacy system access.
- **Phase 2 decisions:** O8 and O9 are needed during Phase 2.

## Next task

**Stop for owner review of Phase 1.** Phase 2 (users, authentication/sessions, markets, RBAC, MFA, audit log, admin shell) starts only on explicit instruction.

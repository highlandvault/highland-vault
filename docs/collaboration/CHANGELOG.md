# Development Changelog

_Last updated: 2026-09-22_

Meaningful changes that other developers and Claude sessions need to know about. This is **not** a copy of Git history.

Record a change here when it:

- changes what another developer must do (new setup step, new environment variable, new command, new migration);
- changes a shared contract, module boundary, or convention;
- completes, blocks, or unblocks a phase or task;
- records an accepted ADR or an owner decision.

Don't record routine commits, refactors with no external effect, or test-only changes.

Format: newest first, one short line per change with its task and PR or commit. Unmerged work goes under **Unreleased**.

## Unreleased

- **P5-1:** Migration `0011_outbox`: transactional outbox (`outbox` table, guard trigger, `hv_claim_outbox`). Producers add an event with `enqueueOutboxEvent` inside their own transaction, so it commits or rolls back with the business change; the worker claims due events every 5 s with `FOR UPDATE SKIP LOCKED` and delivers them at least once. No producers or handlers yet (P5-2). Run `pnpm db:migrate up` and `pnpm db:codegen`. Next free migration number: `0012`.

- **P5-0:** Migration `0010_reservation_end_fix`: `hv_end_reservation` now returns the entrant-cap allowance for the ticket rows it actually freed (`GET DIAGNOSTICS`), not the reservation quantity, so tickets that are already sold keep counting against the cap (NB-1). Behaviour is unchanged for Phase 4 and Phase 5, where nothing writes `sold`. Run `pnpm db:migrate up`. Next free migration number: `0011`.

- **P4:** Merged into `develop` via PR #8 (`49e3903`) and released to `main` via PR #9 (`c284825`) on 2026-09-23. Phase 4 is DONE; review items carried into Phase 5 are in [PROJECT_STATUS.md](../PROJECT_STATUS.md) and [HANDOFFS.md](HANDOFFS.md).

- **P4:** O15 decided: sequential ticket numbers (ADR-0027).
- **P4:** Migration `0009_tickets`: `tickets`, `reservations`, `draw_entrant_counts`. Publishing a draw now creates its ticket pool (1..N) in the same transaction; at most 1,000,000 tickets per draw. Run `pnpm db:migrate up`. Next free migration number: `0010`.
- **P4:** Customer API: `GET /markets/:market/draws/:slug/availability`, `POST …/draws/:slug/reservations`, `GET /markets/:market/reservations[/:reservation]`, `POST …/reservations/:reservation/release`. Admin: `GET /admin/markets/:market/draws/:draw/inventory` (read-only).
- **P4:** New optional env variable `RESERVATION_TTL_SECONDS` (default 600; production refuses any other value; tests use short values).
- **P4:** New access policy `@Public({ identify: true })` for public routes that may recognise a signed-in caller, and the param decorator `@OptionalAuth()`.
- **P4:** The worker also runs the `reservations` expiry sweep every 30 s.
- **P4:** Web: draws take real reservations (signed-in customers); new page `/{market}/reservations/{id}`; the admin draw page shows the ticket inventory. The skill question is now shown as information (answered at checkout, Phase 5). e2e reservations last 60 s (test configuration).
- **P4:** The integration test project now runs on at most 4 workers. Each file starts its own database and NestJS app, and the new contention tests made a worker-per-core run fail on timeouts rather than on behaviour; capped, the suite is green and ~5x faster.

- **P3:** Migration `0008_draws`: draws, prizes (one per winner position) and skill questions. Run `pnpm db:migrate up`. Next free migration number: `0009`.
- **P3:** Customer API `GET /markets/:market/draws` and `/:slug`; admin draw API under `/admin/markets/:market/draws` (`draws.write`, scoped to the market). Correct skill answers never leave the admin API.
- **P3:** The worker now also runs the `draw-lifecycle` sweep every minute (scheduled → live → closed, audited).
- **P3:** The customer website starts: `/{market}`, `/{market}/draws`, `/{market}/draws/{slug}`, plus admin draw pages. Design tokens live in `apps/web/src/app/globals.css` (plain CSS, no UI framework). The web app now depends on `@hv/domain`.
- **P3:** e2e uses Redis DB 14 (emptied by `e2e:prepare`), 3 workers and a mobile project; seeded test draws live in `packages/db/src/testing/e2e-database.ts`.

- **Process:** Branch policy settled: `feature/*` → PR → `develop` (integration) → release PR → `main` (production). Task PRs target `develop`. DEVELOPMENT_RULES §4, §5, §7, §10 and the TASK_BOARD definition of DONE were updated.

- **P2:** Migrations `0002`–`0007` add users, markets + settings, sessions + MFA, RBAC and the audit log. Run `pnpm db:migrate up` after pulling. Next free migration number: `0008`.
- **P2:** New env variables: `ENABLED_MARKETS`, `WEB_ORIGINS` and `MFA_ENCRYPTION_KEY` are **required** (the API refuses to start without them); `SESSION_TTL_HOURS`, `SESSION_COOKIE_SECURE`, `MFA_ENCRYPTION_KEY_ID` and `TRUST_PROXY` are optional. Copy them from `.env.example` into your `.env`.
- **P2:** **All markets are disabled** on every real database until the O12 compliance values are supplied (ADR-0016), so `/uk` and `/ie` are 404 locally. Tests enable markets only in throwaway databases.
- **P2:** Convention: every API route declares `@Public()`, `@Authenticated()` or `@RequirePermission()`; routes without one are denied. Market-scoped routes use `@UseGuards(MarketGuard)`. Every API error is `{ error: { code, message, details? }, requestId }`.
- **P2:** State-changing API requests must send an `Origin` listed in `WEB_ORIGINS` (CSRF check).
- **P2:** `pnpm test:e2e` now starts the built API and web on ports 4100/3100 against a throwaway `hv_e2e` database. Run `pnpm build` first.
- **P2:** Operator CLI `pnpm --filter @hv/api cli:grant-role -- --email … --role … --reason …` bootstraps staff accounts (audited).

## 2026-09-22

- **T-001:** Collaboration and synchronization layer merged into `develop` (PR #2, `e05f270`).
- **P1:** Phase 1 (Foundation) approved by the owner.
- **P2:** Phase 2 started on owner instruction and merged into `develop` (PR #3, `6b0ea82`). The P2 entries under **Unreleased** are in `develop` and not yet released to `main`.

## 2026-09-21

- **P1:** Phase 1 Foundation committed (`a16ca35`): pnpm monorepo (`apps/{api,worker,web}`, `packages/{config,contracts,db,domain}`), Docker stack (PostgreSQL 18, Redis 7.4, Mailpit), plain-SQL migration tool (`pnpm db:migrate up | status | verify`), Kysely codegen, health endpoints, CI workflow, ADR-0001 to ADR-0026. Details and verification in [PROJECT_STATUS.md](../PROJECT_STATUS.md).

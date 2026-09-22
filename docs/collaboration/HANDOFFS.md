# Handoffs

_Last updated: 2026-09-22_

A handoff is written when another developer (or another developer's Claude session) needs to continue, integrate with, or depend on your work. It carries what the code and the commit messages don't: the decisions, traps, and state that someone continuing the work needs.

- Newest handoff first.
- Write it in the branch, and reference it from the PR's **Reviewer notes**.
- A handoff is never a substitute for tests or an ADR. If it records an architecture decision, that decision needs an ADR.
- When the receiving developer has picked the work up, they change the handoff's status to `ACCEPTED`. Do not delete old handoffs. They are the project's memory.

## Handoff format

```text
### <YYYY-MM-DD> — <Task ID> — <short title>

Status: OPEN | ACCEPTED (by <name>, <date>)

Task: <Task ID, issue #, PR #>
Developer: <who is handing off>
Branch: <branch; merged or not>
Status of the work: <DONE | PARTIAL | BLOCKED>

What was completed:
- ...

Important implementation details:
- non-obvious choices, invariants, traps

Files/modules affected:
- ...

Tests executed:
- exact commands and results (for example "pnpm test:integration: 42/42 passed")
- what was NOT tested

Known issues:
- ...

Integration points:
- what other areas call this or depend on it; contracts, events, queues, tables

Next developer action:
- the first concrete thing the next person should do
```

## Extra required details for sensitive areas

A handoff that touches one of these areas must also answer the listed questions. Write "N/A" only when it really does not apply.

| Area               | Also state                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Database**       | Migrations added (file names), whether applied anywhere shared, codegen re-run, locks and isolation level relied on, `hv_app` grants |
| **Authentication** | Session and token lifetimes, MFA / step-up behaviour, what an unauthenticated or wrong-market request gets                           |
| **Payments**       | Idempotency keys, webhook signature checks, states the payment can be left in, what the redirect is and isn't allowed to do (Gate 4) |
| **Tickets**        | Allocation and reservation invariants, cap keys, expiry behaviour, concurrency tests and their repeat-run results                    |
| **Wallet**         | Ledger entries created, balance invariants, reversal path, reconciliation impact                                                     |
| **Settlement**     | Determinism inputs, grace-period handling (ADR-0024), edge cases (ADR-0025), how to re-verify a result                               |
| **Infrastructure** | Environment variables added (placeholders in `.env.example` only), Docker / CI changes, what must be run after pulling               |
| **Security**       | Threats considered, permissions required, audit log entries, anything deliberately deferred                                          |

## Handoff log

### 2026-09-22 — P3 — Draws foundation (for Phase 4, the ticket engine)

Status: OPEN

Task: P3 (no GitHub issue; PR #7)
Developer: Divyanshu (owner), with Claude
Branch: `feature/p3-draws` (PR #7 into `develop`, not merged)
Status of the work: DONE, in review

What was completed:

- `0008_draws`: `draws`, `draw_prizes`, `skill_questions` + options, lifecycle trigger, publish requirements, configuration lock.
- `@hv/domain`: draw lifecycle, validation, publish blockers, effective status, market time zones, `parseDecimalMoney`.
- API `draws` module (customer + admin), worker `draw-lifecycle` sweep, customer and admin web pages.

Important implementation details:

- **Allocation must not trust the stored status alone:** use `effectiveStatus()` or check `opens_at`/`closes_at` in SQL (B9 step 0). The sweeper runs only once a minute.
- **The ticket pool belongs to the publish transition:** B9 says the pool is generated on publish. Hook it into `AdminDrawsService.publish` (same transaction) or into a new transition; `total_tickets` is frozen once published, so the pool size is stable.
- **Publishing locks the configuration:** `hv_draws_guard()` refuses changes to price, capacity, cap, positions, times, slug and question after draft.
- Every draw query is scoped by `market_id`. Keep it that way for tickets (`tickets.draw_id` → draw; the market comes through the draw).

Files/modules affected:

- `packages/db/migrations/0008_draws.sql`, `packages/db/src/testing/{fixtures,e2e-database}.ts`
- `packages/domain/src/{draws,time,money}.ts`, `packages/contracts/src/draws.ts`
- `apps/api/src/draws/`, `apps/worker/src/draws/`, `apps/web/src/app/[market]/`, `apps/web/src/app/admin/draws/`, `apps/web/src/components/`

Tests executed:

- `pnpm verify`: unit 126/126, integration 198/198. `pnpm test:e2e`: 33/33 (desktop + mobile). Concurrency files 5/5 repeat runs.
- Not tested: behaviour with thousands of draws (no pagination yet); real prize images (placeholders).

Known issues:

- No pagination on draw lists (fine for V1 volumes; add before listings grow).
- Public pages are rendered per request, not cached (see PROJECT_STATUS scope notes).

Integration points:

- **Database:** `draws (id, market_id)` for order lines; `draws.total_tickets`, `max_per_person` and `status` for allocation; `draw_prizes.position` for settlement winners.
- **Authentication and security:** `draws.write` for mutations, `admin.access` for reads, both market-scoped; the sweeper audits as `system`.
- **Infrastructure:** the new worker queue `draw-lifecycle`, and Redis DB 14 for e2e.

Next developer action:

- After P3 is reviewed and merged, P4 (ticket engine) starts only on explicit owner approval. O15 (ticket numbering) is needed there.

### 2026-09-22 — P2 — Users, markets, auth, RBAC, MFA, audit (foundation for Phase 3)

Status: OPEN

Task: P2 (no GitHub issue; PR #3)
Developer: Divyanshu (owner), with Claude
Branch: `feature/p2-users-markets-auth`, merged into `develop` (PR #3, `6b0ea82`)
Status of the work: DONE (merged into `develop`)

What was completed:

- Migrations 0002–0007: citext + `hv_set_updated_at()`, `users`, `markets` + `market_settings` (Germany gate, compliance gate), `sessions` + TOTP MFA tables, RBAC (roles, permissions, B7 matrix, `user_roles`), append-only `audit_log`.
- API modules: `markets` (public + admin gate management), `auth` (register, login, logout, me, TOTP MFA), `rbac` (global deny-by-default `AccessGuard`), `audit`, operator CLI `grant-role`.
- Web: `/[market]` resolved through the API, `/login`, `/login/mfa`, `/register`, `/account`, `/admin` shell (read-only market gate table).

Important implementation details:

- **No market is enabled anywhere.** The compliance gate (ADR-0016) needs `min_age` and `self_exclusion_required` (OPEN O12) before a market can be enabled, UK and IE included. On a real database `/uk` and `/ie` are 404 until the owner supplies those values. Tests enable markets only in throwaway databases with labelled fixture values (`packages/db/src/testing/fixtures.ts`).
- **Market context comes only from the `:market` route parameter.** Put `@UseGuards(MarketGuard)` on every market-scoped route. `@CurrentMarket()` fails closed if the guard is missing.
- **Every route needs an access decorator** (`@Public()`, `@Authenticated()`, `@RequirePermission(...)`). Without one, `AccessGuard` denies it, and a conformance unit test fails.
- **Isolation key for Phase 3:** reference markets with `FOREIGN KEY (market_id, currency) REFERENCES markets (id, currency)` and add `UNIQUE (id, market_id)` on `draws`, so `order_items` can use a composite FK to draws (Revision 2 B8). `packages/db/test/markets.int.test.ts` shows the pattern.
- Sensitive operations = `@RequirePermission(p, { sensitive: true })` + a `reason` in the body + `AuditService.record(trx, …)` inside the SAME transaction. See `AdminMarketsService.change()`.
- Services open transactions; controllers never do. Repositories take a `DbExecutor` (pool or transaction).

Files/modules affected:

- `packages/db/migrations/0002`–`0007`, `packages/db/src/generated/db.ts`, `packages/db/src/testing/{fixtures,e2e-database}.ts`
- `packages/domain/src/{email,markets}.ts`, `packages/contracts/src/{auth,admin,errors,markets}.ts`
- `apps/api/src/{auth,rbac,markets,audit,users,common,cli}/`, `apps/api/src/{app,app.module}.ts`, `apps/api/src/config/env.ts`
- `apps/web/src/{lib,app}/…`, `apps/web/e2e/`, `apps/web/playwright.config.ts`

Tests executed:

- See PROJECT_STATUS.md "Phase 2 verification" for the exact commands and counts.
- Not tested: behaviour behind real TLS and proxies (`TRUST_PROXY`, `Secure` cookies over https), and graceful shutdown on Windows (unchanged from Phase 1).

Known issues:

- Email verification and password reset are not implemented (decision needed, see PROJECT_STATUS.md).
- `sessions.user_id` is NOT NULL: guest sessions (ADR-0020) need a migration in Phase 5.

Integration points:

- Database: `markets (id, currency)` and `markets.id` for draws/orders; `users.id` for ownership; `audit_log` for every admin mutation; `hv_market_missing_settings()` is the single definition of "required settings". A later phase that adds a required setting must also update `hv_missing_compliance_settings()` and handle markets that are already enabled.
- Authentication: `request.hvAuth` (`AuthContext`) after `AccessGuard`; sessions expire after `SESSION_TTL_HOURS` (default 7 days); a session with `mfa_required` and no `mfa_verified_at` gets 401 `MFA_REQUIRED` everywhere except `/auth/mfa/verify` and `/auth/logout`.
- Security: permissions are checked by code (`draws.write` etc. are already seeded for Phase 3). `hv_app` cannot INSERT/DELETE markets or change roles/permissions; `audit_log` is append-only for everyone.
- Infrastructure: new env variables `ENABLED_MARKETS`, `WEB_ORIGINS`, `MFA_ENCRYPTION_KEY` (required) and `SESSION_TTL_HOURS`, `SESSION_COOKIE_SECURE`, `MFA_ENCRYPTION_KEY_ID`, `TRUST_PROXY` (optional). After pulling: copy the new lines from `.env.example` into `.env`, then run `pnpm install` and `pnpm db:migrate up`.

Next developer action:

- P2 is merged into `develop`. Phase 3 (draws) starts only on explicit owner approval: branch from `develop`, claim it on `docs/collaboration/TASK_BOARD.md`, and use `0008_…` for its first migration.

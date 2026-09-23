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

### 2026-09-22 — P4 — Ticket engine + customer entry flow (for Phase 5, checkout)

Status: OPEN

Task: P4 (no GitHub issue; no PR open yet)
Developer: Divyanshu (owner), with Claude
Branch: `feature/p4-ticket-engine` (implementation still uncommitted in the working tree; no PR, not merged)
Status of the work: DONE and verified locally; waiting to be committed and reviewed

What was completed:

- `0009_tickets`: ticket pool created on publish, reservations, per-entrant counters, guard triggers, `hv_end_reservation`, `hv_expire_reservations`.
- `@hv/domain` tickets (transitions, entrant keys, totals, quantity and open checks, display numbering); `@hv/contracts` tickets.
- API `tickets` module (reservations, availability, admin inventory) and `TicketAllocator` with a contention retry; worker `reservations` expiry sweep.
- Web: reservation flow on the draw page, `/{market}/reservations/{id}` with a server-timed countdown, admin inventory.

Important implementation details:

- **Allocation (one transaction):** create and lock the entrant's counter row → check the cap → insert the reservation → `SELECT … WHERE status = 'available' ORDER BY ticket_number LIMIT n FOR UPDATE SKIP LOCKED` → mark the tickets reserved → increment the counter. A short result rolls everything back. `AllocationContended` means "retry"; any other refusal is final.
- **Lock order** is always entrant counter → tickets. `hv_expire_reservations` processes reservations in entrant order with SKIP LOCKED, so sweeps and allocations cannot deadlock. Keep this order in checkout.
- **Cap:** `draw_entrant_counts.count` = tickets held in active reservations. **Phase 5 must not decrement it when a reservation becomes an order**: sold tickets keep counting. Guests use the `email` key with the normalized verified email (ADR-0020); the API does not accept guests yet.
- **Selling:** Phase 5 marks the reservation's tickets `reserved → sold` (the trigger allows only this, for the same reservation) and ends the reservation. A new reservation status (for example `converted`) needs a migration that extends `reservations_status_valid` and `hv_reservations_guard`. Check `expires_at > now()` in the same transaction: an expired reservation must never become an order.
- **Order lines** can reference `reservations (id, draw_id)` and `draws (id, market_id)` with composite FKs.
- **Reads use the effective state:** an active reservation past `expires_at` is shown as expired, and availability, allowance and inventory count its tickets as free before any sweep runs.
- **Availability is display-only** (cached 3 s). Never base a decision on it.
- **Database:** migration `0009_tickets.sql`, applied only to local dev and test databases; codegen re-run (18 tables). READ COMMITTED with row locks (`FOR UPDATE`, `SKIP LOCKED`); no advisory or table locks. `hv_app` has no DELETE or TRUNCATE on the three new tables.
- **Tickets:** invariants and the concurrency results are in PROJECT_STATUS.md ("Ticket engine: invariants and concurrency" and "Phase 4 verification").
- **Authentication:** reservation routes need a full session (MFA-pending sessions are refused). Another customer's or another market's reservation is 404. The availability route is public and only adds `allowance` for a signed-in caller.
- **Security:** no route or admin page can change a ticket by hand; staff see counts only. Reservations are rate-limited per user (30 per 10 minutes).

Files/modules affected:

- `packages/db/migrations/0009_tickets.sql`, `packages/db/src/generated/db.ts`, `packages/db/src/testing/{fixtures,e2e-database}.ts`
- `packages/domain/src/tickets.ts`, `packages/domain/src/draws.ts` (pool limit), `packages/contracts/src/{tickets,errors,draws}.ts`
- `apps/api/src/tickets/`, `apps/api/src/rbac/access*.ts`, `apps/api/src/common/request-context.ts`, `apps/api/src/config/env.ts`, `apps/api/src/auth/rate-limiter.ts`
- `apps/worker/src/tickets/`
- `apps/web/src/app/[market]/{reservation-actions.ts,reservations/,draws/[slug]/}`, `apps/web/src/components/{entry-panel,reservation-countdown}.tsx`, `apps/web/src/lib/reservations.ts`, `apps/web/src/app/admin/draws/[market]/[id]/page.tsx`

Tests executed:

- See PROJECT_STATUS.md, "Phase 4 verification": unit, integration, repeated concurrency runs, e2e on desktop and mobile, clean-DB migrations.
- Not tested: guest (email-key) reservations through the API (not exposed yet; the key is covered by the DB and concurrency tests). Automated tests stop at a 50,000-ticket pool.

Known issues:

- Publishing a very large draw holds one transaction for the pool insert (linear in size). Fine for publication, which is rare; revisit if much larger pools are wanted.

Integration points:

- **Database:** `reservations (id, draw_id)`, `tickets.reservation_id`, `draw_entrant_counts`; functions `hv_end_reservation` and `hv_expire_reservations`.
- **API:** `TicketsRepository`, `TicketAllocator` (the only place that allocates), `ReservationsService`.
- **Infrastructure:** worker queue `reservations` (job `expire`, every 30 s); env `RESERVATION_TTL_SECONDS`.

Next developer action:

- After P4 is reviewed and merged, P5 (cart and checkout) starts only on explicit owner approval. It needs O12 (wrong skill answer behaviour) and the email-verification timing decision for guests.

### 2026-09-22 — P3 — Draws foundation (for Phase 4, the ticket engine)

Status: ACCEPTED (by P4, 2026-09-22)

Task: P3 (no GitHub issue; PR #7)
Developer: Divyanshu (owner), with Claude
Branch: `feature/p3-draws`, merged into `develop` (PR #7, `3eb551e`)
Status of the work: DONE (merged into `develop`)

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

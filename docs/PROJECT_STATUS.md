# Highland Vault — Project Status

_Last updated: 2026-09-22_

## Current phase

**Phase 3 (Day 3): Draws foundation + first customer vertical slice — implementation complete, in review (draft PR #7 → `develop`).**

- Branch `feature/p3-draws` (from `develop` `8677781`). Not merged.
- Phases 1 and 2 are complete. Phase 2 is merged into `develop` (PR #3); its record is below.
- Phase 4 has not started and will not start without explicit owner approval.
- Verified on the development machine: Windows 11, Docker Desktop 29.8.0, Node 24.11.1, pnpm 10.34.5, PostgreSQL 18.6, Redis 7.4.11.

> **Still true: no market can be enabled on a real database.** ADR-0016 blocks enabling a market while its O12 compliance values (`min_age`, `self_exclusion_required`) are unset. So the new customer draw pages are unreachable outside tests until the owner supplies those values. Tests use throwaway databases where UK and IE are enabled with labelled fixture values.

## Phase 3 Definition of Done

| Item                                 | Status | Evidence                                                                                                                                                |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draw schema implemented              | ✅     | Migration `0008_draws` (below)                                                                                                                          |
| Migrations work on a clean DB        | ✅     | Brand-new DB: `verify` fails while pending, `up` applies 8, second `up` is a no-op, `status` and `verify` OK                                            |
| Kysely types regenerated             | ✅     | 15 tables; `codegen:verify` up to date on the dev DB and on the clean DB                                                                                |
| Market isolation enforced            | ✅     | `(market_id, currency)` FK; same-market skill-question FK; `UNIQUE(id, market_id)` for order lines; every query scoped by market                        |
| Lifecycle constraints                | ✅     | `hv_draws_guard()`: allowed transitions only; publish requirements; time checks; configuration frozen after publish                                     |
| Draw domain / service                | ✅     | `@hv/domain` draws (transitions, validation, publish blockers, effective status); `DrawsService`, `AdminDrawsService`                                   |
| Customer API                         | ✅     | `GET /markets/:market/draws`, `GET /markets/:market/draws/:slug`                                                                                        |
| Admin API                            | ✅     | Create, update, prizes, skill question, publish, cancel under `/admin/markets/:market/draws`                                                            |
| RBAC respected                       | ✅     | Reads: `admin.access` in that market. Writes: `draws.write` in that market. Customers 403; support read-only; market-scoped admins 403 on other markets |
| Market draw listing / detail         | ✅     | `/{market}/draws`, `/{market}/draws/{slug}`; loading, empty and error states                                                                            |
| Responsive customer UI               | ✅     | Playwright runs the customer journey on desktop and on a Pixel 7 viewport; screenshots reviewed at 1280px and 390px                                     |
| Germany blocked                      | ✅     | `/de`, `/de/draws`, `/de/draws/{slug}` 404, and the API returns `MARKET_NOT_AVAILABLE`, although a German draw is published in the test DB              |
| No fake ticket/payment functionality | ✅     | Entry panel is disabled with an explicit notice; no availability count; e2e asserts none is shown                                                       |
| Admin create/manage + lifecycle      | ✅     | Admin UI + e2e: create → prizes → question → publish → customer sees it                                                                                 |
| Audit / security                     | ✅     | Every admin draw change and every sweeper transition writes `audit_log` in the same transaction; correct answers never leave the admin API              |
| Unit / integration / e2e             | ✅     | 126/126 · 198/198 · 33/33                                                                                                                               |
| Phase 1/2 tests still green          | ✅     | All included in the counts above                                                                                                                        |
| `pnpm verify`                        | ✅     | exit 0                                                                                                                                                  |
| GitHub CI on the PR                  | ✅     | Passed on `f90ce14`. The first run on `c758360` failed on an e2e wait race in the admin draw test; the test was fixed, not the product                  |

## Database (migration 0008_draws)

- **`draws`**
  - One market per draw.
  - `(market_id, currency) → markets (id, currency)`, so the currency cannot drift from the market.
  - `UNIQUE(id, market_id)` for Phase 5 order lines, and `UNIQUE(market_id, slug)`.
  - Checks: price > 0 (bigint minor units), tickets > 0, 0 < cap ≤ tickets, 0 < winner positions ≤ tickets, `opens_at < closes_at`, slug format, status values, and status/timestamp consistency.
- **Trigger `hv_draws_guard()`**
  - Draws are created as draft.
  - Only the transitions `draft → scheduled → live → closed → settled → completed` and `draft|scheduled → cancelled` are allowed.
  - Publishing requires a skill question (≥ 2 options, exactly one correct), a prize for every position and a future closing time.
  - `live` requires `opens_at` to have passed; `closed` requires `closes_at` to have passed.
  - The configuration is frozen after publishing.
- **`draw_prizes`:** one prize per winner position (`UNIQUE(draw_id, position)`); frozen after publishing.
- **`skill_questions` + `skill_question_options`**
  - Owned by a market; a draw can only use a question from its own market (composite FK).
  - At most one correct option (partial unique index).
  - Frozen while a published draw uses it.
- **Helper:** `hv_draw_publish_blockers()` is the single definition of what a draft still lacks.
- **Privileges:** `hv_app` cannot DELETE or TRUNCATE draws; they are cancelled instead.
- **Concurrency:** publish-versus-prize-removal race tested (15 rounds, 5 repeat runs); the prize and question triggers lock the draw row.

## API (Phase 3)

| Endpoint                                           | Access                         | Behaviour                                                                                                       |
| -------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET /markets/:market/draws`                       | public + `MarketGuard`         | Open, then upcoming draws of that market (effective status); drafts, cancelled and other markets never included |
| `GET /markets/:market/draws/:slug`                 | public + `MarketGuard`         | Published draw with prizes and skill question; the correct answer is never selected from the DB                 |
| `GET /admin/markets/:market/draws[/:draw]`         | `admin.access` for that market | All draws, including drafts, with publish blockers                                                              |
| `POST /admin/markets/:market/draws`                | `draws.write` for that market  | Create a draft (currency from the market)                                                                       |
| `PUT /admin/markets/:market/draws/:draw`           | `draws.write`                  | Edit a draft                                                                                                    |
| `PUT …/:draw/prizes`, `PUT …/:draw/skill-question` | `draws.write`                  | Replace prizes (one per position) / the skill question (2–10 options, exactly one correct), drafts only         |
| `POST …/:draw/publish`                             | `draws.write`                  | `draft → scheduled`; 409 `DRAW_NOT_PUBLISHABLE` with blockers                                                   |
| `POST …/:draw/cancel`                              | `draws.write`, reason required | `draft                                                                                                          | scheduled → cancelled`; live draws refused (O6) |

**Worker:** the `draw-lifecycle` queue sweeps every 60 s, moving `scheduled → live` and `live → closed` with conditional updates. Concurrent sweeps apply each change once, and each change is audited as a system action. Between sweeps, the API reports the _effective_ status based on the current time.

## Web (Phase 3)

- **Design foundation:** `globals.css` in plain CSS with tokens, no UI framework and no web-font download. It covers the header and footer, hero, cards, badges, panels, forms and tables, responsive at 720px and 1080px, and respects reduced motion.
- **Customer pages**
  - `/{market}`: market home with featured draws.
  - `/{market}/draws`: "Open now" and "Opening soon", with loading, empty and error states.
  - `/{market}/draws/{slug}`: prizes, prices in the market currency, times in the market time zone, and the skill question.
  - The entry panel is honest: a quantity selector with an exact total, answer choices that nothing checks yet, and a disabled button with a notice that entry is not available online.
  - Prize images are branded placeholders (the storage/CDN decision is O14).
- **Admin pages:** `/admin/draws` (market tabs), `/admin/draws/{market}/new`, and `/admin/draws/{market}/{id}` (details, prizes, skill question, publish with blockers shown, cancel with reason).

## Phase 3 verification

| Check                     | Command                                                       | Result                      |
| ------------------------- | ------------------------------------------------------------- | --------------------------- |
| Format / lint / typecheck | `pnpm verify`                                                 | ✅                          |
| Unit                      | `pnpm test`                                                   | ✅ 126/126 (11 files)       |
| Integration               | `pnpm test:integration`                                       | ✅ 198/198 (13 files)       |
| Concurrency repeat        | draws + markets + concurrency + draw-lifecycle files, 5 times | ✅ 5/5 runs (56 tests each) |
| e2e                       | `pnpm test:e2e` (desktop + mobile)                            | ✅ 33/33                    |
| Build                     | `pnpm build`                                                  | ✅ 7 workspaces             |
| Migrations (dev DB)       | `pnpm db:migrate up / status / verify`                        | ✅ 8 applied, verify OK     |
| Migrations (brand-new DB) | `verify`, `up`, `up`, `status`, `verify`, `codegen:verify`    | ✅                          |
| Secret scan               | gitleaks 8.30.1 `git` + `dir` (235 files)                     | ✅ no leaks                 |
| Client bundle             | grep `.next/static` for DB URLs, env names, `isCorrect`       | ✅ none                     |

## Phase 3 scope notes

- **Caching:** Part F says "public list/detail (functional, cached)". The pages are rendered per request instead, so gate changes and cancellations take effect immediately. The < 200 ms cached-page target (SPEC §9) needs tag revalidation from the API. That is not built yet; proposed with the performance work.
- **Not built (later phases):** ticket pool at publish (P4), availability counts (P4), checking skill answers (P5; wrong-answer behaviour is O12), settlement after close (P9), prize values and cash alternatives (O16), prize images (O14).

## Implementation choices made in Phase 3 (for review)

1. **Publication = lifecycle status.** Draft is unpublished; scheduled and later are published (`published_at` recorded). There is no separate flag that could disagree with the status.
2. **Customers list scheduled and live draws.** Closed draws stay reachable by URL; draft and cancelled draws are 404.
3. **Configuration is frozen once published**, enforced by the database. Changing a published draw is a "major configuration change" (O9).
4. **Every winner position needs a prize before publishing.** Prizes have a title and description only; no value or type, because the specification does not define one for main-draw prizes.
5. **Skill questions are owned by a market** and created per draw by the API (the schema allows reuse). They have 2–10 options with exactly one correct.
6. **Draw management needs `draws.write`** (admin, super_admin), scoped to the market. It is not a step-up sensitive operation, because D10 does not list it (O9 may change this). Every change is audited.
7. **Draws can be prepared in any market**, including disabled Germany; customers cannot see them.
8. **Times are entered and shown in the market's time zone** (Europe/London, Europe/Dublin, Europe/Berlin) and stored in UTC. Wall-clock times inside a DST gap are rejected.
9. **The lifecycle sweep runs every 60 s.** The effective status covers the gap for display; Phase 4 allocation must also check `closes_at`, as Revision 2 B9 already says.
10. **e2e tuning:** 3 workers, 10 s expect timeout, and an e2e Redis DB (14) emptied per run. Rate-limit counters and Argon2 cost made heavier parallelism on this machine flaky; no assertion was weakened.

## Decisions needed

| #   | Decision                                                                                                  | Blocks                                     |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | **O12** `min_age` + self-exclusion for UK and IE                                                          | Any market (and the draw pages) going live |
| 2   | Email verification + password reset timing                                                                | Account recovery                           |
| 3   | **O8** roles that must use MFA                                                                            | Mandatory staff MFA                        |
| 4   | **O9** major configuration changes, including whether publishing or editing a published draw is sensitive | Editing published draws                    |
| 5   | Confirm the seeded RBAC matrix                                                                            | —                                          |
| 6   | **O6** policy for cancelling a live draw                                                                  | Cancelling live draws (refused today)      |
| 7   | Public page caching approach (see scope notes)                                                            | SPEC §9 performance target                 |

## Phase 3 known issues

- Under heavy CPU load on this Windows machine, the web app's 5 s API timeout can trip during e2e runs (`UNREACHABLE`). A 2-worker local run passes 33/33, and CI passes with the committed 3 workers.
- The e2e suite is CPU-heavy on this Windows machine. It is tuned to 3 workers; CI runs the same configuration.
- `The destination stream closed early` appears in the web server log when a test navigates away mid-stream. It is harmless.

## Open decisions (Revision 2 Part G, still unresolved)

| ID        | Question                                                                                                                                      | Needed by                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| O6 (part) | Policy for cancelling a draw that is already live                                                                                             | Phase 9                                                                                                     |
| O7        | Refund policy: destination, refunds after close/settlement, tickets and instant wins on refunded orders                                       | Phases 6/10                                                                                                 |
| O8        | Which roles are "privileged" for mandatory MFA (not enforced in Phase 2)                                                                      | Phase 2                                                                                                     |
| O9        | Exact list of "major configuration changes" (market gate changes are treated as sensitive meanwhile)                                          | Phases 2/10                                                                                                 |
| O10       | Postal-entry rule values; maker-checker threshold for admin wallet credits                                                                    | Phases 7/10                                                                                                 |
| O11       | Referral qualifying actions/rewards; Vault Meter metric, scope, thresholds, rewards                                                           | Phase 11                                                                                                    |
| O12       | Compliance values: minimum age per market, wrong skill answer behaviour, self-exclusion scope, consent wording, retention, masked-name format | **Now** for UK/IE `min_age` + self-exclusion (market enablement); the rest Phase 12 (skill answer: Phase 5) |
| O13       | Production payment provider(s)                                                                                                                | Before Phase 14                                                                                             |
| O14       | Hosting (and PostgreSQL 18 availability), email provider, storage/CDN, monitoring, analytics                                                  | Before Phase 13                                                                                             |
| O15       | Customer-visible ticket numbering: random vs sequential                                                                                       | Phase 4                                                                                                     |
| O16       | Cash alternative for physical prizes                                                                                                          | Phases 8/9                                                                                                  |
| O17       | Legacy access: plugin list and a sanitized WordPress DB export                                                                                | Now (migration discovery)                                                                                   |

O1–O6 and O18 were approved by the owner on 2026-09-21. They are recorded in ADR-0020 to ADR-0026 as the Revision 2 proposals, because the approval did not restate them. If any approval differs from the proposal, amend the ADR.

## Blockers

- **Phase 3:** none for the implementation. Customer pages stay unreachable on real databases until O12 lets a market be enabled.
- **Migration discovery:** O17, legacy system access.

## Next task

**Stop for owner review of Phase 3 (PR #7).** Phase 4 (ticket engine) starts only on explicit owner approval. Active work and ownership: [collaboration/ACTIVE_WORK.md](collaboration/ACTIVE_WORK.md), [collaboration/TASK_BOARD.md](collaboration/TASK_BOARD.md).

---

# Phase 2 record (merged into `develop`, PR #3)

### Phase 2 Definition of Done

| Item                                          | Status | Evidence                                                                                                                                                                                                                |
| --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 2 scope (Revision 2 Part F) implemented | ✅     | Markets seeded (DE disabled, legal-approval CHECK), market settings, auth + sessions, global email, RBAC, TOTP MFA + step-up, audit log, `/admin` shell, `/[market]` via the API + API guard. Exceptions: "Scope notes" |
| Schema/migrations complete for Phase 2        | ✅     | `0002`–`0007` (below)                                                                                                                                                                                                   |
| Codegen updated                               | ✅     | `src/generated/db.ts`: 11 tables; `codegen:verify` up to date against the dev DB and against a brand-new DB                                                                                                             |
| API integration works                         | ✅     | 69 API integration tests; live run of the built API against the dev DB as `hv_app`                                                                                                                                      |
| Web integration works                         | ✅     | 10 Playwright tests + setup, against the built API and web                                                                                                                                                              |
| Market model works                            | ✅     | DB: 19 tests; API: 21 tests                                                                                                                                                                                             |
| Germany remains gated                         | ✅     | Refused at every layer: DB CHECK, compliance gate, `ENABLED_MARKETS`, API guard, web 404                                                                                                                                |
| Market isolation enforced                     | ✅     | `UNIQUE(id, currency)` composite-FK key tested; route-only market context; market-scoped RBAC (a UK admin cannot touch IE/DE)                                                                                           |
| User/account foundation works                 | ✅     | Normalized, globally unique email (case-insensitive), Argon2id, no market column                                                                                                                                        |
| Authentication foundation works               | ✅     | Register/login/logout/me, sessions, rate limits, CSRF origin check, TOTP enrolment, second factor, step-up, recovery codes                                                                                              |
| Invariants at database level                  | ✅     | CHECK, UNIQUE, FK and trigger constraints listed below; 25-round write-skew race test                                                                                                                                   |
| Unit tests pass                               | ✅     | 82/82                                                                                                                                                                                                                   |
| Integration tests pass                        | ✅     | 133/133 (real PostgreSQL + Redis)                                                                                                                                                                                       |
| e2e/smoke tests pass                          | ✅     | 11/11 (1 setup + 10 browser)                                                                                                                                                                                            |
| Migrations pass on a clean database           | ✅     | Brand-new DB: `verify` fails while pending, `up` applies 7, `up` again is a no-op, `status` OK, `verify` OK                                                                                                             |
| Migration verification passes                 | ✅     | Dev DB: `verify: OK — 7 migration(s) applied, all checksums match, none pending`                                                                                                                                        |
| Typecheck / lint / formatting pass            | ✅     | `pnpm verify` exit 0                                                                                                                                                                                                    |
| Builds pass                                   | ✅     | 7 workspaces                                                                                                                                                                                                            |
| Secret scan passes                            | ✅     | gitleaks 8.30.1 (the version pinned in CI): 2 commits and all 196 committable files, no leaks                                                                                                                           |
| No Phase 3+ business features                 | ✅     | No draws, tickets, orders, payments, wallet or email sending                                                                                                                                                            |
| Documentation/status updated                  | ✅     | This file, README, `packages/db/README.md`, collaboration files                                                                                                                                                         |
| Handoff created                               | ✅     | [HANDOFFS.md](collaboration/HANDOFFS.md)                                                                                                                                                                                |
| No unreviewed architectural decisions         | ✅     | Implementation choices are listed below for review; decisions outside the approved architecture were not taken (see "Decisions needed")                                                                                 |

### Database (Phase 2 migrations)

| Migration                     | What it does                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0002_extensions_and_helpers` | `citext`; `hv_set_updated_at()` trigger function (both deferred from Phase 1)                                                                                                                                                                                                                                                                                                          |
| `0003_users`                  | `users`: `email citext UNIQUE` stored normalized (CHECK), email shape CHECK, Argon2id-only password hash CHECK, `status ∈ {active, disabled}`, **no `market_id`** (ADR-0003)                                                                                                                                                                                                           |
| `0004_markets`                | `markets` + `market_settings`. Market set pinned (uk→GBP/en-GB, ie→EUR/en-IE, de→EUR/de-DE); `UNIQUE(code)`; `UNIQUE(id, currency)` for composite FKs; identity immutable (trigger); legal-approval fields all-or-nothing; **B8 Germany CHECK**; compliance-gate triggers on both tables (row-locked, no write skew); `hv_app` may not INSERT or DELETE; all three seeded **disabled** |
| `0005_sessions_and_mfa`       | `sessions` (SHA-256 token hash only, unique, expiry CHECK, `mfa_required`, `mfa_verified_at`); `user_mfa` (AES-256-GCM secret, key id, `confirmed_at`, `last_used_step` for replay protection); `mfa_recovery_codes` (hashes, single use)                                                                                                                                              |
| `0006_rbac`                   | `roles` (6, ADR-0010), `permissions` (16), `role_permissions` (Revision 2 B7 starting matrix), `user_roles` (`market_id` NULL = all markets; `UNIQUE NULLS NOT DISTINCT`; customer never market-scoped); role tables read-only for `hv_app`                                                                                                                                            |
| `0007_audit_log`              | Append-only `audit_log` (actor, action, entity, market, reason, before/after JSON, ip, request id); UPDATE/DELETE/TRUNCATE blocked by trigger for every role and revoked from `hv_app`                                                                                                                                                                                                 |

### API (Phase 2)

Layering: controller (validation + response shape) → service (transactions, application logic) → `@hv/domain` rules → repository (Kysely). Every error is `{ error: { code, message, details? }, requestId }`. Request IDs and structured pino logs from Phase 1 are unchanged; cookies are redacted in logs.

| Endpoint                                     | Access                                          | Behaviour                                                                                 |
| -------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /health/live`, `GET /health/ready`      | public                                          | Unchanged                                                                                 |
| `GET /markets`                               | public                                          | Markets allowed by `ENABLED_MARKETS` **and** enabled in the DB                            |
| `GET /markets/:market`                       | public + `MarketGuard`                          | 404 `MARKET_NOT_AVAILABLE` for unknown, disabled or env-excluded markets; no query params |
| `POST /auth/register`                        | public, rate-limited                            | Creates the account, the `customer` role and a session cookie                             |
| `POST /auth/login`                           | public, rate-limited                            | `authenticated` or `mfa_required`                                                         |
| `POST /auth/logout`                          | session (MFA pending allowed)                   | Revokes the session server-side                                                           |
| `GET /auth/me`                               | session                                         | User, roles, and permissions with market scope                                            |
| `POST /auth/mfa/verify`                      | session (MFA pending allowed), rate-limited     | TOTP or recovery code; completes sign-in or refreshes step-up                             |
| `POST /auth/mfa/totp/setup`, `/confirm`      | session                                         | Enrol TOTP; confirm returns 10 recovery codes once and revokes other sessions             |
| `GET /admin/markets`                         | `admin.access` (any scope)                      | Full gate state per market, including `environmentAllowed` and `missingSettings`          |
| `PUT /admin/markets/:market/settings`        | `markets.gate.manage` for that market + step-up | Sensitive: reason required, audited in the same transaction                               |
| `POST /admin/markets/:market/legal-approval` | same                                            | Only for markets that require it; once                                                    |
| `POST /admin/markets/:market/enable`         | same                                            | Refused (409) while legal approval or settings are missing                                |
| `POST /admin/markets/:market/disable`        | same                                            | Audited                                                                                   |

Also:

- a global deny-by-default `AccessGuard`;
- a CSRF origin check on every state-changing request;
- security headers (`nosniff`, `DENY`, `no-referrer`, `no-store`);
- a 64 KiB body limit;
- the audited operator CLI `grant-role`.

### Web (Phase 2)

- `/[market]` asks the API; the Phase 1 static allow-list is gone. `/de`, `/xx` and any market the API refuses are 404.
- `/` lists the markets the API reports as available.
- `/login`, `/login/mfa`, `/register`, `/account`: minimal server-rendered forms (server actions). The session token is kept in the web origin's HttpOnly cookie and forwarded to the API server-side. Browser JavaScript never sees it.
- `/admin`: a server-side session + `admin.access` check (404 otherwise) and a read-only market gate table. The API enforces everything again.

### Market gate: all layers

1. **Database:** the `markets_legal_approval_required` CHECK (Revision 2 B8); legal-approval fields all-or-nothing; `requires_legal_approval` immutable; compliance-gate triggers.
2. **Environment:** `ENABLED_MARKETS` (required; `uk,ie` in `.env.example`, DE not listed).
3. **API guard:** `MarketGuard` on market-scoped routes; the same 404 for every refusal.
4. **Admin activation:** a sensitive operation (permission + step-up MFA + reason + audit).
5. **Web:** no market list of its own; 404 whenever the API refuses.

### Phase 2 verification

| Check                              | Command                                                  | Result                                                    |
| ---------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Format                             | `pnpm format:check`                                      | ✅ all files                                              |
| Lint                               | `pnpm lint`                                              | ✅ 0 problems                                             |
| Typecheck                          | `pnpm typecheck`                                         | ✅ 6 workspaces                                           |
| Unit                               | `pnpm test`                                              | ✅ 82/82 (9 files)                                        |
| Integration                        | `pnpm test:integration`                                  | ✅ 133/133 (10 files)                                     |
| Concurrency repeat                 | concurrency + markets + auth integration files, 10 times | ✅ 10/10 runs (46 tests each)                             |
| e2e                                | `pnpm test:e2e`                                          | ✅ 11/11                                                  |
| Build                              | `pnpm build`                                             | ✅ 7 workspaces                                           |
| Migrations (dev DB)                | `pnpm db:migrate up`, `status`, `verify`                 | ✅ 6 applied; 7 applied, 0 pending, 0 problems; verify OK |
| Migrations (brand-new DB)          | `up`, `up`, `status`, `verify`, `codegen:verify`         | ✅ 7 applied, then no-op, OK, OK, up to date              |
| Codegen                            | `pnpm db:codegen` + `codegen:verify`                     | ✅ 11 tables, up to date                                  |
| Secret scan                        | gitleaks 8.30.1 `git` + `dir`                            | ✅ no leaks                                               |
| Everything except e2e and the scan | `pnpm verify`                                            | ✅ exit 0                                                 |

Integration tests per file:

- API: admin-markets 17, auth 23, health 8, markets 21;
- worker: 3;
- db: concurrency 4, foundation 11, identity 15, markets 19, migrate 12.

Live run (built API against the dev DB):

- The API connected as `hv_app` (`pg_stat_activity`).
- `/health/ready` returned 200 and `/markets` returned `[]`.
- `/markets/{uk,ie,de,xx}` returned 404.
- Registration without an Origin got 403. With one it got 201 and an HttpOnly, SameSite=Lax cookie.
- As a customer, `/admin/markets` returned 403.
- The CLI grant was audited, and a second run was a no-op.

### Scope notes

- **Email verification and password reset are not implemented.** B5 lists them under the Phase 2 auth module, but Part F's Phase 2 line does not. Both need transactional email, which B3 routes through the outbox (Phase 5) with per-market templates (Phase 12). `users.email_verified_at` exists and stays NULL. **Decision needed** (below).
- **Mandatory MFA per role is not enforced** (O8 OPEN). Any account can enrol, and enrolled accounts always need the second factor. Sensitive operations always need step-up.
- **Guest sessions** (ADR-0020) are Phase 5; `sessions.user_id` is NOT NULL for now.

### Implementation choices made in Phase 2 (for review)

All sit within the approved architecture; each is reversible by a migration or a code change.

1. **Required compliance settings in Phase 2:** `min_age` and `self_exclusion_required` (both OPEN O12). Later phases add their own settings to `hv_missing_compliance_settings()`: skill-answer behaviour in P5; consent, retention and masked names in P12.
2. **The market set is pinned by a CHECK.** Adding a market later needs a migration. Code, currency, locale and `requires_legal_approval` are immutable.
3. **`legal_approved_by`** is the staff user who recorded the approval; the approval document itself is `legal_approval_ref`.
4. **All market gate changes are sensitive operations**, not just Germany activation. This is the stricter reading while O9 is open.
5. **RBAC matrix = the Revision 2 B7 "proposed starting matrix", seeded as written**, plus `admin.access` (every staff role) for the admin shell. `audit.read` is not seeded because the matrix has no row for it. Please confirm or amend the matrix.
6. **Security values:**
   - sessions: 7 days absolute (`SESSION_TTL_HOURS`), no idle timeout;
   - passwords: 12–128 characters, Argon2id with m=19 MiB, t=2, p=1 (OWASP minimum), through Node's built-in `crypto.argon2`, so there is no native dependency;
   - TOTP: SHA-1, 6 digits, 30 s, ±1 step; 10 recovery codes of 80 bits each;
   - step-up window: 15 minutes (Revision 2 B7);
   - rate limits: login 100/15 min per IP and 10/15 min per email, registration 20/h per IP, MFA 5/15 min per account;
   - the rate limiter **fails closed**: if Redis is unavailable, auth answers 503.
7. **MFA enrolment signs out the user's other sessions.**
8. **Registration answers 409 `EMAIL_TAKEN`** for an existing email. That reveals the account exists; a "check your inbox" flow needs email (decision 2).
9. **The web relays the session cookie server-side.** CORS is not enabled on the API, so browsers never call it directly.
10. **An operator CLI bootstraps staff roles.** There is no role-management API yet (O9 decides whether it is sensitive).
11. **Database sessions run in UTC** (`TimeZone=UTC` on the pool).
12. **Test harness:** `drop()` retries `42501` while autovacuum holds a throwaway database. The e2e suite uses its own `hv_e2e` database, with the API on :4100 and the web on :3100.

### Decisions needed

| #   | Decision                                                                                                                                | Blocks                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | **O12 values for UK and IE:** `min_age`, and whether self-exclusion is required. Until then no market can be enabled in any environment | Opening UK/IE (any customer-facing testing) |
| 2   | Email verification + password reset: build them in Phase 5 with the outbox, or build a minimal outbox/mailer now                        | Account recovery; verified emails           |
| 3   | O8: which roles must use MFA (proposal: all staff roles)                                                                                | Enforcing mandatory staff MFA               |
| 4   | O9: which configuration changes are sensitive (market gate changes are treated as sensitive meanwhile)                                  | A role-management API; P10 config screens   |
| 5   | Confirm the seeded RBAC matrix (choice 5)                                                                                               | —                                           |
| 6   | ~~Role of the `develop` branch~~ — **resolved 2026-09-22**: `feature/*` → `develop` → `main` (DEVELOPMENT_RULES §4)                     | —                                           |

### Phase 2 known issues

- **`TRUST_PROXY` and X-Forwarded-For** depend on the hosting setup (O14). Until they are configured, per-IP rate limits and audit IPs see the web server's address for traffic that arrives through the web app.
- **GitHub CI is red on the merged Phase 2 commit** (`b06226b`). A timing race in the test `identity.int.test.ts` "stamps updated_at" failed on the Ubuntu runner; build and e2e were skipped. Production code is not affected. The fix is in PR #4 (`fix/p2-updated-at-test-timing`). CI runs on PRs and on pushes to `main` only, not on pushes to `develop`.
- **Graceful shutdown on Windows:** unchanged from Phase 1 (see below).

# Phase 1 record (approved 2026-09-22)

### Day 1 Definition of Done

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

### Verified results

#### Infrastructure (`pnpm infra:up`)

| Service    | Image                   | Status  | Port (127.0.0.1 only)  |
| ---------- | ----------------------- | ------- | ---------------------- |
| PostgreSQL | postgres:18.6-alpine    | healthy | 5432                   |
| Redis      | redis:7.4.11-alpine     | healthy | 6379                   |
| Mailpit    | axllent/mailpit:v1.31.2 | healthy | 1025 (SMTP), 8025 (UI) |

#### Migrations (clean database)

- `up` applied `0001_foundation.sql`. Running it again reported "nothing to apply".
- Resulting objects:
  - table `schema_migrations`, owned by the migration tool; `hv_app` has **SELECT only**;
  - function `hv_forbid_update_delete`.
- The recorded checksum `9c121ea4…0532e` equals `sha256sum` of the file.

#### Codegen

- `pnpm db:codegen` introspected 0 application tables (correct for Phase 1; `schema_migrations` is excluded) and wrote `src/generated/db.ts`.
- `codegen:verify` reports: up to date.

#### Integration tests (`pnpm test:integration`, real PostgreSQL + Redis): 38/38 passed

| File                                        | Tests |
| ------------------------------------------- | ----- |
| `packages/db/test/concurrency.int.test.ts`  | 4     |
| `packages/db/test/migrate.int.test.ts`      | 12    |
| `packages/db/test/foundation.int.test.ts`   | 11    |
| `apps/api/test/health.int.test.ts`          | 8     |
| `apps/worker/test/system-queue.int.test.ts` | 3     |

#### PostgreSQL concurrency test (infrastructure verification)

This test uses 10 separate `pg.Client` connections, confirmed to be 10 distinct backend PIDs, against PostgreSQL 18. It proves four things:

1. **Distinct connections.** The 10 connections really are 10 separate backends.
2. **SKIP LOCKED gives disjoint rows.** 10 transactions hold `FOR UPDATE SKIP LOCKED` locks at the same moment and each receives 10 rows. The 100 rows are all distinct, with no overlap. While the locks are held, an 11th session finds 0 lockable rows but can still read all 100 (MVCC).
3. **The harness can catch races.** An unlocked read-modify-write loses updates: the final value is 1, not 10.
4. **Locking prevents lost updates.** The same read-modify-write with `FOR UPDATE` gives the correct final value of 10.

It passed **10 out of 10 consecutive runs**.

#### API (built, running for real)

- `GET /health/live` → **200** `{"status":"ok"}`
- `GET /health/ready` → **200** `{"status":"ok","checks":{"database":{"status":"up",…},"redis":{"status":"up",…}}}`
- Structured JSON logs carry `reqId`. A supplied `x-request-id` (≤128 characters) is propagated and echoed on the response; otherwise a UUID is generated.

#### Worker (built, running for real)

- Logged: `startup check passed: PostgreSQL and Redis reachable` → `worker ready: queue "system", heartbeat every 60s` → `processed heartbeat`.
- On restart, exactly **1** job scheduler exists, so the upsert is idempotent.

#### Final static checks

`pnpm verify` exit 0: format ✅, lint ✅, typecheck (6 workspaces) ✅, unit 19/19 ✅, migrate up/verify ✅, integration 38/38 ✅, build (7 workspaces) ✅. Playwright 5/5 ✅.

### Fixes made during Docker verification

1. **Three integration-test assertions were wrong.** These were test bugs only; no production code changed.
   - `SHOW server_version` and `SHOW transaction_isolation` name their result columns after the setting. The tests now use `current_setting(...) AS alias`.
   - BullMQ `getJobCounts('waiting')` also returns `paused`. The assertion was relaxed to `toMatchObject`.
2. **Request IDs weren't propagated.** Under the Fastify adapter, pino-http's `genReqId` is ignored: logs showed Fastify's default `req-1`, `req-2`, and a supplied `x-request-id` was dropped.
   - Request-ID generation moved to the Fastify adapter in `apps/api/src/app.ts`, and the ID is echoed on the response.
   - Two integration tests were added.

### Important technical decisions made during Phase 1

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

### Known issues

- **Graceful shutdown on OS signals is not verified on Windows.** Windows cannot deliver SIGTERM/SIGINT to a Node process from outside, so the dev processes were stopped with a forced kill. The shutdown hooks (`app.close()`, worker/queue close, DB/Redis teardown) are exercised by the integration tests on every run.
- **`corepack enable` needs admin rights** on this machine (`EPERM` on `C:\Program Files\nodejs`). The workaround, `corepack enable --install-directory "%APPDATA%\npm"`, is in the README.
- **npm flags ESLint 9 as "deprecated"** because ESLint 10 exists. It is functional and supported by the configs in use.
- **Vite warns about loading the config as CommonJS**, cosmetic only. `vitest.config.mts` is ESM; the warning comes from the Vite native config loader preview.
- **CI result on GitHub not yet confirmed.** Commit `a16ca35` is now on `origin/main` and `origin/develop`. CI was validated locally with actionlint.

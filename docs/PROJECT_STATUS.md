# Highland Vault — Project Status

_Last updated: 2026-09-25_

## Current phase

**Phase 4 (Day 4): Ticket engine + customer entry flow — DONE. Merged into `develop` and released to `main`.**

- **PR #8** (`feature/p4-ticket-engine` → `develop`), merged as **`49e3903`** on 2026-09-23. The implementation commit is `ba5e871`.
- **Release PR #9** (`develop` → `main`), merged as **`c284825`**. `main` now contains Phase 4.
- Phases 1–4 are complete and merged into `develop` (Phase 3: PR #7, Phase 4: PR #8). Their records are below.
- Re-verified on the merged `develop` (`49e3903`): `pnpm verify` exit 0 — format, lint, typecheck, unit 139/139, migrations 9 applied and verified, integration 255/255, build 7 workspaces.
- **O15 decided by the owner: sequential ticket numbers** (ADR-0027).
- **Phase 5 (cart + checkout) is under way; P5-5 is in review** (owner-approved scope: specification-faithful Option A, ending at `pending_payment`). Payments, webhooks and the RESERVED → SOLD transition stay in Phase 6 (ADR-0006), and Gate 4 does not move. P5-0 through P5-4 are merged, with NB-3, the gitleaks placeholder fix, the ticket-engine teardown fix and the local gitleaks tooling. The remaining work is broken down as **P5-5 to P5-8** below. P5-5 (guest checkout access and the per-market basket, migration `0014`) is implemented and awaiting review; P5-6 to P5-8 are not approved to start.
- Verified on the development machine: Windows 11, Docker Desktop 29.8.0, Node 24.11.1, pnpm 10.34.5, PostgreSQL 18.6, Redis 7.4.11.

> **Still true: no market can be enabled on a real database** until the owner supplies the O12 compliance values (ADR-0016). So reservations are only possible in test databases, where UK and IE are enabled with labelled fixture values. Germany stays disabled everywhere.

## Phase 4 Definition of Done

| Item                                         | Status | Evidence                                                                                                                                                                     |
| -------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket pool from the draw configuration      | ✅     | Publishing (`draft → scheduled`) creates tickets 1..N in the same transaction (DB trigger). `UNIQUE(draw_id, ticket_number)`                                                 |
| States available / reserved / purchased      | ✅     | `available`, `reserved`, `sold` (the specification's word for purchased). Only the allowed transitions pass the `hv_tickets_guard` trigger                                   |
| Atomic reservation, no partial reservations  | ✅     | One transaction: cap check → reservation → `FOR UPDATE SKIP LOCKED` → tickets reserved. Short results roll back the whole attempt                                            |
| 10-minute expiry, idempotent                 | ✅     | DB CHECK caps a reservation at 10 minutes. Worker sweep every 30 s, plus an inline sweep before each allocation, plus effective status on every read                         |
| Reservation identity for Phase 5             | ✅     | `reservations.id` (UUIDv7), `UNIQUE(id, draw_id)` for a composite FK from order lines; tickets carry `reservation_id`                                                        |
| Per-entrant cap, transactional               | ✅     | `draw_entrant_counts` row locked per entrant; key = user id, or normalized verified email for guests; DB trigger backstop. No fingerprinting                                 |
| Concurrency tests                            | ✅     | Gate 1 (200 buyers / 100 tickets), 100×10, near exhaustion, Gate 2 (user and email keys), expiry vs reservation, 50,000-ticket pool. Each 3 rounds per run; 3/3 rounds green |
| API routes                                   | ✅     | Reserve, get, list, release, availability (below). No internal ticket ids or entrant keys in responses                                                                       |
| Customer UI                                  | ✅     | Quantity → exact total → Reserve → confirmation with real numbers (`#0021`) → server-timed countdown → Continue (disabled: no checkout)                                      |
| Countdown survives refresh, sleep and expiry | ✅     | Computed from the server's `expiresAt` and `serverTime`; recomputed from the clock every tick; refreshes at zero and when the tab becomes visible. e2e covers both           |
| Admin inventory                              | ✅     | Total, available, reserved, purchased, reservation counts on the admin draw page. Read-only: no ticket controls exist                                                        |
| Market isolation, Germany blocked            | ✅     | Every query is scoped by market; another market's reservation or draw is 404; `/de/...` is 404 and the DB refuses reservations in a disabled market                          |
| Unit / integration / e2e                     | ✅     | 139/139 (12 files) · 255/255 (17 files) · 38/38 (desktop + mobile)                                                                                                           |
| `pnpm verify`                                | ✅     | exit 0                                                                                                                                                                       |
| GitHub CI on the PR                          | ✅     | Green on PR #8 (`ba5e871`) and on the `develop` merge commit `49e3903` (push event). One caveat in the CI note below                                                         |

## Phase 4 CI record (and one flaky run)

Three CI runs touch the Phase 4 merge. Two are green; one is red on the **same commit** as a green one.

| Run             | Event          | Commit    | Result                                         |
| --------------- | -------------- | --------- | ---------------------------------------------- |
| PR #8           | `pull_request` | `ba5e871` | ✅ success                                     |
| `develop` merge | `push`         | `49e3903` | ✅ success — this is the merge commit's own CI |
| Release PR #9   | `pull_request` | `49e3903` | ❌ **failure** at the "Integration tests" step |
| `main` merge    | `push`         | `c284825` | ✅ success                                     |

The same tree passed integration twice and failed once, so this is a **flaky integration test on CI hardware, not a product defect** — no code differs between the green and red runs. The job log needs repository authentication to read, so the specific failing test has not been identified.

**Investigated under NB-3 (PR #12), and the first hypothesis was wrong.** An earlier revision of this file blamed `expect(r.status).toBe('active')` on the reservation-creation response under a 2-second TTL. The CI step timings refute it: green integration steps take 18–20 s and the red one took **22 s**, so the suite ran to completion and **no 30-second timeout fired** — a fast assertion or error, not the timeout class seen locally. CI is also far faster than the development machine, which makes a single POST exceeding two seconds implausible there.

What was found instead: `hv_tickets_guard` compares a reservation's expiry with `now()`, the **transaction** timestamp. Allocation runs the reservation insert and the ticket hold in one transaction, so `now()` is frozen and production is immune by construction. Two test fixtures built the same state with **separate statements**, putting a one-second wall-clock budget on the round trips; missing it is refused by `tickets_reservation_active` and fails immediately. That rejection was reproduced deterministically and the fixtures now run in one transaction (PR #12).

**The original CI failure was never attributed.** The job log needs repository authentication (HTTP 403), and the fixture fragility could not be reproduced end to end even with PostgreSQL throttled to 0.1 CPU. NB-3 therefore remains an **unconfirmed hypothesis**; what was fixed is a proven fragility matching its signature. One failure in thirteen runs.

## Database (migration 0009_tickets)

- **`draws_total_tickets_max`:** at most 1,000,000 tickets per draw (see choices, item 3).
- **`reservations`**
  - Draw, market, currency, entrant (`user` + user id, or `email` + normalized verified email), quantity, unit price, exact total (bigint minor units), status (`active` → `released` | `expired`), `expires_at`, `ended_at`.
  - FKs: `(draw_id, market_id) → draws`, `(market_id, currency) → markets`. `UNIQUE(id, draw_id)` for tickets and future order lines.
  - CHECKs: total = unit price × quantity; `created_at < expires_at ≤ created_at + 10 minutes`; ended timestamps consistent; entrant fields consistent.
  - Trigger `hv_reservations_guard`: created active, only for a draw that is open right now (by its times, not only its stored status) in an enabled market, at the draw's price. Terms immutable; ends exactly once.
- **`tickets`**
  - `bigint` identity (never exposed), `draw_id`, `ticket_number > 0`, status, `reservation_id`.
  - `UNIQUE(draw_id, ticket_number)`; composite FK `(reservation_id, draw_id) → reservations(id, draw_id)`, so a ticket can only be held by a reservation of its own draw.
  - CHECK: a ticket has a holder exactly when it is not available.
  - Trigger `hv_tickets_guard`: created available; draw and number immutable; only `available → reserved`, `reserved → available`, `reserved → sold` (same reservation); reserving needs an active, unexpired reservation.
  - Partial index `(draw_id, ticket_number) WHERE status = 'available'`: allocation reads the next free numbers without scanning the pool.
- **`draw_entrant_counts`:** `(draw_id, entrant_type, entrant_ref) → count`; trigger refuses a count above the draw's `max_per_person` or below zero.
- **Functions:** `hv_generate_ticket_pool` (one `generate_series` insert, only if the draw has no tickets), `hv_end_reservation` (frees tickets and allowance exactly once), `hv_expire_reservations` (SKIP LOCKED batches, in entrant order so counter locks never deadlock).
- **Privileges:** `hv_app` cannot DELETE or TRUNCATE tickets, reservations or entry counts.

## Ticket engine: invariants and concurrency

- **No overselling:** a ticket row is taken only under its row lock and only while `available`; the unique constraint and the holder CHECK make a double sale impossible even if application code were wrong.
- **No global lock:** buyers lock only the tickets they take (SKIP LOCKED) and their own entrant counter. Two buyers never wait on each other unless they are the same entrant.
- **No partial reservations:** if fewer tickets than requested can be locked, the whole transaction rolls back.
- **Near exhaustion:** SKIP LOCKED can make two buyers each see part of the last tickets. If committed availability still covers the request, the attempt is retried (up to 5 times, with jitter), so someone gets the tickets instead of nobody. If the tickets are really gone, the answer is `INSUFFICIENT_TICKETS` at once.
- **Cap:** the entrant's counter row is locked first, so concurrent requests from one entrant are serialized, and the DB trigger refuses an over-cap count regardless.
- **Expiry:** the worker sweeps every 30 s; the API also expires the draw's overdue reservations (in their own transaction) before each allocation; reads report an overdue reservation as expired. Expiry is idempotent and safe with duplicate sweepers.
- **Pool size:** generation is one set-based insert. On this machine a 50,000-ticket pool publishes in 6.2 s (the Docker VM here is roughly 10× slower than a normal server; `generate_series` of 5M rows takes 5 s). Allocation cost does not depend on the pool size.

## API (Phase 4)

| Endpoint                                                  | Access                               | Behaviour                                                                                                            |
| --------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `GET /markets/:market/draws/:slug/availability`           | public (recognises a session if any) | `{available, total, allowance}`; display only, cached 3 s in Redis; `allowance` only when signed in                  |
| `POST /markets/:market/draws/:slug/reservations`          | signed-in customer, 30 per 10 min    | 201 with the reservation; 409 `DRAW_NOT_OPEN`, `TICKET_CAP_EXCEEDED`, `INSUFFICIENT_TICKETS`; 400 `INVALID_QUANTITY` |
| `GET /markets/:market/reservations`                       | signed-in customer                   | The caller's active reservations in this market                                                                      |
| `GET /markets/:market/reservations/:reservation`          | signed-in customer (owner only)      | ID, draw, status, quantity, ticket numbers, currency, unit price, exact total, expiry, `serverTime`                  |
| `POST /markets/:market/reservations/:reservation/release` | signed-in customer (owner only)      | Idempotent; releasing after expiry records `expired`                                                                 |
| `GET /admin/markets/:market/draws/:draw/inventory`        | `admin.access` for that market       | Ticket counts by status and reservation counts; read-only                                                            |

Anyone else's reservation, another market's reservation and malformed IDs are all 404. Every route passes `MarketGuard`.

## Worker (Phase 4)

`reservations` queue, job `expire`, repeat scheduler `reservations-expire` every 30 s: `hv_expire_reservations(NULL, 500)` in up to 20 batches per run.

## Web (Phase 4)

- **Draw page:** real availability ("3,997 of 4,000 tickets available"), quantity stepper bounded by the cap, the customer's remaining allowance and availability, exact total, **Reserve tickets** (server action → API). Signed out: **Sign in to reserve**, returning to the draw. Refusals are shown in plain words.
- **Skill question:** shown on the draw page as information. It is answered at checkout (Phase 5; wrong-answer behaviour is O12).
- **Reservation page** `/{market}/reservations/{id}`: the numbers (zero-padded to the draw's size), quantity, unit price, total, countdown, **Release these tickets**, and a disabled **Continue** with a notice that checkout is not available yet. Expired and released states say what happened and that nothing was charged.
- **Admin draw page:** "Ticket inventory" section for published draws.

## Phase 4 verification

| Check                     | Command                                                    | Result                               |
| ------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| Format / lint / typecheck | `pnpm verify`                                              | ✅                                   |
| Unit                      | `pnpm test`                                                | ✅ 139/139 (12 files)                |
| Integration               | `pnpm test:integration`                                    | ✅ 255/255 (17 files)                |
| Concurrency repeat        | ticket DB + ticket engine + reservations + expiry files    | ✅ 3/3 runs (60 tests each, 5 files) |
| e2e                       | `pnpm test:e2e` (desktop + mobile)                         | ✅ 38/38                             |
| Build                     | `pnpm build`                                               | ✅                                   |
| Migrations (dev DB)       | `pnpm db:migrate up / status / verify`                     | ✅ 9 applied, verify OK              |
| Migrations (brand-new DB) | `verify`, `up`, `up`, `status`, `verify`, `codegen:verify` | ✅ all six steps                     |
| Secret scan               | gitleaks `git` + `dir`                                     | ✅ no leaks (257 files)              |
| Client bundle             | grep `.next/static` for DB URLs, env names, `isCorrect`    | ✅ none                              |

## Phase 4 scope notes

- **Not built (later phases, as instructed):** orders, checkout, payment, webhooks, wallet, refunds, settlement, instant wins, referrals, production migration.
- **Guest entry:** the engine and the cap support the verified-email key. Phase 5 built the identity (P5-3, ADR-0029) and the verification that fills it (P5-4, ADR-0020); the reservation and checkout routes still accept signed-in customers only until the remaining P5 tasks connect them.
- **`sold`:** nothing in Phase 4 sets it, and nothing in Phase 5 does either (Option A). **Phase 6** turns a reservation's tickets into `sold` when the payment webhook confirms the order; the trigger already allows only `reserved → sold` for the same reservation.

## Implementation choices made in Phase 4 (for review)

1. **The pool is created by a database trigger on publish**, so every publish path (API, fixtures, future tools) gets exactly one pool, in the same transaction.
2. **Numbers are taken lowest first.** With sequential numbering (O15), customers get the next free numbers; zero padding is display only.
3. **Pool limit: 1,000,000 tickets per draw** (DB CHECK, domain and contract). This is a technical safeguard for the publish transaction, not a business rule; the owner may change it.
4. **The cap counts tickets held in active reservations** (and, from Phase 5, sold tickets). Released and expired reservations give the allowance back.
5. **Reservation length is configuration** (`RESERVATION_TTL_SECONDS`): default 600, and production refuses any other value. Tests use 2 s (API integration) and 60 s (e2e), clearly labelled.
6. **Availability is display-only**, cached 3 s; decisions always use the locked rows.
7. **Reservations are rate-limited** to 30 per user per 10 minutes (Redis), to stop one account from churning the pool.
8. **Customer reservations are not written to `audit_log`.** The non-deletable `reservations` table is their record; the audit log stays for staff and system actions.
9. **New access policy `@Public({ identify: true })`:** a public route that recognises a signed-in caller (to show their allowance) but never refuses anyone. MFA-pending sessions count as signed out.
10. **The integration suite runs on at most 4 workers** (`vitest.config.mts`). Every integration file starts its own database and NestJS app, and Phase 4 adds files that drive real contention (200 buyers, a 50,000-ticket pool). At one worker per core the machine, not the code, decided the result: the first full run failed 8 files and 3 tests on hook and test timeouts. Capped at 4 the same suite is green and about five times faster (17 files / 255 tests in 73 s, against 365 s failing). Nothing about the engine changed. If CI hardware differs, this is the number to revisit.
11. **Two reservation-expiry tests no longer depend on a request finishing inside the test TTL.** They were correct about the product but assumed wall-clock margins that a loaded machine erases: one slept 3,300 ms against a 3-second availability cache it had just refilled (300 ms of room), and one asserted ticket numbers from a creation response that, on a 2-second TTL, can legitimately come back already expired and empty. The first now polls until the cache rolls over; the second uses a 6-second TTL instance and waits on the server's own `expiresAt`. Both still fail if the behaviour is wrong.
12. **Continue is disabled** with an explicit notice, because checkout does not exist yet.

## Decisions needed

| #   | Decision                                                                                                   | Blocks                                  |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | **O12** `min_age` + self-exclusion for UK and IE                                                           | Any market going live                   |
| 2   | Email verification + password reset timing                                                                 | Account recovery; guest entry (Phase 5) |
| 3   | **O8** roles that must use MFA                                                                             | Mandatory staff MFA                     |
| 4   | **O9** major configuration changes                                                                         | Editing published draws                 |
| 5   | Confirm the seeded RBAC matrix                                                                             | —                                       |
| 6   | **O6** policy for cancelling a live draw (and what happens to its reservations)                            | Cancelling live draws (refused today)   |
| 7   | Public page caching approach                                                                               | SPEC §9 performance target              |
| 8   | Confirm the 1,000,000-ticket pool limit and the 30-per-10-minutes reservation rate limit (choices 3 and 7) | —                                       |

## Phase 4 known issues

- Pool generation is linear in the pool size and runs inside the publish transaction: about 6.2 s for 50,000 tickets on this machine, so a 1,000,000-ticket pool would take around a minute here (much less on server hardware). Publishing is rare and the draw is not yet open, so nothing waits on it.
- `The destination stream closed early` still appears in the web server log when a test ends mid-stream (known from Phase 3; harmless).
- The e2e suite is CPU-heavy on this Windows machine (3 workers, as in CI). The expiry test waits for a real 60-second reservation to run out.

## Open decisions (Revision 2 Part G, still unresolved)

| ID        | Question                                                                                                                                                         | Needed by                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| O6 (part) | Policy for cancelling a draw that is already live                                                                                                                | Phase 9                                                                             |
| O7        | Refund policy: destination, refunds after close/settlement, tickets and instant wins on refunded orders                                                          | Phases 6/10                                                                         |
| O8        | Which roles are "privileged" for mandatory MFA (not enforced in Phase 2)                                                                                         | Phase 2                                                                             |
| O9        | Exact list of "major configuration changes" (market gate changes are treated as sensitive meanwhile)                                                             | Phases 2/10                                                                         |
| O10       | Postal-entry rule values; maker-checker threshold for admin wallet credits                                                                                       | Phases 7/10                                                                         |
| O11       | Referral qualifying actions/rewards; Vault Meter metric, scope, thresholds, rewards                                                                              | Phase 11                                                                            |
| O12       | Compliance values: minimum age per market, self-exclusion scope, consent wording, retention, masked-name format. **The skill-answer part is settled — ADR-0030** | **Now** for UK/IE `min_age` + self-exclusion (market enablement); the rest Phase 12 |
| O13       | Production payment provider(s)                                                                                                                                   | Before Phase 14                                                                     |
| O14       | Hosting (and PostgreSQL 18 availability), email provider, storage/CDN, monitoring, analytics                                                                     | Before Phase 13                                                                     |
| O16       | Cash alternative for physical prizes                                                                                                                             | Phases 8/9                                                                          |
| O17       | Legacy access: plugin list and a sanitized WordPress DB export                                                                                                   | Now (migration discovery)                                                           |

O15 (ticket numbering) was decided on 2026-09-22: sequential (ADR-0027). O1–O6 and O18 were approved on 2026-09-21 (ADR-0020 to ADR-0026).

## Blockers

- **Phase 4:** none for the implementation. Reservations stay impossible on real databases until O12 lets a market be enabled.
- **Migration discovery:** O17, legacy system access.

## Phase 5 progress

| Task                                               | State         | Evidence                                                     |
| -------------------------------------------------- | ------------- | ------------------------------------------------------------ |
| P5-0 NB-1 structural reservation-end fix           | ✅ merged     | PR #11, migration `0010`                                     |
| NB-3 reservation fixtures made transaction-stable  | ✅ merged     | PR #12, tests only                                           |
| P5-1 Transactional outbox                          | ✅ merged     | PR #13 (`13b35ae`), migration `0011`                         |
| P5-2 Mail port + notifications relay               | ✅ merged     | PR #15 (`f1d33d3`), ADR-0028                                 |
| Ticket-engine test-pool teardown fix               | ✅ merged     | PR #17 (`117a6fa`), harness only                             |
| Local gitleaks in `pnpm verify`                    | ✅ merged     | PR #18 (`5ebbdf2`), tooling only                             |
| P5-3 Guest sessions                                | ✅ merged     | PR #20 (`b940e7d`), ADR-0029, migration `0012`, 41 tests     |
| P5-4 Guest email verification                      | ✅ merged     | PR #21 (`173fd45`), ADR-0020 + ADR-0030, migration `0013`    |
| **P5-5 Guest checkout access + per-market basket** | **in review** | Migration `0014`, `apps/api/src/cart/`, 34 integration tests |
| P5-6 Market terms versions and acceptance          | not started   | Scope below                                                  |
| P5-7 Order creation, skill answer and idempotency  | not started   | Scope below                                                  |
| P5-8 Phase 5 integration and gate hardening        | not started   | Scope below                                                  |

### P5-1: the outbox (migration 0011)

- **`outbox`:** `id` (UUIDv7), `topic` (dotted lower-case, same format as `audit_log.action`), `payload` (jsonb object), `available_at`, `attempts`, `published_at`, `last_error`, `created_at`.
- **Producers** call `enqueueOutboxEvent(executor, topic, payload)` with the **same executor as the business change**, so the event commits or rolls back with it. This is why `withTransaction` forbids side effects in `fn`: an outbox row is inside the database, an email is not.
- **`hv_claim_outbox(limit, lease_seconds)`** claims due, unpublished events with `FOR UPDATE SKIP LOCKED` — the same pattern as `hv_expire_reservations` — counting the attempt and pushing `available_at` forward by the lease.
- **A claim is a lease, not a hand-off.** A worker that dies mid-delivery loses nothing: the lease lapses and the event is claimable again. Delivery is therefore **at least once**, and every handler must be idempotent.
- **Guard trigger `hv_outbox_guard`:** created unpublished, unattempted and error-free; `id`, `topic`, `payload` and `created_at` immutable; **publishing happens once** (a published row cannot change again); attempts never decrease.
- **Privileges:** `hv_app` cannot `DELETE` or `TRUNCATE` the outbox, so application code cannot lose a pending event.
- **Worker:** `outbox` queue, job `publish`, scheduler `outbox-publish` every 5 s, up to 20 batches of 100 per run, `concurrency: 1` per process. Several worker processes remain safe because claiming skips what another holds.
- **Retry:** backoff doubles from 10 s and stops growing at 1 hour. **No give-up policy is set** — a stuck event keeps its attempt count and last error and stays visible rather than being dropped. Choosing when to stop is a policy decision left to the owner.
- **The first producer is P5-4** (guest verification codes). An unknown topic still fails the event — recorded, not dropped. `enqueueOutboxEvent` now lives in `@hv/db`, because the API produces and the worker delivers and neither app can import the other; `apps/worker/src/outbox/outbox.ts` re-exports it.

### P5-2: mail delivery and the B17 relay (ADR-0028, no migration)

- **The `outbox` queue relays**, it does not deliver: it claims due rows and enqueues a job on the `notifications` queue with **`jobId` = the outbox row id** (specification B17), then returns `deferred` so the row stays unpublished.
- **The `notifications` queue delivers**: it opens the sealed payload, sends the message, and only then marks the row published. **`published_at` still means the side effect happened** — never "queued in Redis".
- **PostgreSQL owns retry, exclusively.** Notification jobs use `attempts: 1`; the outbox lease, `attempts` and backoff remain the only retry mechanism.
- **Notification jobs remove themselves on success and on failure.** Verified by experiment, not assumed: BullMQ silently ignores an enqueue whose job id belongs to a **retained** completed or failed job, so retention would have left a failed email permanently un-redeliverable while its attempt count climbed.
- **Sensitive payloads are sealed** with the same AES-256-GCM construction as TOTP secrets (`SecretBox`, now in `@hv/domain` so the API and worker share one key-management model). The topic is the associated data. No plaintext one-time code or recipient address is stored in PostgreSQL **or Redis** — proven by direct SQL and by inspecting the job.
- **`MailPort` is provider-independent**, following the shape of ADR-0006. `nodemailer` exists only behind the SMTP adapter; Mailpit is the dev/test target. **Production refuses to start without `SMTP_URL`, `MAIL_FROM` and `OUTBOX_ENCRYPTION_KEY`**, because O14 has not chosen a provider.
- **Duplicate verification emails are possible and accepted** (at-least-once). Redelivery is tested: the message is sent again, but the record of the first success is not overwritten.

### P5-4: guest email verification (ADR-0020, migration 0013)

The parameters are in [ADR-0020](adr/0020-guest-email-verification.md#implementation-phase-5-task-p5-4). What matters structurally:

- **`guest_email_verifications`:** `id` (UUIDv7), `guest_session_id`, `email` (citext, normalized exactly as `users.email`), `code_hash` (bytea, `CHECK octet_length = 32`), `attempts`, `consumed_at`, `expires_at`, `created_at`. A partial index on `(guest_session_id, email, created_at DESC) WHERE consumed_at IS NULL` serves the only hot lookup.
- **Guard trigger `hv_guest_email_verifications_guard`:** rows are created fresh (unconsumed, unattempted); identity columns and `expires_at` are immutable; a consumed row stays consumed; attempts never decrease. A `CHECK` also caps the TTL at 60 minutes, so no migration or fixture can quietly issue an hour-long code.
- **Privileges:** `hv_app` cannot `DELETE` or `TRUNCATE` the table, so an attempt count cannot be erased by application code. Retention is Phase 12 (O12), as for the outbox.
- **The limits are in the database, not the API.** The attempt count is incremented under `FOR UPDATE` before the comparison, and **committed whatever the verdict** — the verifying transaction returns a verdict and the error is raised outside it. Throwing inside would roll the increment back and the cap would never engage.
- **Every failure is the same error.** Wrong, expired, consumed, belonging to another session, never existed: one `INVALID_VERIFICATION_CODE`. Tested directly, because this is the property that makes the 5-attempt cap worth having.
- **Sending is limited on both dimensions, deliberately.** Per address (3/hour), so one inbox cannot be flooded from many sessions; and **per IP (20/hour, the same value as `registerPerIp`)**, because the per-address limit does nothing about a caller who rotates addresses — which is what would produce unbounded mail to strangers and unbounded rows on tables `hv_app` cannot delete from. Both are consumed before anything is written, and both fail closed. A third count in SQL covers the same address across rotated sessions, as a backstop if Redis is emptied.
- **Routes:** `POST /markets/:market/checkout/email/code` (202), `POST …/verify` (200), `GET …/verification`. All `@Public({ identify: true })` behind `MarketGuard`. The code request issues the guest session if there is none, so **these are the only routes that set `hv_guest`**.
- **The API is now a key holder.** `OUTBOX_ENCRYPTION_KEY` is required for it to start, and it refuses a low-entropy placeholder in production exactly as the worker does. The API and worker must hold the same value.
- **Still no plaintext code anywhere it could persist**: hashed in PostgreSQL, sealed in the outbox and in Redis, absent from every response, and never logged.

## Phase 5 remaining scope (P5-5 to P5-8)

Specification Part F gives Phase 5 as "per-market basket, guest email verification, skill answer validation, terms acceptance, idempotent order creation, outbox". The outbox (P5-1, P5-2) and guest email verification (P5-3, P5-4) are merged. **Four items remain**, and they are broken down below.

This breakdown was derived on 2026-09-25 from the specification alone. Nothing here adds a requirement the specification does not state; where the specification is silent, it says so. The three questions it raised as needing an owner decision were **all settled on 2026-09-25 in [ADR-0031](adr/0031-checkout-cart-terms-and-order-numbers.md)**, so P5-5, P5-6 and P5-7 are no longer blocked on a decision.

### Why this decomposition, and not one task per remaining item

The obvious split — basket, skill answer, terms, orders — does not survive contact with the data model (Revision 2 B18):

| Table                 | Specified shape                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `carts`, `cart_items` | Cart per (session, market); `UNIQUE(cart_id, draw_id)`                                                                                                            |
| `terms_versions`      | `market_id`, `version`, `published_at`; `UNIQUE(market_id, version)`                                                                                              |
| `terms_acceptances`   | `terms_version_id`, `user_id` **or** `order_id`, `at`                                                                                                             |
| `orders`              | `idempotency_key UNIQUE`; `(market_id, currency)` FK; `user_id` **or** `guest_email` (CHECK exactly one); `status`; **`terms_version_id`**; `order_number UNIQUE` |
| `order_items`         | `(draw_id, market_id)` FK → `draws (id, market_id)`; `quantity > 0`; `unit_price_minor`; **`skill_answer_option_id`**                                             |

The skill answer is a column on `order_items` and the accepted terms are a column on `orders`. B20 requires the answer to be validated **before order creation**, and `cart_items` has no answer column — so the answer arrives with the checkout request and is written in the order-creation transaction. **Skill-answer validation is therefore not separable from order creation**; a task that validated an answer without creating an order would have nothing to persist and nothing to test end to end.

Terms are different: `orders.terms_version_id` is a foreign key, so **`terms_versions` must exist before `orders` can be created at all**. That makes terms a genuine prerequisite task rather than a slice of order creation, and it keeps the orders migration focused.

Hence: basket → terms → orders (carrying the skill answer) → hardening.

### P5-5 — Guest checkout access and the per-market basket

**Objective.** Give a verified guest a way into the purchase path, and put the server-side basket behind it.

In scope:

- **Open the purchase path to guests.** Part F requires guest checkout; the reservation routes are `@Authenticated()` today and the P4 handoff records that "the API does not accept guests yet". The constraints on this are fixed and listed below.
- **`carts` and `cart_items`**, per the shape above. One basket per market (ADR-0026); a basket cannot mix markets and the API rejects an attempt to.
- **Basket identity for both guests and accounts**, using the same mechanism (B4).
- **Basket persistence** across the requests a checkout takes, and its relationship to the existing reservations (a reservation is what actually holds tickets; the basket is not a hold).
- **Market isolation**, enforced as everywhere else: `MarketGuard`, and a cross-market basket refused by the API rather than by the UI.
- **Concurrency**: proven against real PostgreSQL, following the P4 lock order (entrant counter → tickets) wherever the basket touches allocation.

Out of scope: orders, payment, terms, skill answers.

**Guest access — the constraints, which are not negotiable:**

1. The appropriate guest identity is `guest_sessions` (ADR-0029), resolved through `@Public({ identify: true })` into `request.hvGuest`.
2. A **fresh** verified email is required wherever the cap identity is needed — `GuestSessionsService.hasFreshVerifiedEmail()`, evaluated at the point of decision, never cached (ADR-0020, 30-minute window).
3. **Authenticated behaviour is preserved exactly.** A signed-in customer's path does not change, and a signed-in caller is never also treated as a guest.
4. **Guest context never satisfies an authenticated authorization decision.** `AccessGuard` keeps reading `hvAuth` only below the public branch. Nothing may be re-routed through `hvGuest` to make a guest "count as" a user.
5. **Cap identity rules are unchanged** (ADR-0008): user → user id, guest → normalized verified email. ADR-0021 bridging still applies.
6. **Market isolation is unchanged.**

**Route names are deliberately not specified here.** The implementation task inspects the existing reservation API first and proposes them.

**Migration: yes — `0014`.** The specification names `carts` and `cart_items` and gives their key constraints (`UNIQUE(cart_id, draw_id)`), and **ADR-0031 fixes the ownership columns**. The column list beyond that is not specified and must not be invented; the task proposes a schema from the spec, ADR-0031 and the existing conventions, and the owner approves it before it is applied.

**OWNER-DECIDED (2026-09-25) — cart ownership. ADR-0031, Decision 1.** A cart carries both `user_id` and `guest_session_id` with a CHECK that **exactly one** is set, plus one `market_id` — the same shape the specification already gives `orders`. "One cart per owner per market" is therefore two partial unique indexes, not one constraint. Cart ownership and order identity differ on purpose: the cart points at a guest **session**, the order records a guest **email**, and the verified email must still be fresh at order creation even though the cart is not.

**Cart merge on sign-in is not decided, because nothing requires it.** ADR-0021's merge is about cap counters, not baskets. What happens to a guest's cart when they sign in is a **P5-5 implementation decision** to be taken from the ownership model and reported at the P5-5 gate; doing nothing is consistent with ADR-0031. If P5-5 concludes a merge is needed, that needs its own ADR.

### P5-5 as built (migration 0014)

- **`carts`:** `market_id`, plus `user_id` and `guest_session_id` with the ADR-0031 CHECK that exactly one is set. One cart per owner per market as **two partial unique indexes**, because the owning column differs.
- **`cart_items`:** `cart_id`, `market_id`, `draw_id`, `reservation_id`, `removed_at`. It deliberately **does not copy quantity, price or currency** — the reservation already records all three under constraints that tie them to the draw and the market, and a second copy could only drift.
- **Market isolation is structural.** Composite foreign keys force an item's market to equal its cart's market _and_ its draw's market, and a reservation already carries the same pair (0009). A UK basket holding an IE draw is unrepresentable, not merely refused. Proven by a test that tries it in raw SQL.
- **`hv_cart_items_guard` checks ownership in the database**: a user's basket takes only that user's `user` reservations, a guest's only `email` reservations for the address that guest session verified. Putting someone else's reservation in your basket would otherwise be one INSERT.
- **Nothing is deleted.** `hv_app` has no DELETE or TRUNCATE on either table; removing an item sets `removed_at`, and B18's `UNIQUE(cart_id, draw_id)` is a partial index over live items.
- **Routes** (all `@Public({ identify: true })` behind `MarketGuard`): `GET /markets/:market/cart`, `POST …/cart/items`, `DELETE …/cart/items/:item`. The authenticated reservation routes are **unchanged** and still refuse a guest cookie.
- **The basket allocates through the existing engine** — same `TicketAllocator`, same caps, same lock order, same expiry. There is no second allocation path.
- **A guest's cap key is their verified email, checked fresh at the moment it is used** (ADR-0008, ADR-0020); a lapsed verification cannot add to a basket.
- **An expired hold stays visible but stops counting**: the item is reported with its effective status and is excluded from `activeItemCount` and the total.
- **Guest → user cart merge is deliberately not implemented** (ADR-0031). A guest's basket and an account's basket are separate rows and stay that way; nothing in the specification asks for a merge, and inventing one was out of scope.

### P5-6 — Market terms versions and acceptance

**Objective.** Make it possible for a market to have terms, and for accepting them to be recorded.

In scope: `terms_versions` and `terms_acceptances` as specified; a market's active terms version (B12 lists "active terms version" among the typed `market_settings` compliance columns, which `0004` does not yet have); the read path that exposes a market's current terms; and recording acceptance.

Out of scope: **terms content**, which B12 marks "Content: legal" and Part F assigns to Phase 12. The mechanism is built with the content absent, exactly as `market_settings` already carries nullable compliance columns.

**Migration: yes — `0015`** (plus the `market_settings` column). Required before `orders.terms_version_id` can exist.

**OWNER-DECIDED (2026-09-25) — an active terms version gates checkout. ADR-0031, Decision 2.** A market must have an active terms version before checkout can create an order; the customer accepts that version; the order references the accepted `terms_version_id`; missing active terms prevent order creation, refused by the API rather than the UI; and acceptance is tied to the applicable market and version.

**The gate is on checkout, not on market enablement** — `hv_market_missing_settings` is not extended. A market can be enabled and browsable with no terms version; it simply cannot take an order. Terms content remains Phase 12 and comes from legal; no wording is invented here or in fixtures.

### P5-7 — Order creation, skill answer and idempotency

**Objective.** Turn a basket into an order that stops at `pending_payment`.

In scope:

- **`orders` and `order_items`** as specified above, including `order_number UNIQUE` and the `user_id`-or-`guest_email` CHECK.
- **Server-side skill-answer validation** per **ADR-0030**: a wrong answer rejects the whole checkout, creates no order, leaves the reservation active and returns a generic error. The submitted option is checked to belong to the question of the draw being bought. Correct options never leave the admin API.
- **Terms acceptance** recorded in the same transaction (`orders.terms_version_id` plus a `terms_acceptances` row).
- **`Idempotency-Key`** on the mutating endpoint (B5), backed by `orders.idempotency_key UNIQUE`, with replay returning the original order rather than creating a second.
- **One transaction** for the whole of it: skill answer, terms, order, order items. Money as `(amount_minor, currency)`, never summed across currencies; `order_items` snapshot `market_id`, `currency` and `unit_price_minor`.
- **The order ends at `pending_payment`.** The reservation stays active and its tickets stay `reserved`. An expired reservation must never become an order — check `expires_at > now()` in the same transaction.

Explicitly out of scope, and this is the part the P4 handoff originally got wrong: **no payment, no payment webhooks, no `reserved → sold`, no Gate 4, and a payment return URL is never proof of payment.** All of that is Phase 6 (ADR-0006).

**Migration: yes — `0016`.**

**OWNER-DECIDED (2026-09-25) — `order_number` is an opaque `HV-` identifier. ADR-0031, Decision 3.** `HV-` followed by an uppercase alphanumeric suffix (for example `HV-7F4K92M8`): randomly and collision-resistantly generated with the project's existing `node:crypto` conventions, `UNIQUE` in PostgreSQL, and **never the primary key** — primary keys stay `uuidv7()`. **Not sequential**, which would leak order volume and let a holder guess neighbouring numbers.

**The length is left to P5-7**, since nothing in the specification, schema or tests constrains one; P5-7 records its choice and the reasoning. Worth weighing there: `generateRecoveryCode` is the project's other customer-facing typed-back identifier and uses base32, whose alphabet has no `0`/`O` or `1`/`I` to confuse when read aloud. Either the full alphanumeric range or a narrower one satisfies ADR-0031.

### P5-8 — Phase 5 integration and gate hardening

**Objective.** Prove the whole checkout works together, and close the phase.

In scope: the full vertical integration (guest and account); the two Part F exit criteria — **idempotency-key replay** and **cross-market basket rejected**; the **ADR-0021 concurrency test of registration racing a guest purchase**, which that ADR requires "in Phase 4/5" and which does not yet exist; concurrency against real PostgreSQL; and the documentation, handoff and status cleanup that closes the phase.

**Migration: none expected.**

### Dependencies

```text
P5-4 (merged) ──► P5-5 ──► P5-7 ──► P5-8
                    │        ▲
P5-6 ───────────────┴────────┘
```

- **P5-5 needs P5-3 and P5-4** for guest identity and the verified-email cap key.
- **P5-6 needs neither P5-5 nor anything after P5-4**; it can be built at any point, and only has to land before P5-7.
- **P5-7 needs both P5-5 and P5-6** — a basket to turn into an order, and a terms version to point at.
- **P5-8 needs all three.**

## Phase 5 Definition of Done

ADR-0019 gates every phase on a Definition of Done. Phase 1's is in the Initialization Report (H4); this is Phase 5's, built from Part F, DEVELOPMENT_RULES and the approved Option A scope. Phase 5 is complete only when every line is true.

**Functionality**

- [ ] A **guest** can complete a checkout: verified email, basket, skill answer, terms, order — without an account.
- [ ] A **signed-in customer** can do the same, and their existing behaviour is unchanged.
- [ ] A checkout requires a **fresh verified email** for a guest, judged at the point of decision.
- [ ] The basket is **server-side and one per market**; a cross-market basket is **refused by the API**, with the UI bypassed.
- [ ] The **skill answer is validated server-side** and a wrong answer rejects the checkout per ADR-0030. Correct options never leave the admin API.
- [ ] **Terms acceptance is recorded** against the order (and the user, where there is one).
- [ ] Order creation is **idempotent**: the same `Idempotency-Key` returns the original order and never creates a second.
- [ ] An order ends at **`pending_payment`**.

**Explicitly not done in Phase 5** (each must be demonstrably absent)

- [ ] No payment is taken or initiated; no payment provider code runs.
- [ ] No payment webhooks.
- [ ] No ticket moves `reserved → sold`.
- [ ] Gate 4 has not moved.
- [ ] No wallet, referrals or Vault Meter.

**Correctness and concurrency**

- [ ] **PostgreSQL is the source of truth.** No decision rests on Redis, a cache, or anything the browser sent back.
- [ ] Concurrency is proven **against real PostgreSQL**, not a mock.
- [ ] The **idempotency-key replay test** passes (Part F exit criterion).
- [ ] The **cross-market basket rejection test** passes (Part F exit criterion).
- [ ] The **guest purchase racing account registration** test passes (ADR-0021).
- [ ] An **expired reservation cannot become an order**.
- [ ] Cap identity holds across the guest and account paths (ADR-0008, ADR-0021).

**Quality gate**

- [ ] `pnpm verify` green end to end, including `pnpm secrets:scan` (local Gitleaks).
- [ ] Migrations apply from a clean database, checksums match, and `codegen:verify` is clean.
- [ ] `pnpm test:e2e` green.
- [ ] **CI green** on the pull request.
- [ ] Reviewed and merged into `develop` by pull request (DEVELOPMENT_RULES §4, §7); no direct push to `develop` or `main`.
- [ ] `PROJECT_STATUS.md`, `TASK_BOARD.md`, `ACTIVE_WORK.md`, `CHANGELOG.md` and a handoff are current.
- [ ] Every architectural decision taken during the phase has an ADR.

**Not part of this DoD:** legal and compliance _values_ (terms content, consent wording, minimum age, self-exclusion) remain O12 and Phase 12. Phase 5 builds the mechanisms that carry them.

## Carried into Phase 5 (from the Phase 4 review)

These came out of the final review of PR #8. **None of them is reachable in Phase 4**; they are obligations and known issues for the phase that introduces orders.

1. **NB-1 — `hv_end_reservation` returns the wrong allowance once sold tickets exist. Phase 5 must fix this structurally before adding the reservation → sold/order transition.** The function frees only `reserved` tickets (correct, sold ones are untouched) but then decrements `draw_entrant_counts.count` by the reservation's **quantity** rather than by the number of tickets it actually released. A reservation holding a sold ticket that later expires or is released would therefore give the entrant their cap allowance back while they keep the sold ticket — a cap bypass. Unreachable in Phase 4 because nothing writes `sold`. The fix is to decrement by the actual row count freed (`GET DIAGNOSTICS`), making the invariant structural instead of a rule Phase 5 has to remember. **Fixed by task P5-0, migration `0010_reservation_end_fix`**, merged in PR #11.
2. **NB-2 — a temporary "the last tickets are being taken right now" refusal.** When a shortfall is caused by reservations that are overdue but not yet swept, `countAvailable` counts their tickets as free, so the allocator raises `AllocationContended` and retries; the inline sweep runs once before allocation (limit 200), not between retries, so all five attempts reach the same conclusion. The customer gets a correct refusal with a slightly misleading message. **No data corruption.** Low severity; leave it unless Phase 5 changes the reservation flow, in which case re-sweep before the final retry or reword the refusal.
3. **NB-3 — a flaky integration assertion on CI.** See the Phase 4 CI record above. Test-only; needs its own `fix/*` branch.
4. **Large ticket-pool publication is acceptable for V1. Do not change it now.** The pool is one set-based insert inside the publish transaction: ~6.2 s for 50,000 tickets on the development machine, whose Docker VM is roughly 10× slower than a normal server. The scale assumption is that draws are published rarely, by staff, at sizes in the thousands to tens of thousands; `draws_total_tickets_max` (1,000,000) bounds the worst case. Revisit only if pools beyond ~100,000 become real.
5. **`maxWorkers: 4` is resource management, not reduced coverage.** It caps how many integration **files** run at once. The concurrency the gates actually exercise lives inside each test (`Promise.all` over dozens of simultaneous transactions against a 60-connection pool) and is untouched by it, as is `ROUNDS = 3`.
6. **O15 = sequential ticket numbering** (ADR-0027). Numbers are taken lowest first; zero padding is display only.

## Next task

**Phase 5 (cart and checkout) is under way; P5-0 to P5-4 are merged and P5-5 is in review.** Scope is Option A (specification-faithful), ending at `pending_payment`; Phase 6 keeps payments, webhooks, RESERVED → SOLD and Gate 4. The wrong-skill-answer behaviour is settled in **ADR-0030**, and cart ownership, the terms gate and the order-number format in **ADR-0031**. The remaining work is broken down as P5-5 to P5-8 in "Phase 5 remaining scope", and the phase closes against the "Phase 5 Definition of Done" above. Each task needs its own branch, PR and owner approval before it starts. Active work and ownership: [collaboration/ACTIVE_WORK.md](collaboration/ACTIVE_WORK.md), [collaboration/TASK_BOARD.md](collaboration/TASK_BOARD.md).

---

# Phase 3 record (merged into `develop`, PR #7)

Phase 3 (Day 3): draws foundation + first customer vertical slice. Branch `feature/p3-draws`, merged into `develop` as `3eb551e`; CI green on `develop`.

### Phase 3 Definition of Done

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

### Database (migration 0008_draws)

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

### API (Phase 3)

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

### Web (Phase 3)

- **Design foundation:** `globals.css` in plain CSS with tokens, no UI framework and no web-font download. It covers the header and footer, hero, cards, badges, panels, forms and tables, responsive at 720px and 1080px, and respects reduced motion.
- **Customer pages**
  - `/{market}`: market home with featured draws.
  - `/{market}/draws`: "Open now" and "Opening soon", with loading, empty and error states.
  - `/{market}/draws/{slug}`: prizes, prices in the market currency, times in the market time zone, and the skill question.
  - The entry panel is honest: a quantity selector with an exact total, answer choices that nothing checks yet, and a disabled button with a notice that entry is not available online.
  - Prize images are branded placeholders (the storage/CDN decision is O14).
- **Admin pages:** `/admin/draws` (market tabs), `/admin/draws/{market}/new`, and `/admin/draws/{market}/{id}` (details, prizes, skill question, publish with blockers shown, cancel with reason).

### Phase 3 verification

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

### Phase 3 scope notes

- **Caching:** Part F says "public list/detail (functional, cached)". The pages are rendered per request instead, so gate changes and cancellations take effect immediately. The < 200 ms cached-page target (SPEC §9) needs tag revalidation from the API. That is not built yet; proposed with the performance work.
- **Not built (later phases):** ticket pool at publish (P4), availability counts (P4), checking skill answers (P5; wrong-answer behaviour is O12), settlement after close (P9), prize values and cash alternatives (O16), prize images (O14).

### Implementation choices made in Phase 3 (for review)

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

### Decisions needed

| #   | Decision                                                                                                  | Blocks                                     |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | **O12** `min_age` + self-exclusion for UK and IE                                                          | Any market (and the draw pages) going live |
| 2   | Email verification + password reset timing                                                                | Account recovery                           |
| 3   | **O8** roles that must use MFA                                                                            | Mandatory staff MFA                        |
| 4   | **O9** major configuration changes, including whether publishing or editing a published draw is sensitive | Editing published draws                    |
| 5   | Confirm the seeded RBAC matrix                                                                            | —                                          |
| 6   | **O6** policy for cancelling a live draw                                                                  | Cancelling live draws (refused today)      |
| 7   | Public page caching approach (see scope notes)                                                            | SPEC §9 performance target                 |

### Phase 3 known issues

- Under heavy CPU load on this Windows machine, the web app's 5 s API timeout can trip during e2e runs (`UNREACHABLE`). A 2-worker local run passes 33/33, and CI passes with the committed 3 workers.
- The e2e suite is CPU-heavy on this Windows machine. It is tuned to 3 workers; CI runs the same configuration.
- `The destination stream closed early` appears in the web server log when a test navigates away mid-stream. It is harmless.

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

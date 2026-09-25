# Handoffs

_Last updated: 2026-09-25_

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

### 2026-09-25 — P5-7 — Order creation, skill answer and idempotency (for P5-8 and Phase 6)

Status: OPEN

Task: P5-7
Developer: Divyanshu (owner), with Claude
Branch: `feature/p5-7-order-creation` (not merged)
Status of the work: DONE, awaiting review

What was completed:

- `0016_orders`: `orders` and `order_items`, with guard triggers making the checkout snapshot immutable and the project's usual DELETE/TRUNCATE protection.
- `apps/api/src/orders/`: repository, `CheckoutService`, controller. `packages/domain/src/order-number.ts`.
- Routes: `POST /markets/:market/checkout/orders`, `GET …/checkout/orders`, `GET …/checkout/orders/:order`.

Important implementation details — read these before Phase 6:

- **The status is `awaiting_payment`, not `pending_payment`.** B7's state machine names it, and B7's later transitions (`awaiting_payment → failed | expired`, `paid_unfulfillable`) are what Phase 6 implements. The planning prose used "pending_payment" informally for the same moment. The CHECK already admits the full B7 enumeration, so **Phase 6 adds transitions, not values**.
- **The reservation is the ticket hold and stays that way.** An order leaves it `active` with its tickets `reserved`. **Phase 6 marks them `sold`** (the trigger allows only `reserved → sold` for the same reservation), and per the amended P4 handoff a new reservation status such as `converted` needs a migration extending `reservations_status_valid` and `hv_reservations_guard`. `order_items.reservation_id` is UNIQUE, so an order line is the one route from an order to its tickets.
- **Everything that decides the outcome is in one transaction**: the idempotency claim, the terms check, the skill answers, the reservation checks, the order and its lines. A refusal therefore leaves nothing at all — no draft order, and no spent idempotency key.
- **Idempotency is the database's, not a cache's.** `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`; there is no read-then-insert. `idempotency_digest` (SHA-256 of market, buyer, terms label and sorted answers) is **not in B18** — it was added because "same key, different request" must be refused rather than answered with the earlier order, and because returning one customer's order to another reusing their key would be a disclosure.
- **A duplicate request blocks on the cart lock**, and finds the basket emptied when released. An empty basket is therefore re-checked against the idempotency key before it is reported: found means replay, absent means genuinely empty. **This was found by the concurrency test**, which first saw four 400s where it expected five 201s.
- **The correct skill answer never enters the API process.** `isCorrectAnswer` compares in SQL and returns a boolean. A missing answer and a wrong one are the same refusal (ADR-0030); an answer for a draw that is not in the basket is refused too, so answers and lines map exactly.
- **Money comes from the reservation**, which already constrains price, currency and total against the draw and the market. The request contributes only which option was chosen.
- **`order_number`: `HV-` + 10 base32 characters.** ADR-0031 left the length here. About 50 bits; base32 avoids `0`/`O` and `1`/`I` for something read aloud to support, matching `generateRecoveryCode`. Collisions are a UNIQUE violation retried up to five times.
- **Database:** migration `0016_orders.sql`, applied to local dev and test only; codegen re-run (27 tables). READ COMMITTED with row locks; no advisory locks. `orders` keeps UPDATE so Phase 6 can move the status; `order_items` has UPDATE, DELETE and TRUNCATE revoked.
- **Security:** a guest never becomes a user; the order records the verified address (B18), not the session, and freshness is re-checked at order creation. Another customer's order is 404, not 403. The audit entry carries the order number, line count and total — no address, no ticket numbers, no answer.

Files/modules affected:

- `packages/db/migrations/0016_orders.sql`, `packages/db/src/generated/db.ts`
- `packages/domain/src/{order-number,index}.ts`, `packages/contracts/src/{orders,errors,index}.ts`
- `apps/api/src/orders/` (new), `apps/api/src/terms/{terms.service,terms.repository}.ts`, `apps/api/src/app.module.ts`

Tests executed:

- `apps/api/test/checkout-orders.int.test.ts`: 30/30 against real PostgreSQL and Redis.
- Full `pnpm verify` (213 unit, 459 integration, 16 migrations), `codegen:verify`, `pnpm test:e2e` 38 passed.
- **Not tested:** payment of any kind — none exists.

Known issues:

- **The known gitleaks negative-control flake is still open.** `tools/gitleaks/negative-control.test.mjs` plants a per-run random hex string and depends on an entropy threshold catching it; measured at roughly 5–10% during P5-6. Untouched here, and it wants its own `fix/*` branch.
- No web UI for checkout; the routes are API-only.

Integration points:

- **Database:** `orders`, `order_items`; `hv_orders_guard`, `hv_order_items_guard`.
- **API:** `CheckoutService` (`createOrder`, `getOrder`, `listOrders`), `OrdersRepository`.
- **For Phase 6:** a payment attaches to an order by id; confirmation moves `awaiting_payment → paid` and marks that order's reservations' tickets `sold` in the same transaction (B7). The order already records everything a payment needs: `external_due_minor`, `currency` and `market_id`.

Next developer action:

- **P5-8** (Phase 5 integration and gate hardening): the two Part F exit criteria and the ADR-0021 concurrency test of registration racing a guest purchase, which still does not exist. Scope in `PROJECT_STATUS.md`. It starts only on explicit owner approval.

### 2026-09-25 — P5-6 — Market terms versions and acceptance (for P5-7, order creation)

Status: OPEN

Task: P5-6
Developer: Divyanshu (owner), with Claude
Branch: `feature/p5-6-market-terms` (not merged)
Status of the work: DONE, awaiting review

What was completed:

- `0015_market_terms`: `terms_versions`, `terms_acceptances`, and `market_settings.active_terms_version_id`, with guard triggers and the project's usual DELETE/TRUNCATE protection.
- `apps/api/src/terms/`: repository, customer service, admin service, and two controllers.
- Routes: `GET /markets/:market/terms`, `POST …/terms/acceptance`; admin `GET/POST /admin/markets/:market/terms`, `POST …/:terms/publish`, `POST …/:terms/activate`.

Important implementation details:

- **What P5-7 needs is `TermsService`**, which the module exports. `acceptedActiveVersion(market, identity)` answers both questions order creation has to ask — is there an active version here, and has this customer accepted it — and returns the version to write into `orders.terms_version_id`. It returns null in both the "no terms" and "not accepted" cases, so P5-7 must distinguish them if it wants different errors (`TERMS_UNAVAILABLE` already exists for the first).
- **The gate is on checkout, not enablement.** `hv_market_missing_settings` is deliberately untouched (ADR-0031). A market with no active version is still enabled and browsable; `GET …/terms` reports `checkoutAllowed: false`. A test asserts the enablement gate does not mention terms.
- **A published version is immutable and cannot be withdrawn.** An order points at it as the thing the customer agreed to; that record is worthless if it can be rewritten. A correction is a new version. Enforced by `hv_terms_versions_guard`, not by the service.
- **Acceptances are append-only** — `hv_app` has no UPDATE or DELETE, and a trigger refuses any change. Accepting twice is one acceptance (two partial unique indexes), so P5-7 can call it freely.
- **Identity follows ADR-0031**: `user_id` **or** `guest_session_id`, exactly one. B18's "per user or order" predates ADR-0029; the order link is P5-7's to add if it wants one, and `orders.terms_version_id` already records the version. **A guest accepting creates no user row.**
- **Market isolation is structural**: composite foreign keys tie the active version and every acceptance to the market they claim, so no market can point at or accept another's terms. Proven in raw SQL.
- **No legal wording exists.** No content column, no content field in any contract, none in fixtures. B12 marks it legal; Part F puts per-market terms in Phase 12. **Do not add placeholder wording in P5-7 or its tests.**
- **Database:** migration `0015_market_terms.sql`, applied to local dev and test only; codegen re-run (25 tables). `terms_versions` keeps UPDATE (publishing is an update); `terms_acceptances` has UPDATE, DELETE and TRUNCATE revoked.
- **Security:** admin mutations are `markets.gate.manage`, scoped to the market in the route and **sensitive** (step-up MFA), audited in the same transaction as the change. Accepting needs a checkout identity and grants nothing; a guest cookie reaches no admin route.

Files/modules affected:

- `packages/db/migrations/0015_market_terms.sql`, `packages/db/src/generated/db.ts`, `packages/db/src/testing/global-setup.ts`
- `packages/contracts/src/{terms,errors,index}.ts`
- `apps/api/src/terms/` (new), `apps/api/src/app.module.ts`

Tests executed:

- `apps/api/test/terms.int.test.ts`: 33/33 against real PostgreSQL.
- Full `pnpm verify`, plus `pnpm test:e2e`. Results in PROJECT_STATUS.md.
- **Not tested:** anything that consumes terms at checkout — there is no order yet.

Known issues:

- **A shared-test-infrastructure fix rides along.** `global-setup.ts` now reproduces the production privilege model in the test template. Before it, `hv_app` had **no privileges at all** in any test database, so every "hv_app cannot DELETE this" assertion — including the one merged with P5-5 — passed because there was no grant to revoke. A migration that forgot its REVOKE would have looked correct. Those assertions are real now, and this is the reason a test-only file appears in a schema task.
- No admin UI for terms; the routes are API-only. The web app is unchanged.

Integration points:

- **Database:** `terms_versions`, `terms_acceptances`, `market_settings.active_terms_version_id`; `hv_terms_versions_guard`, `hv_terms_acceptances_guard`.
- **API:** `TermsService` (`marketTerms`, `accept`, `acceptedActiveVersion`), `TermsRepository`, `AdminTermsService`.
- **For P5-7:** `orders.terms_version_id` points at `terms_versions(id)`; the composite `UNIQUE(id, market_id)` is there so the order's market can be checked against it too.

Next developer action:

- **P5-7** (order creation, skill answer and idempotency, migration `0016`), which needs both this and P5-5. Scope in `PROJECT_STATUS.md`. It starts only on explicit owner approval.

### 2026-09-25 — P5-5 — Guest checkout access + per-market basket (for P5-6 and P5-7)

Status: OPEN

Task: P5-5
Developer: Divyanshu (owner), with Claude
Branch: `feature/p5-5-guest-checkout-basket` (not merged)
Status of the work: DONE, awaiting review

What was completed:

- `0014_carts`: `carts` (one owner, one market) and `cart_items` (a reservation in a basket), both with guard triggers and no DELETE for `hv_app`.
- `apps/api/src/cart/`: repository, service, controller, and `CheckoutIdentity` — the discriminated union that says whether a basket belongs to a user or a guest.
- Routes `GET /markets/:market/cart`, `POST …/cart/items`, `DELETE …/cart/items/:item`.

Important implementation details:

- **A cart item carries no money.** Quantity, unit price, currency and expiry all live on the reservation, which already constrains them against the draw and the market (`reservations_total_exact`, `reservations_market_currency_fkey`). P5-7 should take an order line's money from the reservation too, not from the cart item.
- **Market isolation is enforced by composite foreign keys**, not by the service: `(cart_id, market_id)`, `(draw_id, market_id)` and `(reservation_id, draw_id)`. There is no arrangement of rows that puts an IE draw in a UK basket. Keep that property when `order_items` is added — the specification already gives it the same `(draw_id, market_id)` FK.
- **`hv_cart_items_guard` checks ownership against the cap identity** (ADR-0008): a user's basket takes `user` reservations with the same `user_id`; a guest's takes `email` reservations whose address is the one that guest session verified. A guest whose verification has lapsed can still _see_ their basket but cannot add to it.
- **One allocation path.** The basket calls the same `TicketAllocator` the reservation routes use, so caps, `FOR UPDATE SKIP LOCKED`, the entrant-counter → tickets lock order and expiry are all unchanged. `TicketsModule` now exports the allocator, repository and service for this.
- **The pre-check is not the last word.** Two requests adding the same draw can both find the basket empty; the partial unique index `cart_items_cart_draw_idx` settles it and the loser is mapped to the same 409 as a caller who was simply late. This was found by a concurrency test, not by reading the code.
- **Removing an item releases its tickets in the same transaction.** An item gone from the basket whose tickets were still held would keep counting against the cap with nothing on screen to explain it.
- **Authentication:** the cart routes are `@Public({ identify: true })`; the authenticated reservation routes were **not** modified and still refuse a guest cookie. A guest context never reaches an authorization decision.
- **Database:** migration `0014_carts.sql`, applied to local dev and test databases only; codegen re-run (23 tables). READ COMMITTED with row locks; no advisory or table locks. `hv_app` has no DELETE or TRUNCATE on the two new tables.
- **Security:** the client is never the source of truth for price, currency, market, availability or eligibility — a request names a draw slug and a quantity, and everything else is read from PostgreSQL. New rate limit `cartItemsPerOwner` (30 per 10 minutes), keyed on the user or the guest session.

Files/modules affected:

- `packages/db/migrations/0014_carts.sql`, `packages/db/src/generated/db.ts`
- `packages/contracts/src/{cart,errors,index}.ts`
- `apps/api/src/cart/` (new), `apps/api/src/tickets/{tickets.repository,reservations.service,tickets.module}.ts`, `apps/api/src/auth/rate-limiter.ts`, `apps/api/src/app.module.ts`

Tests executed:

- `apps/api/test/cart.int.test.ts`: 34/34 against real PostgreSQL and Redis, including the guest/account boundary, market isolation attempted in raw SQL, the ownership guard trigger, and four concurrency cases.
- Full `pnpm verify`, plus `pnpm test:e2e`. Results in PROJECT_STATUS.md.
- **Not tested:** anything past the basket. No order, no payment, no `sold`.

Known issues:

- **Guest → user cart merge is not implemented** (ADR-0031 leaves it to this task, and nothing in the specification requires it). A guest who signs in keeps a separate guest basket; both remain reachable by their own identity. If the owner wants a merge, it is an architecture decision and needs its own ADR.
- A guest whose 30-minute verification lapses cannot re-verify on the same session (ADR-0029 makes `verified_email` immutable), so they need a new session to add more. Pre-existing, recorded during the P5-4 reconciliation.

Integration points:

- **Database:** `carts`, `cart_items`; `hv_cart_items_guard`, `hv_carts_guard`.
- **API:** `CartService` (`view`, `addItem`, `removeItem`), `CartRepository`, `checkoutIdentity()`.
- **For P5-7:** an order is built from the cart's **active** items — `CartService` already reports `activeItemCount` and excludes lapsed holds from the total. An expired item must never become an order line.

Next developer action:

- **P5-6** (market terms versions and acceptance, migration `0015`), which P5-7 needs before `orders.terms_version_id` can exist. Scope in `PROJECT_STATUS.md`. It starts only on explicit owner approval.

### 2026-09-25 — P5-3 + P5-4 — Guest identity and verified email (for P5-5, basket and guest checkout)

Status: OPEN

Task: P5-3 (PR #20), P5-4 (PR #21)
Developer: Divyanshu (owner), with Claude
Branch: `feature/p5-3-guest-sessions` merged as `b940e7d`; `feature/p5-4-guest-email-verification` merged as `173fd45`
Status of the work: DONE, reviewed and merged

What was completed:

- `0012_guest_sessions`: a guest's checkout identity — opaque token stored as SHA-256 only, 24-hour lifetime, and the verified email that is their ticket-cap key. Cookie `hv_guest`, built by the same code as `hv_session` (ADR-0029).
- `0013_guest_email_verifications`: the six-digit code proving a guest can read an address — hashed, single-use, 10-minute expiry, 5 attempts counted under a row lock, 3 sends per address and 20 per IP per hour (ADR-0020). First real producer for the outbox; the payload is sealed (ADR-0028) and delivered by the P5-2 relay.

Important implementation details:

- **A guest session is not authentication.** `AccessGuard` resolves it only on the `public` branch, for `@Public({ identify: true })` routes, into `request.hvGuest`. Every authorization path reads `hvAuth` only, and a signed-in caller is never also treated as a guest. **P5-5 must not weaken this**: opening checkout to guests means giving the relevant routes a public-with-identify policy, never making `hvGuest` satisfy an authenticated one.
- **The cap key for a guest is `guest_sessions.verified_email`**, normalized exactly as `users.email` (ADR-0008). It is **immutable once set** — verifying a different address means a new session.
- **Freshness is judged on every use, never cached.** Call `GuestSessionsService.hasFreshVerifiedEmail()` at the point of decision; the 30-minute window (`GUEST_VERIFIED_EMAIL_TTL_MINUTES`) is deliberately much shorter than the session.
- **Producing outbox events:** `enqueueOutboxEvent` lives in `@hv/db` and takes an executor, so it must be called with the **same transaction** as the business change.
- **Database:** migrations `0012` and `0013`; codegen re-run (21 tables). `hv_app` has no `DELETE` or `TRUNCATE` on either table, so retention is an operator task (Phase 12, O12). Guard triggers make identity columns immutable independently of the API.
- **Infrastructure:** `OUTBOX_ENCRYPTION_KEY` is now **required by the API as well as the worker** and must hold the same value in both, or sealed payloads cannot be opened. Both refuse a low-entropy placeholder in production. Placeholders are in `.env.example` only.
- **Security:** every failure of `verify` returns one generic `INVALID_VERIFICATION_CODE`; attempts are committed even when the code is wrong (the transaction returns a verdict and the error is raised outside it). Plaintext codes exist only in memory, never in PostgreSQL, Redis, a response or a log.

Files/modules affected:

- `packages/db/migrations/{0012,0013}*.sql`, `packages/db/src/{outbox.ts,generated/db.ts}`
- `packages/domain/src/{verification-code,verification-email}.ts`, `packages/contracts/src/guests.ts`
- `apps/api/src/guests/`, `apps/api/src/auth/{cookies,rate-limiter}.ts`, `apps/api/src/rbac/access.guard.ts`, `apps/api/src/config/env.ts`
- `apps/worker/src/{outbox,mail}/` (re-exports only; delivery unchanged)

Tests executed:

- `pnpm verify` green: 213 unit, 362 integration, 13 migrations with matching checksums, build. `pnpm test:e2e`: 38 passed. Integration suite run twice. Gitleaks clean.
- Not tested: guest **purchase** end to end — there is no guest purchase path yet. That is P5-5.

Known issues:

- Reconciliation findings the owner chose to leave: authenticated callers can create unreachable guest sessions; `VERIFICATION_REQUIRED` is distinguishable from an invalid code; a 429 can expose per-address limit state; the SQL send-limit backstop is not independently atomic; only the newest live verification is reachable. All are recorded in `PROJECT_STATUS.md`.

Integration points:

- **Database:** `guest_sessions`, `guest_email_verifications`, `outbox`.
- **API:** `GuestSessionsService` (`issue`, `resolve`, `bindVerifiedEmail`, `hasFreshVerifiedEmail`, `reload`), `EmailVerificationService`, `@CurrentGuest()`.
- **Infrastructure:** env `GUEST_SESSION_TTL_HOURS`, `GUEST_VERIFIED_EMAIL_TTL_MINUTES`, `OUTBOX_ENCRYPTION_KEY`.

Next developer action:

- **P5-5** (guest checkout access + per-market basket). Its scope, constraints and Definition of Done are in `PROJECT_STATUS.md` ("Phase 5 remaining scope"); cart ownership is fixed by **ADR-0031** (`user_id` XOR `guest_session_id`, one `market_id`). It starts only on explicit owner approval, and its first step is to inspect the existing reservation API before proposing any route. What happens to a guest cart when they sign in is deliberately left to it to decide and report.

### 2026-09-22 — P4 — Ticket engine + customer entry flow (for Phase 5, checkout)

Status: ACCEPTED (by Divyanshu, 2026-09-25) — **amended, see the end of this entry**

Task: P4 (no GitHub issue; PR #8)
Developer: Divyanshu (owner), with Claude
Branch: `feature/p4-ticket-engine` — merged into `develop` via PR #8 (`49e3903`), released to `main` via PR #9 (`c284825`)
Status of the work: DONE, reviewed and merged

What was completed:

- `0009_tickets`: ticket pool created on publish, reservations, per-entrant counters, guard triggers, `hv_end_reservation`, `hv_expire_reservations`.
- `@hv/domain` tickets (transitions, entrant keys, totals, quantity and open checks, display numbering); `@hv/contracts` tickets.
- API `tickets` module (reservations, availability, admin inventory) and `TicketAllocator` with a contention retry; worker `reservations` expiry sweep.
- Web: reservation flow on the draw page, `/{market}/reservations/{id}` with a server-timed countdown, admin inventory.

Important implementation details:

- **Allocation (one transaction):** create and lock the entrant's counter row → check the cap → insert the reservation → `SELECT … WHERE status = 'available' ORDER BY ticket_number LIMIT n FOR UPDATE SKIP LOCKED` → mark the tickets reserved → increment the counter. A short result rolls everything back. `AllocationContended` means "retry"; any other refusal is final.
- **Lock order** is always entrant counter → tickets. `hv_expire_reservations` processes reservations in entrant order with SKIP LOCKED, so sweeps and allocations cannot deadlock. Keep this order in checkout.
- **Cap:** `draw_entrant_counts.count` = tickets held in active reservations. **Phase 5 must not decrement it when a reservation becomes an order**: sold tickets keep counting. See **NB-1** below — the database function does not currently enforce this, so Phase 5 has to make it structural. Guests use the `email` key with the normalized verified email (ADR-0020); the API does not accept guests yet.
- **Selling:** ~~Phase 5 marks the reservation's tickets `reserved → sold` … and ends the reservation.~~ **SUPERSEDED on 2026-09-25 by the approved Option A scope** (see the amendment at the end of this handoff). `reserved → sold` and ending the reservation belong to **Phase 6**, not Phase 5. What is still true and still applies whenever that transition is built: the trigger allows only `reserved → sold` for the same reservation; a new reservation status (for example `converted`) needs a migration extending `reservations_status_valid` and `hv_reservations_guard`; and `expires_at > now()` must be checked in the same transaction, because an expired reservation must never become an order.
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

Review findings carried into Phase 5 (from the final review of PR #8):

- **NB-1 — must be fixed structurally before the reservation → sold/order transition exists.** `hv_end_reservation` (migration 0009) frees only `reserved` tickets, correctly leaving sold ones alone, but then decrements `draw_entrant_counts.count` by the reservation's **quantity** rather than by the number of tickets actually released. Once sold tickets exist, a reservation holding one that later expires or is released hands the entrant their cap allowance back while they keep the sold ticket — a cap bypass. **Phase 4 cannot reach it: nothing writes `sold`.** Fix by decrementing the actual row count freed (`GET DIAGNOSTICS`) in the Phase 5 migration, so the invariant is enforced by construction rather than by remembering this note. Do not simply rely on "Phase 5 must not decrement it".
- **NB-2 — known low-severity issue, no action needed.** A shortfall caused by overdue-but-unswept reservations makes `countAvailable` report their tickets as free, so the allocator retries five times and refuses with "The last tickets are being taken right now". The refusal is correct and **nothing is corrupted**; the next attempt or the 30 s worker sweep clears it. Only revisit if Phase 5 changes the reservation flow.
- **NB-3 — flaky integration assertion on CI (test-only).** The release PR #9 run failed at the integration step on the same commit that passed on the `develop` push. Likely `expect(r.status).toBe('active')` on the creation response in `reservations.int.test.ts` under `RESERVATION_TTL_SECONDS=2`. Needs its own `fix/*` branch. Details in PROJECT_STATUS.md, "Phase 4 CI record".
- **Large ticket-pool publication stays as it is for V1.** One set-based insert in the publish transaction; ~6.2 s for 50,000 tickets on the development machine. Assumes draws are published rarely, by staff, at thousands-to-tens-of-thousands scale, with the 1,000,000 CHECK as the bound. Do not change it now.
- **`maxWorkers: 4` does not reduce concurrency coverage.** It caps how many integration _files_ run at once; the races the gates exercise live inside each test and are unaffected, as is `ROUNDS = 3`.
- **O15 = sequential ticket numbering** (ADR-0027), lowest numbers first; zero padding is display only.

Next developer action:

- ~~P5 (cart and checkout) starts only on explicit owner approval. It needs O12 (wrong skill answer behaviour) and the email-verification timing decision for guests, and it must address NB-1 in its database design before any order can mark tickets sold.~~ **Done: all three are settled — see the amendment below.**

#### Amendment — 2026-09-25, Phase 5 scope lock

This handoff was written before Phase 5's scope was fixed, and two of its statements no longer match the approved architecture. They are corrected here rather than deleted, because a handoff is the project's memory (§ Handoffs, rule 4).

1. **Phase 5 does NOT sell tickets.** The approved scope is **Option A**: Phase 5 ends at `pending_payment`. **Payment, payment webhooks, the `reserved → sold` transition and Gate 4 are all Phase 6** (ADR-0006). Phase 5 also must never treat a payment return URL as proof of payment. The "Selling" bullet above is struck through accordingly. An order created in Phase 5 leaves its reservation active and its tickets `reserved`.
2. **The three preconditions are met.** NB-1 was fixed structurally by **P5-0** (migration `0010`, PR #11) — `hv_end_reservation` now decrements the cap by the rows actually freed. The guest email-verification timing decision became **ADR-0020** and was implemented by **P5-4** (migration `0013`, PR #21). The O12 wrong-skill-answer behaviour is now **ADR-0030**.
3. **Guests still cannot reserve.** The reservation routes remain `@Authenticated()`. Part F requires guest checkout, so opening that path is explicit scope for **P5-5**; the constraints it must honour are recorded in `PROJECT_STATUS.md` ("Phase 5 remaining scope").

Everything else in this handoff — the allocation transaction, the lock order (entrant counter → tickets), the composite FKs available to order lines, effective-state reads, availability being display-only, and NB-2 — is unchanged and still applies to Phase 5.

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

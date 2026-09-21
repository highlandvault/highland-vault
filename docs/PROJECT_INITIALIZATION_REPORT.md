# Highland Vault — Project Initialization Report

| | |
|---|---|
| **Revision** | 2 (supersedes Revision 1 of 2026-09-21) |
| **Date** | 2026-09-21 |
| **Status** | Revised architecture and Day 1 plan, **awaiting owner review** |
| **Code written** | None. No dependencies installed. No database created. |
| **Sources** | `01 — Platform Specification` (**SPEC**) · `02 — Solo Developer Development Plan` (**PLAN**) · Owner decisions of 2026-09-21 (**D1–D19**) |

## How to read this document

Every design point carries one of four labels.

| Label | Meaning |
|---|---|
| **REQ** | Stated in SPEC or PLAN (`SPEC §n` / `PLAN §n`). |
| **APPROVED** | Decided by the project owner (see Part A, `Dn`). |
| **PROPOSED** | My implementation recommendation. It follows from the requirements and approved decisions and needs your confirmation. |
| **OPEN** | Not defined by the documents or decisions. It is listed in Part G and is **not implemented until decided**. |

**Revision 2 changes**

- Every Revision 1 question that your decisions answered is now closed.
- The architecture has been re-derived from those decisions.
- Nine gaps that the decisions surfaced are raised in Part G. Two examples: a guest winning a wallet-credit instant win, and the settlement grace period for in-flight payments.
- A detailed Day 1 plan has been added (Part H).

---

## Contents

- **Part A** — Approved decisions (decision register)
- **Part B** — Revised architecture
- **Part C** — Revised repository structure
- **Part D** — Revised database / domain model
- **Part E** — Revised dependency map
- **Part F** — Revised development sequence and risks
- **Part G** — Remaining OPEN decisions
- **Part H** — Day 1 implementation plan

---

# Part A — Approved Decisions (Decision Register)

Each decision will be recorded as a short ADR in `docs/adr/` during Day 1.

| ID | Area | Decision (summary) |
|---|---|---|
| D1 | Local development | Docker Desktop and Docker Compose running PostgreSQL, Redis and Mailpit. pnpm workspaces via Corepack. Concurrency is tested only against real PostgreSQL, **never mocked databases**. |
| D2 | Database | Kysely with plain SQL migrations. PostgreSQL is the source of truth. Explicit SQL is used for transactions, `FOR UPDATE`, `SKIP LOCKED`, UNIQUE, CHECK, indexes and triggers. No Prisma, no TypeORM. |
| D3 | Users and markets | One account can be used in both UK and IE, and users are **not** assigned to a market. Email is **globally unique**. Market context lives on draw, order, payment, currency, terms and consent. |
| D4 | Draws and markets | In V1 each draw belongs to exactly one market (UK→GBP, IE→EUR, DE→EUR). There are no multi-market draws, but the design stays extensible for them. |
| D5 | Routing | `/uk`, `/ie`, `/de`. Germany stays disabled until legal approval, and the gate is **enforced by the API**. |
| D6 | Payments | Provider-independent abstraction with four operations: create payment, verify webhook, retrieve status, refund. A fake provider is used for development and tests. No production provider is hard-coded. A browser redirect **never** marks an order paid. |
| D7 | Wallet | One wallet per currency (GBP, EUR). Credit comes from instant wins, refunds, referral rewards, Vault Meter rewards and approved admin credits. No top-ups, no withdrawals and no expiry in V1. The ledger is append-only and corrections are reversing entries. |
| D8 | Guests and caps | Guests can browse, answer the skill question, buy and pay. Guests get no wallet, referral or Vault Meter features. Cap key: authenticated user → user ID; guest → normalized **verified** email. No fingerprinting in V1, but the design stays extensible. |
| D9 | Admin | `/admin` lives inside the main Next.js app. The API is the security boundary. |
| D10 | Roles | Roles: customer, support, fulfilment, finance, admin, super_admin. RBAC is permission-based. MFA is required for privileged roles. Sensitive operations require a reason and create an audit record. |
| D11 | Tickets | Ticket pool is pre-generated at publish. `UNIQUE(draw_id, ticket_number)`. Allocation uses row locks and `SKIP LOCKED`. Checkout reserves tickets with a **10-minute TTL**, and background processing releases expired reservations. If fewer tickets are available than requested, the request is **rejected**. Postal entries use the same engine. |
| D12 | Instant wins | Winning ticket numbers are predefined. Prize types are wallet credit and physical prize (no cash). An instant-win ticket stays eligible for the main draw. Instant wins are kept separate from main-draw winners. The database guarantees each prize is awarded at most once. |
| D13 | Postal entries | Same allocation engine. One valid postal entry equals one ticket. Postal tickets count toward the cap and are eligible for the main draw and instant wins. The detailed rules are configurable. |
| D14 | Settlement | Settles automatically after the scheduled close, **even if the draw has not sold out**. Uses a row lock, a CSPRNG seed, deterministic selection, and stores the seed, algorithm version and eligible-set hash. Winner positions are unique and configurable per draw. Settlement is audited and idempotent, and only one concurrent settler can succeed. No live or external draw in V1. |
| D15 | Reports | Sales by draw, market and date; orders; tickets; wallet liability; wallet credits and debits; refunds; instant-win awards; main-draw winners; fulfilment; reconciliation; compliance/audit activity. All have CSV export. |
| D16 | Compliance | No invented legal rules. Compliance is configurable per market across all SPEC §8 areas. Undefined rules are marked OPEN. |
| D17 | Referrals and Vault Meter | Configurable infrastructure with no hard-coded amounts or rules. `UNIQUE(user_id, milestone_id)`. |
| D18 | Migration | Discovery starts early. The migration is deterministic and reproducible: inventory → mapping → test import → reconciliation → rehearsal → final delta → cutover → rollback window. Production migration data is never modified by hand. |
| D19 | Schedule | Days 1–15 are **phases**, not calendar dates. A phase is complete only when it meets the Definition of Done. Critical tests are never skipped. |

---

# Part B — Revised Architecture

## B1. Product understanding (unchanged)

**REQ.** Highland Vault is a native replacement for a WordPress/WooCommerce prize-competition site. It runs in UK and IE, with DE gated. Customers answer a skill question and buy numbered tickets in one or more draws, as a guest or with an account. They pay by provider and/or wallet. Some tickets win instant prizes, and draws settle at close. There is also a free postal route, referrals, a Vault Meter and a full admin back office.

The rebuild's primary purpose is to make three incidents impossible (SPEC §3): duplicate winners, lost wallet credit and ticket overselling.

## B2. Technology stack (confirmed)

| Concern | Choice | Basis |
|---|---|---|
| Frontend | Next.js (App Router) + TypeScript strict | REQ |
| Backend | NestJS (Fastify adapter) + TypeScript strict | REQ; Fastify is PROPOSED |
| Database | **PostgreSQL 18** | REQ (PostgreSQL); version PROPOSED: it has native `uuidv7()`. Fallback is 17 plus app-generated UUIDv7 if the production host lacks 18 (OPEN O14) |
| Data access | **Kysely** + `pg` driver + **plain SQL migrations** | APPROVED D2 |
| Queue/cache | Redis 7.4 + BullMQ (`maxmemory-policy noeviction`, AOF on) | REQ; configuration PROPOSED (BullMQ requires noeviction) |
| Local infrastructure | Docker Desktop + Compose: postgres, redis, mailpit | APPROVED D1 |
| Package manager | pnpm workspaces via Corepack (version pinned in `packageManager`) | APPROVED D1 |
| Validation | Zod, shared between API and web | PROPOSED |
| Tests | Vitest (unit/integration), Supertest (API), Playwright (e2e), k6 (load) | PROPOSED |
| Logging/monitoring | pino JSON logs, Sentry (errors). Analytics tool OPEN | PROPOSED / OPEN O14 |
| CI | GitHub Actions with Postgres and Redis service containers | PROPOSED |

## B3. Overall system architecture

```
 Browser ─► CDN ─► Next.js apps/web  (/uk /ie /de, /admin)
                       │ server-side fetch / browser mutations
                       ▼
                 NestJS apps/api  ──────────────► PostgreSQL 18  ◄── SOURCE OF TRUTH
                   │  ▲    ▲                         ▲
                   │  │    └── /webhooks/{provider}  │  (outbox table written in-transaction)
                   ▼  │                              │
                 Redis 7.4 ◄──── BullMQ ────► NestJS apps/worker
                  (queues, rate limits,         draw close, settlement, reservation expiry,
                   availability cache)          outbox relay, emails, rewards, reconciliation
                                                      │
                                   PaymentProvider adapter (fake | real), email (SMTP/Mailpit), object storage
```

**Principles:**

- **REQ.** PostgreSQL is the source of truth. Money is stored in integer minor units. Business-critical transitions run in transactions. Payment and webhook handling is idempotent. Critical background work is driven by scheduled jobs, never by page views. Instant wins and main-draw winners are separate concepts. (SPEC §13)
- **PROPOSED.** The API is the only writer of business data, and Next.js never connects to PostgreSQL.
- **PROPOSED.** Redis holds no business fact that isn't also in PostgreSQL, so losing Redis only loses queue timing. Sweeper jobs rebuild that from database state.
- **PROPOSED.** Side effects after commit (emails, follow-up jobs) go through a **transactional outbox**. The `outbox_messages` row is written in the business transaction, and a worker relays it to BullMQ. Nothing is lost if Redis is down at commit time.
- **PROPOSED.** Every job and webhook handler is safe to run twice.

## B4. Frontend architecture

- **APPROVED D5.** URL structure is `/{market}/…` with `market ∈ {uk, ie, de}`. `/de` returns 404 while Germany is gated, and the API independently refuses DE requests.
- **REQ SPEC §9.** A cached draw page must respond in under 200 ms.
  - **PROPOSED:** draw list and detail pages are server-rendered and cached with tag revalidation (the API triggers revalidation on draw edits).
  - The **remaining-ticket count** is not in cached HTML. A small client component polls `GET /markets/:m/draws/:id/availability`, which reads a Redis value with a 2–5 s lifetime.
- **PROPOSED.** The basket is server-side and **one basket per market**, because each order is single-currency (from D4, see O18). Guest and account baskets use the same mechanism.
- **APPROVED D9.** `/admin` is a route group with its own layout and a server-side session and role check. The API enforces permissions again on every call.
- **REQ PLAN §5.** The UI is functional and unpolished until late phases.

## B5. Backend architecture

NestJS modules, grouped by phase. `apps/api` and `apps/worker` share the same modules.

| Module | Responsibility | Phase |
|---|---|---|
| `config`, `logging`, `health` | Env validated by Zod, pino, liveness/readiness | 1 |
| `database` | Kysely provider, `withTransaction()` with retry on `40001`/`40P01`, int8 parsing | 1 |
| `queue`, `outbox` | BullMQ connections, outbox relay | 1 (queue), 5 (outbox) |
| `markets` | Market config, compliance config, **Germany gate guard** | 2 |
| `auth` | Registration, login, sessions, password reset, email verification, **TOTP MFA** | 2 |
| `rbac` | Permissions, roles, `@RequirePermission()` guard (deny by default), step-up MFA | 2 |
| `audit` | Append-only audit log written **inside** the same transaction as the action | 2 |
| `users` | Profile, DOB, per-market consents and terms acceptances | 2 / 12 |
| `draws` | Draw CRUD, lifecycle state machine, prizes and positions, skill question, publish | 3 |
| `tickets` | Pool generation, allocation, caps, reservations, expiry, availability | 4 |
| `cart`, `checkout`, `orders` | Market basket, guest email verification, skill answer, idempotent order creation | 5 |
| `payments` | `PaymentProvider` interface, fake provider, payments, webhook ingestion, status polling, refunds | 6 |
| `wallet` | Ledger, balances, debit/credit/reversal, part-payment, reconciliation | 7 |
| `instant-wins` | Prize definitions, award on paid allocation | 8 |
| `settlement` | Close + grace, deterministic selection, winners | 9 |
| `postal-entries`, `fulfilment`, `reports`, `admin-*` | Operations back office | 10 |
| `referrals`, `vault-meter` | Configurable programmes, attribution, milestones | 11 |
| `notifications`, `compliance` | Email templates per market, self-exclusion, anonymisation | 12 |

**PROPOSED conventions:**

- Transactions are opened only in service methods, never in controllers.
- Every mutating endpoint accepts an `Idempotency-Key` header.
- Money is always a `(amount_minor, currency)` pair and is never summed across currencies.

## B6. Authentication

- **REQ SPEC §2.** Secure authentication. **APPROVED D3.** Global email uniqueness; users have no market assignment.
- **PROPOSED:**
  - **Sessions.** Server-side sessions in PostgreSQL. The cookie holds an opaque token and only its SHA-256 hash is stored. The cookie is `httpOnly; Secure; SameSite=Lax`.
  - **Passwords.** Argon2id. Login and registration are rate-limited via Redis.
  - **Email.** The email column is `citext UNIQUE`. Verification uses single-use hashed tokens.
  - **Guest checkout (D8).** The guest's email must be **verified** before it can act as a cap key.
    - PROPOSED mechanism: a 6-digit one-time code emailed during checkout, before order creation, producing a short-lived `verified_guest_email` bound to the session.
    - Timing and UX are OPEN O1.
  - **Guest → account bridging.** PROPOSED (OPEN O2): if an account already exists for a guest's verified email, the purchase is attributed to that user ID. When a guest later registers, their email-keyed cap counters are merged into the user key in one transaction. This stops "buy as guest, then buy again as user" from bypassing caps.
  - **MFA (D10).** TOTP with an encrypted secret and hashed recovery codes. Which roles count as "privileged" is OPEN O8; my proposal is all staff roles.
  - **Legacy passwords.** WordPress hashes (phpass/bcrypt) are verified on first login and rehashed to Argon2id. This will be confirmed during migration discovery.

## B7. RBAC

- **APPROVED D10.** Roles: `customer`, `support`, `fulfilment`, `finance`, `admin`, `super_admin`. RBAC is permission-based.
- **PROPOSED.**
  - Permissions are fine-grained strings, such as `draws.write`, `settlement.retry`, `wallet.adjust`, `refunds.create`, `markets.gate.manage`, `customers.pii.read`, `reports.export` and `audit.read`.
  - Role→permission mappings are stored in the database and seeded by migration.
  - `user_roles.market_id` is nullable (NULL means all markets), which allows market-scoped staff later.
- **APPROVED D10: sensitive operations.** These are settlement, wallet adjustments, refunds, Germany activation and major configuration changes. Each requires:
  1. the permission;
  2. an MFA'd session with **step-up MFA within the last 15 minutes** (PROPOSED);
  3. a non-empty `reason`;
  4. an `audit_log` row in the same transaction.

  The exact list of "major configuration changes" is OPEN O9.

- **Proposed starting matrix** (to be finalised in Phase 2):

| Permission area | support | fulfilment | finance | admin | super_admin |
|---|:-:|:-:|:-:|:-:|:-:|
| View customers/orders (masked PII) | ✓ | ✓ | ✓ | ✓ | ✓ |
| View full PII | ✓ | | ✓ | ✓ | ✓ |
| Fulfilment updates | | ✓ | | ✓ | ✓ |
| Postal entries | ✓ | | | ✓ | ✓ |
| Refunds, wallet adjustments | | | ✓ | | ✓ |
| Draw/instant-win management, settlement retry | | | | ✓ | ✓ |
| Reports / CSV export | | | ✓ | ✓ | ✓ |
| Roles, market gates, major configuration | | | | | ✓ |

## B8. Market architecture

- **REQ SPEC §7.** UK GBP/en-GB, IE EUR/en-IE, DE EUR/de-DE, with market-specific content, terms, payment configuration and marketing controls.
- **APPROVED D3/D4.** Users span markets, and a draw belongs to one market.

**Market context carriers:**

| Entity | Market column | Why |
|---|---|---|
| `draws` | `market_id` NOT NULL | D4 |
| `orders`, `order_items` | `market_id`, `currency` | Orders are single-market (D4) |
| `payments`, `refunds` | via order + own `currency` | D3 |
| `terms_versions`, `terms_acceptances` | `market_id` | D3 |
| `consents` | `market_id` | D3 |
| `wallets` | `currency` (not market) | D7. See OPEN O4: the IE and DE EUR wallet is shared |
| `users` | **none** | D3 |

**Database-enforced isolation (PROPOSED):**

- `markets` has `UNIQUE(id, currency)`.
- `draws` and `orders` reference it with a composite FK `(market_id, currency)`, so a currency can never drift from its market.
- `order_items (draw_id, market_id)` has a composite FK to `draws (id, market_id)`, so an order cannot contain another market's draw.

**Germany gate (APPROVED D5). Three independent layers:**

1. **Database:**
   ```sql
   CHECK (NOT (requires_legal_approval AND is_enabled AND legal_approved_at IS NULL))
   ```
   A legally-gated market cannot be enabled without a recorded approval. The approval fields are `legal_approved_at`, `legal_approved_by` and `legal_approval_ref`.
2. **Environment kill switch:** `ENABLED_MARKETS=uk,ie`. The API refuses any market that is not listed, whatever the database says.
3. **API guard:** every market-scoped route resolves the market and rejects disabled markets with 404. Admin activation is a sensitive operation (D10).

**Compliance configuration gate (PROPOSED):**

- Compliance values are typed, nullable columns in `market_settings`: minimum age, self-exclusion required, postal-entry settings, active terms version, and so on.
- NULL means "not yet decided" (OPEN).
- **A market cannot be enabled while any required compliance setting is NULL.** This is how "mark OPEN rather than invent" is enforced in the system itself, for UK and IE as well as DE.

**Extensibility to multi-market draws (D4).**

- `order_items` snapshot `market_id`, `currency` and `unit_price_minor`, so reporting never depends on `draws.market_id`.
- A future `draw_market_offers(draw_id, market_id, currency, price_minor)` table could then be added without touching the ticket pool, which is per draw rather than per market. Nothing is built for this in V1.

## B9. Ticket architecture

- **REQ SPEC §4.** `UNIQUE(draw_id, ticket_number)`. Allocation is atomic with row locking and SKIP LOCKED. Caps are enforced in the same transaction.
- **APPROVED D11.** Pool, 10-minute reservations, reject when short, and the same engine for postal entries.

**Pool generation.** On publish, one statement inserts `tickets(draw_id, ticket_number 1..N, status='available', shuffle_key=random)`. For an imported open draw, the pool is generated and the legacy sold numbers are then marked sold (see B18).

**Entrant key (D8, extensible).** `draw_entrant_counts(draw_id, entrant_type, entrant_ref, count)`:

- `entrant_type` is `user` (ref = user ID) or `email` (ref = normalized verified email).
- **PROPOSED normalization:** trim and lowercase only, with no provider-specific dot or plus stripping. Stronger identity later means adding a new `entrant_type`.

**Allocation transaction** (one function, used for orders and postal entries):

```sql
BEGIN;
-- 0. draw must be live and not past closes_at (row read, no lock needed on the draw)
-- 1. cap: create-if-missing, then lock THIS entrant's counter row only
INSERT INTO draw_entrant_counts (...) VALUES (...) ON CONFLICT DO NOTHING;
SELECT count FROM draw_entrant_counts WHERE ... FOR UPDATE;      -- reject if count + qty > max_per_person
-- 2. take tickets without blocking other buyers
SELECT id, ticket_number FROM tickets
 WHERE draw_id = $1 AND status = 'available'
 ORDER BY shuffle_key LIMIT $qty
 FOR UPDATE SKIP LOCKED;                                          -- fewer than qty rows → ROLLBACK, reject (D11)
UPDATE tickets SET status='reserved', order_item_id=$oi, reserved_until=now()+'10 min' WHERE id = ANY($ids);
UPDATE draw_entrant_counts SET count = count + $qty WHERE ...;
COMMIT;
```

- **No oversell by construction.** Only existing pool rows can be taken, SKIP LOCKED prevents double-taking, and the UNIQUE constraint is the final net.
- **Contention.** Buyers contend only on their own counter row. There is no draw-row lock in the purchase path.
- **SKIP LOCKED caveat.** A request can be rejected as "not enough available" while other buyers' uncommitted reservations are momentarily locked. That is correct behaviour, because those tickets are genuinely being taken.

**Ticket states.**

- `available → reserved → sold`
- `reserved → available` (on expiry or cancel)
- `sold → void` (on refund, per O7)

Every transition is a conditional `UPDATE … WHERE status = <expected>`.

**Reservation expiry (D11). PROPOSED:**

- A BullMQ repeatable job runs every 30 s. It releases rows `WHERE status='reserved' AND reserved_until < now()` in batches, decrementing counters in the same transaction.
- The allocation path also sweeps the draw it touches.
- **Safety rule:** before releasing a reservation whose order has a pending provider payment, the job performs a **trusted provider status check** (D6). If the provider says the payment succeeded, the payment is confirmed instead of released.

**Availability.** Remaining tickets = `COUNT(*) WHERE status='available'`, served from Redis for 2–5 s. The count is display-only and is never used for decisions.

**Ticket numbering.** The pool holds numbers 1..N, and allocation order is random via `shuffle_key`. Whether customers see random or sequential numbers is OPEN O15; switching is one `ORDER BY` change.

## B10. Payment architecture

- **REQ.** Unique provider references, unique order idempotency key, idempotent webhooks, refunds tested, checkout under 3 s excluding the provider.
- **APPROVED D6.** Provider-independent abstraction, fake provider, redirect never marks paid.

```ts
interface PaymentProvider {
  readonly code: string;                                        // 'fake', later e.g. 'stripe'
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;       // amount, currency, order ref, idempotency key, return URLs
  verifyWebhook(rawBody: Buffer, headers: Headers): Promise<VerifiedEvent>; // throws on bad signature
  getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus>;
  refund(input: RefundInput): Promise<ProviderRefundResult>;               // idempotency key required
}
```

**Provider configuration.** Providers are selected per market via `market_payment_configs(market_id, provider_code, config_ref)`. The configuration holds only secret *references*; the secrets themselves live in env or a secret manager.

**The fake provider** is used in dev and tests:

- it signs webhooks with an HMAC test key;
- it can deliver events late, duplicated, out of order or never;
- it exposes a dev-only page to "complete/fail" a payment.

It is not registered in production builds (a config guard refuses it).

**Order state machine:**

- `created → awaiting_payment → paid`
- `created → cancelled`
- `awaiting_payment → failed | expired`
- `paid → partially_refunded | refunded`
- Orders paid entirely from wallet go `created → paid` in the checkout transaction.

**Confirmation paths.** These are the only two, and both call the same idempotent `confirmPayment()`:

1. **Webhook:**
   1. Verify the signature.
   2. `INSERT payment_events … ON CONFLICT (provider, provider_event_id) DO NOTHING`. A duplicate returns 200 immediately.
   3. In one transaction, lock the order, apply the conditional transition, mark tickets `sold`, evaluate instant wins (B12) and write outbox messages.
   4. Return 200. A processing error returns 5xx so the provider retries, and the stored event is also retried by a job.
2. **Trusted status check:** `getPaymentStatus()` called server-side from the reservation-expiry job, the stuck-payment poller and the "return from provider" page. The return page may *trigger* a check but never marks anything paid itself.

**Late payment** (confirmed after the reservation was released):

- If the draw is still live and tickets are available, re-allocate.
- Otherwise the order goes to `paid_unfulfillable` and an automatic refund is raised. Where the refund goes is OPEN O7.

**Uniqueness:**

- `orders.idempotency_key UNIQUE`
- `payments UNIQUE(provider, provider_reference)`
- `payment_events UNIQUE(provider, provider_event_id)`
- `refunds UNIQUE(provider, provider_refund_reference)` and `refunds.idempotency_key UNIQUE`

## B11. Wallet architecture

- **REQ.** Append-only `wallet_entries`. `wallet_balances` is a cache. Spending locks, checks, debits and updates in one transaction.
- **APPROVED D7.** Per currency; five credit sources; no top-up, withdrawal or expiry; reversals only.

**Tables.** `wallets(id, user_id, currency)` with `UNIQUE(user_id, currency)`, created lazily on first credit. `wallet_balances(wallet_id PK, currency, balance_minor CHECK ≥ 0)`.

**`wallet_entries`:**

- `amount_minor` is signed.
- `entry_type` is a closed enum with sign rules enforced by CHECK:

| Credits (> 0) | Debits (< 0) |
|---|---|
| `instant_win_credit` | `order_payment` |
| `refund_credit` | `admin_debit` (correction) |
| `referral_reward` | |
| `vault_meter_reward` | |
| `admin_credit` | |
| `order_wallet_release` (compensation) | |

- Reversals use `entry_type='reversal'` with `reverses_entry_id UNIQUE`, so an entry can be reversed at most once, and the reversal must have the opposite sign.
- `idempotency_key UNIQUE` is **derived from the source**, for example `instant_win_award:{id}`, `refund:{id}`, `milestone_award:{id}`, `order:{id}:payment` or `order:{id}:release`.
- `market_id` is nullable and records origin for reporting.
- `actor_id` and `reason` are required for admin types (CHECK).
- A trigger and a privilege REVOKE make UPDATE and DELETE impossible.

**Debit** (inside the checkout transaction):

1. `SELECT … FROM wallet_balances WHERE wallet_id=$w FOR UPDATE`
2. Check that the balance is at least the amount.
3. Insert the ledger row.
4. Update the balance.

**Credit.** The ledger insert happens in the **same transaction** as the source state change (award, refund, reward). Credit therefore cannot be lost, and because of the idempotency key it cannot be duplicated.

**Part payment.** The wallet portion is debited when the order is created. If the external payment fails or expires, the order transition writes `order_wallet_release` (key `order:{id}:release`), which restores the funds exactly once. Guests cannot use the wallet (D8).

**Currency guard.**

- A composite FK `wallet_entries(wallet_id, currency) → wallets(id, currency)` pins the currency.
- The service rejects a wallet whose currency differs from the order's.

**Admin credits (D7 "approved").** A single actor with `wallet.adjust`, step-up MFA, a reason and an audit record. Whether large credits need a second approver is OPEN O10.

**Nightly reconciliation job** (REQ SPEC §9) checks:

- `SUM(entries)` equals the balance for every wallet;
- every paid order's `wallet_applied_minor` matches its ledger rows;
- no award, refund or reward that should have a credit is missing one;
- sold ticket counts match paid order items.

Discrepancies are stored in `reconciliation_findings` and alerted. **They are never auto-corrected.**

## B12. Instant-win architecture

- **APPROVED D12.** Predefined winning numbers. Prizes are wallet credit or physical. Instant-win tickets stay eligible for the main draw. Instant wins are separate from main-draw winners. Uniqueness is DB-enforced.

**Definitions.** `instant_win_prizes(draw_id, ticket_number, prize_type, value_minor/currency or description)` with `UNIQUE(draw_id, ticket_number)`. The FK `(draw_id, ticket_number) → tickets` is created at publish. They are editable only while the draw is in `draft`, and are never exposed by public APIs until won.

**Award moment (PROPOSED).** Awards happen when tickets become **sold**, never when they are reserved:

- inside `confirmPayment()` for orders;
- inside postal allocation for postal tickets (D13).

The award step is:

```sql
INSERT INTO instant_win_awards (instant_win_prize_id, ticket_id, …)
SELECT p.id, t.id, … FROM tickets t JOIN instant_win_prizes p USING (draw_id, ticket_number)
 WHERE t.id = ANY($soldTicketIds)
ON CONFLICT (instant_win_prize_id) DO NOTHING;
```

`UNIQUE(instant_win_prize_id)` means a prize can be awarded at most once. A wallet-credit prize is credited in the same transaction (key `instant_win_award:{id}`). A physical prize creates a `fulfilments` row.

**Recipient without a wallet.** A guest or postal entrant without an account who wins a wallet-credit prize is OPEN O3. Proposal: the award is recorded as `pending_claim` against the verified email and credited when an account with that email claims it.

**Refunded tickets.** What happens to an instant win on a later-refunded ticket is part of OPEN O7.

## B13. Postal entries

- **APPROVED D13.**
  - One valid entry equals one ticket, allocated via the same function.
  - Entries count toward the cap and are eligible for the main draw and instant wins.
  - The rules are configurable.

**PROPOSED:**

- Staff record `postal_entries(draw_id, entrant details, received_at, status: received → validated → allocated | rejected, rejection_reason)`.
- Allocation happens only on `validated`, with the ticket status going straight to `sold`. There is no reservation and no payment.
- **Configurable per market or draw** (`postal_entry_rules`): required fields, received-by cutoff relative to `closes_at`, whether the entry counts toward the cap (default true per D13), and entries per envelope (default 1). The values are OPEN O10 or legal.
- **Cap identity.** The cap key is the user ID if the postal email matches an account; otherwise it is the email. Whether email is mandatory on postal entries is OPEN O10.

## B14. Settlement architecture

- **REQ SPEC §4.** Lock; if settled, return; otherwise select, seed, create winners and change state atomically.
- **APPROVED D14.** Automatic after close, settled even if not sold out, positions configurable, no live draw.

**Draw lifecycle:**

- `draft → scheduled → live → closed → settled → completed`
- `draft|scheduled → cancelled`; cancellation after going live is OPEN O6.

**Close and grace period (PROPOSED, OPEN O5 for the duration).**

- At `closes_at`, a scheduled job moves the draw to `closed`, which blocks new reservations.
- **Settlement runs at `closes_at + grace`.** The proposed grace is 10-minute TTL + 2 minutes, so every in-flight checkout has either been confirmed or released.
- Reserved tickets never count as eligible, and payments confirmed after settlement follow the late-payment path (B10).
- Without a grace period, a customer who paid at close could miss the draw.

**Trigger.** A BullMQ delayed job, plus a **sweeper** every minute that settles any `closed` draw past its grace (this covers a lost Redis job). An admin "retry settlement" is a sensitive operation, but it calls the same idempotent function.

**Settlement transaction** (single function):

1. Lock the draw: `SELECT * FROM draws WHERE id=$d FOR UPDATE`.
2. If the status is `settled`, return the existing `draw_settlements` row (idempotent). If it is not `closed` or the grace has not elapsed, refuse.
3. Load the eligible tickets: `status='sold'`, which covers paid orders and validated postal entries, excluding voided tickets. Order them by `ticket_number`.
4. Compute `eligible_set_hash = SHA-256` over the ordered ticket numbers.
5. Generate a 32-byte seed with `crypto.randomBytes`.
6. **Algorithm `hv-settle-v1`.** For position k = 1..P, take `HMAC-SHA256(seed, "pos:" + k + ":" + attempt)`. The first 8 bytes form an unsigned integer, which is **rejection-sampled** to avoid modulo bias. The resulting index is drawn without replacement from the remaining tickets.
7. Insert `draw_winners(draw_id, position, ticket_id, user_id|entrant_email, masked_name)`. **`UNIQUE(draw_id, position)`** and `UNIQUE(draw_id, ticket_id)` enforce the invariants.
8. Insert `draw_settlements(draw_id UNIQUE, seed, algorithm_version, eligible_count, eligible_set_hash, settled_by = 'system'|user, settled_at)`.
9. Update the draw to `settled`, write the audit record, write outbox messages (winner emails and fulfilment creation), then commit.

**Concurrency.** A second concurrent call blocks on the row lock, then sees `settled` and returns the same result. The UNIQUE constraints are the backstop.

**Reproducibility.** The algorithm is a pure function in `packages/domain`. Given the seed and the eligible set, a verification command re-derives the winners and checks the stored hash.

**Performance.** The selection is one indexed scan of about 50k rows plus in-memory hashing, far below the 5 s target. A test (REQ SPEC §9) verifies it.

**Edge cases.** Zero eligible tickets, and fewer eligible tickets than winner positions, are OPEN O6. Proposal: fill positions up to the eligible count, mark the rest unawarded, and flag the draw for admin attention.

## B15. Admin operations and reports

- **REQ SPEC §6** scope and **APPROVED D9/D10/D15.**

**PROPOSED:**

- **Audit in the same transaction.** Every admin mutation is a service method that writes `audit_log(actor_id, action, entity_type, entity_id, market_id, reason, before, after, ip, request_id)` in the same transaction as the change. The audit log is append-only (trigger plus REVOKE).
- **Ticket operations** are transitions (void, re-issue) and never deletes. **Wallet operations** are ledger entries only.
- **Reports** (D15) are parameterised SQL queries or views in a `reports` module. All take a market and a date range. Amounts are grouped **per currency**, never summed across GBP and EUR. CSV export is **streamed**, requires `reports.export`, and each export is audit-logged because it may contain PII.

| Report | Primary source |
|---|---|
| Sales by draw / market / date | `order_items` ⋈ `orders` (paid) |
| Orders, tickets | `orders`, `tickets` |
| Wallet liability | `wallet_balances` by currency, reconciled against ledger sums |
| Wallet credits/debits | `wallet_entries` by type |
| Refunds | `refunds` |
| Instant-win awards | `instant_win_awards` |
| Main-draw winners | `draw_winners` ⋈ `draw_settlements` |
| Fulfilment | `fulfilments` |
| Reconciliation | `reconciliation_runs`, `reconciliation_findings` |
| Compliance/audit activity | `audit_log`, consent and self-exclusion changes, market gate changes |

## B16. Referrals and Vault Meter (configurable infrastructure)

- **APPROVED D17.** No hard-coded amounts or rules. **REQ.** `UNIQUE(user_id, milestone_id)`.
- **PROPOSED data-driven design:**
  - **Referral codes:** `referral_codes(user_id UNIQUE, code UNIQUE)`.
  - **Referrals:** `referrals(referred_user_id UNIQUE, referrer_user_id, programme_id, status, qualified_at, qualifying_ref)`. A user can be referred only once, and self-referral is blocked by CHECK.
  - **Programmes:** `referral_programmes(market_id, qualifying_action, parameters jsonb, referrer_reward_minor, referee_reward_minor, currency, active_from/to)`. The admin enters all values.
  - **Rewards:** `referral_rewards(referral_id, recipient_role, …)` with `UNIQUE(referral_id, recipient_role)`, credited with ledger key `referral_reward:{id}`.
  - **Vault Meter:**
    - `vault_meter_events(user_id, metric, amount, source_type, source_id)` with `UNIQUE(metric, source_type, source_id)`, so progress cannot double-count a source.
    - `milestone_progress(user_id, metric, scope, value)` is a cache.
    - `milestones(id, metric, scope, threshold, reward_type, reward_minor, currency, active)`.
    - `milestone_awards` with **`UNIQUE(user_id, milestone_id)`**, credited with key `milestone_award:{id}` in the same transaction.
  - **Qualifying actions and metrics** are small code-implemented strategies selected by configuration. **Which strategies exist is OPEN O11.** None is implemented until defined.
  - Guests are excluded (D8).

## B17. Redis / BullMQ usage

| Queue | Jobs | Safety |
|---|---|---|
| `system` | Heartbeat (Day 1 proof) | n/a |
| `outbox` | Relay committed outbox rows to target queues | Row status + `FOR UPDATE SKIP LOCKED` |
| `draw-lifecycle` | Open/close at scheduled times; sweeper every minute | Conditional state updates |
| `settlement` | Settle at `closes_at + grace`; sweeper | Draw row lock + settled check |
| `reservations` | Expiry every 30 s | Conditional updates + provider status check |
| `payments` | Stuck-payment status poll; webhook event retry | `payment_events` unique; idempotent confirm |
| `notifications` | Transactional email per market/locale | Outbox id as job id |
| `rewards` | Referral qualification, milestone evaluation | Unique constraints + ledger keys |
| `reconciliation` | Nightly checks | Read-mostly; writes run record |

Rate limiting and availability caching also use Redis. BullMQ job IDs are derived from business IDs where possible, so duplicate enqueues collapse.

## B18. Migration architecture (D18)

- **Flow (APPROVED):** inventory → mapping → test import → reconciliation → rehearsal → final delta → cutover → rollback window.
- **PROPOSED:**
  - **Tooling.** `tools/migration` contains read-only extractors that take a WordPress MySQL dump or export and load it into a PostgreSQL `legacy` schema. Transformers then write into the application schema.
  - **Determinism.**
    - Target IDs are **UUIDv5** derived from `(source_system, source_table, legacy_id)`.
    - `legacy_id_map(source_system, source_table, legacy_id, target_table, target_id)` has a UNIQUE constraint.
    - Every run records its input checksum in `migration_runs`.
    - The same dump always produces the same result, and re-running is idempotent.
  - **Rule (D18).** Corrections are code or mapping changes and are never hand edits to data.
  - **Legacy wallet balances** import as an opening `migration_opening_balance` ledger entry per wallet (key `migration:{legacy_wallet_id}`), backed by the legacy transaction history held in `legacy`. How much history is imported as individual entries is decided after the inventory.
  - **Open draws** get their pool generated, then legacy sold numbers are marked sold. Collisions or out-of-range numbers fail the import loudly.
  - **Reconciliation** compares counts and sums per entity, per market and per currency between legacy and target. Discrepancy thresholds are zero for money and tickets.
  - **Discovery now.** `docs/migration/INVENTORY.md` is started in Phase 1. It depends on **you** providing the plugin list and a sanitized database export (OPEN O17).

## B19. Security

- **REQ/PLAN.** Secure auth, RBAC, no secrets in the repo, no destructive production changes without confirmation.
- **PROPOSED:**
  - **Secrets.** Only in environment or a secret manager. `.env.example` holds placeholders and local-only development values. A gitleaks check runs in CI.
  - **Database roles.**
    - `hv_owner` runs migrations.
    - `hv_app` has DML only, with `UPDATE/DELETE` revoked on `wallet_entries`, `audit_log`, `payment_events` and `consents`.
    - The ledger and audit triggers are a second layer.
  - **Input validation.** Zod on every input. Parameterised SQL only.
  - **Rate limits.** On authentication, checkout, guest code sending and webhooks.
  - **Webhooks.** Signatures are verified against the raw body.
  - **HTTP.** CSRF protection (origin check + SameSite), CSP and security headers, and a strict CORS allow-list.
  - **Card data.** Never touches our servers: provider-hosted fields or a redirect, so the PCI scope is SAQ-A.
  - **PII.** Reading full PII requires permission and is logged. Exports are audited.
  - **Dependencies.** Dependency audit in CI. An OWASP ASVS-based review runs in Phase 13.

## B20. Compliance (D16)

| Area | Mechanism (PROPOSED) | Rule values |
|---|---|---|
| Skill question | Per-draw question; answer validated server-side **before** order creation; answer stored on `order_items` | Wrong-answer behaviour, retries: **OPEN O12** |
| Free postal entry | B13 | Per market, **OPEN O10** |
| DOB/age | DOB on account, and on guest checkout (PROPOSED); checked against `market_settings.min_age` | Min age per market **OPEN O12** |
| Self-exclusion | `self_exclusions(user_id, market_id nullable, starts_at, ends_at)`; checkout rejects | Required markets and scope **OPEN O12** |
| Marketing consent | Append-only `consents` per user/email **per market** and channel, with wording version; send-time suppression check | Channels/wording **OPEN O12** |
| Deletion/anonymisation | PII nulled or hashed; orders, ledger and winners kept with pseudonymous reference; audit entry | Retention period **OPEN O12** |
| Masked winner identity | Precomputed `masked_name` stored at settlement and award time | Format **OPEN O12** |
| Market terms | `terms_versions` per market; `terms_acceptances` recorded per user **or order** at checkout | Content: legal |
| Germany approval | B8 three-layer gate | Legal approval |

As B8 describes, a market cannot be enabled while required compliance values are unset.

## B21. Testing strategy

- **REQ SPEC §12, PLAN §6–7. APPROVED D1: no mocked databases for concurrency.**

| Layer | Tool | Database |
|---|---|---|
| Unit | Vitest | none (pure `packages/domain`) |
| Integration | Vitest | **Real PostgreSQL**: one database per test file, cloned from a migrated template (`CREATE DATABASE … TEMPLATE`) |
| Concurrency | Vitest with N separate pool connections and barrier-synchronised starts | Real PostgreSQL |
| API | Supertest on the NestJS app | Real PostgreSQL + Redis |
| e2e | Playwright + fake provider | Full local stack |
| Load | k6 | Staging-like local stack |

**Critical gates** (PLAN §7). Each is an automated test that must pass for its phase to be done:

1. 200 buyers race for 100 tickets → exactly 100 sold, and every number is unique.
2. 20 concurrent requests from one entrant with cap 5 → at most 5 tickets, for both the user key and the email key.
3. Balance 10, with 10 concurrent debits of 5 → exactly 2 succeed, the balance is 0, and the ledger sum equals the cache.
4. The same webhook ×10 in parallel, plus out-of-order delivery → one payment transition, one ticket sale and one credit.
5. 10 concurrent settlements → one settlement row, winners inserted once, and every caller gets the same result.
6. Concurrent confirmation of an order holding an instant-win number → one award and one credit.
7. Concurrent milestone events → one award.
8. Market isolation: a UK context cannot read or mutate IE or DE data. With DE gated, the API refuses DE even if the UI is bypassed.

Additional tests:

- reservation expiry racing a late webhook;
- a part-payment failure releasing wallet funds exactly once;
- refunds;
- settlement determinism (the same seed and set give the same winners);
- the 50k-ticket settlement staying under 5 s;
- migration re-run idempotency.

---

# Part C — Revised Repository Structure

```
highland-vault/
├─ apps/
│  ├─ web/                    Next.js: /[market]/… customer, /admin route group
│  ├─ api/                    NestJS HTTP API + /webhooks/{provider}
│  └─ worker/                 NestJS standalone: BullMQ processors, schedulers, outbox relay
├─ packages/
│  ├─ db/                     Kysely client, int8 parsing, migrate runner, migrations/*.sql, generated types, test-db harness
│  ├─ domain/                 Pure logic: Money, state machines, settlement algorithm, cap rules, email normalization
│  ├─ contracts/              Zod schemas + DTO types shared by api/web
│  ├─ payments/               PaymentProvider interface, fake provider (real adapters added later)
│  └─ config/                 tsconfig base, ESLint flat config, Prettier config
├─ tools/
│  └─ migration/              WordPress extract/transform/reconcile (Phase 13, discovery from Phase 1)
├─ infra/
│  └─ docker/
│     └─ postgres/init/       Local-only role/database bootstrap SQL
├─ docs/
│  ├─ PROJECT_STATUS.md
│  ├─ PROJECT_INITIALIZATION_REPORT.md
│  ├─ adr/                    0001-… one file per decision D1–D19 (+ later)
│  └─ migration/INVENTORY.md
├─ .github/workflows/ci.yml
├─ docker-compose.yml
├─ .env.example               placeholders / local-only dev values
├─ .gitattributes .gitignore .editorconfig .nvmrc
├─ package.json               packageManager pinned; root scripts
├─ pnpm-workspace.yaml
└─ vitest.workspace.ts
```

**Changes since Revision 1:**

- `packages/payments` is added, so the D6 abstraction is isolated and commerce code depends only on the interface.
- `infra/docker` and `docs/migration` are added.
- There is no separate admin app (D9).

---

# Part D — Revised Database / Domain Model

## D-1. Tables by area (PROPOSED; ★ = REQ constraint)

| Area | Table | Key columns and constraints |
|---|---|---|
| **Platform** | `schema_migrations` | Filename, checksum, applied_at (runner-owned) |
| | `outbox_messages` | Topic, payload, status, attempts, `available_at` |
| **Markets** | `markets` | `code UNIQUE` (uk/ie/de), `currency`, `locale`, `is_enabled`, `requires_legal_approval`, `legal_approved_at/by/ref`; `UNIQUE(id, currency)`; gate CHECK (B8) |
| | `market_settings` | `market_id PK`; typed nullable compliance values (min_age, self_exclusion_required, …) |
| | `market_payment_configs` | `market_id`, `provider_code`, `config_ref` (no secrets) |
| | `terms_versions` | `market_id`, `version`, `published_at`; `UNIQUE(market_id, version)` |
| **Identity** | `users` | `email citext UNIQUE` (D3), `email_verified_at`, `password_hash`, `dob`, `status`, `anonymised_at`. **No market_id** (D3) |
| | `sessions` | `token_hash UNIQUE`, `user_id` nullable (guest), `verified_guest_email`, `mfa_at`, `expires_at` |
| | `guest_email_verifications` | Email, code_hash, attempts, expires_at |
| | `user_mfa` | `user_id PK`, encrypted TOTP secret, recovery code hashes |
| | `roles`, `permissions`, `role_permissions`, `user_roles` | `user_roles(user_id, role_id, market_id NULL)` unique |
| | `consents` | user_id / email, `market_id`, channel, granted, wording_version, source, at (append-only) |
| | `terms_acceptances` | `terms_version_id`, `user_id` or `order_id`, at |
| | `self_exclusions` | `user_id`, `market_id` NULL, starts_at, ends_at |
| **Draws** | `draws` | `market_id`, `currency` → FK `markets(id, currency)`; `slug` unique per market; `status`; `ticket_price_minor > 0`; `total_tickets > 0`; `max_per_person > 0`; `opens_at < closes_at`; `winner_positions > 0`; `skill_question_id`; `UNIQUE(id, market_id)` |
| | `draw_prizes` | `draw_id`, `position`, description; `UNIQUE(draw_id, position)`; `position ≤ winner_positions` enforced at publish |
| | `skill_questions`, `skill_question_options` | Exactly one correct option (partial unique index) |
| **Tickets** | `tickets` | ★`UNIQUE(draw_id, ticket_number)`; `status`, `shuffle_key`, `order_item_id`, `postal_entry_id`, `reserved_until`, `entrant_type/ref`; CHECK on state/column consistency; index `(draw_id, status, shuffle_key)` |
| | `draw_entrant_counts` | PK `(draw_id, entrant_type, entrant_ref)`, `count ≥ 0` |
| **Commerce** | `carts`, `cart_items` | Cart per (session, market); `UNIQUE(cart_id, draw_id)` |
| | `orders` | ★`idempotency_key UNIQUE`; `market_id, currency` FK; `user_id` or `guest_email` (CHECK exactly one); `status`; `total_minor = wallet_applied_minor + external_due_minor` (CHECK); `terms_version_id`; `order_number UNIQUE` |
| | `order_items` | `(draw_id, market_id)` FK → `draws(id, market_id)`; `quantity > 0`; `unit_price_minor`; `skill_answer_option_id` |
| **Payments** | `payments` | `order_id`, `provider`, ★`UNIQUE(provider, provider_reference)`; `amount_minor`, `currency`, `status` |
| | `payment_events` | `UNIQUE(provider, provider_event_id)`; raw payload; `processed_at`; append-only |
| | `refunds` | `order_id`, `payment_id` NULL, `amount_minor`, `destination` (provider/wallet), `idempotency_key UNIQUE`, `UNIQUE(provider, provider_refund_reference)`, `status`, `reason`, `actor_id` |
| **Wallet** | `wallets` | `UNIQUE(user_id, currency)`; `UNIQUE(id, currency)`; currency ∈ {GBP, EUR} |
| | ★`wallet_entries` | Append-only; signed amount with CHECK per type; `idempotency_key UNIQUE`; `reverses_entry_id UNIQUE`; `(wallet_id, currency)` FK; `source_type/id`; `market_id` NULL; `actor_id/reason` required for admin types |
| | ★`wallet_balances` | `wallet_id PK`, `balance_minor ≥ 0` (cache) |
| **Instant wins** | `instant_win_prizes` | `UNIQUE(draw_id, ticket_number)`; `prize_type ∈ {wallet_credit, physical}` (D12); value/currency or description |
| | `instant_win_awards` | `instant_win_prize_id UNIQUE`; `ticket_id UNIQUE`; recipient user or email; `status` (awarded / pending_claim / credited) |
| **Settlement** | `draw_settlements` | `draw_id UNIQUE`; `seed bytea`; `algorithm_version`; `eligible_count`; `eligible_set_hash`; `settled_by`; `settled_at` |
| | `draw_winners` | ★`UNIQUE(draw_id, position)`; `UNIQUE(draw_id, ticket_id)`; recipient; `masked_name` |
| **Operations** | `fulfilments` | Exactly one of `draw_winner_id` / `instant_win_award_id` (CHECK); `status`; tracking |
| | `postal_entries` | `draw_id`, entrant fields, `received_at`, `status`, `ticket_id UNIQUE NULL` |
| | `postal_entry_rules` | Per market or draw; nullable values = OPEN |
| | `audit_log` | Append-only (B15) |
| | `reconciliation_runs`, `reconciliation_findings` | |
| **Growth** | `referral_codes`, `referral_programmes`, `referrals`, `referral_rewards` | B16 |
| | `milestones`, `vault_meter_events`, `milestone_progress`, ★`milestone_awards UNIQUE(user_id, milestone_id)` | B16 |
| **Migration** | `legacy.*`, `legacy_id_map`, `migration_runs` | B18 |

## D-2. Relationships

```
markets 1─* draws 1─* tickets *─0..1 order_items *─1 orders 1─* payments 1─* refunds
markets 1─1 market_settings        markets 1─* terms_versions 1─* terms_acceptances
markets 1─* consents *─0..1 users  (consent is per market; user is NOT tied to a market)
users 1─* orders (nullable: guest orders carry guest_email)
users 1─* wallets(≤1 per currency) 1─* wallet_entries ; wallets 1─1 wallet_balances
draws 1─* draw_prizes ; draws 1─* instant_win_prizes 1─0..1 instant_win_awards 1─1 tickets
draws 1─0..1 draw_settlements ; draws 1─* draw_winners 1─1 tickets
draw_winners | instant_win_awards 1─0..1 fulfilments
draws 1─* postal_entries 1─0..1 tickets
draws 1─* draw_entrant_counts  (entrant = user | verified email)
users 1─0..1 referral_codes ; users 1─* referrals(as referrer) ; users 1─0..1 referrals(as referred)
users 1─* milestone_awards *─1 milestones ; users 1─* vault_meter_events
users *─* roles *─* permissions   (user_roles optionally market-scoped)
wallet_entries.source_(type,id) → order | refund | instant_win_award | referral_reward | milestone_award | admin action
```

## D-3. Domain state machines (summary)

| Entity | States |
|---|---|
| Draw | draft → scheduled → live → closed → settled → completed; draft/scheduled → cancelled |
| Ticket | available → reserved → sold → void; reserved → available |
| Order | created → awaiting_payment → paid → partially_refunded/refunded; created/awaiting_payment → cancelled/failed/expired; paid_unfulfillable → refunded |
| Payment | pending → succeeded / failed / cancelled; succeeded → partially_refunded/refunded |
| Postal entry | received → validated → allocated; received/validated → rejected |
| Instant-win award | awarded → credited / fulfilment_pending; pending_claim → credited (O3) |
| Fulfilment | pending → contacted → dispatched/paid → complete |

---

# Part E — Revised Dependency Map

```
P1 Foundation ─────────────────────────────────────────────────────────────┐
 │                                                                         │ (parallel) Migration discovery:
P2 Users · Markets · RBAC · MFA · Audit                                    │  inventory + mapping  ── needs O17 from you
 │                                                                         │
P3 Draws (market-scoped, prizes, positions, skill question)                │
 │                                                                         │
P4 Ticket engine (pool, SKIP LOCKED, caps, reservations+expiry) ◄─ reused by P10 postal entries
 │
P5 Cart + Checkout (market basket, guest verification, order idempotency, outbox)
 │     └─ wallet seam defined here; wallet plugged in at P7
P6 Payments (interface, fake provider, webhooks, status checks, refunds skeleton)
 │
 ├──► P7 Wallet (ledger, part-payment, release, reconciliation) ──┬─► P8 Instant wins (wallet-credit prizes)
 │                                                               ├─► P11 Referrals + Vault Meter (rewards)
 │                                                               └─► refunds-to-wallet (P6 skeleton completed)
 └──► P9 Settlement (needs P4 sold tickets + P6 confirmation + grace-period rule O5)
P10 Admin ops · postal · fulfilment · reports   (needs P3–P9 data to operate on)
P12 Market compliance · emails · DE gate hardening (touches P2, P3, P5)
P13 Migration test import + rehearsal + QA/security/load   (needs final schema of P2–P11)
P14 UAT + RC  ─►  P15 Cutover (+ rollback window)
```

**Hard blockers from OPEN items:**

| Phase | Blocked by |
|---|---|
| P5 | O1 (guest verification timing) |
| P6 production readiness | O13 (provider). Development proceeds on the fake provider. |
| P9 | O5 (grace), O6 (zero/short eligible) |
| P11 | O11 |
| P12 market enablement | O12 values |
| P13 | O17 (legacy data access) |

---

# Part F — Revised Development Sequence

Each phase ends only when the Definition of Done (PLAN §6) is met (D19). Critical gates are shown in **bold**.

| Phase | Scope | Exit criteria (in addition to DoD) |
|---|---|---|
| **P1** Foundation | Monorepo, Docker stack, migration runner, Kysely, api/worker/web skeletons, health, CI, test-DB harness, ADRs, status file | See Part H |
| **P2** Users/Markets/Admin shell | Markets seeded (DE disabled, legal-approval CHECK), market settings, auth + sessions, global email, RBAC roles/permissions, TOTP MFA + step-up, audit log, `/admin` shell, `/[market]` routing + API guard | DE refused by API with the UI bypassed; RBAC deny-by-default tests |
| **P3** Draws | Draw CRUD + lifecycle, prizes/positions, skill question, publish, public list/detail (functional, cached) | Market-scoped queries tested; composite FKs in place |
| **P4** Ticket engine | Pool generation, allocation function, caps (user/email keys), reservations 10 min, expiry job, availability cache | **Gates 1, 2**; expiry race tests |
| **P5** Cart + Checkout | Per-market basket, guest email verification, skill answer validation, terms acceptance, idempotent order creation, outbox | Idempotency-key replay test; cross-market basket rejected |
| **P6** Payments | `packages/payments`, fake provider, payment records, webhook ingestion, confirm, status poller, late-payment path, refund skeleton | **Gate 4**; the redirect cannot mark paid (test) |
| **P7** Wallet | Ledger, balances, debit/credit/reversal, part payment + release, admin credit (sensitive operation), nightly reconciliation | **Gate 3**; part-payment failure releases once |
| **P8** Instant wins | Prize definitions, award on sale, wallet credit / fulfilment row, customer display | **Gate 6** |
| **P9** Settlement | Close job, grace, sweeper, `hv-settle-v1`, settlement records, winners, verification command | **Gate 5**; determinism; 50k under 5 s |
| **P10** Admin ops | Orders, tickets, customers, wallet ops, refunds UI, fulfilment, postal entries, reports + CSV, audit views | Postal allocation reuses the P4 function; exports audited |
| **P11** Referrals + Vault Meter | Configurable programmes, attribution, events, progress, awards | **Gate 7** |
| **P12** Markets/Emails/Compliance | Per-market templates/terms, consent, DOB/age, self-exclusion, anonymisation, masked names, enablement gate | **Gate 8**; market cannot enable with NULL compliance values |
| **P13** Migration + QA | Test import → reconciliation → rehearsal; security review; k6 500+ buyers | Reconciliation zero-diff on money and tickets |
| **P14** UAT + RC | e2e UAT, fixes, prod configuration review, backup/restore + rollback rehearsal | Signed-off release candidate |
| **P15** Cutover | Final delta, deploy, smoke, monitoring, reconciliation, controlled launch, rollback window | Post-cutover reconciliation clean |

**Continuous from P1:** migration discovery (O17), and the ADR and `PROJECT_STATUS.md` updates.

## F-1. Updated risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Docker Desktop not yet installed (Windows needs WSL2 and virtualization enabled) | Part H prerequisite step 0 |
| R2 | Payment provider undecided or restricted for prize competitions | Fake provider now; the interface keeps commerce provider-neutral (D6) |
| R3 | Undefined rules (Part G) | Configuration-driven design; NULL config blocks market enablement; nothing invented |
| R4 | Legacy data unknown | Discovery from P1; deterministic tooling |
| R5 | Concurrency bugs | DB constraints + real-DB race tests (D1) |
| R6 | Reservation/payment timing at close | Grace period (O5), provider status check before release, late-payment path |
| R7 | Hot-draw contention | Per-entrant locks, SKIP LOCKED, short transactions, k6 |
| R8 | Shared EUR wallet across IE/DE (O4) | Decision needed before DE is enabled |
| R9 | Guest identity bridging (O2) | Proposed merge-on-registration; tests in P4/P5 |
| R10 | Hosting doesn't offer PostgreSQL 18 | Fallback: 17 + app-generated UUIDv7 (small change, decided before P2 schema grows) |
| R11 | Cutover drift | Delta migration, reconciliation, rollback window (D18) |

---

# Part G — Remaining OPEN Decisions

Items marked ★ are **new**, raised by the approved decisions. None blocks Day 1.

| ID | Question | My proposal (not implemented until you confirm) | Needed by |
|---|---|---|---|
| O1 ★ | How and when is a guest email **verified** (D8 requires "verified email")? | 6-digit code emailed during checkout, before order creation | P5 |
| O2 ★ | Guest → account cap bridging | If an account exists for the email, use its user ID; on registration, merge email counters into the user key | P4/P5 |
| O3 ★ | Guest or postal entrant (no account) wins a **wallet-credit** instant win | Record `pending_claim` against the verified email; credit on account claim | P8 |
| O4 ★ | One EUR wallet shared by IE and DE: can credit earned in IE be spent on DE draws (once DE is enabled)? | Allowed technically; decide before DE enablement | P12 |
| O5 ★ | Settlement grace period after close for in-flight checkouts | Grace = reservation TTL (10 min) + 2 min | P9 |
| O6 ★ | Zero eligible tickets, fewer tickets than winner positions, cancelling a live draw | Fill available positions, flag the rest; cancellation policy needs your rule | P9 |
| O7 | Refund policy: destination (card vs wallet), refunds after close/settlement, fate of tickets/instant wins on refunded orders | Refund to original method; void tickets and decrement caps if before close; none after settlement | P6/P10 |
| O8 | Which roles are "privileged" for mandatory MFA | All staff roles (support → super_admin) | P2 |
| O9 | Exact list of "major configuration changes" (sensitive operations) | Markets/settings, payment configs, roles/permissions, draw price/capacity after publish, instant-win definitions | P2/P10 |
| O10 | Postal rules: required fields (is email mandatory?), cutoff, per-envelope limit; maker-checker threshold for admin wallet credits | Configurable; values from you or legal | P10/P7 |
| O11 | Referral qualifying actions and rewards; Vault Meter metric, scope (per market, per currency or global), thresholds and rewards | Infrastructure only until defined | P11 |
| O12 | Compliance values: min age per market, wrong skill answer behaviour and retries, self-exclusion markets and scope, consent channels/wording, retention period, masked name format | Configurable; blocks market enablement until set | P12 (P5 for skill answer) |
| O13 | Production payment provider(s) per market | Fake provider until merchant approval | Before P14 |
| O14 | Hosting target (and PostgreSQL 18 support), email provider, object storage/CDN, monitoring, analytics | — | Before P13 |
| O15 | Ticket numbers shown to customers: random from pool or sequential | Random via `shuffle_key` | P4 |
| O16 | Cash alternative for physical prizes (main draw or instant win) | Not built unless required | P8/P9 |
| O17 | Legacy access: plugin list and a sanitized WordPress DB export | Start now | P1 onward |
| O18 ★ | Can one basket mix UK and IE draws? (D4 makes orders single-currency) | No: one basket and order per market | P5 |

---

# Part H — Day 1 (Phase 1) Implementation Plan: Foundation

**Goal (REQ PLAN Day 1).** Repository, monorepo structure, Next.js, NestJS, PostgreSQL, Redis, configuration, migrations, linting, formatting, typecheck, tests and Docker/local development. There is **no business functionality** in this phase.

## H0. Prerequisites (you, before implementation starts)

1. Install **Docker Desktop** for Windows with the WSL2 backend, then confirm that `docker compose version` works.
2. Run `corepack enable` so the pnpm version pinned in `package.json` is used automatically.
3. Confirm that local ports **5432, 6379, 1025 and 8025** are free, or tell me which to change. All of them are configurable via `.env`.

I will not install anything. Your approval of this plan authorises me to run `pnpm install` and `docker compose up` in the implementation step.

## H1. Work items

| # | Item | Details |
|---|---|---|
| 1 | Root workspace | `package.json` (`packageManager: pnpm@<current stable>`, `engines.node >=24`), `pnpm-workspace.yaml`, `.nvmrc` (24), `.gitignore`, `.gitattributes` (`* text=auto eol=lf`, to avoid Windows CRLF churn), `.editorconfig`, `README.md` (setup) |
| 2 | `packages/config` | `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint flat config (typescript-eslint, import ordering, no floating promises), Prettier |
| 3 | Docker stack | `docker-compose.yml` with the four services below. Named volumes; ports bound to `127.0.0.1` only. |
| 4 | Environment | `.env.example` with local-only values; `.env` git-ignored; Zod env schema shared by api/worker (fails fast on missing values) |
| 5 | `packages/db` | See below |
| 6 | Migration `0001_foundation.sql` | See below |
| 7 | `packages/domain` | `Money` type (integer minor units + `Currency = 'GBP' \| 'EUR'`), add/subtract with same-currency guard, no floats, `formatMoney(locale)` via `Intl`. It is small but real, and every later phase depends on it. |
| 8 | `packages/contracts` | Zod `HealthResponse` schema (proves web ↔ api contract sharing) |
| 9 | `apps/api` | NestJS + Fastify; `ConfigModule` (Zod), pino logging with request IDs, `DatabaseModule` (Kysely provider, pool shutdown hook), `RedisModule`, `GET /health/live`, `GET /health/ready` (checks PostgreSQL `SELECT 1` and Redis `PING`; 503 on failure), graceful shutdown |
| 10 | `apps/worker` | NestJS standalone context; BullMQ connection; `system` queue with a `heartbeat` processor. Proves the pipeline; no business jobs. |
| 11 | `apps/web` | Next.js App Router minimal: `/` and `/[market]` with a **static** allow-list (uk, ie, de). Real market resolution and the DE gate are P2 (API-enforced). A server component calls `/health/ready` and shows the status. No styling work. |
| 12 | Test harness | See below |
| 13 | Root scripts | See below |
| 14 | CI | `.github/workflows/ci.yml`: Node 24 + Corepack, `pnpm install --frozen-lockfile`, PostgreSQL 18 + Redis service containers, lint → typecheck → unit → migrate → integration → build. The file is added; **pushing is your call**. |
| 15 | Docs | `docs/PROJECT_STATUS.md` (PLAN §10), `docs/adr/0001…` for D1–D19 (short), `docs/migration/INVENTORY.md` skeleton (what I need from you: O17) |

**Item 3: `docker-compose.yml` services.**

- `postgres:18` with a healthcheck, running `infra/docker/postgres/init/*.sql`, which creates:
  - roles `hv_owner` (migrations, CREATEDB for tests) and `hv_app` (DML only, via default privileges);
  - databases `highland_vault` and `highland_vault_test_template`.
- `redis:7.4` with `--maxmemory-policy noeviction --appendonly yes` and a healthcheck.
- `axllent/mailpit` (SMTP 1025, UI 8025).

**Item 5: `packages/db`.**

- Kysely + `pg` pool factory. **int8 parsing**: `bigint` columns are parsed to JS `number` with a `Number.isSafeInteger` guard that throws if exceeded.
- `withTransaction(db, fn, { isolation, retries })`, which retries only on `40001`/`40P01`.
- **Custom plain-SQL migration runner (PROPOSED, about 150 lines):**
  - reads `migrations/NNNN_name.sql` in order;
  - runs each file in its own transaction;
  - records SHA-256 checksums in `schema_migrations` and **fails if an applied file changed**;
  - takes `pg_advisory_lock` so concurrent runners serialise;
  - is forward-only.
- `kysely-codegen` generates `src/generated/db.ts` from the migrated database, and the output is committed.
- Why a custom runner: existing tools either want JS/TS migrations or add a non-Node binary. The runner is small, fully tested and does exactly what D2 asks.

**Item 6: migration `0001_foundation.sql`.** It contains no business tables. Business tables start in P2.

- `citext` extension.
- Reusable trigger functions: `hv_forbid_update_delete()` (for the ledger, audit and events later) and `hv_set_updated_at()`.
- Grants baseline for `hv_app`.
- `outbox_messages` is **not** created yet (P5).

**Item 12: test harness.**

- Vitest workspace: `unit` project (no DB) and `integration` project.
- Global setup migrates the template database. Each test file gets `CREATE DATABASE hv_test_<id> TEMPLATE highland_vault_test_template` and drops it afterwards.
- `concurrency` helper: N dedicated connections plus a barrier so statements start simultaneously.

**Item 13: root scripts.**

- `infra:up` / `infra:down` / `infra:reset`
- `dev` (api + worker + web in parallel)
- `db:migrate`, `db:codegen`
- `lint`, `format`, `format:check`, `typecheck`
- `test` (unit), `test:integration`
- `build`
- `verify` (all checks in order)

## H2. Day 1 tests

| Test | Type | Proves |
|---|---|---|
| Money arithmetic, currency mismatch throws, no float input, formatting per en-GB / en-IE / de-DE | unit | Integer minor units (SPEC §13) |
| Migration runner: applies in order; re-run is a no-op; modified applied file → fails; two concurrent runners → applied once | integration (real PG) | Deterministic, safe migrations |
| `hv_forbid_update_delete` on a scratch table rejects UPDATE and DELETE | integration | Append-only mechanism ready for ledger and audit |
| **Concurrency harness smoke:** 10 connections run `SELECT … FOR UPDATE SKIP LOCKED LIMIT 10` over 100 rows simultaneously → disjoint sets, 100 rows total, no duplicates | integration (real PG) | The harness genuinely exercises PostgreSQL locking (D1). This is the template for gates 1–8. |
| `withTransaction` retries a forced serialization failure and gives up after N | integration | Retry policy |
| int8 parsing: safe values parse; an unsafe value throws | integration | No silent money precision loss |
| `/health/live` 200; `/health/ready` 200 with PG + Redis up and 503 with a bad Redis URL | API (Supertest) | Wiring and readiness |
| Worker: enqueue `heartbeat` with a fixed job ID twice → processed once | integration (real Redis) | BullMQ wiring and job-ID idempotency pattern |
| `apps/web` builds; `/uk` renders; `/xx` → 404 | build + smoke | Frontend skeleton and route allow-list |

## H3. Verification commands (run and reported at the end of Day 1)

```
docker compose up -d && docker compose ps          # all healthy
pnpm install --frozen-lockfile
pnpm db:migrate && pnpm db:codegen                 # no diff after codegen
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test && pnpm test:integration
pnpm build
pnpm dev   → GET http://localhost:<api>/health/ready = 200; http://localhost:<web>/uk renders; Mailpit UI reachable
```

## H4. Day 1 Definition of Done

- [ ] `docker compose up` gives healthy PostgreSQL 18, Redis and Mailpit.
- [ ] A fresh clone with `pnpm install` and `pnpm verify` passes: lint, format, typecheck, unit, integration and build.
- [ ] Migration runner tests pass against real PostgreSQL, and the concurrency smoke test passes.
- [ ] API health endpoints and the worker heartbeat work locally.
- [ ] No secrets in the repo. `.env.example` holds only local placeholders, and a gitleaks-style check is clean.
- [ ] `PROJECT_STATUS.md`, ADRs D1–D19 and the migration inventory skeleton are written.
- [ ] I have reviewed the diff and reported files, migrations, APIs, tests, commands and results, risks and the next task (PLAN §4).
- [ ] **Commit:** I will propose a commit message and ask before committing. Pushing to `origin` is only done on your instruction.

## H5. Explicitly out of scope for Day 1

Markets, users, auth, RBAC, draws, tickets, payments and wallet tables and logic, the outbox, UI styling, deployment, and production configuration.

## H6. Day 1 risks

| Risk | Mitigation |
|---|---|
| Docker Desktop / WSL2 setup issues on Windows | Prerequisite H0; Day 1 starts only once `docker compose version` works |
| Port conflicts | All ports come from `.env` |
| CRLF line endings breaking lint/format or SQL checksums | `.gitattributes eol=lf`; the runner normalises line endings before checksumming |
| Tool major-version churn (Next.js, NestJS, ESLint) | Pin exact versions in the lockfile; record the versions chosen in `PROJECT_STATUS.md` |

---

## Next Step

**STOPPED for review.** Nothing has been built or installed, and no database has been created. The only file changed is this report.

When you approve:

- confirm or adjust the **proposals in Part G** (none blocks Day 1);
- confirm the Day 1 choices of **PostgreSQL 18** and a **custom plain-SQL migration runner**;
- complete the **H0 prerequisites**.

I will then begin Phase 1 exactly as laid out in Part H.

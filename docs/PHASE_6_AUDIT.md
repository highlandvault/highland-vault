# Phase 6 audit — payments and order settlement

_Audited: 2026-09-25 · `develop` at `723c7ae` (PR #26, Phase 5 complete) · audit only, nothing implemented._

Every claim below was checked against the repository at that commit. Where something could not be established from the code, it says **NOT DETERMINED FROM CURRENT REPOSITORY** rather than guessing. Labels used throughout:

| Label             | Meaning                                         |
| ----------------- | ----------------------------------------------- |
| **CURRENT**       | Verified in the repository at `723c7ae`         |
| **PROPOSED**      | A Phase 6 design suggestion, not decided        |
| **OPEN DECISION** | Needs the owner; deliberately not answered here |
| **OUT OF SCOPE**  | Explicitly not Phase 6                          |

A note on sources. Much of what follows is **not** invention: Revision 2 **B10** already specifies the provider interface, the order state machine and the confirmation paths, and **B18** already specifies `payments`, `payment_events` and `refunds`. Where the specification decides something, this document cites it rather than proposing an alternative.

---

## 1. CURRENT — the Phase 5 boundary, as built

### Order statuses

`orders.status`, `CHECK orders_status_valid` (migration `0016_orders.sql:95`):

```
'created', 'awaiting_payment', 'paid', 'cancelled', 'failed', 'expired',
'paid_unfulfillable', 'partially_refunded', 'refunded'
```

The CHECK already admits the **full B7 enumeration**. Phase 5 only ever writes `awaiting_payment` (the column default). **Phase 6 adds transitions, not values.**

⚠️ **Terminology discrepancy, resolved in code but still live in prose.** Planning documents describe the boundary as `pending_payment`. That value does not exist anywhere in the schema or the code. B7 names `awaiting_payment` and the implementation uses it. `PROJECT_STATUS.md:408`, `HANDOFFS.md:134`, `CHANGELOG.md:22` and `0016_orders.sql:22` record the reconciliation explicitly; the two names mean the same moment. **Phase 6 must use `awaiting_payment`.**

### What order creation persists

`CheckoutService.createOrder` (`apps/api/src/orders/checkout.service.ts`), one transaction:

- locks the cart's live lines (`cart_items … FOR UPDATE`);
- requires an active terms version the customer has accepted (ADR-0031);
- locks each reservation, confirms its **effective** status is `active`, validates the skill answer (ADR-0030);
- claims the idempotency key by `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`;
- writes `orders` + `order_items`, removes the basket lines, writes an `order.created` audit entry.

### What the order leaves behind

| Thing                 | State after checkout                          | Verified by                                                                                                                                                              |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orders.status`       | `awaiting_payment`                            | `checkout-orders.int.test.ts`, `phase5-journey.int.test.ts`                                                                                                              |
| `reservations.status` | **`active`** — untouched                      | `phase5-journey.int.test.ts` (`assertPhaseBoundary`)                                                                                                                     |
| `tickets.status`      | **`reserved`** — untouched                    | same                                                                                                                                                                     |
| `cart_items`          | `removed_at` set; the order is now the record | same                                                                                                                                                                     |
| Payment of any kind   | **none**                                      | asserted: `count(*) FROM tickets WHERE status='sold'` is 0, and `information_schema` shows **0** of `payments`, `payment_events`, `refunds`, `wallets`, `wallet_entries` |

### What is NOT implemented — verified by search

A repository-wide search for `payment`, `webhook`, `refund`, `merchant`, `settlement`, `payment intent`, `checkout session`, `provider reference` across `apps/**` and `packages/**` returns **exactly two substantive hits**, both of which say the feature is absent:

- `apps/web/src/app/layout.tsx:44` — a site banner: "Tickets can be reserved, but checkout and payment …"
- `packages/contracts/src/orders.ts:68` — "Phase 5 only ever produces `awaiting_payment`; payment is Phase 6."

There is **no** `packages/payments`, no payment module, no provider abstraction, no webhook route, no payment table, no `market_payment_configs`, and no fake provider. Phase 6 starts from zero on payments.

> **Repository note:** the audit brief lists `packages/shared`. There is no such workspace. The packages are `config`, `contracts`, `db`, `domain`.

---

## 2. CURRENT — the payment window does not exist

This is the most consequential finding in the audit.

**There is no order payment window, and no order expiry of any kind.**

- `orders` has **no `expires_at`** column (`grep -c expires_at 0016_orders.sql` → 0).
- The only 600-second value in the system is `RESERVATION_TTL_SECONDS` (`apps/api/src/config/env.ts:75`), which is the **reservation** TTL, pinned to exactly 600 in production by a refinement at `env.ts:105`, per D11.
- Planning prose referred to `ORDER_PAYMENT_WINDOW_SECONDS = 600`. **No such variable exists** in `env.ts` or `.env.example`.

So today the payment window is _de facto_ **whatever is left of the reservation's 10 minutes at the moment the order was created** — not 10 minutes from the order, and not recorded anywhere on the order.

**And the reservation expiry worker is not order-aware.** `apps/worker/src/tickets/reservation-expiry.ts` runs `hv_expire_reservations(NULL, batch)` every 30 s and frees any reservation past `expires_at`. Its own header records the gap:

> "Phase 6 adds the B9 safety rule: a trusted provider status check before expiring a reservation whose order has a pending payment."

That rule is **not implemented**. Today an order in `awaiting_payment` can have its tickets returned to the pool while the customer is on the provider's page.

### Consequences Phase 6 must handle

| Case                            | CURRENT behaviour                                     | Phase 6 must decide                              |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| Payment before expiry           | No payment path exists                                | Normal finalization                              |
| Reservation expires mid-payment | Tickets freed, order left `awaiting_payment` for ever | **OPEN DECISION 3**                              |
| Payment success after expiry    | No path                                               | B10 describes `paid_unfulfillable` + refund (O7) |
| Webhook after order expiry      | No path; orders never reach `expired`                 | **OPEN DECISION 3**                              |

**OPEN DECISION 1 — is the payment window the reservation, or its own clock?** B9's grace rule (O5: reservation TTL + 2 minutes) assumes the reservation is the clock. If so, no new column is needed. If the order gets its own window, `orders` needs `expires_at` and a new migration. The code supports neither today.

---

## 3. CURRENT — where money comes from, and who may touch it

### The authoritative chain

Nothing the client sends contributes to an amount. Verified in `CheckoutService.matchAndPrice`: the request carries `{ slug, quantity, optionId? }` only, and is **matched against** the locked basket; `quantity`, `currency`, `unit_price_minor` and `total_minor` are all read from the **reservation**.

```
markets(id, currency)                ← the market pins its currency
  └── draws(market_id, currency)                    FK (market_id, currency)
        └── reservations(market_id, currency,       FK (market_id, currency)
                         unit_price_minor, total_minor)
              CHECK reservations_total_exact: total = unit_price × quantity
              CHECK reservations_price_snapshot (trigger): price = draw's price
              └── order_items(reservation_id, draw_id, market_id, currency,
                              unit_price_minor, total_minor)
                    FK (reservation_id, draw_id), (draw_id, market_id), (market_id, currency)
                    CHECK order_items_total_exact
                    └── orders(market_id, currency, total_minor,
                               wallet_applied_minor, external_due_minor)
                          FK (market_id, currency)
                          CHECK orders_totals_add_up:
                              total_minor = wallet_applied_minor + external_due_minor
```

**The authoritative payable amount is `orders.external_due_minor`** — today always equal to `total_minor`, since `wallet_applied_minor` is fixed at 0 until Phase 7.

Both are frozen: `hv_orders_guard` (`0016`) makes `market_id`, `currency`, `total_minor`, `external_due_minor`, buyer and terms **immutable**; only `status` and `updated_at` may move. `order_items` is immutable entirely, and `hv_app` has no UPDATE or DELETE on it.

### PROPOSED — the Phase 6 invariants

> **I1.** A payment attempt's amount **must equal `orders.external_due_minor`**, read inside the same transaction that creates the attempt, never from the request.
>
> **I2.** A payment's currency **must equal `orders.currency`**, which the `(market_id, currency)` FK already pins to the market's.
>
> **I3.** A verified provider event must be matched to its order and **re-checked against the order's own amount and currency before finalization**, inside the finalizing transaction.

I1 and I2 are enforceable structurally by giving `payments` the same composite FK `(market_id, currency) → markets` and a composite FK to `orders (id, market_id)` — the pattern used five times already in this schema. I3 cannot be structural and must be an explicit check with a row lock.

---

## 4. CURRENT — concurrency and idempotency primitives already present

Phase 6 should reuse these rather than invent:

| Primitive                                                               | Where                                                                      | Reusable for                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `INSERT … ON CONFLICT (unique) DO NOTHING` as the idempotency authority | `OrdersRepository.insertIfNew`                                             | `payment_events` replay protection                                 |
| Request digest to reject key reuse                                      | `orders.idempotency_digest` + `assertSameRequest`                          | Payment-creation idempotency                                       |
| Transactional outbox, at-least-once, sealed payloads                    | `0011_outbox`, ADR-0028                                                    | Payment notifications                                              |
| `FOR UPDATE` + `SKIP LOCKED` claim-with-lease                           | `hv_claim_outbox`, `hv_expire_reservations`                                | Webhook processing workers                                         |
| Append-only guard + `REVOKE UPDATE, DELETE`                             | `audit_log`, `terms_acceptances`                                           | `payment_events`                                                   |
| Advisory lock on a business key                                         | `lockEntrantEmail` (`packages/db/src/entrant-lock.ts`, ADR-0011 amendment) | Serialising per-order finalization if row locks prove insufficient |
| Fail-closed Redis rate limiter                                          | `apps/api/src/auth/rate-limiter.ts`                                        | Payment endpoint limits                                            |

**Rate limits currently defined:** `loginPerIp`, `loginPerEmail`, `registerPerIp`, `mfaPerUser`, `reservePerUser`, `cartItemsPerOwner`, `checkoutPerOwner`, `verificationCodePerEmail`, `verificationCodePerIp`. **No payment limit exists.**

**Audit actions currently written:** `auth.mfa.enrolled`, `auth.mfa.recovery_code_used`, `entrant.cap.bridged`, `market.terms.activated`, `order.created`, `rbac.role.granted`. **No payment actions.**

**Outbox topics currently registered:** exactly one — `email.verification_code` (`apps/worker/src/outbox/outbox.service.ts:69`). An unknown topic **fails the event rather than dropping it**.

---

## 5. CURRENT — authorization, and a gap Phase 6 must close

### How order access works today

`CheckoutService.getOrder` resolves the caller through `buyerOf(identity)` and compares with `ownedBy`. Cross-identity reads return **404, not 403** — someone else's order is indistinguishable from one that does not exist. Tested both directions in `phase5-journey.int.test.ts`.

### ⚠️ Gap — a guest loses access to their own order after 30 minutes

`buyerOf` throws `VERIFICATION_REQUIRED` unless `guests.hasFreshVerifiedEmail(guest)` is true. That window is `GUEST_VERIFIED_EMAIL_TTL_MINUTES`, **default 30** (`env.ts:61`), while the guest session itself lasts `GUEST_SESSION_TTL_HOURS`, **default 24** (`env.ts:57`).

So a guest who returns from a provider's page more than 30 minutes after verifying **cannot read their own order** — `GET /markets/:market/checkout/orders/:order` answers 404. They also cannot re-verify: ADR-0029 makes `guest_sessions.verified_email` immutable, so a second verification on the same session is refused.

This is not a Phase 5 defect — nothing in Phase 5 needed post-order access. It becomes one the moment a customer leaves for a payment provider and comes back.

**OPEN DECISION 2 — how does a guest reach their order after the verification window lapses?**

Note this does **not** affect webhook processing, which is server-to-server and touches no session (see §8).

---

## 6. CURRENT — markets and currencies

| Market | Currency | State                                                                                    | Enforcement                                                                                            |
| ------ | -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| UK     | GBP      | enabled in tests; **no real market is enabled** until O12 values are supplied (ADR-0016) | `MarketGuard` → 404; `markets(id, currency)` composite FK                                              |
| IE     | EUR      | same                                                                                     | same                                                                                                   |
| DE     | EUR      | **disabled**, three-layer gate (B8, ADR-0005)                                            | `/markets/de/...` 404 even when the row is enabled — tested in `cart.int.test.ts`, `terms.int.test.ts` |

Cross-market is **structurally impossible**, not merely refused: composite FKs force item market = cart market = draw market = order market, and tests attempt the violation in raw SQL and are rejected by the schema.

**PROPOSED:** `payments` carries `market_id` + `currency` with the same `(market_id, currency) → markets` FK and a composite FK to `orders (id, market_id)`. A UK order can then not have a EUR payment at the database level, and a payment cannot reference an order from another market.

---

## 7. PROPOSED — the Phase 6 lifecycle

**CURRENT** stops at the first box. Everything after it is proposed, and the status names are B7's.

```
order created ──► awaiting_payment          ← CURRENT: Phase 5 ends here
                        │
                        ├─► payment attempt created (payments row, status 'pending')
                        │        │
                        │        └─► provider createPayment() → provider_reference
                        │                 │
                        │        customer completes at the provider (redirect/hosted)
                        │                 │
                        │   ┌─────────────┴─────────────┐
                        │   ▼                           ▼
                        │  webhook                trusted status check
                        │  verifyWebhook()        getPaymentStatus()
                        │   └─────────────┬─────────────┘
                        │                 ▼
                        │        the SAME idempotent confirmPayment()      ← B10
                        │                 │
                        ▼                 ▼
                  failed / expired      paid  ──► tickets reserved → sold
                                              ──► reservation ended
                                              ──► instant wins (Phase 8)
                                              ──► outbox: order paid
```

**B10 fixes two things that are therefore not open:**

1. **"The browser redirect never marks an order paid."** (ADR-0006, D6.) Only a verified webhook or a trusted server-side status check may confirm. A return page may _trigger_ a check; it may never assert an outcome.
2. **Both confirmation paths call the same idempotent `confirmPayment()`.**

---

## 8. PROPOSED — the payment-attempt model

B18 already specifies the table. This expands it with types and justification; **every field below traces to B18, to an existing repository pattern, or to a stated invariant.** Nothing is included because other systems have it.

### `payments`

| Field                              | Type                                 | Mutability           | Constraint / index                                                   | Why                                                                                 |
| ---------------------------------- | ------------------------------------ | -------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `id`                               | `uuid` PK `DEFAULT uuidv7()`         | immutable            | —                                                                    | Every table in this schema does this                                                |
| `order_id`                         | `uuid NOT NULL`                      | immutable            | composite FK `(order_id, market_id) → orders (id, market_id)`        | B18; the composite form reuses `orders_id_market_key`, which `0016` already created |
| `market_id`                        | `uuid NOT NULL`                      | immutable            | FK above + `(market_id, currency) → markets`                         | Makes cross-market payment unrepresentable (§6)                                     |
| `provider`                         | `text NOT NULL`                      | immutable            | part of `UNIQUE(provider, provider_reference)`                       | B18. `PaymentProvider.code` in B10                                                  |
| `provider_reference`               | `text NOT NULL`                      | immutable            | ★ `UNIQUE(provider, provider_reference)`                             | B18 and B10 REQ: "unique provider references"                                       |
| `amount_minor`                     | `bigint NOT NULL`                    | immutable            | `CHECK > 0`; must equal `orders.external_due_minor` at creation (I1) | B18; integer minor units (B5)                                                       |
| `currency`                         | `text NOT NULL`                      | immutable            | `(market_id, currency)` FK                                           | B18; invariant I2                                                                   |
| `status`                           | `text NOT NULL`                      | **mutable**          | `CHECK status IN (…)`                                                | B18                                                                                 |
| `created_at` / `updated_at`        | `timestamptz NOT NULL DEFAULT now()` | `updated_at` mutable | `hv_set_updated_at` trigger                                          | Repository convention                                                               |
| `idempotency_key`                  | `text`                               | immutable            | `UNIQUE`                                                             | Mirrors `orders.idempotency_key`; B10 requires it on `createPayment`                |
| `failure_code` / `failure_message` | `text`                               | set once             | —                                                                    | Mirrors `outbox.last_error`; needed for support and for `failed`                    |

**Deliberately NOT proposed**, because nothing in the repository or the specification justifies them: `metadata jsonb`, `customer_id`, `payment_method`, `card_last4`, `attempt_number`, `return_url`, `cancel_url`. The last two are `createPayment` _inputs_ (B10), not stored state, unless a decision requires persisting them.

**`expires_at` — NOT PROPOSED pending OPEN DECISION 1.** If the reservation remains the clock, the payment does not need its own.

### `payment_events`

B18: `UNIQUE(provider, provider_event_id)`, raw payload, `processed_at`, **append-only**.

| Field                            | Type                                 | Why                                                                                         |
| -------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `id`                             | `uuid` PK                            | convention                                                                                  |
| `provider` / `provider_event_id` | `text NOT NULL`                      | ★ `UNIQUE(provider, provider_event_id)` — **this is the replay-protection mechanism** (§10) |
| `payload`                        | `jsonb NOT NULL`                     | B18 "raw payload". See the sealing question in §15                                          |
| `received_at`                    | `timestamptz NOT NULL DEFAULT now()` | when it arrived                                                                             |
| `processed_at`                   | `timestamptz`                        | NULL until handled; B18                                                                     |
| `payment_id`                     | `uuid` nullable FK                   | an event may arrive for an unknown reference; keep it and record why                        |
| `last_error`                     | `text`                               | mirrors the outbox pattern so a stuck event stays visible                                   |

**Privileges (PROPOSED):** `REVOKE UPDATE, DELETE, TRUNCATE ON payment_events FROM hv_app` except for `processed_at`/`last_error` — which, following the `outbox` precedent, means a guard trigger allowing only those columns to change rather than a blanket revoke. B19 already lists `payment_events` among the tables with `UPDATE/DELETE` revoked.

### `refunds`

B18 specifies it fully: `order_id`, `payment_id` nullable, `amount_minor`, `destination` (provider/wallet), `idempotency_key UNIQUE`, `UNIQUE(provider, provider_refund_reference)`, `status`, `reason`, `actor_id`. See §13 for what of this belongs in Phase 6.

---

## 9. PROPOSED — provider abstraction

B10 already gives the interface verbatim, and ADR-0006 fixes the four operations. **Adding methods beyond these would be inventing requirements:**

```ts
interface PaymentProvider {
  readonly code: string; // 'fake', later e.g. 'stripe'
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  verifyWebhook(rawBody: Buffer, headers: Headers): Promise<VerifiedEvent>; // throws on bad signature
  getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus>;
  refund(input: RefundInput): Promise<ProviderRefundResult>;
}
```

- **Location:** `packages/payments` (ADR-0006 Consequences names it).
- **Boundary:** the provider package may not import the API's domain modules, and no domain module may import a concrete provider — only the interface. This mirrors how `MailPort` keeps `nodemailer` behind an adapter (ADR-0028): the concrete SMTP library exists in one file and nowhere else.
- **Error mapping:** provider errors map to domain refusals at the adapter edge, as `mapRefusal` does for the ticket engine, so no provider type escapes into services.
- **Fake provider:** required by ADR-0006 and B10 — HMAC-signed webhooks, able to deliver late, duplicated, out-of-order and missing events, with a dev-only complete/fail page. B10: **"not registered in production builds (a config guard refuses it)"** — the same fail-closed shape as the `OUTBOX_ENCRYPTION_KEY` placeholder guard in `env.ts`.
- **Provider selection:** B10 specifies `market_payment_configs(market_id, provider_code, config_ref)` holding secret _references_ only. **Not present in the repository.**

**NOT DETERMINED FROM CURRENT REPOSITORY:** the concrete types of `CreatePaymentInput`, `CreatedPayment`, `VerifiedEvent`, `ProviderPaymentStatus`, `RefundInput` and `ProviderRefundResult`. B10 names them but does not define their fields.

---

## 10. PROPOSED — webhook architecture and idempotency

### Boundary

| Concern            | PROPOSED                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint           | `POST /webhooks/payments/:provider` — **not** market-scoped: a provider does not know Highland Vault's markets                                                                                     |
| Body               | **Raw bytes required.** B19: "Signatures are verified against the raw body." Fastify must not have JSON-parsed it first — this constrains the route's content-type parser and is easy to get wrong |
| Authorization      | `@Public()`. The signature is the authentication; no session, no guest, no CSRF origin check (a provider sends no `Origin`)                                                                        |
| Provider identity  | From the route parameter, resolved to a registered provider; unknown → 404 without detail                                                                                                          |
| Signature          | `verifyWebhook(rawBody, headers)` throws; the route answers a generic failure. **No provider-specific algorithm is proposed here**                                                                 |
| Replay protection  | `INSERT INTO payment_events … ON CONFLICT (provider, provider_event_id) DO NOTHING`. A duplicate inserts nothing and returns 200 immediately (B10 step 2)                                          |
| Malformed payload  | 400, recorded, never retried into a loop                                                                                                                                                           |
| Unknown event type | Stored, `processed_at` set, ignored — the outbox precedent of never dropping what arrived                                                                                                          |
| Processing failure | 5xx so the provider retries, **and** the stored event is retried by a job (B10 step 4)                                                                                                             |

### Duplicate and ordering matrix — PROPOSED

| Case                     | Expected outcome                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| Same event twice         | Second insert conflicts → no-op → 200                                                               |
| Same success twice       | `confirmPayment` is idempotent; the conditional status transition matches zero rows the second time |
| Failure then success     | Success wins if the order is still eligible; a `failed` payment is not terminal for the order       |
| Success then failure     | **Success is terminal.** A later failure is recorded and must not un-sell tickets                   |
| Two events, same payment | Ordered by the conditional transition, not by arrival                                               |
| Two attempts, one order  | **OPEN DECISION 4**                                                                                 |
| Webhook after expiry     | **OPEN DECISION 3**                                                                                 |

---

## 11. PROPOSED — the finalization transaction

B10 step 3 states it: _"In one transaction, lock the order, apply the conditional transition, mark tickets `sold`, evaluate instant wins (B12) and write outbox messages."_ Instant wins are Phase 8, so for Phase 6:

```
BEGIN
  SELECT … FROM orders WHERE id = $1 FOR UPDATE            -- lock first
  verify amount = external_due_minor, currency = order currency   (I3)
  UPDATE orders SET status='paid' WHERE id=$1 AND status='awaiting_payment'
      ← 0 rows ⇒ already finalized or no longer eligible; stop, succeed idempotently
  UPDATE payments SET status='succeeded' WHERE id=$2 AND status<>'succeeded'
  for each order_item:
      lock its reservation; confirm still active and unexpired
      UPDATE tickets SET status='sold' WHERE reservation_id=$r AND status='reserved'
      end the reservation                     ← see the cap warning below
  INSERT audit_log  (same transaction, ADR-0010)
  INSERT outbox     (same transaction, ADR-0028)
  UPDATE payment_events SET processed_at = now()
COMMIT
```

**Must never happen partially:** order `paid` without tickets `sold`; tickets `sold` without the order `paid`; either without the audit row; the outbox event committed without the state change (that is the whole point of the outbox).

**Lock order.** The ticket engine's established order is **entrant counter → tickets** (P4 handoff; `hv_expire_reservations` processes in entrant order for this reason). Finalization adds `orders` at the front. **PROPOSED: orders → entrant counter → tickets**, kept consistent everywhere, or the expiry sweep and finalization can deadlock.

### ⚠️ Cap warning that Phase 6 must not get wrong

`hv_end_reservation` (`0010`) returns cap allowance **only for tickets it actually frees**, using `GET DIAGNOSTICS` — that was NB-1, fixed structurally. Sold tickets free nothing and therefore keep counting against the entrant's cap, which is correct.

Since P5-8 there is a second trap: the cap key lives **on the reservation** and may have been **re-keyed** from `email` to `user` by ADR-0021 bridging (`0017_entrant_rekey.sql`). **Phase 6 must read the entrant key from the reservation row and never re-derive it from the buyer** — the P5-8 handoff states this explicitly. Re-deriving would decrement a counter that does not exist and silently mis-state the cap.

---

## 12. PROPOSED — concurrency matrix

All of these are PostgreSQL-authoritative; none needs Redis for correctness.

| #   | Race                              | Conflicting resource      | Mechanism                                                                                      | Expected final state                              |
| --- | --------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| A   | Two identical success webhooks    | `payment_events`          | `UNIQUE(provider, provider_event_id)` + `ON CONFLICT DO NOTHING`                               | One processed; second 200s immediately            |
| B   | Two attempts, one order           | `payments`, `orders`      | **OPEN DECISION 4** decides whether a partial unique index forbids a second live attempt       | Depends on that decision                          |
| C   | Success + reservation expiry      | `reservations`, `tickets` | `FOR UPDATE` on the reservation inside finalization; B9's trusted status check before expiring | One wins; never half-sold                         |
| D   | Success + order expiry            | `orders`                  | Conditional `UPDATE … WHERE status='awaiting_payment'`                                         | **OPEN DECISION 3**                               |
| E   | Success + cancellation            | `orders`                  | Same conditional transition                                                                    | Whichever commits first; the other matches 0 rows |
| F   | Duplicate provider event          | `payment_events`          | As A                                                                                           | Idempotent                                        |
| G   | Out-of-order events               | `orders.status`           | Conditional transitions, not arrival order                                                     | Terminal states are not reopened                  |
| H   | Webhook + refund                  | `orders`, `refunds`       | Order row lock; refund `idempotency_key UNIQUE`                                                | Serialised                                        |
| I   | Two workers, same event           | `payment_events`          | Claim-with-lease exactly as `hv_claim_outbox` does                                             | Processed once                                    |
| J   | Two workers finalizing one order  | `orders`                  | `SELECT … FOR UPDATE` then conditional transition                                              | Second is a no-op                                 |
| K   | Success while inventory finalizes | `tickets`                 | `hv_tickets_guard` allows only `reserved → sold` for the **same** reservation                  | Structurally safe                                 |

---

## 13. PROPOSED — refunds in Phase 6

ADR-0006 and Part F call for a **refund skeleton**, not a refund subsystem. B10's late-payment path needs one: an order that is confirmed after its tickets are gone becomes `paid_unfulfillable` and "an automatic refund is raised".

**In scope (PROPOSED):** the `refunds` table as B18 specifies it; `PaymentProvider.refund()` in the interface and in the fake provider; a refund _record_ raised by the late-payment path.

**OUT OF SCOPE for Phase 6:** admin-initiated refunds and a refunds UI (Part F puts them in **P10**); refunds to wallet (**P7** — `destination` exists in the schema but wallet is Phase 7); partial-refund workflows; anything depending on **O7**, which is unresolved (_"Refund policy: destination, refunds after close/settlement, tickets and instant wins on refunded orders"_ — `PROJECT_STATUS.md`).

---

## 14. PROPOSED — outbox events

The outbox is for **side effects after commit**, never a substitute for transactional correctness (ADR-0028). Four distinct things must not be conflated: the database transaction; the internal domain change; the provider side effect; the customer notification.

| Event                                   | Needed in Phase 6?  | Why                                                                                                                                     |
| --------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `order.paid`                            | **Yes**             | The customer must be told their entry is confirmed; it is the first thing a real buyer expects. Written in the finalization transaction |
| `payment.failed`                        | **OPEN DECISION 6** | Only if the customer is notified on failure; the UI may be sufficient                                                                   |
| `order.expired`                         | **OPEN DECISION 6** | Same                                                                                                                                    |
| `refund.initiated` / `refund.completed` | **No** — defer      | Nothing in Phase 6 completes a refund; a record is raised, and O7 is open                                                               |
| `payment.succeeded`                     | **No**              | Redundant with `order.paid`; one event per business fact                                                                                |

Each new topic must be registered in the worker's dispatcher (`outbox.service.ts:69`), or the event **fails rather than being dropped** — the existing, deliberate behaviour.

---

## 15. PROPOSED — security and abuse

| Concern                     | CURRENT                                                                     | PROPOSED for Phase 6                                                                           |
| --------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Amount tampering            | Impossible at checkout (§3)                                                 | I1/I3: amount read from the order, re-checked at finalization                                  |
| Currency / market tampering | Structurally impossible                                                     | Same composite FKs on `payments`                                                               |
| Order ownership             | 404 not 403; tested both ways                                               | Payment creation must apply the same ownership check                                           |
| Guest access                | ⚠️ 30-minute cliff (§5)                                                     | **OPEN DECISION 2**                                                                            |
| Webhook spoofing            | —                                                                           | Signature over the **raw** body is the only authentication                                     |
| Webhook replay              | —                                                                           | `UNIQUE(provider, provider_event_id)`                                                          |
| Webhook enumeration         | —                                                                           | Generic failures; never reveal whether a reference is known                                    |
| Reference enumeration       | —                                                                           | `provider_reference` never appears in a customer-facing response                               |
| Endpoint abuse              | No payment limit exists                                                     | A payment-creation limit per owner, following `checkoutPerOwner` (30 / 10 min)                 |
| Idempotency-key abuse       | Digest + buyer check refuse cross-customer reuse                            | Reuse the same pattern                                                                         |
| Logging                     | `pino` redacts `authorization`, `cookie`, `set-cookie` (`app.module.ts:41`) | **Add the provider signature header.** Never log payloads, references or amounts at info level |
| Card data                   | None stored                                                                 | **Never touches our servers** — provider-hosted fields or redirect, PCI scope SAQ-A (B19)      |

⚠️ **`payment_events.payload` deserves a decision.** B18 says "raw payload". Provider payloads may carry PII (name, email, address, partial card metadata), and `hv_app` cannot delete these rows. ADR-0028 already established the pattern for exactly this problem — sealing sensitive payloads with `SecretBox` because an outbox row can never be redacted. **PROPOSED: apply the same reasoning**, and if the raw payload is retained unsealed, make that an explicit decision rather than a default.

---

## 16. PROPOSED — migrations

Conservative, and dependent on decisions. **No migration is created by this audit.**

| #               | Purpose                            | Tables / objects                                                                                                                                                                                                                                    | Depends on                                                                                                                                      |
| --------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `0019`          | Payment attempts                   | `payments`; composite FKs to `orders (id, market_id)` and `markets (id, currency)`; `UNIQUE(provider, provider_reference)`; `UNIQUE(idempotency_key)`; `hv_payments_guard` (snapshot immutable, status-only transitions); `REVOKE DELETE, TRUNCATE` | `0016`                                                                                                                                          |
| `0020`          | Provider events                    | `payment_events`; `UNIQUE(provider, provider_event_id)`; append-only guard; index on `processed_at IS NULL`; `REVOKE UPDATE/DELETE/TRUNCATE` per B19                                                                                                | `0019`                                                                                                                                          |
| `0021`          | Refund skeleton                    | `refunds` per B18                                                                                                                                                                                                                                   | `0019`                                                                                                                                          |
| `0022`          | Per-market provider config         | `market_payment_configs(market_id, provider_code, config_ref)` — **secret references only**                                                                                                                                                         | `0004`                                                                                                                                          |
| **Conditional** | Order payment window               | `orders.expires_at` + guard change                                                                                                                                                                                                                  | **OPEN DECISION 1** — needed only if the order gets its own clock                                                                               |
| **Conditional** | Reservation status for a sold hold | extend `reservations_status_valid` and `hv_reservations_guard` (e.g. `converted`)                                                                                                                                                                   | The P4 handoff flags this as needed _when_ `reserved → sold` is built. **Possibly none** if ending as `released`/`expired` is judged sufficient |

**No migration is required** for the provider abstraction, the fake provider, the webhook route, or the outbox topics.

---

## 17. PROPOSED — API surface

### Customer-facing

|              |                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------- |
| **POST**     | `/markets/:market/checkout/orders/:order/payments`                                       |
| Auth         | `@Public({ identify: true })` + `MarketGuard`; ownership checked as `getOrder` does      |
| Request      | `{}` — or a provider hint if several are configured. **Never an amount**                 |
| Response     | Provider redirect/session details; never `provider_reference`                            |
| Idempotency  | `Idempotency-Key` required, as checkout already requires                                 |
| Errors       | 404 not owned; 409 not `awaiting_payment`; 409 expired; 429 rate-limited; 503 Redis down |
| Rate limit   | New, per owner                                                                           |
| Side effects | `payments` row; provider `createPayment`                                                 |

|         |                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------- |
| **GET** | `/markets/:market/checkout/orders/:order/payments/:payment`                                          |
| Purpose | Status for the return page. **May trigger a trusted status check; may never assert paid** (ADR-0006) |

### Webhook

|              |                                                                        |
| ------------ | ---------------------------------------------------------------------- |
| **POST**     | `/webhooks/payments/:provider`                                         |
| Auth         | Signature over the raw body only. No session, no CSRF                  |
| Response     | 200 on accept **and** on duplicate; 4xx malformed; 5xx to invite retry |
| Side effects | `payment_events` insert; finalization; outbox                          |

### Admin / operations

|          |                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **GET**  | `/admin/markets/:market/orders/:order/payments` — `RequirePermission('orders.read')`, which **already exists** in `0006_rbac.sql` |
| **POST** | Retry a stuck confirmation — sensitive, audited. **OPEN DECISION 5**                                                              |

---

## 18. PROPOSED — UI

`apps/web` today has no checkout UI at all; `layout.tsx:44` states so. E2E specs are `admin-draws`, `auth`, `draws`, `reservations`, `smoke` — **no cart, terms, checkout or payment spec exists.**

Minimum required states: **pay** (leave for the provider), **pending** (returned, not yet confirmed — must poll, never assert), **paid**, **failed with retry**, **expired**. A countdown is only meaningful once **OPEN DECISION 1** fixes what the deadline is.

**The pending state is the one that matters**, because it is where the "redirect never marks paid" rule becomes visible to a real customer.

---

## 19. PROPOSED — test matrix

Real PostgreSQL for every concurrency test — mocks are explicitly rejected by DEVELOPMENT_RULES §3 and by the existing suite's practice.

**Payment creation:** valid · invalid order · wrong owner (404) · wrong market · order not `awaiting_payment` · expired order · duplicate idempotency key · key reused with a different request.

**Webhook:** valid signature · invalid signature · malformed body · unknown event type · duplicate event · replayed event · out-of-order events · wrong provider · amount mismatch · currency mismatch · unknown reference.

**Finalization:** success → `paid` + tickets `sold` + reservation ended + audit + outbox · failure · cancellation · reservation still valid · reservation expired · duplicate finalization is a no-op · **cap counter decremented on the correct (possibly re-keyed) entrant key**.

**Concurrency (real PostgreSQL):** two identical webhooks · two workers on one event · two workers finalizing one order · success racing expiry · success racing cancellation.

**Refund:** record raised on the unfulfillable path · duplicate refund refused by `idempotency_key`.

**Guest:** payment on a guest order · **webhook succeeds with the browser closed** · **webhook succeeds after the guest session expires** · guest reads the order after the verification window (**OPEN DECISION 2**).

**Authenticated:** normal payment · another user's order 404.

**Markets:** UK/GBP · IE/EUR · DE refused · UK order + EUR payment refused · payment referencing another market's order refused.

---

## 20. PROPOSED — vertical slices

Each is one focused PR, following the repository's DB → domain → API → tests → verification → PR → CI → merge pattern.

| Slice                                         | Objective                                                                                                                                   | Migration                           | Risk                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| **P6-1** Provider port + fake provider        | `packages/payments`: the B10 interface and a fake implementation with HMAC webhooks and a production config guard. No routes, no tables     | **none**                            | Low                                            |
| **P6-2** `payments` table + attempt creation  | `0019`; create an attempt with I1/I2 enforced; customer POST route                                                                          | `0019`                              | Medium — first money-adjacent schema           |
| **P6-3** `payment_events` + webhook intake    | `0020`; raw-body route, signature boundary, replay protection. **Stores and acknowledges; does not finalize**                               | `0020`                              | Medium — raw-body handling is the subtle part  |
| **P6-4** Finalization                         | `confirmPayment`: order lock, conditional transition, `reserved → sold`, reservation end, audit, `order.paid` outbox. **Gate 4 lives here** | possibly the reservation-status one | **Highest** — the cap-key and lock-order traps |
| **P6-5** Trusted status check + expiry safety | `getPaymentStatus`; B9's rule before expiring a reservation whose order has a pending payment                                               | none                                | Medium                                         |
| **P6-6** Late payment + refund skeleton       | `0021`; `paid_unfulfillable` and a raised refund record                                                                                     | `0021`                              | Depends on **O7**                              |
| **P6-7** Per-market provider config           | `0022`                                                                                                                                      | `0022`                              | Low                                            |
| **P6-8** Web payment flow                     | Pay / pending / paid / failed / expired; guest and authenticated                                                                            | none                                | Medium                                         |
| **P6-9** Gate hardening                       | Full concurrency matrix, e2e, Gate 4 sign-off                                                                                               | none                                | —                                              |

Splitting P6-3 from P6-4 is deliberate: storing an event and acting on it have different failure modes, and P5-8 showed how much is learned by running a slice's tests before the next one depends on it.

---

## 21. PROPOSED — gates

**Slice gate** (every PR): `pnpm verify` green — `secrets:scan`, `format:check`, `lint`, `typecheck`, unit, `db:migrate up`, `db:migrate verify`, integration, build — plus `codegen:verify`, `pnpm test:e2e` when the web app changes, CI green, review, merge by PR only. No direct push to `develop` or `main` (DEVELOPMENT_RULES §4).

**Final Phase 6 gate**, additionally: the full concurrency matrix against real PostgreSQL; **Gate 4 — a test proving the redirect cannot mark an order paid** (Part F's stated exit criterion); no raw card data anywhere; no payment secrets in the repository; every ADR written; `PROJECT_STATUS`, `TASK_BOARD`, `ACTIVE_WORK`, `CHANGELOG` and a handoff current; a Phase 6 Definition of Done committed **before** the phase closes — Phase 5's was written mid-phase, which the P5-8 audit showed to be late.

---

## 22. OPEN DECISIONS

Genuinely unresolved. No option is ranked and none is silently chosen.

### OD-1 — Is the payment window the reservation, or its own clock?

**Why it matters:** determines whether `orders` needs `expires_at` and a migration, what a countdown counts down to, and when an order becomes `expired`.
**Options:** (a) the reservation is the clock — no new column, and B9's grace (O5 = TTL + 2 min) already assumes this; (b) the order gets its own window — new column, new guard, and two clocks to keep consistent.
**Current code supports:** (a) only. `orders` has no expiry; `RESERVATION_TTL_SECONDS` is the sole 600-second value.
**To decide:** how long a customer may realistically take at the chosen provider.

### OD-2 — How does a guest reach their order after the verification window lapses?

**Why it matters:** a guest who takes more than `GUEST_VERIFIED_EMAIL_TTL_MINUTES` (30) at the provider gets **404** on their own order, and cannot re-verify because ADR-0029 makes the binding immutable.
**Options:** (a) lengthen the window; (b) let an order be read with the guest **session** rather than a fresh verification; (c) a one-time link emailed with the order; (d) accept it.
**Current code supports:** (a) by configuration alone. (b), (c) need code; (b) would loosen an ADR-0029 boundary and should not be done casually.
**To decide:** how long the chosen provider's flow really takes, and whether guests get order emails.

### OD-3 — What happens when a payment succeeds after the tickets are gone?

**Why it matters:** the customer has paid and there is nothing to give them.
**Options:** B10 describes re-allocating if the draw is still live and tickets remain, otherwise `paid_unfulfillable` + automatic refund. Whether to re-allocate, and where the refund goes, is **O7**, which is unresolved.
**Current code supports:** neither. No payment path, and `paid_unfulfillable` exists only as a permitted status value.
**To decide:** O7, and whether silent re-allocation is acceptable to the customer.

### OD-4 — May an order have more than one payment attempt?

**Why it matters:** decides whether a partial unique index forbids a second live attempt per order, and whether "retry payment" creates a new row or reuses one.
**Options:** (a) one attempt ever; (b) one _live_ attempt, retry after failure; (c) many.
**Current code supports:** any — nothing exists yet.
**To decide:** whether the chosen provider's session can be resumed after abandonment.

### OD-5 — May an operator retry a stuck confirmation?

**Why it matters:** B10 has a stuck-payment poller; a manual override is a sensitive, audited operation, and the RBAC matrix has no payment permission today.
**Current code supports:** `orders.read` exists in `0006_rbac.sql`; no payment-write permission does.
**To decide:** who is on support, and what they are trusted to do.

### OD-6 — Which payment outcomes notify the customer?

**Why it matters:** each notification is an outbox topic, a worker handler and a template; templates are Phase 12.
**Options:** paid only; paid + failed; paid + failed + expired.
**Current code supports:** the mechanism fully (ADR-0028); exactly one topic is registered today.
**To decide:** O12 wording ownership and what the business wants to send.

### OD-7 — Is the raw provider payload stored unsealed?

**Why it matters:** payloads may carry PII, `hv_app` cannot delete these rows, and ADR-0028 already set a precedent for sealing exactly this kind of payload.
**Options:** store raw; seal with `SecretBox`; store a redacted subset.
**Current code supports:** all three — `SecretBox` and `sealPayload` exist in `@hv/domain`.
**To decide:** what a dispute or a provider support case actually requires.

### OD-8 — Which production provider? (**O13**, pre-existing)

Unchanged and still open. ADR-0006 exists precisely so this can be answered late. Phase 6 proceeds on the fake provider.

---

## 23. OUT OF SCOPE for Phase 6

Justified by Part F's phase sequence, not by general practice:

- **Wallet** — P7. `orders.wallet_applied_minor` exists and stays 0.
- **Instant wins** — P8, though B10 evaluates them inside the same finalization transaction, so P6-4 must leave a clean seam.
- **Settlement** — P9.
- **Admin refunds UI, fulfilment, reports, CSV** — P10.
- **Referrals, Vault Meter** — P11.
- **Per-market templates, consent, compliance values** — P12; O12 still blocks market enablement.
- **Production merchant onboarding** — O13/O14.
- **Financial reconciliation, payouts, accounting** — not in Part F at all.
- **Fraud engine, chargebacks, analytics** — not in Part F at all.

---

## 24. Recommended first slice — **P6-1, provider port + fake provider**

**Not** "implement payments".

**Why this first, from this repository:**

1. **It needs no migration and touches no existing behaviour.** Every other slice writes money-adjacent rows; this one adds a package. If it is wrong, nothing is at risk.
2. **It is the one thing every later slice depends on.** P6-2 needs `createPayment`, P6-3 needs `verifyWebhook`, P6-4 needs the events the fake provider can produce, P6-5 needs `getPaymentStatus`.
3. **Without the fake provider, the later slices cannot be tested deterministically.** ADR-0006 requires it to "simulate duplicate, late, out-of-order and missing webhooks" — precisely the cases §12 must prove. Building the fake first means P6-3 and P6-4 arrive with their adversary already in place.
4. **It settles the types B10 leaves undefined** (`CreatePaymentInput`, `VerifiedEvent`, …) in a slice where they are cheap to change.
5. **It proves the boundary early.** ADR-0006 forbids a production provider in core commerce logic; establishing `packages/payments` with no domain imports makes that structural from the first commit, as `MailPort` did for mail.

**Acceptance criteria (PROPOSED):** `packages/payments` exists with the B10 interface and a fake implementation; HMAC-signed webhooks it can also deliver late, duplicated and out of order; a config guard refusing the fake in production, tested as `env.ts` tests its placeholder guards; unit tests; no API route, no table, no change to any existing file beyond workspace registration.

---

## 25. Discrepancies found during this audit

Reported rather than silently resolved.

1. **`pending_payment` is not a real status.** Planning prose uses it; the schema and code use `awaiting_payment` (B7). Already reconciled in four documents; Phase 6 must not reintroduce it.
2. **No payment window exists.** `ORDER_PAYMENT_WINDOW_SECONDS` was referenced in planning and never implemented; `orders` has no `expires_at`. → **OD-1**.
3. **The reservation expiry worker is not order-aware.** Its own header records B9's rule as Phase 6 work. Today an order awaiting payment can lose its tickets mid-flow.
4. **A guest cannot read their own order after 30 minutes.** → **OD-2**.
5. **`packages/shared` does not exist.** The workspaces are `config`, `contracts`, `db`, `domain`.
6. **`market_payment_configs` is specified in B10 but absent** from the B18 table list and from the repository.
7. **Two known flaky tests remain open**, neither payment-related and neither touched: `tools/gitleaks/negative-control.test.mjs` (~5–10%, random hex against an entropy threshold) and one case in `apps/worker/test/outbox.int.test.ts` (unexplained, one failure under heavy load, not reproducible in isolation). Each wants its own `fix/*` branch and should not be carried into Phase 6 unexamined.

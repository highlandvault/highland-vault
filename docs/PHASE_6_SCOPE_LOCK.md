# Phase 6 — scope lock and architectural decisions

_Locked: 2026-09-25 · audit HEAD `723c7ae` · Phase 5 COMPLETE · documentation only, nothing implemented._
_Owner decisions D1–D20 and every sub-value recorded: 2026-09-25 — see [§3b](#3b-owner-decisions-recorded). **All nine slices are unblocked with nothing pending.** Items deferred to later phases: [§26](#26-remaining-open-decisions)._

This converts [PHASE_6_AUDIT.md](PHASE_6_AUDIT.md) into an explicit scope and architecture lock. The audit is the primary source; every claim here was re-checked against the repository at `723c7ae` before being written down.

**Labels used throughout**

| Label            | Meaning                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| **LOCKED**       | Decided by the owner. Implement as written. Changing it needs a new owner decision.                                  |
| **PROPOSED**     | A design suggestion that follows from LOCKED decisions and repository fact. A reviewer may refine it inside a slice. |
| **OPEN**         | Not decided. Must not be resolved silently by an implementer.                                                        |
| **OUT OF SCOPE** | Explicitly not Phase 6.                                                                                              |

**Eleven contradictions between the instructed decisions and the repository were found.** They are in [§3a](#3a-conflicts-found-during-the-decision-audit) and none of them was silently resolved. **The owner answered all eleven on 2026-09-25**, together with the later decisions OD-2a, OD-4a, OD-6a and O7/O9/O13. The answers are recorded in [§3b](#3b-owner-decisions-recorded) and carried into every affected section below.

**Every Phase 6 decision, value, interpretation and name is now answered, and all nine slices are unblocked.** Nothing in [§26](#26-remaining-open-decisions) blocks Phase 6; what is listed there is deferred to P7, P10 and P14 by design.

One answer produced a finding rather than a clean resolution — D11 = A's predicate cannot fire under D1 = B — and the owner resolved it as **D11a = B**: no migration, dependency recorded instead. **Phase 6 makes no change to the reservation-expiry sweep**, and adds eight migrations, `0019`–`0026`.

---

## 1. Phase 6 objective

**LOCKED.** Take an order that Phase 5 left at `awaiting_payment` and carry it, safely and idempotently, to a settled outcome — `paid` with its tickets `sold`, or `failed`, `expired` or `paid_unfulfillable` with the customer's money and the draw's inventory both correct.

Phase 6 builds the payment infrastructure and the state transitions. It does **not** invent order statuses: `orders_status_valid` (`0016_orders.sql:95`) already admits the full B7 enumeration.

The objective is met when a payment can be initiated, confirmed through a verified provider event or a trusted server-side status check, finalized atomically against real inventory, and reconciled when the provider's answer is late or ambiguous — with **Gate 4** passing.

---

## 2. Phase 5 boundary — where Phase 6 begins

**LOCKED, and verified in the repository.**

After `CheckoutService.createOrder` commits:

| Thing                                       | State                                                                                         | Verified by                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `orders.status`                             | `awaiting_payment`                                                                            | `checkout-orders.int.test.ts`, `phase5-journey.int.test.ts` |
| `orders.total_minor` / `external_due_minor` | fixed; `wallet_applied_minor` = 0                                                             | `orders_totals_add_up` CHECK                                |
| `reservations.status`                       | **`active`**, untouched                                                                       | `assertPhaseBoundary` in `phase5-journey.int.test.ts`       |
| `tickets.status`                            | **`reserved`**, untouched                                                                     | same                                                        |
| `cart_items`                                | `removed_at` set                                                                              | same                                                        |
| Payments                                    | **none exist** — `payments`, `payment_events`, `refunds` are absent from `information_schema` | same                                                        |

The order snapshot is immutable: `hv_orders_guard` (`0016`) freezes `market_id`, `currency`, buyer, `terms_version_id`, `total_minor`, `external_due_minor`, both idempotency columns and `created_at`. **Only `status` and `updated_at` may move**, and moving `status` is exactly Phase 6's job.

`order_items` is immutable entirely — `hv_order_items_guard` raises on **any** UPDATE, and `hv_app` has `UPDATE, DELETE, TRUNCATE` revoked. This has a consequence the spec did not anticipate; see **C10**.

---

## 3. Phase 6 boundary

**LOCKED — in scope:**

payment attempt domain · provider abstraction · deterministic fake provider · payment initiation · payment window · webhook ingestion · webhook verification · webhook idempotency · payment state transitions · order payment finalization · reservation/ticket finalization (`reserved → sold`) · late payment handling · payment failure · payment reconciliation · refund skeleton · customer payment status · required notifications · payment security · concurrency protection · **Gate 4**.

**LOCKED — not in scope:** see [§25](#25-explicit-out-of-scope-list).

**Repository agreement.** Part F row **P6** reads: "`packages/payments`, fake provider, payment records, webhook ingestion, confirm, status poller, late-payment path, refund skeleton | **Gate 4**; the redirect cannot mark paid (test)". The instructed boundary matches it, with two documented deviations (**C6**, **C10**).

---

## 3a. Conflicts found during the decision audit

Reported rather than silently resolved. Format as instructed: DECISION · CONFLICTING REPOSITORY FACT · IMPACT · REQUIRED OWNER DECISION.

**Status at 2026-09-25: all eleven are answered.** Each block below carries its answer under **OWNER DECISION — RESOLVED**. The consolidated tables are in [§3b](#3b-owner-decisions-recorded).

One answer produced a finding rather than a clean resolution: **C2's database half (D11 = A) cannot fire under C1's answer (D1 = B)**, because the options for C2 were drafted before C1 was decided. The owner resolved it as **D11a = B** — no migration, the dependency recorded instead. See [§3b](#3b-owner-decisions-recorded).

### C1 — A 600-second order payment deadline always outlives its reservation ⛔ BLOCKER

**DECISION.** OD-1: a dedicated immutable order payment deadline, default **600 seconds**, explicitly _not_ the reservation TTL.

**CONFLICTING REPOSITORY FACT.** `0009_tickets.sql:68-69`:

```sql
CONSTRAINT reservations_ttl_valid CHECK (
  expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
)
```

This is a **hard database ceiling**. A reservation can never live more than 10 minutes from its own creation, and it **cannot be extended** — `hv_reservations_guard` (`0009:144-147`) lists `expires_at` among the columns that may not change. `RESERVATION_TTL_SECONDS` is separately pinned to exactly 600 in production (`env.ts:105`, D11).

An order is always created _after_ its reservation — reserve, add to basket, accept terms, answer the skill question, checkout. Let the reservation be created at T₀ and the order at T₀+d, where d > 0 is the customer's own checkout time. The reservation dies at T₀+600 at the latest; a fresh 600-second order deadline runs to T₀+d+600.

**The payment deadline therefore outlives the reservation by exactly d, always — not occasionally.**

**IMPACT.** Any customer who uses more than (600 − d) seconds at the provider will have their tickets swept back into the pool while their payment deadline is still open. The late-payment path (OD-3) stops being an edge case and becomes the **normal outcome for slow payers**. Because re-allocation is structurally impossible (**C10**), every such customer reaches `paid_unfulfillable` and a refund. That is a poor experience and a real support cost, not a theoretical concern.

**REQUIRED OWNER DECISION.** One of:

- **(a) Deadline = min(600s, reservation `expires_at`).** The order carries its own immutable deadline column, as OD-1 requires, but it is never set beyond the reservation it depends on. No schema change to reservations. The window is shorter than 600s for slow shoppers, and the countdown is honest.
- **(b) Keep a flat 600s and accept that late payment is routine.** Requires the OD-3 path to be production-quality from day one and a refund policy (**O7**) settled before P6-6.
- **(c) Raise the reservation ceiling** so a reservation can cover order creation plus the payment window. Needs a new migration replacing `reservations_ttl_valid` and relaxing the guard, and it reopens D11, Gate 1/Gate 2 assumptions and the O5 settlement grace (reservation TTL + 2 min). **Most invasive; not recommended without a separate ADR.**

**OWNER DECISION — RESOLVED 2026-09-25 (D1 = B, D1a = 90 s, D1b = 180 s, D2 = B).** The payment deadline is set so the reservation always outlives it. See [§3b](#3b-owner-decisions-recorded) for the derived arithmetic and its consequences. Options (c) and (d) are **not** taken, so `reservations_ttl_valid`, `hv_reservations_guard`, ADR-0024 and the D11 production pin are all **untouched**.

### C2 — The expiry safety rule has two call sites, and neither can call a provider

**DECISION.** OD-1 requires the relationship between the order deadline and reservation expiry to be defined. B10 states the safety rule: "before releasing a reservation whose order has a pending provider payment, the job performs a **trusted provider status check**".

**CONFLICTING REPOSITORY FACT.** `hv_expire_reservations` has **two** callers, not one:

- `apps/worker/src/tickets/reservation-expiry.ts:38` — the global 30-second sweep;
- `apps/api/src/tickets/tickets.repository.ts:180` — a **per-draw sweep on the API allocation path**.

The sweeping logic itself lives in PL/pgSQL (`0009:304`), which cannot make an HTTP call to a provider.

**IMPACT.** Implementing the safety rule only in the worker leaves the API's allocation-path sweep free to release a reservation whose order is mid-payment. The rule would be silently incomplete.

**OWNER DECISION — RESOLVED 2026-09-25 (D11 = A, D12 = A).** The rule is split in two, along the line between what the database can decide and what only the provider knows.

1. **Database half (D11 = A, then D11a = B).** The owner first chose a pure SQL predicate inside `hv_expire_reservations`. Working it through showed the predicate **cannot fire** under D1 = B — the 90-second margin already guarantees that a hold whose order is inside its deadline is never due for sweeping. **D11a = B therefore creates no migration.** `hv_expire_reservations` stays exactly as `0009` defines it, and the dependency that makes the predicate unnecessary is recorded instead, in [§3b](#3b-owner-decisions-recorded) and in the two call sites' comments.
2. **Provider half (D12 = A).** A **scheduled background reconciler** calls the trusted `getPaymentStatus()` for payments in a non-terminal state and applies the answer through the same idempotent `confirmPayment()` the webhook uses. It follows the established repeatable-job pattern (`draw-lifecycle.service.ts`, `reservation-expiry.ts`) and never holds row locks across a network call.

The database stays authoritative, and no network I/O enters a sweep transaction — now because the sweep is untouched.

**Net effect on the original C2 problem.** Both call sites are safe, but not by the route C2 proposed: the sweep needs no knowledge of orders, because a hold whose order is still payable is never due, and a hold that _is_ due can never be sold thanks to **D10 = B**. The two-call-site hazard C2 identified is therefore closed by arithmetic and by the ticket guard rather than by a predicate.

**LOCKED (D12a):** the reconciler runs **every 60 seconds** with a **5-minute lookback**, and is repeatable and idempotent — safe to run concurrently with itself and with the webhook path, because both call the same conditional `confirmPayment()`. 60 seconds matches `draw-lifecycle.service.ts`; `reservation-expiry.ts` runs at 30.

**How the two clocks fit.** An attempt times out at 120 s (**D3a**), so the reconciler sees every attempt at least twice inside its lifetime, and a customer blocked by a stuck attempt waits at most about a minute beyond the timeout. Payments older than the lookback fall to the operator endpoint — which is what `payments.reconcile` is for. See the interpretation note in [§3b](#3b-owner-decisions-recorded).

### C3 — The global CSRF hook rejects every provider webhook ⛔ BLOCKER

**CONFLICTING REPOSITORY FACT.** `apps/api/src/app.ts:44-61` installs a Fastify `onRequest` hook that rejects **every** non-safe method whose `Origin` header is absent or not in `WEB_ORIGINS`, with `403 ORIGIN_NOT_ALLOWED`.

A payment provider's webhook is a server-to-server `POST` and **sends no `Origin` header**. It would be refused before reaching any controller, guard or signature check.

**IMPACT.** P6-3 cannot work at all until this is addressed. It would also be easy to "fix" badly — a broad exemption here weakens CSRF protection for the whole API.

**OWNER DECISION — RESOLVED 2026-09-25 (D5 = B).** Webhook routes get their **own request pipeline inside the same application**, registered in a scope the CSRF origin hook is not attached to. The exemption is therefore structural, not a path-prefix condition, and cannot be widened by editing a string. The `onSend` security headers (`x-content-type-options`, `x-frame-options`, `referrer-policy`, `cache-control`) must be applied to the webhook scope as well — they are currently set once, globally, in `app.ts:64-70`.

Still required, unchanged: an explicit test proving (i) a webhook POST with no `Origin` is admitted, and (ii) a POST to any other route with no `Origin` is still refused.

### C4 — There is no raw-body capture, and the body limit is 64 KB ⛔ BLOCKER

**CONFLICTING REPOSITORY FACT.** B19 requires signatures to be verified against the **raw** body, and B10's `verifyWebhook(rawBody: Buffer, headers)` takes raw bytes. The API registers **no** `addContentTypeParser` and no raw-body plugin, so Fastify JSON-parses the body and the original bytes are gone. `app.ts:33` also sets `bodyLimit: 64 * 1024` globally.

**IMPACT.** Signature verification is impossible as the app is configured. Separately, a provider payload above 64 KB would be rejected with a body-limit error that looks nothing like a signature failure.

**OWNER DECISION — RESOLVED 2026-09-25 (D6 = C), in part.** The owner decided the **failure behaviour**: a message that fails its signature or cannot be read is **rejected outright and not retried** (4xx); a failure in **our own** processing returns 5xx so the provider retries. The handler must classify the two correctly — misclassifying our fault as theirs loses a payment confirmation, which is then recoverable only through the re-check path (**C2**, still open).

**Left to the developers** as engineering detail, per the owner's instruction: how the raw `Buffer` is preserved, what body limit the webhook route carries, and where in the pipeline the signature is verified. The D5 = B decision makes a scoped content-type parser and a scoped `bodyLimit` the natural shape, since the webhook pipeline is already separate.

**Non-negotiable regardless:** the raw buffer is never re-serialised before verification — a JSON round trip changes bytes and breaks every provider's signature; the comparison is constant-time; the raw body is never logged; and the provider's signature header joins the pino redaction list (`app.module.ts:41`) once **O13** names it.

### C5 — OD-7 prefers normalized events; B18 specifies a raw payload

**DECISION.** OD-7: "Prefer normalized provider event data where raw payload retention is not necessary."

**CONFLICTING REPOSITORY FACT.** B18 line 696 specifies `payment_events` as: `UNIQUE(provider, provider_event_id)`; **raw payload**; `processed_at`; append-only.

**IMPACT.** A deliberate deviation from the written specification. Not a defect — OD-7's reasoning (these rows can never be deleted by `hv_app`, so anything sensitive in them is permanent) is sound, and ADR-0028 set exactly this precedent for the outbox. But it must be recorded as a deviation rather than presented as compliance.

**OWNER DECISION — RESOLVED 2026-09-25 (D7 = B).** `payment_events` stores a **normalized event** (provider, event id, type, provider reference, amount, currency, status) as the working record, **plus the raw payload sealed** with `sealPayload`/`SecretBox` (already exported from `@hv/domain`), for dispute and reconciliation only, opened by an operator tool and never by a request handler.

This satisfies B18's intent — the raw bytes are retained — and OD-7's constraint: nothing sensitive sits in plaintext in a row the application cannot delete. It is a recorded deviation from B18's literal wording, and **needs an ADR written with the P6-3 slice**, following the Phase 5 pattern where ADR-0028 recorded the same reasoning for the outbox.

**Two sub-answers remain open** and are tracked in [§26](#26-remaining-open-decisions): how long sealed payloads are retained, and which role may open one (which overlaps **C7**). Neither blocks the P6-3 migration — the column exists either way.

### C6 — Gate 4 as written includes an instant-win credit, which is Phase 8

**CONFLICTING REPOSITORY FACT.** Critical gate 4 (`PROJECT_INITIALIZATION_REPORT.md:609`) reads: "The same webhook ×10 in parallel, plus out-of-order delivery → one payment transition, **one ticket sale and one credit**." Instant wins are **P8** (Gate 6), and there is no wallet until **P7**.

**IMPACT.** Phase 6 cannot literally satisfy the "one credit" clause. Claiming Gate 4 passed without saying so would overstate it.

**OWNER DECISION — RESOLVED 2026-09-25 (D8 = A).** Phase 6 satisfies Gate 4 as **"one payment transition and one ticket sale"**. The credit clause is **explicitly deferred to Gate 6 in P8** and must be recorded in `PROJECT_STATUS.md` when Phase 6 closes, so Phase 8 inherits it as a tracked obligation. Phase 6 must **not** claim that clause is satisfied.

P6-4 must leave a clean seam where the instant-win evaluation will sit, because B10 puts it inside the **same** finalization transaction.

### C7 — OD-5 needs a permission that does not exist

**DECISION.** OD-5: define who may invoke payment reconciliation.

**CONFLICTING REPOSITORY FACT.** `0006_rbac.sql` seeds `orders.read`, `refunds.create` (sensitive), `settlement.retry` (sensitive), `wallet.adjust`, `config.manage` and others. There is **no** payment-write or payment-reconcile permission. `refunds.create` already exists and already carries "Sensitive operation", which in this codebase means step-up MFA within `STEP_UP_WINDOW_MS` (`AccessGuard`).

**IMPACT.** Without a new permission, reconciliation would have to reuse an ill-fitting one, and RBAC is deny-by-default — a route with no policy is refused outright (`access.guard.ts`).

**OWNER DECISION — RESOLVED 2026-09-25 (D13 = B, D13a).** **Viewing** payment status and **acting on it** are separate authorities, and only the acting half is new.

|                                                           | Authority                | Permission                                                                      | Granted to                                                                | Sensitive             |
| --------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------- |
| **View** payment and reconciliation status                | existing                 | **`orders.read`** — no new permission                                           | `support`, `fulfilment`, `finance`, `admin`, `super_admin` (`0006:86-87`) | no                    |
| **Act** — re-check with the provider and apply the result | **new**                  | **`payments.reconcile`**                                                        | **`finance`, `admin`, `super_admin`**                                     | **yes — step-up MFA** |
| **Open a sealed provider payload**                        | **new, same permission** | **`payments.reconcile`** — **no separate payload-access permission in Phase 6** | as above                                                                  | **yes — step-up MFA** |

`support` and `fulfilment` keep read-only visibility through `orders.read` and cannot act. The code follows the established `noun.verb` pattern, and its description ends with "Sensitive operation." as `refunds.create`, `wallet.adjust`, `settlement.retry`, `markets.gate.manage` and `config.manage` all do.

**This also closes OD-7a's access half.** D7 = B stores provider payloads sealed; `payments.reconcile` is the authority for opening one, and every opening is audited. **The retention period remains open** — see [§26](#26-remaining-open-decisions).

The seed migration lands in P6-5; see [§17](#17-proposed-migrations).

### C8 — A reservation has no "sold" end state

**CONFLICTING REPOSITORY FACT.** `reservations_status_valid` permits only `'active'`, `'released'`, `'expired'` (`0009:55`), and `hv_reservations_guard` permits only `active → released | expired` (`0009:151-153`). `hv_end_reservation` refuses any other target (`0010`).

**IMPACT.** After finalization marks tickets `sold`, the reservation must still be ended, and the only words available are "released" or "expired" — both of which read, in reports and in support tooling, as _the customer did not buy_.

**Verified as safe either way:** calling `hv_end_reservation(id, 'released')` **after** the tickets are `sold` frees nothing (the `WHERE … status = 'reserved'` matches zero rows), so `freed = 0` and **no cap allowance is returned** — the NB-1 fix in `0010` makes this structural. The sold tickets keep counting against the entrant's cap, which is correct.

**OWNER DECISION — RESOLVED 2026-09-25 (D9 = A).** A sold reservation is closed as **`'released'`**. **No new reservation status, and no migration.** `reservations_status_valid`, `hv_reservations_guard` and `hv_end_reservation` are untouched, and Gates 1 and 2 are unaffected by this decision.

The vocabulary is misleading on its own, so finalization must carry a comment recording why "released" here means _this hold became a sale_, and the Phase 10 reporting work must not read a released hold as evidence that no purchase occurred — the purchase is recorded on `order_items`, which is immutable and permanent.

**Ordering constraint created by D10 = B** (see **C9**): finalization must mark the tickets `sold` **first**, while the reservation is still `active` and unexpired, and only then call `hv_end_reservation(id, 'released')`. Ending the reservation first would make the sale fail, because D10 = B adds a database rule requiring the reservation to be live at the moment of sale.

### C9 — The database will sell tickets from an expired reservation

**CONFLICTING REPOSITORY FACT.** `hv_tickets_guard` permits `reserved → sold` whenever `NEW.reservation_id = OLD.reservation_id` (`0009:186`). Its liveness check — reservation `status = 'active' AND expires_at > now()` (`0009:192-194`) — fires **only** when `NEW.status = 'reserved'`. It does not apply to a sale.

**IMPACT.** In the window between a reservation's `expires_at` and the sweep that collects it (up to 30 seconds, `EXPIRE_INTERVAL_MS`), the database will happily let finalization sell those tickets. The schema does **not** backstop this.

**Implementation invariant, never in question.** **Finalization must itself check `status = 'active' AND expires_at > now()` on every reservation, under `FOR UPDATE`, inside the finalizing transaction** (invariant **I9**, [§5](#5-architectural-invariants)). It is the single most important line of the phase.

**OWNER DECISION — RESOLVED 2026-09-25 (D10 = B).** The database **also** refuses it, independently. `hv_tickets_guard` is extended so `reserved → sold` additionally requires the reservation to be `active` with `expires_at > now()`, making the unsafe sale impossible regardless of which code path attempts it — including raw SQL.

Accepted costs: this replaces a trigger on the hot path of **every** ticket allocation, and it is covered by Gates 1 and 2, so **both gates are re-run** in the slice that makes the change. The guard must not forbid a legitimate sale at the boundary instant — `now()` is `transaction_timestamp()`, so the guard and finalization evaluate the same moment within one transaction.

This also creates the ordering constraint recorded under **C8**: sell first, end the reservation second.

### C10 — B10's re-allocation path is structurally impossible ⛔ BLOCKER for OD-3

**CONFLICTING REPOSITORY FACT.** B10's late-payment rule reads: "If the draw is still live and tickets are available, **re-allocate**. Otherwise the order goes to `paid_unfulfillable`…".

Re-allocation would have to point the order at a different reservation. `0016_orders.sql` makes that impossible three times over:

- `hv_order_items_guard` raises on **any** UPDATE of `order_items` — "an order line is fixed when the order is placed";
- `REVOKE UPDATE, DELETE, TRUNCATE ON order_items FROM hv_app`;
- `order_items_order_draw_key UNIQUE (order_id, draw_id)` forbids inserting a _second_ line for the same draw, and `order_items_reservation_key UNIQUE (reservation_id)` forbids reusing a reservation.

**IMPACT.** The spec's preferred branch cannot be implemented on the Phase 5 schema without a migration that deliberately weakens order-line immutability — a protection introduced on purpose and reviewed twice.

This is **not** a defect. OD-3's instruction — "do not invent tickets… use the existing `paid_unfulfillable` state… create the required refund/recovery path" — is exactly what the schema permits, and the schema is the stronger position.

**OWNER DECISION — RESOLVED 2026-09-25 (D14 = A).** **Phase 6 implements only the `paid_unfulfillable` + refund branch. Order tickets are never re-allocated.**

The deviation from B10's re-allocation branch is deliberate and must be recorded in an **ADR written with P6-6**, giving the reason: order-line immutability is the stronger position, and the schema enforces it three ways (`hv_order_items_guard`, the `hv_app` revokes, and `UNIQUE (order_id, draw_id)`).

If re-allocation is ever wanted, it needs its own ADR and its own migration, and must not be smuggled into Phase 6.

**Related, and still open:** the specification's refund path also assumes tickets can be voided, but `tickets_status_valid` admits only `'available'`, `'reserved'`, `'sold'` — there is no `'void'`. That does not affect Phase 6, which only ever refunds orders whose tickets were never sold, but **O7**'s wider answer must account for it.

### C11 — `orders` has no status-transition trigger (advisory, not blocking)

**CONFLICTING REPOSITORY FACT.** `reservations` and `tickets` both carry guard triggers enforcing their state machines in the database. `hv_orders_guard` freezes the order's _snapshot_ but deliberately says nothing about `status` — so at the database level an order may move from any status to any other, including `paid → awaiting_payment`.

**IMPACT.** Phase 5 was safe because it only ever wrote one value. Phase 6 introduces every transition, and the B7 state machine would be enforced by **application code alone** — the only invariant in this system that is.

**OWNER DECISION — RESOLVED 2026-09-25 (D4 = C).** **Both.** The application owns the intent and performs the conditional `UPDATE … WHERE status = <expected>`, giving domain-shaped errors; the database backs it with `hv_orders_status_guard`, permitting exactly the B7 transitions and refusing everything else. An order can then not be un-sold by a future bug, a support script or a mistaken query, whatever wrote it.

This matches how `draws` (`0008:198`), `reservations` (`0009:153`) and `tickets` (`0009:189`) are already protected, and removes the one state machine in the system that would otherwise have had no database backing.

**Consequences accepted:** each later phase that adds a transition extends the guard — **P7** (wallet-only `created → paid`) and **P10** (`partially_refunded`, `paid → refunded`) — and the two places must be kept in step. A raised transition constraint is mapped to a domain error rather than surfacing as a 500, following the existing `mapRefusal` pattern.

**Neither half replaces the lock.** Concurrency safety still comes from `SELECT … FOR UPDATE` on the order plus the conditional update; a second concurrent webhook matching zero rows means "already settled", not an error.

---

## 3b. Owner decisions recorded

**Approved by the owner on 2026-09-25.** These are **LOCKED**: implement as written. Changing one needs a new owner decision. Questions and options are as put in [PHASE_6_DECISION_BRIEF.md](PHASE_6_DECISION_BRIEF.md); the identifiers `D1`–`D10` are the questionnaire's.

| ID      | Decision                                  | Answer                                                                           | Resolves             |
| ------- | ----------------------------------------- | -------------------------------------------------------------------------------- | -------------------- |
| **D1**  | Payment window vs reservation TTL         | **B** — the payment deadline is set to end before the ticket hold expires        | C1                   |
| **D1a** | Safety margin                             | **90 seconds**                                                                   | C1                   |
| **D1b** | Minimum remaining window                  | **180 seconds**; payment initiation is refused below it                          | C1                   |
| **D2**  | Routine late-payment refunds              | **B** — not acceptable as a normal outcome                                       | C1                   |
| **D3**  | Concurrent payment attempts               | **B** — one live attempt at a time                                               | OD-4a                |
| **D3a** | Attempt timeout                           | **120 seconds**, fixed                                                           | OD-4a                |
| **D3b** | Repeated "Pay" action                     | **A** — return the customer to the existing payment page                         | OD-4a                |
| **D4**  | Order status transitions                  | **C** — enforced in both the application and the database                        | C11                  |
| **D5**  | Webhook request handling                  | **B** — a separate webhook pipeline inside the same app                          | C3                   |
| **D6**  | Invalid or unverifiable provider messages | **C** — reject provider-invalid messages; retry only our own processing failures | C4 (in part)         |
| **D7**  | Raw provider payloads                     | **B** — normalized facts plus the encrypted original                             | C5 / OD-7a (in part) |
| **D8**  | Gate 4 scope                              | **A** — payment and ticket finalization; prize-credit deferred to Phase 8        | C6                   |
| **D9**  | Reservation after a completed sale        | **A** — closed as `'released'`; no new status, no migration                      | C8                   |
| **D10** | Expired-hold backstop                     | **B** — the database independently refuses finalization against an expired hold  | C9                   |

**Second batch, approved 2026-09-25:**

| ID       | Decision                               | Answer                                                                                              | Resolves          |
| -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------- |
| **D11**  | Protecting a hold during payment       | **A** — predicate inside `hv_expire_reservations` · **superseded in effect by D11a**                | C2, database half |
| **D11a** | The predicate cannot fire under D1 = B | **B** — **no migration.** `hv_expire_reservations` is unchanged; the dependency is recorded instead | C2, database half |
| **D12**  | Ambiguous payment status               | **A** — a scheduled background reconciler asks the provider                                         | C2, provider half |
| **D13**  | Reconciliation permission              | **B** — viewing payment status and acting on it are separate authorities                            | C7                |
| **D14**  | Re-allocation after late payment       | **A** — `paid_unfulfillable` + refund; **never** re-allocate                                        | C10               |
| **D15**  | Refund policy scope                    | **A** — decide only the Phase 6 automatic-refund slice; defer the rest                              | O7                |
| **D16**  | Unfulfillable notification             | **C** — one when the order becomes unfulfillable, one when the refund completes                     | OD-6a             |
| **D17**  | Payment configuration writes           | **A** — existing `config.manage`, sensitive, step-up MFA                                            | O9                |
| **D18**  | Guest return link scope                | **B** — payment/order status **plus order detail**; **cannot initiate payment**                     | OD-2a, scope      |
| **D19**  | Guest return link lifetime             | **A** — tied to the payment deadline plus a defined short tail                                      | OD-2a, lifetime   |
| **D20**  | Production provider                    | **C** — keep open; gather and document the characteristics we need                                  | O13               |

**Remaining values, approved 2026-09-25:**

| ID                   | Value                                                                                                                                                                                                                                                       | Resolves              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **D12a**             | Reconciler runs every **60 seconds**, lookback **5 minutes**, repeatable and idempotent                                                                                                                                                                     | C2, provider half     |
| **D13a**             | Viewing reuses **`orders.read`**; new sensitive permission **`payments.reconcile`** granted to **finance, admin, super_admin**; acting endpoints require MFA; `payments.reconcile` is also the authority for opening sealed payloads                        | C7, OD-7a access half |
| **D15a**             | An automatic unfulfillable refund goes to the **original payment instrument** — never wallet, never elsewhere                                                                                                                                               | O7, Phase 6 slice     |
| **D15b**             | **`refunds.actor_id` is nullable**; NULL means system-generated with no human actor; staff-initiated refunds keep the actor relationship                                                                                                                    | O7, Phase 6 slice     |
| **D16a**             | Phase 6 topic **`order.unfulfillable`**; it may say the order could not be fulfilled, identify it, say the tickets will not be delivered, and say a refund **has been initiated** — **never** that it completed. **No Phase 6 refund-completion consumer.** | OD-6a                 |
| **D16b**             | **All four order-outcome topics under `order.*`** — `order.paid`, `order.payment_failed`, `order.expired`, `order.unfulfillable`. No aliases, no dual names                                                                                                 | D16a naming           |
| **D12a** (confirmed) | Interpretation confirmed: every **60 s**, examining payments whose **last state change** falls within the previous **5 minutes**; older cases go to the operator endpoint                                                                                   | C2, provider half     |
| **OD-7a**            | Encrypted provider payloads retained **90 days**, then removed by the operator/retention process. Never exposed by ordinary order or customer APIs. Access stays with **`payments.reconcile`**                                                              | OD-7a, retention half |
| **D19a**             | Guest return-link tail = **30 minutes** after `orders.expires_at`; read-only, cannot initiate payment                                                                                                                                                       | OD-2a                 |

### D12a — interpretation **CONFIRMED 2026-09-25**

Settled as recorded:

- the reconciler runs **every 60 seconds**;
- it examines payments whose **last state change** occurred within the **previous 5 minutes**;
- **older cases are reachable through the operator reconciliation endpoint**, under `payments.reconcile`.

Coherent with the rest of the design: **D3a** times an attempt out at 120 seconds, so no attempt stays non-terminal longer than that, and a 5-minute window covers an attempt's entire life roughly twice over. The scheduled job handles the ordinary case; the operator endpoint exists for the rare payment that falls outside it, which is why D13a created the permission.

**One consequence to build against.** A payment unresolved for longer than 5 minutes will not resolve itself. Nothing is lost — the record is intact and the operator endpoint recovers it — but it needs a person, so it must be **visible**. P6-5 should surface unresolved payments somewhere an operator looks, rather than leaving them to be found through a customer complaint.

### The refund-completion topic — P10's, provisional

Recorded "only if the existing architecture requires the topic to be named now". **It does not.** A topic name is needed only when something emits or handles it, and Phase 6 does neither: the dispatcher fails an unregistered topic rather than dropping it (`outbox.service.ts:69`), so an unused name costs nothing and buys nothing. It is recorded in [§20](#20-notification-and-outbox-requirements--locked-od-6-d16--c) as **P10's contract, provisional and non-binding**, and Phase 6 neither emits nor registers it. **D16b's `order.*` standardisation covers the four Phase 6 order-outcome topics and does not bind this one**, which P10 names when it builds the consumer.

### D16b — topic namespace **RESOLVED 2026-09-25**

All four Phase 6 order-outcome topics are standardised under **`order.*`**:

```
order.paid              order becomes paid, tickets sold
order.payment_failed    an attempt fails definitively and no other is live
order.expired           the payment deadline passes with nothing succeeded
order.unfulfillable     payment succeeded but the tickets are gone
```

**No aliases, no dual names.** The earlier working name under the `payment.*` prefix is withdrawn: it survives nowhere in this document, and no implementation may accept both. All four names satisfy `outbox_topic_format`, `^[a-z][a-z_]*(\.[a-z][a-z_]*)+$` (`0011:50`).

The namespace reads correctly: each of the four states an outcome **of the order**, which is the aggregate being finalized (OD-4). A payment attempt is a means to that outcome and never the subject of a customer notification.

**One name deliberately outside this set:** the refund-completion topic, recorded below as P10's provisional contract. It is a refund outcome rather than an order outcome, Phase 6 neither emits nor registers it, and P10 owns its final name — so it is not standardised here and creates no dual-naming obligation.

### D11 + D1 = B — the predicate cannot fire · **resolved as D11a = B**

**Finding, reported rather than implemented.** C2's options were written before D1 was answered. With **D1 = B**, the protection D11 = A asks for is **provably non-binding**.

```
orders.expires_at = min(created_at + 600s, min(reservation.expires_at) − 90s)
                  ≤ reservation.expires_at − 90s        ← true for BOTH terms, always

sweep releases when   reservation.expires_at ≤ now()
predicate would skip when   order is awaiting_payment AND now() < orders.expires_at
                        ⇒   now() < reservation.expires_at − 90s
                        ⇒   reservation.expires_at > now() + 90s
                        ⇒   the hold is NOT due for sweeping anyway
```

A hold whose order is inside its payment deadline is never due, so the predicate can never change an outcome. The 90-second margin is already doing this job, by arithmetic rather than by a guard.

**Extending it past the hold's own expiry would not help either**, and would conflict with an already-locked decision: `hv_tickets_guard` under **D10 = B** refuses `reserved → sold` unless `expires_at > now()`. A hold kept `active` past its expiry by a sweep predicate still could not be sold. Making it sellable would mean reopening D10.

**OWNER DECISION — RESOLVED 2026-09-25 (D11a = B). No expiry-safety migration is created.** `hv_expire_reservations` is left exactly as `0009` defines it. The dependency is recorded instead, below and in code.

### The recorded dependency — LOCKED

**Why `hv_expire_reservations` needs no payment-specific predicate under the current architecture:**

1. **D1's payment deadline must remain strictly before reservation expiry.** `orders.expires_at = min(created_at + 600s, min(reservation.expires_at) − 90s)`, and both terms are `≤ reservation.expires_at − 90s`. This is the load-bearing property. **If it ever stops holding, this analysis stops holding with it.**
2. **The 90-second margin is what prevents a payable order from reaching reservation expiry.** While an order is inside its deadline, its holds are more than 90 seconds from expiring, so the sweep never becomes due for them. The protection is arithmetic, not a guard.
3. **D10's database ticket guard independently prevents finalization against an expired hold.** `hv_tickets_guard` refuses `reserved → sold` unless the reservation is `active` with `expires_at > now()`, whatever the sweep did or did not do, and whatever code attempts the sale.
4. **Therefore `hv_expire_reservations` does not need a new payment-specific predicate.** Adding one would produce a branch that can never be taken, in a function covered by Gates 1 and 2.
5. **If D1, or the payment-to-hold relationship, is changed in a future phase, this dependency must be re-evaluated.** A flat payment window, an extended hold, a changed margin, or any relaxation of D10 each make the predicate load-bearing again.

**Where this must be recorded in code** — to be done inside a Phase 6 slice, not now:

- **`apps/worker/src/tickets/reservation-expiry.ts`** — its header currently reads _"Phase 6 adds the B9 safety rule: a trusted provider status check before expiring a reservation whose order has a pending payment."_ **That is now false and must be corrected**, replaced with the five points above. Leaving it would leave a documented obligation that Phase 6 deliberately does not meet.
- **`apps/api/src/tickets/tickets.repository.ts:180`** — the second call site. A short note pointing at the same reasoning, so a future reader changing one path sees the dependency from either.
- **The function itself cannot be commented in place.** `hv_expire_reservations` is defined in `0009`, and applied migrations are never edited (DEVELOPMENT_RULES §3). A `COMMENT ON FUNCTION hv_expire_reservations(uuid, integer)` carrying the same reasoning could ride along in whichever Phase 6 migration lands — a one-statement addition, not a new migration of its own. Whether to include it is left to the slice; the two TypeScript comments are required either way.

**D12 = A is unaffected.** The scheduled reconciler is the provider half of C2 and proceeds as decided.

### D1a/D1b vs the test suite — engineering consequence, recorded

With a 90-second margin and a 180-second floor, **payment initiation is impossible for any reservation TTL below 270 seconds**. The existing suite deliberately runs short TTLs — `RESERVATION_TTL_SECONDS: '2'` in `cart.int.test.ts:487` and `'2'`/`'6'` in `reservations.int.test.ts:310-315`, and `60` in `playwright.config.ts:18`.

The margin and the floor must therefore be **configurable**, like `RESERVATION_TTL_SECONDS` itself, and production-pinned in the same way (`env.ts:105` is the pattern). This is an engineering consequence of D1a/D1b, not a new decision, but it belongs in the P6-2 env schema and would be discovered painfully otherwise.

### What the second batch and its values settle

- **D12 = A / D12a** makes the reconciler load-bearing rather than a safety net, because **D3 = B** means a stuck attempt blocks the customer's retry. It runs **every 60 s with a 5-minute lookback**, idempotent and safe to overlap.
- **D13 = B / D13a** separates viewing from acting: viewing reuses the existing **`orders.read`**, and only the acting half is new — **`payments.reconcile`**, sensitive, granted to finance, admin and super_admin. It is also the authority for opening sealed payloads, so **no separate payload permission exists**.
- **D14 = A** confirms the deviation from B10's re-allocation branch. **ADR needed at P6-6.**
- **D15 = A / D15a / D15b** scope the refund answer to Phase 6: an automatic unfulfillable refund goes to the **original payment instrument**, and **`refunds.actor_id` is nullable**, NULL meaning system-generated.
- **D16 = C / D16a** define two notifications. Phase 6 **emits `order.unfulfillable`**, which may say a refund was **initiated** and never that it completed. The refund-completion message belongs to **P10**, and Phase 6 builds no consumer for it — an unregistered topic fails the event by design (`outbox.service.ts:69`), so nothing may emit it early.
- **D17 = A** puts payment configuration under `config.manage`, granted to **`super_admin` only** (`0006:106`) and sensitive, requiring step-up MFA.
- **D18 = B / D19 = A / D19a** settle the return link: status **plus order detail**, read-only, expiring **30 minutes** after `orders.expires_at`.
- **D20 = C** keeps O13 open and adds a deliverable: document the provider characteristics we need. The list is in [§26](#26-remaining-open-decisions).

**Net result: every Phase 6 slice is unblocked**, and Phase 6 adds eight migrations, `0019`–`0026`.

### The payment window, derived — LOCKED

D1 = B defines the deadline as the earlier of the configured window and the hold's expiry minus the margin. With the hold capped at 600 s from its own creation (`reservations_ttl_valid`), and the order always created after that:

```
T0                         customer reserves; hold expires at T0+600 (hard DB ceiling)
T0 + d                     order created (d = the customer's own browsing/checkout time)
orders.expires_at        = (T0 + 600) − 90          ← the margin term ALWAYS binds
                         = T0 + 510
initiation refused when  (orders.expires_at − now()) < 180
                         ⇒ the customer must reach payment by T0 + 330 (5 min 30 s)
```

**The configured window never binds.** Because `d > 0`, the term `order_created + WINDOW` is always later than `hold_expiry − MARGIN` for any window of 600 s. The effective deadline is therefore **hold expiry minus 90 seconds**, and the window value exists only as an upper bound that a future shorter setting could bring into play. This is stated explicitly so nobody implements a second clock that does nothing.

**What the 90-second margin buys.** It is exactly how much provider lag is absorbed. A customer who pays one second before their deadline is served if the provider confirms within 90 seconds. Beyond that the hold is gone and the order becomes `paid_unfulfillable`. For scale, the expiry sweep runs every 30 s (`EXPIRE_INTERVAL_MS`), so the margin covers roughly three sweep cycles plus finalization.

**What the 180-second floor costs.** A customer who has not reached the payment page within 5 minutes 30 seconds of reserving is refused and must rebuild their basket. This is the price of D2 = B, and it is a **visible product behaviour**, not an internal detail — P6-8 must present it clearly and early, not as a failure at the payment step.

**D2 = B is satisfied, but not absolutely.** Inside the window, tickets are guaranteed by construction. What remains is provider lag beyond 90 seconds and genuinely lost confirmations. These are rare but real, so **the `paid_unfulfillable` path and the refund skeleton are still required** — D2 = B changes their frequency, not their necessity.

### One live attempt, derived — LOCKED

D3 = B with a 120-second attempt timeout, inside a window of at most 510 s (and at least 180 s by the floor):

- A customer with a full window has time for roughly three attempts; a customer at the floor has time for one, with the remainder truncated.
- **The order deadline always wins over the attempt timeout.** An attempt may never extend past `orders.expires_at`, and one starting within 120 s of the deadline is cut short by it.
- D3b = A: a repeated "Pay" action returns the customer to the **existing** attempt rather than creating a second or refusing. Only once the current attempt is terminal — succeeded, failed, or timed out at 120 s — may a new one be created.
- **This makes the re-check path load-bearing.** With one live attempt, a payment stuck awaiting a provider blocks the retry until it times out. The 120-second timeout bounds that, but **C2 / D12** (whether we actively ask the provider what happened) moves from a safety net to part of the ordinary path, and is still open.

### What these decisions did **not** change

- `reservations_ttl_valid` and `hv_reservations_guard` — untouched. A hold still cannot exceed or extend beyond 10 minutes.
- **ADR-0024** (settlement grace = close + 10 min + 2 min) — **intact**. Options C and D of C1 would have required amending it; they were not taken.
- The **D11 production pin** of `RESERVATION_TTL_SECONDS = 600` — intact.
- `hv_end_reservation` — untouched (D9 = A).
- Gates 1 and 2 — unaffected by D1, D9 and D4; **re-run** because of D10 = B, which replaces `hv_tickets_guard`.

### ADRs these decisions will need

Following the Phase 5 convention — ADRs 0028–0032 were each written **with the slice that implemented them**, not ahead of it — no ADR is written now. The following are expected, at their slice:

| Decision                         | ADR needed          | Why                                                                                               | Slice       |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------- | ----------- |
| **D7 = B**                       | yes                 | Deviation from B18's literal "raw payload"; mirrors ADR-0028's reasoning                          | P6-3        |
| **D1 = B**                       | yes                 | Introduces an order payment deadline as a distinct clock, which the specification does not define | P6-2        |
| **D4 = C**, **D10 = B**          | likely one combined | Both extend database-enforced state machines; ADR-0011 amendment territory                        | P6-2 / P6-4 |
| **C10** (when answered)          | yes                 | A recorded deviation from B10's re-allocation branch                                              | P6-6        |
| D2, D3, D3a, D3b, D5, D6, D8, D9 | no                  | Operational and configuration choices, recorded here and in code comments                         | —           |

Next free ADR number: **0033**.

---

## 4. Locked decisions

### OD-1 — Payment window **LOCKED — C1 resolved 2026-09-25 (D1 = B)**

- The order carries its **own authoritative, immutable payment deadline**. **LOCKED**
- The deadline is **not** `RESERVATION_TTL_SECONDS` and must not be derived from it by accident. **LOCKED**
- Configured window **600 seconds**. **LOCKED** — note that under D1 = B this value never binds; see [§3b](#3b-owner-decisions-recorded).
- **The deadline is the earlier of the configured window and the hold's expiry minus a 90-second margin**, which in practice is always the latter: `orders.expires_at = min(created_at + 600s, min(reservation.expires_at) − 90s)`. **LOCKED (D1 = B, D1a)**
- **Payment initiation is refused when fewer than 180 seconds remain** before the deadline. **LOCKED (D1b)**
- Immutable once written — enforced by adding the column to the `hv_orders_guard` frozen set. **LOCKED**

**The three clocks, defined explicitly** (OD-1 requires this and forbids treating them as interchangeable):

| Clock                                                              | Owner                               | Authority                                        | Enforced by                                                                              |
| ------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Reservation expiry** `reservations.expires_at`                   | the hold on specific ticket numbers | decides whether **inventory** is still ours      | `reservations_ttl_valid`; swept by `hv_expire_reservations`                              |
| **Order payment deadline** `orders.expires_at` (**PROPOSED** name) | the order                           | decides whether the customer may still **pay**   | new CHECK + guard; checked in-transaction at finalization                                |
| **Payment attempt expiry**                                         | one attempt at one provider         | decides whether **this attempt** is still usable | **120 s, fixed (D3a)**, never extending past `orders.expires_at`; mirrored on `payments` |

**Relationships — LOCKED:**

1. The three are **independent**. None is read as a proxy for another.
2. **Inventory is decided only by the reservation.** A live payment deadline never entitles a customer to tickets the reservation no longer holds.
3. **Payability is decided only by the order deadline.** A live reservation does not extend the right to pay.
4. A payment confirmed while the order deadline is open **but the reservation is gone** is a **late payment** → OD-3.
5. A payment attempt expiring does **not** expire the order. A new attempt may be created while the order deadline is open (OD-4).
6. The order deadline passing does not by itself make the order `expired`; a transition must be applied, conditionally, by a job.
7. **The reservation always outlives the payment deadline by 90 seconds** (D1 = B). Relationship 2 therefore holds by construction inside the window, and a late payment can now arise only from provider lag beyond the margin or a lost confirmation — not from the clocks disagreeing. **LOCKED**

**Outstanding:** none. C1 is resolved; see [§3b](#3b-owner-decisions-recorded) for the derived arithmetic.

### OD-2 — Guest order access **LOCKED**

- The 30-minute verified-email binding is **not** extended. `GUEST_VERIFIED_EMAIL_TTL_MINUTES` stays at 30. **LOCKED**
- A guest **must** be able to return from the provider and see the state of their own order after that binding has lapsed. **LOCKED**
- The mechanism must not authenticate the guest as a customer, must not mutate the verified-email binding, must not expose arbitrary orders, must not depend on the browser staying on the checkout page, and must not weaken authenticated authorization. **LOCKED**

**Mechanism — an opaque order access token. LOCKED in scope and lifetime shape (D18 = B, D19 = A).** The repository already contains this pattern twice, so nothing is invented:

| Property           | Value                                                                                                                                                   | Precedent                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Form               | opaque random token, given once to the client                                                                                                           | `guest_sessions.token` (ADR-0029)                                                       |
| Storage            | **SHA-256 only**, `bytea` with `CHECK (octet_length(token_hash) = 32)`, `UNIQUE`                                                                        | `guest_sessions_token_hash_sha256` (`0012:42`)                                          |
| Scope              | **exactly one order** — the token is bound to `order_id`, nothing else                                                                                  | new                                                                                     |
| Grants             | **read-only: payment and order status, plus the order's detail** (draws, quantities, amounts), and the right to trigger a trusted provider status check | **D18 = B**; B10: "the return page may _trigger_ a check but never marks anything paid" |
| **Does not** grant | **initiating a payment**, any session, any cap identity, any basket, any other order, any mutation of order state                                       | **D18 = B**, OD-2                                                                       |
| Lifetime           | **`orders.expires_at` + 30 minutes**                                                                                                                    | **D19 = A, D19a**                                                                       |
| Delivery           | in the provider **return URL**, so the browser need not have stayed anywhere                                                                            | OD-2                                                                                    |
| Revocation         | `revoked_at`, mirroring `guest_sessions`                                                                                                                | `0012`                                                                                  |

Because it is per-order and read-only, it satisfies "must not expose arbitrary orders" structurally rather than by a check. Because it is a separate credential, it touches neither `guest_sessions.verified_email` nor the authenticated path.

**D18 = B has a consequence worth stating plainly.** The link carries order detail, so anyone holding it can see what that person bought. It will sit in browser history and in the provider's stored return URL. Two mitigations are available in the repository and should be used: the API already sends `referrer-policy: no-referrer` (`app.ts:66`), and the return page can exchange the URL token for a cookie and redirect to a clean URL. Presentation must also be rate-limited — `RATE_LIMITS` is the established place, and `verificationCodePerIp` (20/60m) is the nearest precedent.

**D18 = B also means a failed payment cannot be retried from the link.** A guest whose first attempt failed and whose 30-minute email proof has lapsed can see _that_ it failed, but must verify again to try once more. That is the deliberate trade in choosing B over C.

**Why `getOrder` must change.** `CheckoutService.getOrder` resolves the caller through `buyerOf`, which throws `VERIFICATION_REQUIRED` once the 30-minute window lapses (`checkout.service.ts:384-389`). Phase 6 adds a **second, parallel** authorization route — token-scoped read — without altering `buyerOf`, so the authenticated and freshly-verified-guest paths behave exactly as they do today.

**LOCKED (D19a): the tail is 30 minutes** after `orders.expires_at`. The link is **read-only and cannot initiate a payment** (D18 = B).

Worked through: a hold is created at T₀ and the deadline lands at T₀+510 at the latest, so a link dies by roughly **T₀ + 38 minutes**. That comfortably covers a customer returning late from a provider and seeing the outcome, including a `paid_unfulfillable` order and the notice that a refund has been initiated — the refund record is raised in the finalizing transaction, so it exists before the customer can look.

The 30 minutes is arithmetically equal to `GUEST_VERIFIED_EMAIL_TTL_MINUTES`, and that is a coincidence, not a dependency. The two must not be derived from one value: changing the email-proof window must not silently change how long a return link works.

**Settled by D3 = B:** one token per order, not per attempt. With only one live attempt at a time, a per-attempt token would add nothing.

### OD-3 — Payment success after reservation loss **LOCKED**

- A successful provider payment must **never** silently create an invalid sold order. **LOCKED**
- Finalization verifies reservation and ticket eligibility **atomically**. **LOCKED**
- If fulfilment is no longer possible: do not invent tickets; do not mark the order fulfilled; move it to the existing **`paid_unfulfillable`**; raise the refund/recovery path; keep it idempotent; keep a complete audit trail. **LOCKED**
- **No new order status.** The audit confirms the existing nine are sufficient. **LOCKED**
- **Re-allocation is NOT implemented in Phase 6** — see **C10**, pending owner confirmation. **LOCKED, subject to C10**

### OD-4 — Multiple payment attempts **LOCKED — OD-4a resolved 2026-09-25 (D3 = B)**

- An order **may** have several payment attempts, but **only one live at a time**. **LOCKED (D3 = B)**
- An attempt becomes terminal after **120 seconds** if the provider has not answered, and **never outlives `orders.expires_at`**. **LOCKED (D3a)**
- A repeated "Pay" action **returns the customer to the existing attempt**; it neither creates a second nor refuses. **LOCKED (D3b)**
- Each attempt has its own identity, its own provider reference and its own idempotency data. **LOCKED**
- Attempts are **immutable historical records** except for controlled status fields. **LOCKED**
- **Only one successful payment may finalize an order.** **LOCKED**
- Duplicate successful webhooks are idempotent; later attempts never create a second paid order; concurrent attempts are handled safely. **LOCKED**
- **The order remains the aggregate being finalized.** **LOCKED**

**PROPOSED enforcement — structural, not procedural:**

- `UNIQUE (provider, provider_reference)` — B18; every attempt is distinct.
- A **partial unique index** `ON payments (order_id) WHERE status = 'succeeded'` — the database, not the application, guarantees "at most one successful payment per order". This is the single most valuable constraint in the phase: it makes I11 unbreakable even by a bug.
- A **partial unique index** `ON payments (order_id) WHERE status IN ('pending', 'processing')` — at most one _live_ attempt, so a customer cannot open several provider sessions at once. **LOCKED (D3 = B)**: this index is required, and it is what makes "one live attempt" structural rather than a check the application could forget.

**Consequence of D3 = B, recorded so it is not lost:** a payment stuck awaiting a provider blocks the customer's retry until the 120-second timeout fires. The timeout bounds it, but the re-check path (**C2**, still open) moves from a safety net to part of the ordinary path.

### OD-5 — Stuck payment confirmation **LOCKED**

- Phase 6 provides a **safe, idempotent** way to re-check and reconcile a payment whose provider result is ambiguous or whose webhook processing was interrupted. **LOCKED**
- It must **never** require an operator to edit order or payment state in SQL. **LOCKED**

| Question                     | Answer                                                                                                                                                                                                                                         | Status                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Who may invoke it**        | a **scheduled background reconciler** (no actor), and an operator holding the acting authority                                                                                                                                                 | **LOCKED (D12 = A)**; the permission codes and grants are **D13a** |
| **Which provider operation** | `getPaymentStatus(providerReference)` — the B10 trusted status check. Never a webhook replay, never a client-supplied result                                                                                                                   | **LOCKED**                                                         |
| **Allowed transitions**      | only what `confirmPayment` already allows: `awaiting_payment → paid` (fulfillable), `awaiting_payment → paid_unfulfillable` (not fulfillable), `awaiting_payment → failed`. Reconciliation may **never** move an order out of a terminal state | **LOCKED**                                                         |
| **Idempotency**              | it calls the **same** `confirmPayment()` as the webhook path. Running it ten times has the effect of running it once                                                                                                                           | **LOCKED**                                                         |
| **Audit**                    | every invocation writes `audit_log` — actor (or `system`), action, `entity_type='order'`, `entity_id`, `market_id`, `before`/`after` status, `reason`, `request_id`. The columns all exist (`0007_audit_log.sql`)                              | **LOCKED**                                                         |

**LOCKED (D12 = A):** the reconciler is a BullMQ repeatable job in `apps/worker`, following `draw-lifecycle.service.ts` and `reservation-expiry.ts`. Both existing jobs are conditional-update-only and safe to run concurrently; the reconciler must be written the same way, and must never hold a row lock across the provider call — check status first, then open the transaction and apply the result conditionally.

**D3 = B raises its importance.** With one live attempt per order, a payment stuck awaiting a provider blocks the customer's retry until the 120-second timeout fires. The reconciler is therefore part of the ordinary path, not only a safety net for lost webhooks.

**LOCKED (D12a):** every **60 seconds**, **5-minute lookback**. See the OD-5 block in [§4](#4-locked-decisions) for how that meshes with the 120-second attempt timeout.

### OD-6 — Customer notifications **LOCKED**

- Phase 6 defines notification events for **payment success**, **payment failure/expiry** and **refund outcome**. **LOCKED**
- Notification delivery is **not** part of payment correctness. **LOCKED**
- Finalization succeeds even if email is delayed — guaranteed by writing the outbox row in the **same** transaction and delivering it afterwards (ADR-0028). **LOCKED**
- **No final email copy is written in Phase 6.** Per-market templates are P12. **LOCKED**

### OD-7 — Raw provider payloads **LOCKED**

- **Never stored:** card numbers, CVV, bank credentials, access tokens, secrets, or equivalent payment credentials. **LOCKED**
- Stored only what is needed for signature verification, event idempotency, reconciliation, audit and debugging. **LOCKED**
- Normalized event data is preferred where raw retention is not necessary. **LOCKED** — deviation from B18 recorded as **C5**
- If a raw payload is retained, document: exact reason · sensitive fields · protection/encryption · retention · access restrictions. **LOCKED**

**The five required disclosures, as answered by D7 = B and D13a:**

| Required disclosure | Answer                                                                                                                                                                                                                                                               | Status                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact reason        | provider disputes and reconciliation: proving what the provider actually sent, byte for byte                                                                                                                                                                         | **LOCKED (D7 = B)**                                                                                                                                                                              |
| Sensitive fields    | provider-dependent — typically billing name, email, address, and card **metadata** (brand, last four, country). **Never a PAN or CVV**, which never reach our servers under SAQ-A                                                                                    | **LOCKED**; the exact list awaits **O13**                                                                                                                                                        |
| Protection          | sealed with `sealPayload` / `SecretBox` (AES-256-GCM, key from `OUTBOX_ENCRYPTION_KEY`), exactly as ADR-0028 seals outbox payloads                                                                                                                                   | **LOCKED (D7 = B)**                                                                                                                                                                              |
| Retention           | **90 days**, then removed by the operator/retention process                                                                                                                                                                                                          | **LOCKED (OD-7a)**. `hv_app` has no `DELETE` on `payment_events`, so removal runs with elevated privilege as an operational process — **not** application code, and **not** a cascade or trigger |
| Access              | **`payments.reconcile`** — sensitive, step-up MFA, audited on every opening. **No separate payload-access permission in Phase 6.** Opened only by an operator tool: never in a request handler, **never exposed by an ordinary order or customer API**, never logged | **LOCKED (D13a, OD-7a)**                                                                                                                                                                         |

**What the 90 days applies to — precisely.** Only the **sealed payload column**. The `payment_events` **row** is not deleted: it carries `provider`, `provider_event_id`, `processed_at` and the normalized fields, and it is the **idempotency record** — `UNIQUE (provider, provider_event_id)` is what makes a replayed webhook a no-op (**I3**). Deleting rows would reopen replay protection for any event a provider re-sends after 90 days. So retention removes the **encrypted original**, leaving the row and its normalized facts intact.

Mechanically this means the sealed column is nullable and is cleared, not that rows are removed. The retention process is an operational task — a scheduled job under elevated privilege, or a documented operator procedure. **Building it is not Phase 6 work**; Phase 6 must only ensure the schema permits it and that nothing depends on the payload still being present after 90 days. Reconciliation and disputes beyond that window rely on the normalized record and the provider's own systems.

### OD-8 — Production provider **LOCKED**

- **No production provider is selected.** **LOCKED** (O13 remains open)
- Phase 6 implements a provider-agnostic port, a fake/test provider, and deterministic test behaviour. **LOCKED**
- **No provider name is hard-coded anywhere** — not in code, config, schema, migrations or tests. **LOCKED**
- The fake provider **must not be registrable in production**; a config guard refuses it (B10). **LOCKED**

**Repository agreement:** ADR-0006, B10 and D6 all say this already. `packages/payments` is the location the spec names (`PROJECT_INITIALIZATION_REPORT.md:638, 661`).

---

## 5. Architectural invariants

**All LOCKED.** Each is listed with how it is enforced, and whether the enforcement is structural (the database refuses it) or procedural (code must get it right). **Procedural invariants need a test that proves them; structural ones need a test that proves the structure is still there.**

| #       | Invariant                                                                      | Enforcement                                                                                                                        |
| ------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **I1**  | PostgreSQL is the source of truth                                              | structural — Redis is used only for rate limits and queues                                                                         |
| **I2**  | Provider webhooks are untrusted until verified                                 | procedural — signature check before any state is read                                                                              |
| **I3**  | Provider event IDs are idempotent                                              | **structural** — `UNIQUE (provider, provider_event_id)` + `ON CONFLICT DO NOTHING`                                                 |
| **I4**  | The payment amount comes from the authoritative order                          | procedural — read `orders.external_due_minor` in the same transaction                                                              |
| **I5**  | A client-submitted amount is never trusted                                     | structural — the request schema carries **no** amount field                                                                        |
| **I6**  | Payment currency equals order currency                                         | **structural** — composite FK `(market_id, currency) → markets` on `payments`                                                      |
| **I7**  | Order market and currency constraints stay authoritative                       | **structural** — composite FK `(order_id, market_id) → orders (id, market_id)`, reusing `orders_id_market_key`                     |
| **I8**  | Payment success alone cannot make an order sold                                | procedural — only `confirmPayment` sells, and only after I9                                                                        |
| **I9**  | Finalization atomically validates payment + order + reservation + ticket state | procedural — **one** transaction; reservation re-checked `active AND expires_at > now()` under `FOR UPDATE` (see **C9**)           |
| **I10** | A duplicate webhook never creates duplicate fulfilment                         | structural (I3) + procedural (conditional `UPDATE … WHERE status = 'awaiting_payment'`)                                            |
| **I11** | A duplicate successful payment never produces a second successful order        | **structural** — partial unique index on `payments (order_id) WHERE status='succeeded'`                                            |
| **I12** | Reservation entrant identity comes from the reservation itself                 | procedural — **ADR-0021**: the key may have been re-keyed `email → user` by `0017`. Never re-derive it from the buyer              |
| **I13** | Guest browser/session state is never required for webhook processing           | structural — the webhook route is `@Public()` with **no** `identify`, so no guest is resolved at all                               |
| **I14** | Outbox delivery is not part of the correctness transaction                     | structural — ADR-0028; the row is written in the transaction, delivered after commit                                               |
| **I15** | Provider credentials/secrets never appear in order or payment records          | structural — `market_payment_configs` holds only `config_ref`; secrets live in env                                                 |
| **I16** | Refunds are idempotent                                                         | **structural** — `refunds.idempotency_key UNIQUE` and `UNIQUE (provider, provider_refund_reference)`                               |
| **I17** | A failed payment never permanently consumes tickets                            | procedural — failure applies no ticket change; the reservation expires normally and `hv_end_reservation` returns the cap allowance |
| **I18** | A late or ambiguous provider event is handled deterministically and auditably  | procedural — the late-payment path (§10) plus an `audit_log` row for every outcome                                                 |

**Two additional invariants the audit proved necessary**, not in the instructed list:

| #       | Invariant                                                                                | Why                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **I19** | A ticket is never sold from a reservation that is not `active` with `expires_at > now()` | **both** — finalization checks it under `FOR UPDATE`, **and** `hv_tickets_guard` refuses it independently (**D10 = B**) |
| **I20** | The cap allowance is never returned for a sold ticket                                    | already structural — `0010`'s `GET DIAGNOSTICS` fix. Phase 6 must not undo it by ending reservations before selling     |

---

## 6. Payment lifecycle (order-level) — **PROPOSED**

```
                     Phase 5 ends here
                            │
                     awaiting_payment ───────────────────────────┐
                            │                                    │
              ┌─────────────┼─────────────┐                      │
              ▼             ▼             ▼                      ▼
        attempt #1     attempt #2     attempt #n          deadline passes,
        (OD-4)         (after #1      …                   nothing succeeded
                        failed)                                  │
              └─────────────┴─────────────┘                      ▼
                            │                                 expired
              confirmPayment() — one idempotent path
              (webhook OR trusted status check)
                            │
              ┌─────────────┴──────────────┐
              ▼                            ▼
       fulfillable?  yes              fulfillable?  no
       reservation active             reservation gone / draw closed
       AND not expired                         │
              │                                ▼
              ▼                        paid_unfulfillable
            paid                               │
       tickets → sold                      refund raised
       reservation ended                        │
       audit + outbox                           ▼
              │                             refunded
              ▼                          (completion: P10)
        (P7 wallet, P8 instant wins
         extend this same transaction)
```

**Transitions Phase 6 implements — LOCKED:**

| From                 | To                   | Trigger                                                         |
| -------------------- | -------------------- | --------------------------------------------------------------- |
| `awaiting_payment`   | `paid`               | confirmed payment, fulfilment possible                          |
| `awaiting_payment`   | `paid_unfulfillable` | confirmed payment, fulfilment impossible                        |
| `awaiting_payment`   | `failed`             | provider reports definitive failure                             |
| `awaiting_payment`   | `expired`            | payment deadline passed with no success                         |
| `paid_unfulfillable` | `refunded`           | refund completes — **P10**, [§11](#11-refund-skeleton-boundary) |

**Not implemented in Phase 6:** `created → *` (Phase 5 never writes `created`); `created → cancelled`; `paid → partially_refunded | refunded` (P10); wallet-only `created → paid` (P7).

**Terminal states are never reopened** (I10, **C11**).

---

## 7. Payment attempt lifecycle — **PROPOSED**

```
   (none) ──create──► pending ──provider accepts──► processing
                         │                              │
                         │                    ┌─────────┼──────────┐
                         │                    ▼         ▼          ▼
                         └──────────────► failed   succeeded   expired
                                             │         │
                                     new attempt   finalizes the order
                                     allowed       (at most one ever — I11)
                                     (OD-4)
```

- `pending` → the row exists, the provider has been asked.
- `processing` → the provider has a reference and the customer is with them.
- `succeeded` → terminal. **Exactly one per order**, structurally (I11).
- `failed` / `expired` → terminal for the attempt, **not** for the order (OD-4).

**One live attempt at a time — LOCKED (D3 = B).** At most one row may be `pending` or `processing` per order, enforced by a partial unique index. A new attempt is possible only once the current one is terminal.

**Timeout — LOCKED (D3a).** An attempt with no provider answer becomes `expired` after **120 seconds**, and never lives past `orders.expires_at`; an attempt started close to the deadline is cut short by it. The order's clock always wins.

**Repeated "Pay" — LOCKED (D3b = A).** While an attempt is live, asking to pay again **returns that attempt**. It does not create a second and does not refuse.

**Mutable fields only:** `status`, `updated_at`, `failure_code`, `failure_message`, `provider_reference` (set once, from null). Everything else is frozen by a guard trigger, matching `hv_orders_guard`.

**An attempt never sells a ticket.** Only `confirmPayment` on the **order** does (I8).

---

## 8. Webhook lifecycle — **PROPOSED**

```
POST /webhooks/payments/:provider
  │
  ├─ 0. CSRF origin hook must not reject this route  ⛔ C3
  ├─ 1. raw body preserved as Buffer                 ⛔ C4
  ├─ 2. resolve :provider → registered provider  (unknown → 404, no detail)
  ├─ 3. verifyWebhook(rawBody, headers)          (throws → generic 4xx, recorded)
  ├─ 4. INSERT payment_events … ON CONFLICT (provider, provider_event_id) DO NOTHING
  │        └─ 0 rows inserted ⇒ duplicate ⇒ 200 immediately, nothing else runs   [B10 step 2]
  ├─ 5. normalize the event; match provider_reference → payments row
  │        └─ no match ⇒ store, mark processed, 200  (never reveal that it is unknown)
  ├─ 6. confirmPayment()  — the finalization transaction (§9)
  ├─ 7. UPDATE payment_events SET processed_at = now()
  └─ 8. 200
       └─ processing error ⇒ 5xx so the provider retries, AND the stored event
          is retried by a job                                              [B10 step 4]
```

**LOCKED properties:**

| Property               | Value                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Authentication         | the **signature over the raw body** — nothing else                                    |
| Session / guest / CSRF | none; the route is `@Public()` **without** `identify` (I13)                           |
| Market scoping         | **none** — a provider does not know our markets. The market is derived from the order |
| Replay protection      | `UNIQUE (provider, provider_event_id)` (I3)                                           |
| Ordering               | never trusted. Outcomes are decided by conditional transitions, not arrival order     |
| Unknown event type     | stored, marked processed, ignored — never silently dropped                            |
| Failure response       | 5xx, so the provider retries                                                          |

**Ordering matrix — LOCKED expectations:**

| Case                                          | Outcome                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Same event twice                              | second insert conflicts → 200, no work                                                           |
| Two different success events, one order       | first finalizes; second matches 0 rows on the conditional update; I11 makes it impossible anyway |
| Failure then success                          | success wins **if** the order is still `awaiting_payment`                                        |
| Success then failure                          | **success is terminal** — a later failure is recorded and never un-sells                         |
| Success arrives after the order `expired`     | treated as a late payment → §10                                                                  |
| Success arrives after the reservation is gone | → `paid_unfulfillable` → §10                                                                     |

---

## 9. Finalization lifecycle — **PROPOSED**

The single most important transaction in the phase. B10 step 3, with Phase 6's scope.

```
BEGIN  (READ COMMITTED, as everywhere else in this codebase)

 1. SELECT … FROM orders WHERE id = $1 FOR UPDATE          -- lock the aggregate first
 2. IF order.status <> 'awaiting_payment'
       → already settled; commit and return the existing outcome.  IDEMPOTENT EXIT
 3. Verify the event against the ORDER, not the request:
       amount   = orders.external_due_minor      (I4)
       currency = orders.currency                (I6)
       → mismatch: do NOT finalize. Record, audit, alert.
 4. FOR EACH order_item, in a deterministic order:
       SELECT … FROM reservations WHERE id = $r FOR UPDATE
       REQUIRE status = 'active' AND expires_at > now()     (I9, I19 — see C9)
       → any failure ⇒ NOT FULFILLABLE: go to step 8.
 5. UPDATE tickets SET status='sold'                        -- SELL FIRST: D10's guard
        WHERE reservation_id = $r AND status='reserved'     --   requires a LIVE reservation
       REQUIRE rowcount = order_item.quantity               -- partial sale is impossible
 6. hv_end_reservation($r, 'released')                      -- THEN close the hold (D9 = A)
       -- frees 0 rows; cap stays consumed (C8, I20)
       -- the entrant key is read FROM THE RESERVATION, never re-derived      (I12, ADR-0021)
 7. UPDATE orders SET status='paid' WHERE id=$1 AND status='awaiting_payment'
    UPDATE payments SET status='succeeded' WHERE id=$2      -- I11 index backs this
    → go to step 9.

 8. NOT FULFILLABLE:
    UPDATE orders SET status='paid_unfulfillable' WHERE id=$1 AND status='awaiting_payment'
    UPDATE payments SET status='succeeded' WHERE id=$2
    INSERT refunds (…, idempotency_key = 'refund:order:<id>:unfulfillable')   (I16)
    -- no ticket is touched; no cap allowance is returned

 9. INSERT audit_log  (order.paid | order.paid_unfulfillable)
10. INSERT outbox     (§20)                                  (I14)
11. UPDATE payment_events SET processed_at = now()

COMMIT
```

**Lock ordering — LOCKED.** The established order in this codebase is **entrant counter → tickets** (P4 handoff; `hv_expire_reservations` iterates `ORDER BY entrant_type, entrant_ref, id` precisely for this). Finalization adds the order at the front:

> **`orders` → `reservations` → (entrant counter → tickets, inside `hv_end_reservation`)**

Every Phase 6 path that touches more than one of these takes them in this order, or it can deadlock against the expiry sweep.

**Must never happen partially — LOCKED:**

- an order `paid` whose tickets are not `sold`;
- tickets `sold` on an order that is not `paid` or `paid_unfulfillable`;
- either without the `audit_log` row;
- a partial sale — fewer tickets sold than the line's quantity;
- the outbox row committed without the state change, or vice versa.

**Step order is not stylistic — LOCKED (D9 = A + D10 = B).** Steps 5 and 6 may not be swapped. `hv_tickets_guard` now requires the reservation to be `active` and unexpired at the moment of sale, so closing the hold first would make the sale fail. Sell, then close.

**Idempotency.** Steps 2 and 7 are the guards. A second call finds the order out of `awaiting_payment` and exits without touching anything. Combined with I3 and I11, running finalization any number of times has the effect of running it once.

---

## 10. Late-payment behaviour — **PROPOSED**, per **LOCKED** OD-3

A **late payment** is a confirmation that arrives when the order can no longer be fulfilled: the reservation was swept, or its tickets are gone, or the draw has closed.

Because of **C1**, this will not be rare. Because of **C10**, there is exactly one branch:

| Step | Action                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Detected at step 4 of §9 — the reservation is not `active`, or is past `expires_at`                                                                                                   |
| 2    | The order goes to **`paid_unfulfillable`**. No new status is invented (OD-3)                                                                                                          |
| 3    | The payment is still recorded as `succeeded` — the customer really did pay, and pretending otherwise would lose money                                                                 |
| 4    | **No ticket is invented, allocated or re-allocated** (OD-3, **C10**)                                                                                                                  |
| 5    | A `refunds` row is raised with a derived `idempotency_key`, so raising it twice is impossible (I16)                                                                                   |
| 6    | `audit_log` records the full before/after and the reason                                                                                                                              |
| 7    | A `order.unfulfillable` outbox notification is written — **LOCKED (D16 = C, D16a)**. It says a refund has been **initiated**, never completed. The refund-completion message is P10's |
| 8    | Refund **execution** is P6-6's skeleton plus **O7**; refund **completion** and the admin UI are **P10**                                                                               |

**The customer's money is never silently kept, and a ticket is never silently invented.** Those two sentences are the whole rule.

---

## 11. Refund skeleton boundary

**In scope — LOCKED:**

- the `refunds` table exactly as B18 specifies it;
- `PaymentProvider.refund()` in the interface and in the fake provider;
- a refund **record** raised automatically by the late-payment path;
- idempotency: `idempotency_key UNIQUE` and `UNIQUE (provider, provider_refund_reference)` (I16);
- audit on creation.

**OUT OF SCOPE — LOCKED:**

- admin-initiated refunds and any refunds UI — **P10** (the `refunds.create` permission already exists in `0006_rbac.sql` and stays unused in Phase 6);
- refunds to **wallet** — **P7**. `destination` exists in the B18 shape; only the provider destination is exercised;
- partial refunds and `partially_refunded` — **P10**;
- refunds after close or settlement, and the fate of tickets and instant wins on a refunded order — **deferred by D15 = A** to P10, and dependent on the wider **O7** answer.

**The boundary in one line:** Phase 6 _raises_ refunds. Phase 10 _manages_ them.

**D15 = A's two values are now settled:**

| Ref      | Decision                                                                                                                                                                 | Consequence                                                                                                                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D15a** | An automatic unfulfillable refund goes to the **original payment instrument** — the provider payment that was taken. **Never wallet credit, never another destination.** | `destination = 'provider'`, and **`refunds.payment_id` must be set**, not left NULL: "the original instrument" is only meaningful by reference to the payment that took the money. B18 makes `payment_id` nullable for refunds that have no originating payment; an automatic unfulfillable refund is not one of those |
| **D15b** | **`refunds.actor_id` is nullable.** NULL means a system-generated refund with no human actor. Staff-initiated refunds keep the actor relationship.                       | Phase 6 writes **only** NULL-actor refunds, since nothing in Phase 6 is operator-initiated. P10 writes the other kind. Mirrors `audit_log`, which already distinguishes a system actor from a person (`actor_type` with a nullable `actor_user_id`)                                                                    |

**This forecloses a Phase 7 temptation.** When the wallet arrives, refunding an unfulfillable order to wallet credit would be cheaper for the business and worse for the customer, who never asked for credit. D15a says the money goes back the way it came, and that stands unless a later decision supersedes it.

**Not deferred, and worth restating:** `tickets_status_valid` has no `'void'` value. Phase 6 never needs one, because it only refunds orders whose tickets were never sold. **O7**'s wider answer must account for it, since the proposal on file assumes tickets can be voided.

---

## 12. Guest payment and access model — **LOCKED** OD-2, **D18 = B / D19 = A**

| Stage                        | Identity used                                                              | Notes                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Create the order (Phase 5)   | guest session **+** fresh verified email                                   | unchanged; `buyerOf` enforces it                                                                    |
| **Initiate payment**         | guest session + fresh verified email                                       | same rule as checkout. Within 30 minutes of verification, so no new mechanism is needed             |
| At the provider              | none — the customer has left the site                                      |                                                                                                     |
| **Webhook**                  | **none** (I13)                                                             | this is why the guest's session, browser and email window are all irrelevant to correctness         |
| **Return from the provider** | **order access token** (OD-2)                                              | works after the 30-minute window, after the browser closed, on a different tab                      |
| Poll for status              | order access token                                                         | may _trigger_ a trusted status check; never asserts an outcome                                      |
| **Retry a failed payment**   | **guest session + fresh verified email** — **not** the token (**D18 = B**) | a guest past the 30-minute window must verify again to retry. They can _see_ the failure without it |

**LOCKED guarantees:**

- The token authenticates **nothing** — it is not a session and confers no cap identity.
- It reaches **one** order, and is **read-only**: status and order detail, never a payment (**D18 = B**).
- `guest_sessions.verified_email` is never written, read for authorization, or extended by it (ADR-0029 intact).
- Payment confirmation **never** depends on the guest being present.
- It expires at **`orders.expires_at` + 30 minutes** (**D19 = A, D19a**), on its own configured value rather than one derived from the guest email-proof window.

---

## 13. Authenticated payment model — **LOCKED**

Unchanged from Phase 5 in every respect:

- ownership is `orders.user_id = session user`;
- someone else's order returns **404, not 403** — indistinguishable from one that does not exist (`checkout.service.ts:182-185`, tested both ways);
- `AccessGuard` deny-by-default still applies: a route with no access policy is refused (`access.guard.ts`);
- a half-signed-in session (MFA pending) stays anonymous and cannot pay.

**An authenticated customer does not need and does not receive an order access token.** OD-2's mechanism is guest-only, so authenticated authorization is not weakened by it — the requirement is met by not touching that path at all.

---

## 14. Security requirements — **LOCKED**

| Concern                     | Requirement                                                                                                                                                                                              | Enforcement                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Amount tampering            | the payable amount comes from `orders.external_due_minor`, re-checked at finalization                                                                                                                    | I4, I5 — structural: the request has no amount field |
| Currency / market tampering | payment currency = order currency; payment market = order market                                                                                                                                         | I6, I7 — composite FKs                               |
| Webhook spoofing            | signature over the **raw** body; no other authentication                                                                                                                                                 | I2, **C4**                                           |
| Webhook replay              | `UNIQUE (provider, provider_event_id)`                                                                                                                                                                   | I3                                                   |
| Webhook enumeration         | generic failures; never reveal whether a reference or event is known                                                                                                                                     | procedural                                           |
| Reference enumeration       | `provider_reference` never appears in a customer-facing response                                                                                                                                         | procedural                                           |
| Order enumeration           | 404 for someone else's order; the access token is per-order and opaque                                                                                                                                   | existing + OD-2                                      |
| CSRF                        | the `/webhooks/` exemption is **narrow** and tested in both directions                                                                                                                                   | **C3**                                               |
| Endpoint abuse              | a payment-initiation rate limit per owner, fail-closed on a Redis outage                                                                                                                                 | follows `checkoutPerOwner` (30 / 10 min)             |
| Card data                   | **never touches our servers.** Provider-hosted fields or redirect; PCI scope SAQ-A                                                                                                                       | OD-7, B19                                            |
| Secrets                     | only `config_ref` in the database; keys in env or a secret manager; **no provider name hard-coded**                                                                                                      | I15, OD-8                                            |
| Logging                     | add the provider **signature header** to the pino redaction list (`app.module.ts:41` currently redacts `authorization`, `cookie`, `set-cookie`). Never log payloads, references or amounts at info level | procedural                                           |
| Payload at rest             | no card numbers, CVV, credentials or tokens; raw payload sealed if retained                                                                                                                              | OD-7, **C5**                                         |
| Fake provider               | a config guard refuses it in production, like the `OUTBOX_ENCRYPTION_KEY` placeholder guard (`env.ts:123`)                                                                                               | OD-8                                                 |

---

## 15. Concurrency requirements — **LOCKED**

Every case below must be proven against **real PostgreSQL** with barrier-synchronised starts. Mocks are rejected by DEVELOPMENT_RULES §3, and a test that merely runs the operations sequentially does not count.

| #   | Race                                                  | Resource                  | Mechanism                                                | Required outcome                                                          |
| --- | ----------------------------------------------------- | ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| A   | Same success webhook ×10 in parallel                  | `payment_events`          | I3                                                       | one transition, one ticket sale — **this is Gate 4**                      |
| B   | Out-of-order delivery                                 | `orders.status`           | conditional transitions                                  | terminal states never reopened                                            |
| C   | Two concurrent initiation requests on one order       | `payments`                | the live-attempt partial unique index (**D3 = B**)       | one attempt created; the other returns that same attempt (**D3b**)        |
| D   | Success racing reservation expiry                     | `reservations`, `tickets` | `FOR UPDATE` + `expires_at > now()` (**C9**)             | either a clean sale or a clean `paid_unfulfillable` — **never half-sold** |
| E   | Success racing the order-expiry job                   | `orders`                  | conditional `UPDATE … WHERE status='awaiting_payment'`   | whichever commits first; the other is a no-op                             |
| F   | Two workers claiming one stored event                 | `payment_events`          | claim-with-lease, as `hv_claim_outbox` does              | processed once                                                            |
| G   | Two workers finalizing one order                      | `orders`                  | `FOR UPDATE` then conditional transition                 | second is a no-op                                                         |
| H   | Webhook racing reconciliation                         | `orders`                  | same lock, same `confirmPayment`                         | identical result either way                                               |
| I   | Finalization racing the sweep on the same reservation | `reservations`            | lock order **orders → reservations → counter → tickets** | no deadlock                                                               |
| J   | Two refunds for one unfulfillable order               | `refunds`                 | `idempotency_key UNIQUE`                                 | exactly one                                                               |
| K   | Concurrent attempt creation                           | `payments`                | unique indexes                                           | no duplicate live attempt                                                 |

---

## 16. Proposed database entities

**PROPOSED.** Every column traces to B18, to an existing repository pattern, or to a LOCKED invariant. Nothing is included because other payment systems have it.

### `payments`

| Column                            | Type                                 | Mutable      | Constraint                                                         | Source                                |
| --------------------------------- | ------------------------------------ | ------------ | ------------------------------------------------------------------ | ------------------------------------- |
| `id`                              | `uuid` PK `DEFAULT uuidv7()`         | no           | —                                                                  | convention                            |
| `order_id`                        | `uuid NOT NULL`                      | no           | composite FK `(order_id, market_id) → orders (id, market_id)`      | B18 + I7                              |
| `market_id`                       | `uuid NOT NULL`                      | no           | above, **and** `(market_id, currency) → markets`                   | I6, I7                                |
| `provider`                        | `text NOT NULL`                      | no           | part of `UNIQUE (provider, provider_reference)`                    | B18                                   |
| `provider_reference`              | `text`                               | **set once** | ★ `UNIQUE (provider, provider_reference)`                          | B18, B10 REQ                          |
| `amount_minor`                    | `bigint NOT NULL`                    | no           | `CHECK > 0`; = `orders.external_due_minor` at creation             | B18, I4                               |
| `currency`                        | `text NOT NULL`                      | no           | composite FK above                                                 | B18, I6                               |
| `status`                          | `text NOT NULL`                      | **yes**      | `CHECK IN ('pending','processing','succeeded','failed','expired')` | B18                                   |
| `idempotency_key`                 | `text NOT NULL`                      | no           | `UNIQUE`                                                           | B10; mirrors `orders.idempotency_key` |
| `failure_code`, `failure_message` | `text`                               | set once     | —                                                                  | OD-5 needs a reason to show           |
| `created_at`, `updated_at`        | `timestamptz NOT NULL DEFAULT now()` | `updated_at` | `hv_set_updated_at` trigger                                        | convention                            |

**Indexes:** ★ `UNIQUE (order_id) WHERE status = 'succeeded'` — **I11, structural**. ★ `UNIQUE (order_id) WHERE status IN ('pending','processing')` — **required (D3 = B)**, one live attempt per order. Plus `(status, created_at)` for the reconciler.

**Attempt expiry column.** D3a fixes the attempt timeout at 120 s, so `payments` carries an `expires_at` derived at creation as `min(now() + 120s, orders.expires_at)` — immutable, and the value a timeout job acts on. It is advisory about the provider's own session, authoritative about ours.

**Guard:** `hv_payments_guard` freezes everything but `status`, `updated_at`, `failure_*` and the one-time `provider_reference`. `REVOKE DELETE, TRUNCATE FROM hv_app`.

**Deliberately excluded:** `metadata jsonb`, `customer_id`, `payment_method`, `card_last4`, `attempt_number`, `return_url`, `cancel_url`. The last two are `createPayment` _inputs_ (B10), not stored state.

### `payment_events`

| Column                                        | Type                                 | Source                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                          | `uuid` PK                            | convention                                                                                                                                                        |
| `provider`, `provider_event_id`               | `text NOT NULL`                      | ★ `UNIQUE (provider, provider_event_id)` — **I3**                                                                                                                 |
| `event_type`                                  | `text NOT NULL`                      | normalized (OD-7)                                                                                                                                                 |
| `provider_reference`                          | `text`                               | how the event is matched to a payment                                                                                                                             |
| `payment_id`                                  | `uuid` nullable FK                   | an event may arrive for an unknown reference; it is kept, not dropped                                                                                             |
| `amount_minor`, `currency`, `provider_status` | normalized                           | OD-7 — the working record                                                                                                                                         |
| `payload_sealed`                              | `jsonb` **nullable**                 | **D7 = B** — the sealed raw payload. Nullable **by design**: **OD-7a** clears it after 90 days, and it is also NULL for an event whose payload was never retained |
| `received_at`                                 | `timestamptz NOT NULL DEFAULT now()` |                                                                                                                                                                   |
| `processed_at`                                | `timestamptz`                        | NULL until handled — B18                                                                                                                                          |
| `last_error`                                  | `text`                               | mirrors `outbox.last_error`, so a stuck event stays visible                                                                                                       |

**Append-only.** B19 explicitly lists `payment_events` among the tables with `UPDATE/DELETE` revoked. Following the `outbox` precedent, this is a **guard trigger** permitting only `processed_at`, `last_error` and — for the retention process — `payload_sealed` **to be cleared** to change, plus `REVOKE DELETE, TRUNCATE`.

**The guard must allow exactly one transition on `payload_sealed`: non-NULL → NULL.** Setting it back, or changing one sealed value for another, is refused. That keeps retention possible without making the payload rewritable, which would defeat the point of storing what the provider actually sent.

**Rows are never deleted, only the payload cleared (OD-7a).** The row is the replay-protection record: `UNIQUE (provider, provider_event_id)` is what makes a duplicated webhook a no-op (**I3**), and deleting rows after 90 days would reopen that for any event a provider re-sends later.

### `refunds`

Exactly B18: `order_id`, `payment_id`, `amount_minor`, `currency`, `destination`, `idempotency_key UNIQUE`, `UNIQUE (provider, provider_refund_reference)`, `status`, `reason`, `actor_id`. Composite market/currency FKs as above. Append-mostly; `status` is the only freely mutable field.

**Settled by D15a and D15b:**

| Column        | Phase 6                                                                 | Note                                                                                            |
| ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `destination` | `CHECK IN ('provider', 'wallet')`; Phase 6 writes **only `'provider'`** | **D15a.** `'wallet'` exists in the shape for P7 and is unreachable until then                   |
| `payment_id`  | nullable in the schema, but **always set** by Phase 6                   | **D15a** — "the original instrument" is defined by reference to the payment that took the money |
| `actor_id`    | **nullable**; Phase 6 writes **only NULL**                              | **D15b.** NULL = system-generated, no human actor. Staff-initiated refunds (P10) set it         |

A test should assert that every refund Phase 6 raises has `destination = 'provider'`, a non-NULL `payment_id`, and a NULL `actor_id` — three properties that together say "the system sent this person's money back the way it arrived".

### `market_payment_configs`

Exactly B10: `(market_id, provider_code, config_ref)`. **`config_ref` is a reference, never a secret** (I15).

### `order_access_tokens` — OD-2, **D18 = B / D19 = A**

| Column                     | Type                   | Constraint                                                                                         |
| -------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| `id`                       | `uuid` PK              |                                                                                                    |
| `order_id`                 | `uuid NOT NULL`        | FK → `orders`; **one token per order** (D3 = B makes per-attempt tokens pointless)                 |
| `token_hash`               | `bytea NOT NULL`       | `UNIQUE`, `CHECK (octet_length(token_hash) = 32)` — the `guest_sessions` pattern (`0012:42`)       |
| `expires_at`               | `timestamptz NOT NULL` | `CHECK (expires_at > created_at)`; set to **`orders.expires_at + 30 minutes`** (**D19 = A, D19a**) |
| `revoked_at`, `created_at` | `timestamptz`          | mirrors `guest_sessions`                                                                           |

**The 30 minutes is its own configured value**, not a reuse of `GUEST_VERIFIED_EMAIL_TTL_MINUTES`, which happens to be the same number. Deriving one from the other would mean a future change to the email-proof window silently changing how long a return link lives.

### Changes to existing tables

- **`orders.expires_at`** — `timestamptz NOT NULL`, the OD-1 payment deadline, set to `min(created_at + 600s, min(reservation.expires_at) − 90s)` (**D1 = B, D1a**). Added to the `hv_orders_guard` frozen set so it is immutable. A `CHECK (expires_at > created_at)` follows the `guest_sessions` pattern. **LOCKED**
- **`hv_orders_status_guard`** — **LOCKED (D4 = C)**: enforce the B7 transitions in the database, alongside the application's conditional updates.
- **`hv_tickets_guard`** — **LOCKED (D10 = B)**: replaced so `reserved → sold` additionally requires the reservation to be `active` with `expires_at > now()`. Gates 1 and 2 re-run in the slice that does this.
- **`hv_expire_reservations`** — **unchanged. LOCKED (D11a = B).** No payment-specific predicate is added. The D1 = B margin makes one unreachable, and `hv_tickets_guard` under D10 = B independently blocks the sale it would have prevented. The dependency is recorded in [§3b](#3b-owner-decisions-recorded) and must be carried into `reservation-expiry.ts` and `tickets.repository.ts:180`.
- **`hv_end_reservation`, `hv_reservations_guard`, `reservations_ttl_valid`** — **unchanged (D9 = A, D1 = B)**.

---

## 17. Proposed migrations

**PROPOSED.** Next free number is **0019** (`0018_cart_guard_bridged_entrant.sql` is the latest). Migrations are append-only and checksummed; an applied file is never edited (DEVELOPMENT_RULES §3).

| #      | Purpose                                      | Contents                                                                                                                                      | Slice | Blocked by                 |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------- |
| `0019` | Order payment deadline + order state machine | `orders.expires_at` (**D1 = B, D1a**); replace `hv_orders_guard` to freeze it; add `hv_orders_status_guard` (**D4 = C**)                      | P6-2  | **none — ready**           |
| `0020` | Payment attempts                             | `payments` with `expires_at` (**D3a**), guard, **both** partial unique indexes (**D3 = B**), `REVOKE DELETE, TRUNCATE`                        | P6-2  | **none — ready**           |
| `0021` | Provider events                              | `payment_events` with normalized fields + sealed raw payload (**D7 = B**), append-only guard, `processed_at IS NULL` index, revokes per B19   | P6-3  | **none — ready**           |
| `0022` | Expired-hold backstop                        | replace `hv_tickets_guard` so `reserved → sold` requires a live reservation (**D10 = B**); Gates 1 and 2 re-run                               | P6-4  | **none — ready**           |
| `0023` | Payment permission                           | seed **`payments.reconcile`** (sensitive) + grants to finance, admin, super_admin (**D13a**). Viewing needs nothing — it reuses `orders.read` | P6-5  | **none — ready**           |
| `0024` | Refund skeleton                              | `refunds` per B18, `actor_id` **nullable** (**D15b**), `destination` CHECK (**D15a**)                                                         | P6-6  | **none — ready**           |
| `0025` | Per-market provider config                   | `market_payment_configs`                                                                                                                      | P6-7  | **none — ready (D17 = A)** |
| `0026` | Order access tokens                          | `order_access_tokens`, `expires_at = orders.expires_at + 30 min` (**D19a**)                                                                   | P6-8  | **none — ready**           |

**Not created — D11a = B.** The expiry-safety migration that would have replaced `hv_expire_reservations` is **deliberately not written**. Phase 6 therefore adds **eight** migrations, not nine, and makes **no change to the ticket-expiry sweep**. The reasoning and the code comments that must carry it are in [§3b](#3b-owner-decisions-recorded).

**No migration is needed** for the provider port, the fake provider, the webhook route or the outbox topics.

**Numbers are indicative, not reserved.** Slices land in order and each takes the next free number at the time — as P5-8 discovered when a test forced an unplanned `0018`.

---

## 18. API surface — **PROPOSED**

### Customer

**`POST /markets/:market/checkout/orders/:order/payments`**

|                         |                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access                  | `@Public({ identify: true })` + `MarketGuard`; ownership exactly as `getOrder` checks it                                                                                   |
| Request                 | `{}`, or a provider hint if several are configured. **Never an amount** (I5)                                                                                               |
| Headers                 | `Idempotency-Key` required, as checkout already requires                                                                                                                   |
| Response                | provider redirect or session details, and the order access token for the return URL (OD-2). **Never `provider_reference`**                                                 |
| **Live attempt exists** | **returns that attempt** — its provider redirect or session details — rather than creating a second or refusing. **LOCKED (D3b = A)**                                      |
| Errors                  | 404 not owned · 409 not `awaiting_payment` · 409 past the payment deadline · **409 fewer than 180 s remain before the deadline (D1b)** · 429 rate-limited · 503 Redis down |
| Rate limit              | new, per owner, fail-closed                                                                                                                                                |

**The 180-second refusal is a product behaviour, not an internal error.** It means "your hold is about to expire; rebuild your basket", and P6-8 must present it that way. It needs its own error code, distinct from "past the deadline", so the web app can say the right thing.

**`GET /markets/:market/checkout/orders/:order/payments/:payment`** — status for the return page. Accepts either the owning identity **or** a valid order access token. **May trigger a trusted status check; never asserts an outcome** (ADR-0006, D6).

**`GET /markets/:market/checkout/orders/:order`** — unchanged for authenticated and freshly-verified guests; additionally accepts an order access token (OD-2). `buyerOf` is not modified.

### Webhook

**`POST /webhooks/payments/:provider`** — `@Public()` **without** `identify` (I13). Not market-scoped. Raw body (**C4**), origin-exempt (**C3**). 200 on accept and on duplicate; 4xx malformed; 5xx to invite a retry.

### Admin

**`GET /admin/markets/:market/orders/:order/payments`** — `RequirePermission('orders.read')`, which **already exists** and already reaches all five staff roles. **LOCKED (D13a).**

**`POST /admin/markets/:market/orders/:order/payments/:payment/reconcile`** — `RequirePermission('payments.reconcile')`, **sensitive**, so step-up MFA within `STEP_UP_WINDOW_MS` is required. Audited on every invocation. **LOCKED (D13a).**

**Opening a sealed provider payload** — also `payments.reconcile`, sensitive, audited. **No separate payload-access permission exists in Phase 6 (D13a).** The route or operator tool that does this must never return the payload in an ordinary API response and must never log it.

### Configuration

**Payment configuration writes** — `RequirePermission('config.manage')` with `sensitive: true`, so step-up MFA is required. **LOCKED (D17 = A).** `config.manage` is granted to **`super_admin` only** (`0006:106`), so payment configuration is a super-admin operation. No new permission is needed, and **O9 is answered for payment configs specifically**; the wider O9 list remains open for P10.

---

## 19. UI requirements — **PROPOSED**

`apps/web` has no checkout or payment UI today, and `layout.tsx:44` says so on the site. The e2e specs are `admin-draws`, `auth`, `draws`, `reservations`, `smoke` — **none for cart, terms, checkout or payment.**

Minimum states:

| State                  | Requirement                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Pay**                | shows the authoritative amount from the order; leaves for the provider                                               |
| **Pending**            | returned but not confirmed. **Polls; never asserts paid.** The state where D6 becomes visible to a real customer     |
| **Paid**               | confirmed; tickets shown as bought                                                                                   |
| **Failed**             | a clear retry, creating a **new attempt** once the previous one is terminal (D3 = B)                                 |
| **Attempt still live** | "Pay" returns the customer to the **existing** payment page (D3b = A) — never a second one, never a refusal          |
| **Too late to start**  | fewer than 180 s remain (D1b): the hold is about to expire and the basket must be rebuilt. **Distinct from Expired** |
| **Expired**            | the deadline passed; explains that the basket must be rebuilt                                                        |
| **Unfulfillable**      | paid but not fulfillable; states plainly that a refund has been raised                                               |

**Countdown — now buildable. LOCKED (D1 = B).** It counts to `orders.expires_at`, and that is honest: the reservation is guaranteed to outlive it by 90 seconds, so the countdown can never reach zero while the tickets are already gone. Server time is authoritative — the existing verification endpoint already returns `serverTime` for exactly this reason (`email-verification.service.ts:188`), and the payment status response should do the same rather than trusting the browser clock.

**The 180-second floor must be visible before the customer commits**, not only as a refusal at the payment step. A basket or checkout page that can see the hold expiring is where this belongs.

**Banner.** `layout.tsx:44` must be updated when payment goes live — it currently tells every visitor that checkout and payment are unavailable.

---

## 20. Notification and outbox requirements — **LOCKED** OD-6, **D16 = C**, **D16a**, **D16b**

**All four Phase 6 order-outcome topics live under `order.*` (D16b). No aliases, no dual names.**

| Topic                      | Emitted in Phase 6?                                   | Written when                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`order.paid`**           | **yes**                                               | finalization commits successfully                                                                                                                                                                        |
| **`order.payment_failed`** | **yes** (OD-6)                                        | an attempt fails definitively and no other is live                                                                                                                                                       |
| **`order.expired`**        | **yes** (OD-6)                                        | the deadline passes with nothing succeeded                                                                                                                                                               |
| **`order.unfulfillable`**  | **yes — D16 = C, first message. LOCKED (D16a, D16b)** | the late-payment path, in the finalization transaction. The customer has been charged and must be told before the refund lands                                                                           |
| refund completion          | **no — P10's contract, recorded provisionally**       | when the refund actually completes. **Phase 6 neither emits it nor registers a handler (D16a).** P10 names it; D16b's `order.*` standardisation covers order outcomes and does not bind a refund outcome |
| `refund.initiated`         | **no**                                                | D16 = C asks for _failure_ and _completion_, not a third message when the record is raised. `order.unfulfillable` already carries that moment                                                            |
| `payment.succeeded`        | **no**                                                | redundant with `order.paid`. One event per business fact                                                                                                                                                 |

### What `order.unfulfillable` may say — LOCKED (D16a)

**May state:** that the order or payment could not be fulfilled · the order's identity or reference · that the requested tickets **will not** be delivered · that a refund **has been initiated**.

**Must not state:** that the refund **has completed**. It has not. At the moment this event is written, the `refunds` row exists and no money has moved, and completion is not confirmed until the provider says so — which happens in P10. Wording that implies the money is already back would be false at the moment of sending, every time.

The exact copy is **P12**; this fixes what the event is permitted to assert, which is the part that must not drift when the copy is written.

### The two-phase seam — LOCKED (D16a)

An unregistered topic **fails** the event rather than dropping it (`outbox.service.ts:69`) — deliberate, and correct. So:

- **Phase 6 emits all four `order.*` topics and registers a handler for each.**
- **Phase 6 builds no refund-completion consumer**, and no Phase 6 code path may write a refund-completion topic. The Phase 6 Definition of Done asserts this.
- The refund-completion topic is **P10's provisional contract only**. The architecture does not require it to be named now — nothing emits or handles it — so P10 may name it freely. It is noted here so the two halves of D16 = C stay connected across the phase boundary.

**Topic-format check.** All four Phase 6 names satisfy `outbox_topic_format`, `^[a-z][a-z_]*(\.[a-z][a-z_]*)+$` (`0011:50`): `order.paid`, `order.payment_failed`, `order.expired`, `order.unfulfillable`. Note the regex permits `_` inside a segment, which is what makes `order.payment_failed` valid.

**Constraints — LOCKED:**

- Every topic must match `outbox_topic_format`: `^[a-z][a-z_]*(\.[a-z][a-z_]*)+$` (`0011:50`) — lowercase, underscores, dots. **No digits, no hyphens.** All four conform.
- Every new topic **must** be registered in the worker's dispatcher (`outbox.service.ts:69`, currently `{ [VERIFICATION_EMAIL_TOPIC]: relay }`). An unregistered topic **fails the event** rather than dropping it — deliberate, and it means a forgotten registration surfaces loudly.
- Payloads carrying an email address are **sealed** (`sealPayload`, ADR-0028).
- The outbox row is written **inside** the finalization transaction and delivered after commit (I14). **Delivery never blocks or fails finalization** (OD-6).
- **No final email copy.** Per-market templates are P12.

---

## 21. Test strategy — **LOCKED**

Real PostgreSQL for every integration and concurrency test; one database per file, cloned from a migrated template.

**Payment initiation:** valid · order not found · wrong owner (404) · wrong market · not `awaiting_payment` · past the deadline · duplicate idempotency key → same attempt · key reused for a different request → 409 · rate limit → 429 · Redis down → 503.

**Payment window (D1 = B, D1a, D1b):** `orders.expires_at` equals `min(created_at + 600s, min(reservation.expires_at) − 90s)` · it is **immutable** — an `UPDATE` in raw SQL is refused by `hv_orders_guard` · **the margin term always binds**, asserted for a range of browsing times · initiation is refused when fewer than **180 s** remain, with its **own error code**, distinct from "past the deadline" · an order created at the last permitted moment still yields a usable window · the reservation is proven to outlive the deadline in every case.

**Attempts (D3 = B, D3a, D3b):** a second initiation while one is live **returns the existing attempt**, not a new one and not an error · after the live attempt is terminal, a new one is created · an attempt with no provider answer becomes terminal at **120 s** · an attempt never outlives `orders.expires_at` · concurrent initiation requests, barrier-synchronised, produce exactly one attempt · the live-attempt index refuses a second live row when attempted in raw SQL.

**Order transitions (D4 = C):** every permitted transition succeeds · every forbidden transition is refused **in raw SQL**, bypassing the application · `paid → awaiting_payment` is refused · a late failure after a success does not move the order · the raised constraint maps to a domain error, never a 500.

**Webhook (D5 = B, D6 = C, D7 = B):** valid signature · **invalid signature rejected** · tampered body · a semantically identical but **re-serialised** body fails, proving the raw bytes are what is checked · missing signature header · malformed body · body over the limit · **no `Origin` header is admitted**, and a non-webhook route without `Origin` is still refused · the `onSend` security headers are present on webhook responses too · a provider-invalid message returns 4xx and is **not** retried, while a failure in our own processing returns 5xx · unknown event type stored and ignored · duplicate event → 200, no work · unknown provider → 404 · unknown reference stored, not revealed · **amount mismatch refuses finalization** · currency mismatch refuses · the sealed payload is unreadable without the key, and a payload deliberately containing credential-shaped fields appears in **no** column, log or response in plaintext.

**Finalization (D9 = A, D10 = B):** success → `paid` + tickets `sold` + reservation `released` + audit + outbox · **cap counter correct on a re-keyed (bridged) entrant** (I12, ADR-0021) · reservation expired → `paid_unfulfillable` + refund raised · **sale from an expired-but-unswept reservation is refused by the database itself**, attempted in raw SQL with the application bypassed (I19) · **selling before closing the hold succeeds; closing before selling is refused** — the step order is asserted, not assumed · partial sale impossible · duplicate finalization is a no-op · failure applies no ticket change · **cap allowance is not returned for sold tickets** (I20) · **Gates 1 and 2 still pass** after `hv_tickets_guard` is replaced.

**Concurrency** (barrier-synchronised, N connections): the full matrix in [§15](#15-concurrency-requirements--locked). **A test that runs the operations sequentially does not satisfy any row of it.**

**Guest (D18 = B, D19 = A):** payment on a guest order · **webhook succeeds with the browser closed** · **webhook succeeds after the guest session has expired** · order **status and detail** readable via the access token **after the 30-minute binding lapses** · **the token cannot initiate a payment** · the token reaches **only** its own order · a revoked or expired token is refused · the token creates, extends or revives **no** guest session and never touches `verified_email` · only the hash is stored, and the plaintext appears in no table and no log · presentation is rate-limited and fails closed when Redis is down · the token stops working 30 minutes after `orders.expires_at` (**D19a**).

**Reconciliation (D12 = A, D13 = B):** the reconciler resolves a payment the webhook never confirmed · running it repeatedly has the effect of running it once · it never holds a row lock across the provider call · it cannot move an order out of a terminal state · viewing and acting are separately authorized, proven by a role that can do one and not the other · every invocation writes an `audit_log` row naming the actor, or `system` for the scheduled run.

**The D11a = B dependency (a guarded assumption, not a feature):** `orders.expires_at < min(reservation.expires_at)` holds for **every** order created, across a range of browsing times and reservation TTLs. This single assertion is what makes the absent predicate safe, so it is tested explicitly and named in the test so that a future change to D1 fails here first rather than in production. The expiry sweep itself is **unchanged**, so Gates 1 and 2 cover it as they already do.

**Late payment (D14 = A, D15a, D15b, D16a):** a confirmation with no live hold → `paid_unfulfillable`, payment `succeeded`, **no ticket touched**, one `refunds` row, full audit · running it twice produces exactly **one** refund row · **no re-allocation is attempted**, and `order_items` is proven immutable in raw SQL · every Phase 6 refund has **`destination = 'provider'`, a non-NULL `payment_id` pointing at the payment that took the money, and a NULL `actor_id`** · `order.unfulfillable` is written in the same transaction and **claims only that a refund was initiated** · **no Phase 6 code path emits any refund-completion topic**, asserted by searching the built output, since none has a handler until P10 · **every topic Phase 6 writes is under `order.*`** (D16b), asserted against the dispatcher's registered keys so a stray name cannot reach production.

**Reconciler schedule (D12a):** the job is idempotent — two overlapping runs against the same payment produce one outcome · it resolves a payment within the lookback window · a payment outside the window is left for the operator endpoint rather than silently abandoned · it holds no row lock across the provider call.

**Permissions (D13a):** `orders.read` alone can view payment status but **cannot** reconcile · `payments.reconcile` without fresh step-up MFA is refused · `support` and `fulfilment` can view and not act · `finance`, `admin` and `super_admin` can act · a market-scoped grant does not reach another market's order · **opening a sealed payload requires `payments.reconcile`**, is audited, and the payload never appears in an ordinary API response.

**Return link (D19a):** the link works at `orders.expires_at + 29 minutes` and is refused at `+ 31` · it is refused after `revoked_at` · it **cannot** initiate a payment · its lifetime is independent of `GUEST_VERIFIED_EMAIL_TTL_MINUTES`, proven by changing that value and observing the link's expiry unchanged.

**Authenticated:** normal payment · another user's order → 404 · MFA-pending session cannot pay.

**Markets:** UK/GBP · IE/EUR · **DE refused even with the UI bypassed** · a UK order with a EUR payment refused by the schema · a payment referencing another market's order refused.

**Provider abstraction:** the fake provider delivers late, duplicated, out-of-order and missing events · **the fake provider cannot be registered in production** · no provider name appears anywhere in the codebase (a grep test, like the gitleaks negative control).

**Security:** the redirect cannot mark paid (**Gate 4**) · no card data in any table · the signature header is redacted in logs · sealed payloads are never logged or returned.

---

## 22. Slice plan P6-1 → P6-9

**LOCKED structure**, with dependencies validated against the repository. Each slice is one branch, one PR to `develop`, owner-approved before it starts. Slices are not merged together.

| Slice    | Objective                                                                                                                                                                                                                                                                                                      | Migration      | Depends on | Blockers         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------- | ---------------- |
| **P6-1** | **Provider port + deterministic fake provider.** `packages/payments`: the B10 interface, the fake implementation with HMAC webhooks able to deliver late, duplicated, out-of-order and never, the production config guard. **No routes, no tables, no API changes.**                                           | none           | —          | **none — ready** |
| **P6-2** | **Payment attempt persistence + initiation.** `orders.expires_at` (D1/D1a), the 180 s refusal (D1b), `payments` with one-live-attempt (D3/D3a/D3b), `hv_orders_status_guard` (D4), initiation endpoint, rate limit, I1–I7 enforced.                                                                            | `0019`, `0020` | P6-1       | **none — ready** |
| **P6-3** | **Webhook persistence + verified intake.** Separate webhook pipeline (D5), raw-body capture, signature boundary, failure classification (D6), `payment_events` with sealed raw payload (D7), replay protection. **Stores and acknowledges; does not finalize.**                                                | `0021`         | P6-2       | **none — ready** |
| **P6-4** | **Atomic finalization.** `confirmPayment`: order lock, conditional transition, `reserved → sold` **then** `hv_end_reservation(…, 'released')` (D9), the `hv_tickets_guard` backstop (D10), cap correctness, audit, outbox. **Gate 4 lives here, as scoped by D8.**                                             | `0022`         | P6-3       | **none — ready** |
| **P6-5** | **Status / reconciliation.** `getPaymentStatus`, the 60 s reconciler (**D12a**), the viewing and acting endpoints (**D13a**), sealed-payload opening under `payments.reconcile`, and the **comment corrections** recording why the sweep needs no predicate (**D11a = B**). **No change to the expiry sweep.** | `0023`         | P6-4       | **none — ready** |
| **P6-6** | **Late payment + refund skeleton.** `paid_unfulfillable` (**D14 = A**), automatic refund to the original instrument (**D15a**, **D15b**), `order.unfulfillable` notification (**D16a**).                                                                                                                       | `0024`         | P6-4       | **none — ready** |
| **P6-7** | **Per-market payment configuration.** `market_payment_configs`, provider selection per market, writes under `config.manage` (**D17 = A**).                                                                                                                                                                     | `0025`         | P6-1       | **none — ready** |
| **P6-8** | **Web payment flow.** Pay / live attempt / pending / paid / failed / too-late / expired / unfulfillable, countdown, guest and authenticated, order access tokens (**D18 = B**, **D19a**).                                                                                                                      | `0026`         | P6-4, P6-6 | **none — ready** |
| **P6-9** | **Hardening / Gate 4 sign-off.** Full concurrency matrix, e2e, docs, Phase 6 DoD, Gate 1 and Gate 2 re-run after D10.                                                                                                                                                                                          | none           | all        | —                |

**All nine slices are unblocked, with no outstanding decision of any kind.** The items in [§26](#26-remaining-open-decisions) are deferred beyond Phase 6 by design, not pending.

**Why P6-3 and P6-4 stay separate — LOCKED.** Storing an event and acting on it have entirely different failure modes. P5-8 demonstrated how much a slice's own tests reveal before the next one depends on it; merging these two would hide exactly that.

**Why P6-1 is first.** No migration, no existing behaviour touched, and every later slice depends on it. Without the fake provider's ability to misbehave on demand, the §15 matrix cannot be tested deterministically at all.

---

## 23. Slice-level Definition of Done — **LOCKED**

Every P6-x PR, before review:

- [ ] `pnpm verify` green end to end — `secrets:scan`, `format:check`, `lint`, `typecheck`, unit, `db:migrate up`, `db:migrate verify`, integration, build.
- [ ] `pnpm codegen:verify` green when contracts changed; `pnpm test:e2e` green when `apps/web` changed.
- [ ] New migrations are append-only, numbered, checksummed, and **re-runnable** — no applied file edited.
- [ ] Every new invariant has a test that fails without the implementation. Structural invariants have a test proving the constraint still exists.
- [ ] Concurrency claims are proven with barrier-synchronised parallel connections against real PostgreSQL. **Sequential execution does not count.**
- [ ] No provider name hard-coded. No secret committed. `.env.example` placeholders only.
- [ ] No plaintext sensitive payload logged; new sensitive headers added to redaction.
- [ ] `hv_app` privileges asserted for real — the P5-6 lesson: before `global-setup.ts` was fixed, every "cannot DELETE" assertion passed vacuously.
- [ ] ADRs written for decisions made inside the slice (next free number: **0033**).
- [ ] `PROJECT_STATUS.md`, `TASK_BOARD.md`, `ACTIVE_WORK.md`, `CHANGELOG.md` updated; `ACTIVE_WORK` entry removed by the completing PR.
- [ ] CI green. Branch → PR → `develop`. **No direct push to `develop` or `main`; no merge without owner approval** (DEVELOPMENT_RULES §4).
- [ ] Known flakes are **not** used to dismiss a failure. A red run is investigated, not re-run.

---

## 24. Gate 4 Definition of Done — **LOCKED**

Gate 4 is the phase's exit criterion. Its authoritative wording is `PROJECT_INITIALIZATION_REPORT.md:609` (critical gate 4) plus the Part F row "the redirect cannot mark paid (test)".

- [ ] **G4.1 — The redirect cannot mark an order paid.** A test drives the full return-from-provider flow with **no** webhook and **no** successful status check, and asserts the order is still `awaiting_payment` and no ticket is `sold`. A second test forges a "success" return URL and asserts the same. _(Part F)_
- [ ] **G4.2 — The same webhook ×10 in parallel** → exactly **one** payment transition and **one** ticket sale. Barrier-synchronised, real PostgreSQL. _(gate 4, first clause)_
- [ ] **G4.3 — Out-of-order delivery** (success then failure; failure then success; duplicate interleaved) → one deterministic outcome; success is terminal. _(gate 4, second clause)_
- [ ] **G4.4 — "one credit"** — **deferred to Gate 6 / P8. LOCKED (D8 = A, 2026-09-25).** Recorded explicitly in `PROJECT_STATUS.md` when Phase 6 closes, so Phase 8 inherits it. Phase 6 must **not** claim this clause is satisfied.
- [ ] **G4.5 — Reservation expiry racing a late webhook** → either a clean sale or a clean `paid_unfulfillable`, never a half-sold order. _(B-section "additional tests")_
- [ ] **G4.6 — Refunds tested.** _(B10 REQ)_
- [ ] **G4.7 — Unique provider references and idempotent webhooks**, proven structurally. _(B10 REQ)_
- [ ] **G4.8 — Checkout under 3 s excluding the provider.** _(B10 REQ)_
- [ ] **G4.9 — No card data** in any table, log or payload; no provider name hard-coded; the fake provider cannot be registered in production.
- [ ] **G4.10 — A Phase 6 Definition of Done is committed _before_ the phase closes.** Phase 5's was written mid-phase, and the P5-8 audit showed that to be too late.
- [ ] **G4.11 — Every topic Phase 6 emits is under `order.*`** (D16b), asserted against the dispatcher's registered keys, and **no refund-completion topic is written anywhere**, since none has a handler until P10.
- [ ] **G4.12 — Gates 1 and 2 re-run and green** after `hv_tickets_guard` is replaced (D10 = B). They cover the function being changed, so they are part of this phase's exit, not only Phase 4's.
- [ ] **G4.13 — `orders.expires_at < min(reservation.expires_at)` for every order created.** This single assertion is what makes the absent expiry predicate safe (D11a = B); it is named in the test so a future change to D1 fails here first.

---

## 25. Explicit out-of-scope list — **LOCKED**

Justified by Part F's phase sequence, not by general practice:

| Item                                                          | Where it belongs                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Selecting the production payment provider                     | **O13**, before P14                                                                     |
| Wallet, ledger, part payment, release                         | **P7** — `orders.wallet_applied_minor` exists and stays 0                               |
| Instant wins                                                  | **P8** — but P6-4 leaves a clean seam, since B10 evaluates them in the same transaction |
| Settlement, close, grace, winners                             | **P9** (**O5** grace)                                                                   |
| Admin refunds UI, refund completion, fulfilment, reports, CSV | **P10**                                                                                 |
| Referrals, Vault Meter                                        | **P11**                                                                                 |
| Per-market email templates, consent, compliance values        | **P12** (**O12** still blocks market enablement)                                        |
| Order re-allocation after late payment                        | **not implemented** — **C10**; needs its own ADR and migration                          |
| Full accounting, payouts, merchant settlement                 | not in Part F at all                                                                    |
| Chargeback platform, advanced fraud engine, analytics         | not in Part F at all                                                                    |
| Provider-specific optimization                                | not until a provider is chosen (**O13**)                                                |

---

## 26. Remaining open decisions

**All twenty questionnaire decisions are answered.** D1–D10 and D11–D20 are recorded in [§3b](#3b-owner-decisions-recorded). Every conflict from §3a — **C1, C2, C3, C4, C5, C6, C7, C8, C9, C10, C11** — now has an owner answer.

**Nothing in Phase 6's design is undecided, and no slice is blocked.**

**D11a was resolved as B on 2026-09-25:** no expiry-safety migration. `hv_expire_reservations` is untouched, and the dependency that makes it unnecessary is recorded in [§3b](#3b-owner-decisions-recorded), to be carried into `reservation-expiry.ts` and `tickets.repository.ts:180` during P6-5.

**Every decision, value, interpretation and name is answered** and recorded in [§3b](#3b-owner-decisions-recorded): D1–D20, **D11a** (no expiry migration) · **D12a** (60 s / 5 min, confirmed) · **D13a** (`orders.read` + `payments.reconcile`) · **D15a** (original instrument) · **D15b** (nullable `actor_id`) · **D16a** (`order.unfulfillable`, refund initiated only) · **D16b** (`order.*` namespace) · **D19a** (30-minute tail) · **OD-7a** (90-day retention).

**Every Phase 6 slice is unblocked, with nothing pending.** What follows is the record of what closed, and what is deferred to later phases by design.

### Closed on 2026-09-25 — nothing outstanding for Phase 6

| Ref       | Resolution                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D12a**  | **Confirmed.** Every 60 s, examining payments whose **last state change** falls within the previous 5 minutes; older cases go to the operator endpoint                                                                                                               |
| **D16b**  | **Resolved.** All four order-outcome topics under `order.*` — `order.paid`, `order.payment_failed`, `order.expired`, `order.unfulfillable`. **No aliases, no dual names.** The refund-completion topic is a refund outcome, belongs to P10, and is not bound by this |
| **OD-7a** | **Closed in both halves.** Access is `payments.reconcile` (D13a); encrypted payloads are retained **90 days**, then cleared by the operator/retention process, and never exposed by an ordinary order or customer API                                                |

### Deferred beyond Phase 6 by design

These are not Phase 6 blockers. Each belongs to a later phase and is listed so it is not mistaken for an oversight.

| Ref                              | Question                                                                                                 | Where it belongs                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **O7** (wider)                   | Refunds after close/settlement; the fate of tickets and instant wins on refunded orders; partial refunds | **P10**, deferred by D15 = A. Must account for `tickets_status_valid` having no `'void'` value                                     |
| **O9** (wider)                   | The full list of major configuration changes                                                             | **P10.** Answered for payment configs by D17 = A                                                                                   |
| **O13**                          | Production payment provider per market                                                                   | **Before P14**, kept open by D20 = C, with the characteristics below to gather meanwhile                                           |
| Refund-completion topic name     | What P10 calls the event when a refund actually completes                                                | **P10.** Nothing in Phase 6 emits or registers it                                                                                  |
| Retention process implementation | The job or procedure that clears payloads at 90 days                                                     | **Operational, post-Phase 6.** Phase 6 only ensures the schema permits it and that nothing depends on a payload older than 90 days |

### D20 = C — characteristics to gather

The owner chose to keep O13 open **and** gather what we need. These are the questions whose answers would replace an assumption already made, drawn from where each one bites:

| Characteristic                                         | What it informs                                             | Assumption currently standing                                          |
| ------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| How long a provider's hosted payment page stays usable | **D1b** (180 s floor), **D3a** (120 s attempt timeout)      | that 120–180 s is enough to complete a payment                         |
| Whether an abandoned payment session can be resumed    | **D3 = B**, **D3b = A** (returning to the existing attempt) | that returning to a live attempt is meaningful rather than a dead page |
| Maximum webhook payload size                           | **C4** — the webhook route's body limit                     | that it is at or below the current global 64 KB                        |
| Signature header name and algorithm family             | **C4**, and the pino redaction list (`app.module.ts:41`)    | that there is exactly one header to redact                             |
| Which fields a real payload contains                   | **D7 = B** — what the sealed payload holds                  | that it carries PII but never a PAN or CVV                             |
| Event id semantics and delivery guarantees             | **I3** — `UNIQUE (provider, provider_event_id)`             | that the provider supplies a stable, unique event id                   |
| Refund API idempotency and reference semantics         | **I16** — `UNIQUE (provider, provider_refund_reference)`    | that refunds carry a provider reference and accept an idempotency key  |

**No provider is named**, and none of these changes a locked decision — they test whether an assumption holds. Gathering them is a documentation task, not a Phase 6 slice.

### Closed, and not to be reopened by mistake

| Ref    | Status                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O5** | **Closed by [ADR-0024](adr/0024-settlement-grace-period.md)**, accepted 2026-09-21: settlement runs at close + 10 min + 2 min. C1 options (c) and (d) would have required amending it; **D1 = B was chosen, so it stands untouched.** |

---

## Appendix — verified repository facts this lock depends on

Re-checked at `723c7ae` while writing this document.

| Fact                                                                                  | Location                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Reservation TTL ceiling of 10 minutes, `expires_at` immutable                         | `0009_tickets.sql:68-69`, `:144-147`                    |
| Reservation statuses `active`/`released`/`expired`; only `active → released\|expired` | `0009:55`, `:151-153`                                   |
| `hv_end_reservation` returns allowance only for tickets actually freed                | `0010_reservation_end_fix.sql`                          |
| `reserved → sold` permitted; liveness checked only for `→ reserved`                   | `0009:186`, `:192-194`                                  |
| `hv_expire_reservations` has two callers                                              | `reservation-expiry.ts:38`, `tickets.repository.ts:180` |
| Full B7 status enumeration already in the CHECK                                       | `0016_orders.sql:95`                                    |
| `hv_orders_guard` freezes the snapshot but **not** `status`                           | `0016:179-192`                                          |
| `order_items` immutable; `UNIQUE (order_id, draw_id)`; `UNIQUE (reservation_id)`      | `0016`                                                  |
| `orders_id_market_key UNIQUE (id, market_id)` — the composite FK target               | `0016`                                                  |
| No `orders.expires_at`                                                                | `grep -c expires_at 0016_orders.sql` → 0                |
| CSRF origin hook rejects POST without an allowed `Origin`                             | `apps/api/src/app.ts:44-61`                             |
| `bodyLimit: 64 * 1024`; no raw-body parser registered                                 | `apps/api/src/app.ts:33`                                |
| `AccessGuard` denies any route with no access policy                                  | `apps/api/src/rbac/access.guard.ts`                     |
| `buyerOf` throws `VERIFICATION_REQUIRED` past the 30-minute window                    | `apps/api/src/orders/checkout.service.ts:384-389`       |
| `GUEST_SESSION_TTL_HOURS` 24 vs `GUEST_VERIFIED_EMAIL_TTL_MINUTES` 30                 | `apps/api/src/config/env.ts:57, 61`                     |
| `RESERVATION_TTL_SECONDS` default 600, production-pinned                              | `apps/api/src/config/env.ts:75, 105`                    |
| Guest token stored as SHA-256 `bytea`, `UNIQUE`, length-checked                       | `0012_guest_sessions.sql:29, 41-42`                     |
| Permissions include `orders.read`, `refunds.create`; **no** payment permission        | `0006_rbac.sql:61-77`                                   |
| `audit_log` columns available for payment entries                                     | `0007_audit_log.sql:13-25`                              |
| Outbox topic format `^[a-z][a-z_]*(\.[a-z][a-z_]*)+$`                                 | `0011_outbox.sql:50`                                    |
| One registered outbox topic; unknown topics fail rather than drop                     | `apps/worker/src/outbox/outbox.service.ts:69`           |
| `SecretBox`, `sealPayload`, `openPayload` exported                                    | `packages/domain/src/index.ts:13, 25`                   |
| `PaymentProvider` interface, `market_payment_configs`, fake provider                  | `PROJECT_INITIALIZATION_REPORT.md:300-325` (B10)        |
| `payments` / `payment_events` / `refunds` shapes                                      | `PROJECT_INITIALIZATION_REPORT.md:695-697` (B18)        |
| `UPDATE/DELETE` revoked on `payment_events`                                           | `PROJECT_INITIALIZATION_REPORT.md:565` (B19)            |
| Critical gate 4 wording                                                               | `PROJECT_INITIALIZATION_REPORT.md:609`                  |
| Part F **P6** row and Gate 4                                                          | `PROJECT_INITIALIZATION_REPORT.md:796`                  |
| Latest migration `0018`; next free `0019`                                             | `packages/db/migrations/`                               |
| Latest ADR `0032`; next free `0033`                                                   | `docs/adr/`                                             |

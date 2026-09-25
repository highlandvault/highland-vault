# Phase 6 — decision brief

_Prepared: 2026-09-25 · authoritative HEAD `723c7ae` · Phase 5 complete._

Sources: [PHASE_6_AUDIT.md](PHASE_6_AUDIT.md) and [PHASE_6_SCOPE_LOCK.md](PHASE_6_SCOPE_LOCK.md). Every `CURRENT FACT` below was re-checked against the repository at `723c7ae` before being written down.

**This is a decision brief, not an implementation plan.** No option is ranked, and nothing is chosen. Each item ends with the question the owner must answer.

Sections 3–21 use exactly this structure: **CURRENT FACT · PROBLEM · OPTIONS · TRADE-OFFS · REPOSITORY IMPACT · TEST IMPACT · OWNER DECISION REQUIRED**.

> **Status — 2026-09-25: answered in full.** The owner decided every item in this brief — C1 through C11, OD-2a, OD-4a, OD-6a, the protection half of OD-7a, and O7, O9 and O13. The answers, their derived arithmetic and their consequences are recorded in [PHASE_6_SCOPE_LOCK.md §3b](PHASE_6_SCOPE_LOCK.md#3b-owner-decisions-recorded), **which is authoritative** wherever this brief still presents an item as open.
>
> **This brief is retained as the reasoning record** — the options, trade-offs and repository facts that each decision was made against. It is not updated as decisions land.
>
> **All remaining values and names were answered on 2026-09-25** — D11a, D12a, D13a, D15a, D15b, D16a, D16b, D19a and OD-7a — and are recorded in [§3b](PHASE_6_SCOPE_LOCK.md#3b-owner-decisions-recorded). **Every Phase 6 slice is unblocked with nothing pending.**
>
> **Note on topic names.** §16 below discusses `order.unfulfillable` as one option among several. **D16a and D16b settled it:** Phase 6 emits four topics, all under `order.*` — `order.paid`, `order.payment_failed`, `order.expired`, `order.unfulfillable` — with no aliases. The refund-completion message belongs to P10, which names it.
>
> **Deferred to later phases by design**, not outstanding: the wider **O7** and **O9** answers (P10), **O13** (before P14), and the retention process that clears sealed payloads at 90 days (operational).
>
> **Note on §4 (C2).** This brief's C2 options were drafted before C1 was answered. With **D1 = B**, the database-half predicate is provably unreachable; the owner resolved that as **D11a = B** — no migration, the dependency recorded instead. **Phase 6 makes no change to `hv_expire_reservations`.** §4 below is left as written, as the record of the reasoning at the time.

---

## 1. Executive summary

Phase 5 ended cleanly: an order sits at `awaiting_payment`, its reservation `active`, its tickets `reserved`, and nothing about payment exists anywhere in the repository. Phase 6 must add the payment attempt domain, a provider abstraction, webhook ingestion and atomic finalization.

The audit and scope lock found **eleven conflicts** between the instructed Phase 6 decisions and what the repository actually enforces, plus **four new open decisions** raised by the locked design. They fall into three kinds:

- **Framework gaps** (C3, C4) — the API as configured rejects provider webhooks outright and cannot see the raw bytes a signature is computed over. These are narrow and self-contained, but no webhook works until they are settled.
- **Clock and lifecycle conflicts** (C1, C2, C8, C9) — the reservation is capped at 10 minutes from its own creation and its `expires_at` is immutable, so an independent 600-second order payment window cannot be satisfied by the current schema. This is the decision with the widest consequences.
- **Policy and boundary questions** (C5, C6, C7, C10, C11, OD-2a, OD-4a, OD-6a, OD-7a) — where the repository permits several valid designs and the choice belongs to the owner.

One correction to prior documents: **O5 is not open.** It was closed by [ADR-0024](adr/0024-settlement-grace-period.md), accepted 2026-09-21. `PHASE_6_SCOPE_LOCK.md` §26 lists it among pre-existing open questions, which is wrong; see [§18](#18-o5--settlement-grace-period) and [§24](#24-decisions-that-can-remain-open-until-later-slices).

**Nine decisions block the start of a slice.** Five can stay open for now. The split is in [§23](#23-phase-6-implementation-blockers) and [§24](#24-decisions-that-can-remain-open-until-later-slices), and the checklist is [§22](#22-decision-checklist-for-owner).

---

## 2. Why Phase 6 cannot safely start implementation yet

Phase 6 is not blocked by missing design. It is blocked because four decisions change what gets built, in ways that cannot be retrofitted cheaply:

1. **C1 decides the schema.** Whether `orders` gains an independent deadline, a deadline derived from the reservation, or whether reservations themselves change, determines migration `0019` — the first Phase 6 migration. Migrations are append-only and checksummed (DEVELOPMENT_RULES §3); an applied file is never edited. Getting this wrong means a second migration undoing the first.

2. **C1 also decides whether the late-payment path is an edge case or the normal path.** Under a flat 600-second window it is the routine outcome for slow payers, which raises the quality bar on P6-6 and makes **O7** (refund policy) urgent rather than deferred.

3. **C3 and C4 decide whether P6-3 is possible at all.** As configured, the API returns `403 ORIGIN_NOT_ALLOWED` to every webhook before any controller runs, and the raw bytes required for signature verification are discarded by the JSON parser. Both need a deliberate, narrow change to shared request-handling code — the kind of change that is safe when decided and dangerous when improvised mid-slice.

4. **C10 decides what "late payment" means.** The specification's re-allocation branch is structurally impossible on the Phase 5 schema. Either that deviation is confirmed, or order-line immutability is reopened — a protection introduced on purpose and reviewed twice.

A fifth, softer reason: **C7** has no permission to grant, and `AccessGuard` denies any route with no access policy outright. The reconciliation endpoint cannot be written until its permission exists.

Everything else in this brief can be answered as its slice approaches.

---

## 3. C1 — Payment window vs reservation TTL

### CURRENT FACT

`packages/db/migrations/0009_tickets.sql:68-69`:

```sql
CONSTRAINT reservations_ttl_valid CHECK (
  expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
)
```

- A reservation can never live more than 10 minutes from **its own** creation.
- `expires_at` is **immutable**: `hv_reservations_guard` (`0009:144-147`) includes it in the frozen `ROW(...)` comparison, so an `UPDATE` that changes it raises.
- `RESERVATION_TTL_SECONDS` is `min(2) max(600) default(600)` and is pinned to exactly 600 in production (`apps/api/src/config/env.ts:75, 105`), per D11.
- `orders` has **no** expiry column of any kind (`grep -c expires_at 0016_orders.sql` → 0).
- `ORDER_PAYMENT_WINDOW_SECONDS` does not exist anywhere in the repository.
- An order is always created **after** its reservation: reserve → add to basket → accept terms → answer the skill question → checkout.
- [ADR-0024](adr/0024-settlement-grace-period.md) defines the settlement grace arithmetically as `closes_at + 10-minute reservation TTL + 2 minutes = 12 minutes`.

### PROBLEM

Let the reservation be created at T₀ and the order at T₀+d, where d > 0 is the customer's own basket-and-checkout time. The reservation dies at T₀+600 at the latest. An order payment deadline of 600 seconds from order creation runs to T₀+d+600.

**The deadline outlives the reservation by exactly d — always, not occasionally.**

A payment deadline therefore does not, by itself, guarantee that the tickets are still held for its duration. A customer can be inside their payment window and have no inventory. Since re-allocation is structurally impossible (**C10**), each such case ends at `paid_unfulfillable` and a refund.

### OPTIONS

**Option A — Payment deadline equals reservation expiry.**
`orders.expires_at` is set at order creation to the minimum `expires_at` across the order's locked reservations. One clock, mirrored onto the order so it is immutable and queryable.

**Option B — Payment deadline shorter than the reservation TTL.**
`orders.expires_at = min(created_at + WINDOW, min(reservation.expires_at) − MARGIN)`, with payment initiation refused when the resulting window falls below a configured floor. The reservation always outlives the payment deadline by `MARGIN`.

**Option C — The reservation is extended or held for payment.**
A new migration replaces `reservations_ttl_valid` and relaxes `hv_reservations_guard` so `expires_at` may move forward, under stated conditions (for example: only once, only while an order for it is `awaiting_payment`, only up to a bound). The order then carries a genuinely independent 600-second window.

**Option D — Payment window and reservation lifecycle redesigned together.**
The hold is modelled in two stages: a short pre-checkout hold and an order-scoped hold created at checkout with its own lifetime, possibly as a distinct state or a distinct table. The two clocks become one coherent lifecycle by design rather than by arithmetic.

### TRADE-OFFS

**Option A**

| Dimension        | Consequence                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database         | Smallest change: one immutable column on `orders`, derived at insert. No change to `reservations`, no change to `hv_reservations_guard`, no change to the 10-minute CHECK.                                                        |
| Concurrency      | The two clocks cannot disagree, because there is only one. The **C2** safety predicate becomes near-vacuous — a reservation's expiry and its order's deadline arrive together.                                                    |
| UX               | The window is honest but variable and can be very short: a customer who spent 9 minutes browsing has 60 seconds to pay. The countdown is truthful, which may itself be alarming.                                                  |
| Payment provider | A provider's hosted session may have a minimum practical lifetime; a 40-second window may be unusable, and the customer is sent to a provider they cannot finish with. Needs a floor below which initiation is refused.           |
| Expiry behaviour | Single clock. Order expiry and reservation expiry coincide. Late payment arises only from provider-side delay, not from clock skew.                                                                                               |
| Risks            | Customers bounced late in the flow with little warning. Support load shifts to "I ran out of time".                                                                                                                               |
| Tests            | `orders.expires_at` equals the minimum reservation expiry; initiation refused below the floor; order expiry and reservation expiry observed to coincide; a late provider confirmation still reaches `paid_unfulfillable` cleanly. |

**Option B**

| Dimension        | Consequence                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database         | Same single column, with a derivation rule and a floor. Two configured values (`WINDOW`, `MARGIN`) instead of one.                                                                                                                                           |
| Concurrency      | The reservation is guaranteed to outlive the payment deadline by `MARGIN`, so a payment confirmed inside the deadline finds a live reservation. This removes most late-payment cases arising from clock skew — though not those arising from provider delay. |
| UX               | The refusal is explicit and early ("there is not enough time left to pay; your hold expires in 40 seconds") rather than a surprise after the provider. Still refuses some customers outright.                                                                |
| Payment provider | The minimum window is predictable and can be set to what the chosen provider actually needs — but **O13** has not chosen a provider, so the number is not yet knowable.                                                                                      |
| Expiry behaviour | Two clocks with a deliberate ordering: the order expires, then the reservation.                                                                                                                                                                              |
| Risks            | Two values to keep consistent; a margin chosen too small reintroduces the race, too large shortens every window. The derivation lives in application code, so it is procedural rather than structural.                                                       |
| Tests            | The margin is respected for every order; initiation refused below the floor; the order reaches `expired` before its reservation is swept; the derivation is correct when an order spans reservations with different expiries.                                |

**Option C**

| Dimension        | Consequence                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database         | Large. `reservations_ttl_valid` must be replaced and `hv_reservations_guard` relaxed to let `expires_at` move — the guard currently freezes it. Both are in the most heavily concurrency-tested part of the system (ADR-0011).                                                                                                                                                                            |
| Concurrency      | Extension races the sweep. It must be done under `FOR UPDATE` with `status='active' AND expires_at > now()`, and must fail if the sweep already took the row. `hv_expire_reservations` uses `SKIP LOCKED`, so a locked row is skipped rather than waited on — which helps, but the extension path itself becomes a new race to prove.                                                                     |
| UX               | The full payment window is always available regardless of browsing time. The countdown is both honest and generous. No customer is refused for shopping slowly.                                                                                                                                                                                                                                           |
| Payment provider | A full, predictable window every time, independent of what the customer did beforehand.                                                                                                                                                                                                                                                                                                                   |
| Expiry behaviour | Reservation lifetime becomes variable, up to order creation + window.                                                                                                                                                                                                                                                                                                                                     |
| Risks            | **Reopens ADR-0024.** Its grace is stated arithmetically as "reservation TTL (10 min) + 2 minutes"; reservations that can live longer than 10 minutes invalidate that derivation and the ADR would need amending. Also interacts with D11's production pin, with draw close (a reservation extended past `closes_at` + grace affects settlement eligibility), and with the Gate 1 and Gate 2 assumptions. |
| Tests            | Extension permitted only under its stated conditions; refused after the sweep has taken the row; refused twice; the settlement grace re-derived and ADR-0024 re-validated; Gates 1 and 2 re-run; expiry-vs-extension race proven.                                                                                                                                                                         |

**Option D**

| Dimension        | Consequence                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database         | The largest: potentially new reservation states, a new guard, possibly a new table, and changes to `hv_end_reservation` and `hv_expire_reservations`.                       |
| Concurrency      | The entire P4 ticket engine's concurrency story is re-validated, not extended.                                                                                              |
| UX               | Can be made fully coherent — the model matches what customers experience rather than approximating it.                                                                      |
| Payment provider | Whatever the design chooses; no constraint imposed by legacy arithmetic.                                                                                                    |
| Expiry behaviour | Defined by the new design rather than inherited.                                                                                                                            |
| Risks            | Scope substantially exceeds Phase 6 as bounded in the scope lock. Reopens ADR-0011, ADR-0024, D11 and Gates 1–2 simultaneously. Delays every other Phase 6 slice behind it. |
| Tests            | Full re-run and extension of the ticket-engine suite, both gates, the expiry races, and the settlement grace.                                                               |

### REPOSITORY IMPACT

|                                                    | A          | B          | C          | D       |
| -------------------------------------------------- | ---------- | ---------- | ---------- | ------- |
| `orders` column                                    | yes        | yes        | yes        | yes     |
| `hv_orders_guard` replaced (freeze the new column) | yes        | yes        | yes        | yes     |
| `reservations_ttl_valid` changed                   | no         | no         | **yes**    | **yes** |
| `hv_reservations_guard` changed                    | no         | no         | **yes**    | **yes** |
| `hv_end_reservation` changed                       | no         | no         | no         | likely  |
| `hv_expire_reservations` changed                   | see **C2** | see **C2** | see **C2** | **yes** |
| ADR-0024 amended                                   | no         | no         | **yes**    | **yes** |
| ADR-0011 amended                                   | no         | no         | likely     | **yes** |
| D11 production pin reopened                        | no         | no         | possibly   | **yes** |
| Migration count                                    | 1          | 1          | 2+         | several |

In every option the new column is added to the `hv_orders_guard` frozen set so the deadline is immutable, as OD-1 requires.

### TEST IMPACT

Common to all four: the deadline is immutable once written; a payment confirmed inside the deadline with a live reservation reaches `paid`; a payment confirmed with no live reservation reaches `paid_unfulfillable`; the order reaches `expired` when the deadline passes with nothing succeeded; barrier-synchronised races between finalization and the expiry sweep produce either a clean sale or a clean `paid_unfulfillable`, never a half-sold order.

Options C and D additionally require Gates 1 and 2 to be re-run and the ADR-0024 arithmetic re-derived.

### OWNER DECISION REQUIRED

1. Which of A, B, C or D.
2. If B: the values of `WINDOW`, `MARGIN` and the refusal floor. These depend on how long a real provider flow takes, which **O13** has not settled.
3. Is it acceptable for a customer to be refused payment initiation because they browsed slowly (A and B), or must every customer always get a full window (C and D)?
4. Is `paid_unfulfillable` + refund acceptable as a **routine** outcome rather than an exception? This follows directly from a flat window.
5. May ADR-0024's settlement grace arithmetic be reopened (required by C and D)?
6. May the production pin of `RESERVATION_TTL_SECONDS = 600` (D11) be reopened (possibly by C, certainly by D)?

---

## 4. C2 — Reservation expiry safety

### CURRENT FACT

- `hv_expire_reservations(p_draw_id uuid, p_limit integer)` (`0009:304`) selects `status='active' AND expires_at <= now()`, takes rows `FOR UPDATE SKIP LOCKED` in `ORDER BY entrant_type, entrant_ref, id`, and calls `hv_end_reservation(id, 'expired')` on each.
- It has **two** callers:
  - `apps/worker/src/tickets/reservation-expiry.ts:38` — the global sweep, every 30 seconds (`EXPIRE_INTERVAL_MS`), batches of 500, up to 20 batches per run;
  - `apps/api/src/tickets/tickets.repository.ts:180` — a **per-draw sweep on the API allocation path**.
- The sweeping logic is PL/pgSQL. It cannot make an HTTP call to a payment provider.
- The worker's own header records the gap: _"Phase 6 adds the B9 safety rule: a trusted provider status check before expiring a reservation whose order has a pending payment."_
- B10 states the rule: _"before releasing a reservation whose order has a pending provider payment, the job performs a trusted provider status check. If the provider says the payment succeeded, the payment is confirmed instead of released."_

### PROBLEM

The rule as written in B10 puts a network call inside the sweep. That is not possible in PL/pgSQL, and would be undesirable inside a sweep transaction in any language — it would hold row locks for the duration of a third-party HTTP request.

Implementing the rule only in the worker also leaves the API's per-draw sweep free to release a reservation whose order is mid-payment, so the protection would be silently incomplete.

### OPTIONS

The problem separates into two responsibilities that can be assigned independently.

**Database responsibility — "may this reservation be swept?"** Decidable from data alone, with no provider involved.

- **D1.** Put the predicate inside a replaced `hv_expire_reservations`: skip any reservation whose order is `awaiting_payment` and still inside its payment deadline. Fixes both call sites at once, in one place.
- **D2.** Put the predicate in application code at both call sites. Requires the worker and `tickets.repository.ts` to stay in agreement forever.
- **D3.** Carry an explicit flag or timestamp on `reservations` (for example, "held for payment until"), set when an order is created, and have the sweep respect it.
- **D4.** Change nothing in the sweep; let reservations expire normally and handle every consequence through the late-payment path.

**Provider responsibility — "did this ambiguous payment actually succeed?"** Requires network I/O and must live outside any sweep transaction.

- **P1.** A separate reconciler job (BullMQ repeatable, following `draw-lifecycle.service.ts` and `reservation-expiry.ts`) that finds payments in a non-terminal state, calls `getPaymentStatus()`, and calls the same idempotent `confirmPayment()` the webhook uses.
- **P2.** A status check triggered by the customer's return from the provider — permitted by B10 ("the return page may _trigger_ a check but never marks anything paid itself"), but it cannot be relied upon, because the customer may never return.
- **P3.** Rely on webhook retries alone, with no server-initiated check. Leaves genuinely ambiguous cases (webhook lost, provider outage) unresolved until a human looks.

Any database option may be combined with any provider option; they solve different halves.

### TRADE-OFFS

| Option                         | For                                                                                                                      | Against                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** (predicate in SQL)      | One place; both call sites fixed automatically; no network in a sweep; the database stays authoritative                  | Couples the ticket engine's sweep to the orders table; `hv_expire_reservations` is replaced, and it is covered by the Gate 1/Gate 2 suites                      |
| **D2** (predicate in app code) | The sweep function is untouched                                                                                          | Two call sites must agree indefinitely; a third caller added later silently bypasses the rule; procedural rather than structural                                |
| **D3** (flag on reservations)  | Explicit and readable; the sweep does not need to know about orders                                                      | Adds a mutable column to a table whose guard currently freezes nearly everything; a new write path to race-test; the flag can drift from the order's real state |
| **D4** (no sweep change)       | No change to the ticket engine at all                                                                                    | Every slow payer loses their tickets mid-payment; the volume of `paid_unfulfillable` is then set entirely by **C1**                                             |
| **P1** (reconciler job)        | Deterministic; catches lost webhooks and provider outages; reuses the established repeatable-job pattern; satisfies OD-5 | A new job to build, schedule and monitor; calls a provider on a timer                                                                                           |
| **P2** (return-triggered)      | Immediate feedback for the customer who does return; explicitly sanctioned by B10                                        | Cannot be depended on; the customer may close the tab                                                                                                           |
| **P3** (webhooks only)         | Least to build                                                                                                           | No answer when a webhook is genuinely lost; OD-5 requires a reconciliation path, so this does not satisfy the locked decision on its own                        |

**Transactional consistency, whichever combination is chosen.** Two directions must both hold:

- The sweep must never release a reservation that finalization is about to sell. Finalization holds `SELECT … FOR UPDATE` on the reservation; the sweep uses `SKIP LOCKED` and therefore skips it rather than waiting.
- Finalization must never sell a reservation the sweep has already released. Finalization re-checks `status='active' AND expires_at > now()` **after** taking the lock — this is **C9**, and it is what makes the guarantee hold regardless of which option above is chosen.

The provider call must sit **outside** the transaction in every case: check status first, then open a transaction and apply the result conditionally.

### REPOSITORY IMPACT

- **D1:** a migration replacing `hv_expire_reservations` (the `0010` precedent for replacing a function). Touches a function covered by Gates 1 and 2.
- **D2:** changes to `apps/worker/src/tickets/reservation-expiry.ts` and `apps/api/src/tickets/tickets.repository.ts`. No migration.
- **D3:** a migration adding the column and relaxing `hv_reservations_guard`, plus a write path at order creation.
- **D4:** none.
- **P1:** a new job in `apps/worker`, plus the `payments` status index. No migration beyond `payments` itself.
- **P2:** an API route only.
- **P3:** none.

### TEST IMPACT

- A reservation whose order is `awaiting_payment` and inside its deadline is **not** swept — proven through **both** call sites, not just the worker.
- A reservation whose order deadline has passed **is** swept.
- Finalization racing the sweep on the same reservation, barrier-synchronised: exactly one outcome, no half-sold order, no deadlock (lock order `orders → reservations → entrant counter → tickets`).
- The reconciler is idempotent: running it repeatedly against the same payment has the effect of running it once.
- The provider call is never inside a transaction that holds row locks.
- Gates 1 and 2 still pass if `hv_expire_reservations` is replaced.

### OWNER DECISION REQUIRED

1. Which database option (D1–D4).
2. Which provider option(s) (P1–P3). OD-5 is locked and requires a reconciliation path, so P3 alone does not satisfy it.
3. If D1: confirmation that replacing `hv_expire_reservations` is acceptable, given it is covered by Gates 1 and 2.
4. If P1: how often the reconciler runs, and how far back it looks.

---

## 5. C3 — CSRF vs provider webhooks

### CURRENT FACT

`apps/api/src/app.ts:44-61` installs a Fastify `onRequest` hook that runs before every route:

```ts
if (!SAFE_METHODS.has(request.method)) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.has(origin)) {
    // 403 ORIGIN_NOT_ALLOWED
  }
}
```

`SAFE_METHODS` is `GET`, `HEAD`, `OPTIONS`. `allowedOrigins` comes from `WEB_ORIGINS`, which in production must be `https://` (`env.ts:98`). The comment cites Revision 2 B19 and pairs the check with `SameSite=Lax` session cookies.

A provider webhook is a server-to-server `POST` and **sends no `Origin` header**. It is refused with 403 before reaching any controller, guard or signature check.

### PROBLEM

No webhook can be received. P6-3 cannot function. The change needed is to shared request-handling code that protects every other route in the API, so it must be made deliberately rather than improvised.

### Why these are different problems

They defend against different attackers and rely on different evidence.

**Browser CSRF** defends against the _confused deputy_. The attacker cannot read the victim's cookie, but the browser will attach it automatically to any request to our origin — including one triggered by a page the attacker controls. The defence checks **provenance**: did this request come from a page we trust? `Origin` is evidence only a browser can supply honestly, because a browser sets it and script cannot forge it. The request's _content_ is irrelevant; the ambient credential is the problem.

**Webhook authentication** defends against _forgery_. There is no victim session, no cookie and no ambient credential — a webhook carries no authority at all until it proves it. Anyone on the internet can POST to the endpoint. The defence checks **authenticity of content**: was this exact byte sequence produced by someone holding the shared secret? Provenance is worthless here, because the legitimate sender is a server with no browser context to report.

So the two mechanisms check properties that the other party structurally cannot provide:

|                                           | Browser request                                                        | Provider webhook                 |
| ----------------------------------------- | ---------------------------------------------------------------------- | -------------------------------- |
| Ambient credential attached automatically | yes (cookie)                                                           | no                               |
| Can supply a trustworthy `Origin`         | yes                                                                    | no                               |
| Can hold a shared secret                  | **no** — anything in the browser is readable by the user and by script | yes                              |
| Threat                                    | our own user's browser used against them                               | an impostor posting a fake event |
| Correct evidence                          | provenance                                                             | content signature                |

Applying CSRF to a webhook checks a property the sender cannot have, so it fails every legitimate request. Applying signature authentication to browser requests is impossible, because the browser cannot keep a secret.

Exempting `/webhooks/` from the origin check therefore removes **no** protection from that route — it had none to lose, having no cookie and no session — provided the signature check genuinely replaces it. The exemption is only safe while that holds, and only while it is narrow.

### OPTIONS

**Option 1 — Path-prefix exemption in the existing hook.** Skip the origin check when the URL starts with `/webhooks/`, leaving everything else unchanged.

**Option 2 — Separate webhook pipeline within the same app.** Register webhook routes through a distinct Fastify plugin scope with its own hooks, so the CSRF hook never applies to them by construction rather than by condition.

**Option 3 — A separate process or application for webhooks.** Webhooks are received by their own service with its own middleware stack, sharing only the database.

**Option 4 — Move the check from the global hook into the access policy.** The origin requirement becomes part of `AccessGuard`'s policy handling, so a route declaring webhook access opts out declaratively, alongside how `@Public()` already works.

### TRADE-OFFS

| Option | For                                                                                                                                 | Against                                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Smallest diff; one readable condition; easy to test in both directions                                                              | An exemption expressed as a string prefix can be widened casually by a later reader; the protection remains a global hook with a hole in it                                                              |
| **2**  | The exemption is structural — webhook routes are in a scope the hook was never registered on; no string matching                    | More Fastify plugin structure than the codebase currently uses; two hook stacks to keep aligned for the headers set in `onSend`                                                                          |
| **3**  | Strongest isolation; a webhook cannot reach customer routes even by misconfiguration; can be scaled and rate-limited separately     | A new deployable, new configuration, new health checks and CI wiring; Docker Compose and the deployment story both change; substantially more than Phase 6 needs for one route                           |
| **4**  | Consistent with the existing deny-by-default policy model; the exemption is declared on the route with the rest of its access rules | Moves CSRF enforcement from a hook that currently runs before routing into guard execution, which changes when it runs relative to body parsing — needs care, since **C4** also depends on that ordering |

All four require the same test pair: a webhook POST with no `Origin` is admitted, and a POST to any non-webhook route with no `Origin` is still refused.

### REPOSITORY IMPACT

- **Option 1:** `apps/api/src/app.ts` only.
- **Option 2:** `apps/api/src/app.ts` plus the webhook module's registration; the `onSend` security headers must be applied to both scopes.
- **Option 3:** a new app under `apps/`, workspace and CI changes, Docker Compose, deployment configuration.
- **Option 4:** `apps/api/src/app.ts` and `apps/api/src/rbac/access.guard.ts` plus the access-policy types — a change to the security boundary ADR-0009 calls the authoritative one.

No migration in any case.

### TEST IMPACT

- Webhook POST without `Origin` → reaches the handler.
- Non-webhook POST without `Origin` → still 403 `ORIGIN_NOT_ALLOWED`.
- Webhook POST with a hostile `Origin` → still reaches the handler (correct: the signature decides, not the origin).
- Non-webhook POST with a hostile `Origin` → still 403.
- The `onSend` security headers (`x-content-type-options`, `x-frame-options`, `referrer-policy`, `cache-control`) are still applied to webhook responses.
- The exemption does not match near-miss paths (for example `/webhooksfoo`).

### OWNER DECISION REQUIRED

1. Which option.
2. Confirmation that the exemption is narrow, documented in code with the reasoning above, and tested in both directions.

---

## 6. C4 — Raw body and signature verification

### CURRENT FACT

- `apps/api/src/app.ts:33` sets `bodyLimit: 64 * 1024` on the `FastifyAdapter`, globally.
- The API registers **no** `addContentTypeParser` and no raw-body plugin (`grep -rn "addContentTypeParser|rawBody" apps/api/src` → no matches). Fastify's default JSON parser consumes the body and the original bytes are discarded.
- B19 requires: _"Signatures are verified against the raw body."_
- B10's interface takes raw bytes: `verifyWebhook(rawBody: Buffer, headers: Headers): Promise<VerifiedEvent>` — _"throws on bad signature"_.

### PROBLEM

Signature verification is impossible as the application is configured. A JSON parse-and-re-serialise round trip changes bytes — key order, whitespace, number formatting, Unicode escapes — and every provider's signature is computed over the exact bytes sent. Verifying against re-serialised JSON fails for valid requests and, worse, could be made to pass for crafted ones.

Separately, a payload above 64 KB is rejected with a body-limit error that looks nothing like a signature failure, which would be diagnosed as the wrong problem.

### OPTIONS

The question is what minimum framework capability Phase 6 needs. The capability decomposes into five parts, each with choices.

**Raw body availability**

- **R1.** A content-type parser registered only for the webhook route's scope, storing the `Buffer` and parsing JSON separately for the handler.
- **R2.** A global raw-body capture that keeps the buffer alongside the parsed body for every request.
- **R3.** A webhook handler that declares no body parsing at all and reads the request stream itself.

**Maximum payload handling**

- **M1.** A per-route `bodyLimit` for the webhook route, set explicitly and independently of the global 64 KB.
- **M2.** Raise the global `bodyLimit`.
- **M3.** Keep 64 KB and treat an oversized payload as a definitive rejection.

**Signature verification boundary**

- **S1.** Verify in the route handler, before any database access and before parsing.
- **S2.** Verify in a guard or hook that runs before the handler.

**Malformed payload behaviour**

- **F1.** 4xx, recorded, never retried — a body that cannot be verified or parsed will not become valid on retry.
- **F2.** 5xx, inviting the provider to retry.
- **F3.** 4xx for unverifiable signatures, 5xx only for our own processing failures.

### TRADE-OFFS

| Choice                      | For                                                                                      | Against                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **R1** (scoped parser)      | Only the webhook route pays the cost; no other route's parsing changes                   | Requires the route to be in a scope where a parser can be registered, which interacts with the **C3** option chosen              |
| **R2** (global capture)     | Simple and uniform                                                                       | Every request in the system retains a second copy of its body in memory, for one route's benefit                                 |
| **R3** (manual stream read) | No parser registration at all                                                            | Hand-rolled stream handling, including the size limit, which the framework already does correctly                                |
| **M1** (per-route limit)    | The webhook's limit is a deliberate, visible number; the rest of the API keeps its 64 KB | One more configured value                                                                                                        |
| **M2** (raise global)       | One value                                                                                | Raises the limit for every route, including ones with no reason to accept large bodies                                           |
| **M3** (keep 64 KB)         | No change                                                                                | If a real provider exceeds it, this is discovered in production as a signature-shaped failure                                    |
| **S1** (verify in handler)  | Explicit, readable, obviously before any state is touched                                | Discipline-dependent: a future handler could read state first                                                                    |
| **S2** (verify in a guard)  | Structural — the handler cannot run unverified                                           | Guards run after body parsing in Nest/Fastify, so the raw buffer must already be preserved; ordering must be proven, not assumed |
| **F1**                      | A permanently invalid request is not retried forever                                     | A transient bug of ours could be misclassified as malformed and the event lost                                                   |
| **F2**                      | Nothing is lost                                                                          | A genuinely malformed payload is retried indefinitely                                                                            |
| **F3**                      | Distinguishes their fault from ours, which is the distinction that matters for retries   | Requires the handler to classify failures carefully                                                                              |

**Memory and security considerations, independent of the choices:**

- The raw buffer is bounded by whatever `bodyLimit` applies; an unbounded read is never acceptable.
- The raw buffer must not outlive the request handler unless **C5/OD-7a** decides it is retained, in which case it is sealed.
- The raw body is never logged, and the provider's signature header is added to the pino redaction list (`app.module.ts:41` currently redacts `authorization`, `cookie`, `set-cookie`).
- Signature comparison is constant-time. This is a property of the comparison, not of any particular provider's algorithm.
- The raw bytes are never re-serialised before verification.
- Verification failures return a generic response that does not distinguish "unknown provider", "bad signature" and "unknown reference" — see **C3** and the enumeration concerns in the scope lock §14.

**No provider-specific signature algorithm is proposed here.** The port takes `(rawBody, headers)` and throws; what happens inside is the adapter's business, and the fake provider's HMAC is a test implementation, not a template for a production provider.

### REPOSITORY IMPACT

`apps/api/src/app.ts` and the webhook module. Possibly `apps/api/src/app.module.ts` for the redaction list. No migration. The choice interacts with **C3**: options that isolate the webhook pipeline (C3 option 2 or 3) make R1 and M1 natural; a path-prefix exemption (C3 option 1) leaves the parser registration to be scoped some other way.

### TEST IMPACT

- A valid signature over the exact bytes verifies.
- A body altered by one byte fails.
- A body that is semantically identical but re-serialised (different key order or spacing) fails — proving the raw bytes are what is checked.
- A missing signature header fails.
- A payload at the limit succeeds; one over the limit produces a distinguishable error, not a signature failure.
- A malformed body behaves per the chosen F option.
- Verification happens before any database read, proven by a test in which the database is unavailable and an invalid signature is still rejected correctly.

### OWNER DECISION REQUIRED

1. One choice from each of R, M, S, F.
2. The webhook route's body limit value, if M1.
3. Confirmation that the signature header name is added to log redaction once a provider is chosen (**O13**).

---

## 7. C5 — Raw provider payload retention

### CURRENT FACT

- B18 (`PROJECT_INITIALIZATION_REPORT.md:696`) specifies `payment_events` as: `UNIQUE(provider, provider_event_id)`; **raw payload**; `processed_at`; append-only.
- B19 (`:565`) lists `payment_events` among the tables where `hv_app` has `UPDATE/DELETE` revoked.
- `PHASE_6_SCOPE_LOCK.md` OD-7 locks: no card numbers, CVV, bank credentials, access tokens or secrets; store only what is needed for signature verification, event idempotency, reconciliation, audit and debugging; normalized data preferred where raw retention is not necessary; if raw is retained, document reason, sensitive fields, protection, retention and access.
- The repository already solves this class of problem: ADR-0028 seals sensitive outbox payloads with AES-256-GCM because an outbox row cannot be redacted afterwards. `SecretBox`, `sealPayload`, `openPayload` and `isSealedPayload` are exported from `@hv/domain` (`packages/domain/src/index.ts:13, 25`).
- No payment table exists yet, so nothing is being stored today.

### PROBLEM

Two things are in tension. B18 asks for the raw payload; OD-7 asks for normalized data where raw retention is not necessary. And because `hv_app` will have no `DELETE` on `payment_events`, whatever goes into those rows is permanent as far as the application is concerned — there is no later redaction.

This is a deliberate deviation from the written specification either way, and it is recorded as one rather than presented as compliance.

### OPTIONS

**Option 1 — Normalized only.** Store provider, event id, event type, provider reference, amount, currency, provider status. Discard the raw payload after verification.

**Option 2 — Normalized plus sealed raw.** As above, plus the raw payload encrypted with `sealPayload`/`SecretBox`, opened only by an operator tool.

**Option 3 — Normalized plus plaintext raw.** As B18 reads literally.

**Option 4 — Normalized plus a redacted raw subset.** Retain the raw structure with named sensitive fields removed before storage.

### TRADE-OFFS

| Option | For                                                                                                                               | Against                                                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Nothing sensitive can be retained, because nothing raw is retained. Smallest surface.                                             | In a provider dispute there is no byte-level record of what was actually sent. Debugging an unexpected event shape is limited to what we thought to normalize.                                                    |
| **2**  | Byte-level record kept for disputes; nothing sensitive readable without the key; consistent with ADR-0028's established reasoning | A second use of the encryption key, and key rotation now affects two subsystems; opening a payload needs an operator path that must itself be audited                                                             |
| **3**  | Literal B18 compliance; simplest to read and debug                                                                                | Permanent plaintext PII in rows the application cannot delete; conflicts with OD-7 as locked                                                                                                                      |
| **4**  | Retains structure without the sensitive parts                                                                                     | Redaction requires knowing every provider's field names in advance — and **O13** has not chosen a provider, so the list cannot be complete; a field added by the provider later is retained unredacted by default |

### REPOSITORY IMPACT

Determines the `payment_events` schema in the P6-3 migration, and therefore must be settled before that migration is written. Options 2 and 4 add an operator path for reading stored payloads, which needs its own authorization (see **C7**). Option 2 ties `payment_events` to `OUTBOX_ENCRYPTION_KEY` or to a separate key.

An ADR recording the deviation from B18 is needed under every option except 3.

### TEST IMPACT

- A stored event round-trips: what is written can be read back and matched to its payment.
- Under option 2: the sealed payload is unreadable without the key; sealing is non-deterministic; a payload sealed for one topic or key does not open under another (the existing `sealed-payload.test.ts` patterns).
- Under any option: no card number, CVV, credential or token appears in any column, proven against fake-provider payloads deliberately containing such fields.
- Payload contents never appear in logs at any level.
- `hv_app` cannot `DELETE` from `payment_events` — asserted for real, following the P5-6 fix that made privilege assertions non-vacuous.

### OWNER DECISION REQUIRED

Carried to [§17](#17-od-7a--raw-payload-retention), which states the question in the form it needs to be answered.

---

## 8. C6 — Gate 4 boundary

### CURRENT FACT

Critical gate 4 (`PROJECT_INITIALIZATION_REPORT.md:609`):

> 4. The same webhook ×10 in parallel, plus out-of-order delivery → one payment transition, one ticket sale and **one credit**.

Part F's P6 row (`:796`): _"`packages/payments`, fake provider, payment records, webhook ingestion, confirm, status poller, late-payment path, refund skeleton | **Gate 4**; the redirect cannot mark paid (test)"_.

- "one credit" refers to an instant-win wallet credit. Instant wins are **P8** (Gate 6); the wallet is **P7** (Gate 3).
- B10 places instant-win evaluation inside the **same** finalization transaction as the ticket sale.
- `orders.wallet_applied_minor` exists, defaults to 0, and is constrained by `orders_totals_add_up`. No wallet table exists.

### PROBLEM

Phase 6 cannot satisfy the "one credit" clause, because there is nothing to credit. Reporting Gate 4 as passed without qualification would overstate what was proven.

### OPTIONS

**Option 1 — Gate 4 in Phase 6 covers "one payment transition and one ticket sale"; the credit clause is explicitly deferred to Gate 6 in P8**, recorded in `PROJECT_STATUS.md` at phase close.

**Option 2 — Gate 4 is not signed off until P8**, and Phase 6 closes with Gate 4 partially demonstrated.

**Option 3 — Phase 6 includes enough instant-win scaffolding to exercise the credit clause.** This moves P8 functionality into Phase 6.

### TRADE-OFFS

| Option | For                                                                                   | Against                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Phase 6 closes on what it can genuinely prove; the deferral is explicit and traceable | A gate is recorded as met in two parts across two phases, which must be tracked so the second part is not forgotten                                   |
| **2**  | No gate is ever recorded as partially met                                             | Phase 6 closes without its named gate, which complicates the phase-completion criteria in Part F                                                      |
| **3**  | Gate 4 is met in full, exactly as worded                                              | Moves Phase 8 work into Phase 6, which the task instruction explicitly rules out, and requires wallet infrastructure from Phase 7 that does not exist |

### REPOSITORY IMPACT

No code impact. Affects the Phase 6 Definition of Done, and the wording in `PROJECT_STATUS.md` and `TASK_BOARD.md` at phase close.

**Wording to correct in `PHASE_6_SCOPE_LOCK.md` later** (not corrected now — this brief modifies no other document):

1. §24 item **G4.4** already defers the credit clause. It is consistent with Option 1 and needs no change under that option; under Option 2 or 3 it does.
2. §26 lists **O5** among "pre-existing open questions". **O5 is closed** by ADR-0024. See [§18](#18-o5--settlement-grace-period).
3. §26's O5 row says option (c) of C1 "would change what 'reservation TTL' means". That is accurate but understated: it would require **amending ADR-0024**, an accepted decision, not merely reinterpreting a term.
4. P6-4's blocker list in §22 cites **C6, C8, C9**; if Option 2 is chosen, Gate 4 sign-off moves out of P6-9 entirely and §22 and §24 both need updating.

### TEST IMPACT

Under Option 1, Gate 4 in Phase 6 is proven by: the same webhook ×10 in parallel → one payment transition and one ticket sale; out-of-order delivery → one deterministic outcome; and the redirect cannot mark an order paid. The credit clause is carried forward as a Gate 6 obligation.

### OWNER DECISION REQUIRED

1. Which option.
2. If Option 1: confirmation that the deferral is recorded in `PROJECT_STATUS.md` when Phase 6 closes, so Gate 6 inherits it.

---

## 9. C7 — Payment authorization

### CURRENT FACT

`packages/db/migrations/0006_rbac.sql` seeds these permissions: `admin.access`, `customers.read`, `orders.read`, `customers.pii.read`, `fulfilment.write`, `postal_entries.write`, `refunds.create`, `wallet.adjust`, `draws.write`, `instant_wins.write`, `settlement.retry`, `reports.read`, `reports.export`, `roles.manage`, `markets.gate.manage`, `config.manage`.

Relevant grants (`0006:80-106`):

- `orders.read` → `support`, `fulfilment`, `finance`, `admin`, `super_admin`
- `refunds.create` → **`finance`, `super_admin` only**; described as "Sensitive operation"
- `settlement.retry` → `admin`, `super_admin`; "Sensitive operation"

**No payment permission of any kind exists.**

Conventions, verified:

- `AccessGuard` (`apps/api/src/rbac/access.guard.ts`) is a global guard. **A route with no access policy is refused** — `logger.error("route … has no access policy — denied")` then 403.
- Policy kinds: `public` (optionally `identify`), `authenticated` (optionally `allowMfaPending`), and `permission` with a scope.
- A `sensitive` permission additionally requires step-up MFA within `STEP_UP_WINDOW_MS`.
- `@Public({ identify: true })` is the only branch that resolves a guest; every authorization path below it ignores `hvGuest` entirely (ADR-0029).
- Customer order access is **ownership**, not RBAC: `CheckoutService.getOrder` compares `buyerOf(identity)` with the order's buyer and returns **404** on mismatch (`checkout.service.ts:180-187`).
- `buyerOf` throws `VERIFICATION_REQUIRED` for a guest whose verified email is older than `GUEST_VERIFIED_EMAIL_TTL_MINUTES` (`:384-389`).

### PROBLEM

Five distinct actors need to reach payment functionality, and they authenticate by four different mechanisms. Three of them are already covered by existing conventions; one has no permission to grant; one is deliberately unauthenticated.

### OPTIONS

**By actor:**

| Actor                                                     | Mechanism available today                                                                   | Gap                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Customer initiating payment for their own order**       | `@Public({ identify: true })` + `MarketGuard` + ownership check → 404 on mismatch           | **None.** Identical to how checkout and `getOrder` already work. No permission needed or appropriate — RBAC in this codebase is staff-only; `customer` has no back-office permissions by design (`0006:107` comment). |
| **Guest initiating payment for their own verified order** | guest session + `hasFreshVerifiedEmail` within 30 minutes                                   | **None at initiation** — initiation happens shortly after checkout, inside the window. The gap is at _return_, which is **OD-2a**, not this item.                                                                     |
| **Webhook / provider callback**                           | `@Public()` **without** `identify`                                                          | **None.** The signature is the authentication (invariant I13, and see **C3**). Adding any identity here would be incorrect.                                                                                           |
| **Admin/operator reconciliation**                         | nothing                                                                                     | **A permission must be created.**                                                                                                                                                                                     |
| **Admin/operator refund**                                 | `refunds.create`, already seeded, already sensitive, granted to `finance` and `super_admin` | **None for Phase 6** — Phase 6 raises refunds automatically (system actor, no permission), and admin-initiated refunds are P10.                                                                                       |

**For the one gap, options:**

- **Option 1 — One new permission** covering re-checking a payment and applying the provider's result.
- **Option 2 — Two permissions**, separating read (view payment detail beyond `orders.read`) from act (trigger reconciliation).
- **Option 3 — Reuse an existing permission.** `settlement.retry` is the nearest in shape ("retry an automated process") but is about settlement, which is Phase 9; `config.manage` is unrelated.
- **Option 4 — No operator permission in Phase 6.** Only the automatic reconciler exists; ambiguous payments wait for the next poll.

### TRADE-OFFS

| Option | For                                                                                                               | Against                                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | One concept, one grant decision; matches how `settlement.retry` and `refunds.create` are each a single permission | Reading payment detail and changing an order's status are bundled, so anyone who can look can also act                                                                                          |
| **2**  | Support can investigate without being able to move an order to `paid`                                             | Two permissions and two grant lists for one feature; `orders.read` already covers most of what support needs to see                                                                             |
| **3**  | No new permission                                                                                                 | `settlement.retry` is Phase 9's concept; granting it to reach payments would misstate what the role can do, and it is granted to `admin`/`super_admin` rather than `finance`                    |
| **4**  | Nothing to decide now; smallest surface                                                                           | OD-5 is locked and states that reconciliation must not require an operator to edit state in SQL. With no operator path, a payment the poller cannot resolve has no sanctioned manual resolution |

**PROPOSED MINIMUM SET** (label: **PROPOSED** — this is a proposal for the owner to accept, amend or reject, not a decision):

| Permission           | Description                                                                     | Sensitive | Grants                            |
| -------------------- | ------------------------------------------------------------------------------- | --------- | --------------------------------- |
| `payments.reconcile` | Re-check a payment with the provider and apply the result. Sensitive operation. | yes       | `finance`, `admin`, `super_admin` |

Reasoning offered for the owner to test: it is sensitive because a successful reconciliation moves an order to `paid` and sells tickets, which is the same class of consequence as `refunds.create`. The grant list mirrors `refunds.create` (`finance`, `super_admin`) plus `admin`, on the basis that reconciliation is an operational recovery action rather than a financial one. Whether `support` — who already hold `orders.read` — should be included is precisely the question in Option 2.

No permission is proposed for viewing payments: `orders.read` already exists and is granted to all five staff roles.

### REPOSITORY IMPACT

A seed migration inserting into `permissions` and `role_permissions`, following the `0006` pattern. Required before the reconciliation endpoint can exist at all, because `AccessGuard` denies any route with no policy. Needed by **P6-5**.

If Option 2 is chosen, two permissions and two grant lists.

### TEST IMPACT

- Deny-by-default: the reconciliation route without the permission → 403.
- A role without the grant → 403; with the grant → allowed.
- Sensitive: without fresh step-up MFA → step-up required; with it → allowed.
- Market scope: a grant scoped to UK does not reach an IE order.
- The customer and guest initiation paths need **no** permission and are unaffected — proven by a customer with no staff role successfully paying for their own order.
- The webhook route resolves no identity at all: a request carrying a valid staff session is treated no differently from one with none.
- Every reconciliation writes an `audit_log` row with the actor, action, before/after status and `request_id`.

### OWNER DECISION REQUIRED

1. Which option (1–4).
2. If 1 or 2: the permission code(s), description(s), whether sensitive, and the exact role grants — specifically whether `support` is included.
3. Confirmation that no permission is introduced for customer or guest payment initiation, keeping RBAC staff-only.

---

## 10. C8 — Reservation sold state

### CURRENT FACT

- `reservations_status_valid CHECK (status IN ('active', 'released', 'expired'))` (`0009:55`).
- `hv_reservations_guard` permits only `active → released | expired` (`0009:151-153`, re-created in `0017:105`). Any other transition raises `reservations_status_transition`.
- `hv_end_reservation(p_reservation_id, p_status)` rejects any status other than `'released'` or `'expired'` (`0010`).
- `hv_end_reservation` frees tickets with `UPDATE tickets SET status='available', reservation_id=NULL WHERE reservation_id = r.id AND status='reserved'`, captures `GET DIAGNOSTICS freed = ROW_COUNT`, and returns cap allowance **only for rows actually freed** (`IF freed > 0 THEN …`). This is the NB-1 fix.
  - Consequence, verified: called on a reservation whose tickets are already `sold`, it frees **0** rows and returns **no** cap allowance. Sold tickets keep counting against the entrant's cap — which is the intended behaviour, and the function's own comment says so.
- `REVOKE DELETE, TRUNCATE ON tickets, reservations, draw_entrant_counts FROM hv_app` (`0009`). **Reservations cannot be deleted by the application.**
- `order_items.reservation_id` is `NOT NULL` with `UNIQUE (reservation_id)` and a composite FK `(reservation_id, draw_id) → reservations (id, draw_id)` (`0016`). The link from order to reservation is permanent.
- `tickets_status_valid CHECK (status IN ('available', 'reserved', 'sold'))` — there is no `'void'` value.

### PROBLEM

After finalization marks tickets `sold`, the reservation still exists and is still `active`. The only words available to end it are "released" or "expired", both of which read, in reports and support tooling, as _the customer did not buy_.

The question is whether Phase 6 actually needs a new reservation state, or whether the existing vocabulary is sufficient given that the order record carries the history.

### OPTIONS

**Option 1 — End as `'released'` after selling.** No migration. `hv_end_reservation(id, 'released')` frees nothing (tickets are `sold`, not `reserved`), returns no cap allowance, and sets `ended_at`.

**Option 2 — Add a `'converted'` (or `'sold'`) status.** A migration replacing `reservations_status_valid`, `hv_reservations_guard` and `hv_end_reservation` to permit and handle the new terminal state.

**Option 3 — Do not end the reservation; let the sweep collect it.** Finalization sells the tickets and leaves the reservation `active`; within 30 seconds `hv_expire_reservations` marks it `'expired'`, freeing 0 and returning no allowance.

**Option 4 — Remove the reservation.** Not available: `hv_app` has `DELETE` revoked on `reservations`, and `order_items.reservation_id` is a `NOT NULL` FK to it.

### TRADE-OFFS

| Option | For                                                                                                                                                                                                                    | Against                                                                                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | No migration; the concurrency-critical `hv_end_reservation` is untouched; cap accounting is already structurally correct for this case; finalization ends the reservation deterministically inside its own transaction | "Released" is misleading vocabulary in reports and support screens; a future reader could conclude the sale did not happen                                                                                                                               |
| **2**  | Honest vocabulary; the state machine says what actually occurred; reporting and support tooling need no explanatory comment                                                                                            | Touches `hv_end_reservation` and `hv_reservations_guard` — the most concurrency-tested function and trigger in the system, covered by Gates 1 and 2 — for a naming benefit; also interacts with **C2** if the sweep's predicate changes at the same time |
| **3**  | Finalization does less                                                                                                                                                                                                 | Leaves a window in which a reservation looks live although its tickets are sold; the terminal state is `'expired'`, which is more misleading than `'released'`; makes the outcome depend on a background job rather than the finalizing transaction      |
| **4**  | —                                                                                                                                                                                                                      | Structurally impossible                                                                                                                                                                                                                                  |

**On "preserve order/payment history independently":** this already holds under every option. `order_items` records `reservation_id`, `draw_id`, `quantity`, `currency`, `unit_price_minor`, `total_minor` and the skill answer, and is immutable (`hv_order_items_guard` raises on any UPDATE; `hv_app` has UPDATE/DELETE revoked). The sale's history does not depend on the reservation's end state. What the reservation's status affects is how the _hold_ reads, not whether the _purchase_ is recorded.

**On cap correctness:** under options 1, 2 and 3 alike, sold tickets keep consuming the entrant's cap, because `hv_end_reservation` returns allowance only for rows it actually moved back to `available`. Option 2 must preserve that property explicitly when the function is rewritten — it is the NB-1 invariant, and it is the one thing that must not regress.

### REPOSITORY IMPACT

- **Option 1:** none beyond finalization's own code.
- **Option 2:** a migration replacing the CHECK, `hv_reservations_guard` and `hv_end_reservation`; `0017` already re-created that guard once, so a third version would exist. Gates 1 and 2 re-run.
- **Option 3:** none, but couples finalization's correctness to the sweep's schedule.
- **Option 4:** not available.

### TEST IMPACT

- After finalization: tickets are `sold`; the reservation is in its chosen terminal state; `ended_at` is set.
- **The entrant's cap counter is unchanged by ending a sold reservation** — no allowance returned (invariant I20).
- The cap key used is the one **stored on the reservation**, which may have been re-keyed `email → user` by ADR-0021 bridging (`0017`). It is never re-derived from the buyer.
- Ending is idempotent: a second call changes nothing and returns false.
- Under Option 2: the new transition is permitted, every other transition still raises, and Gates 1 and 2 still pass.
- Under Option 3: a test covering the window between sale and sweep, asserting nothing else can act on the reservation meanwhile.

### OWNER DECISION REQUIRED

1. Which option (1–3).
2. If Option 2: the status value's name, and confirmation that rewriting `hv_end_reservation` a second time is acceptable given its Gate 1/Gate 2 coverage.

---

## 11. C9 — Expired-but-unswept reservations

### CURRENT FACT

`hv_tickets_guard` (`0009:164-196`) permits these transitions:

```
available → reserved
reserved  → available
reserved  → sold     (requires NEW.reservation_id = OLD.reservation_id)
```

and then:

```sql
IF NEW.status = 'reserved' AND NOT EXISTS (
     SELECT 1 FROM reservations r
      WHERE r.id = NEW.reservation_id AND r.status = 'active' AND r.expires_at > now()
   ) THEN … RAISE …
```

The liveness check fires **only when `NEW.status = 'reserved'`**. It does not apply to `reserved → sold`.

Expiry is logical, not physical: a reservation is expired the instant `expires_at <= now()`, but the row still says `status='active'` until a sweep collects it. The worker sweeps every `EXPIRE_INTERVAL_MS = 30_000` (`reservation-expiry.ts:20`).

### PROBLEM

In the window between a reservation's `expires_at` and the sweep that collects it — up to 30 seconds, and longer if the worker is down or backlogged — the database will permit `reserved → sold` on tickets held by a logically expired reservation.

**The schema does not backstop this.** If finalization does not check, tickets are sold from a hold the system considers dead, and those same ticket numbers may be re-sold to someone else moments later when the sweep frees them.

### The invariant

> **Finalization must independently verify, for every reservation it is about to sell, that the reservation is `status = 'active'` AND `expires_at > now()`, having first taken a row lock on it, inside the same transaction that marks the tickets `sold` and moves the order's status.**

It may not rely on the expiry worker, on the API's per-draw sweep, on a value read earlier in the request, or on the ticket guard.

### The required PostgreSQL transaction boundary

The database runs at READ COMMITTED (the codebase default; nothing sets otherwise). Relevant properties:

1. **A plain `SELECT` is not a guarantee.** At READ COMMITTED each statement sees its own snapshot, so a row read without a lock may be changed and committed by another transaction before the next statement runs. Reading `expires_at` and then selling is a check-then-act race.

2. **`SELECT … FOR UPDATE` is the boundary.** It takes a row-level lock held until the transaction ends, and — importantly at READ COMMITTED — it re-reads the **latest committed** version of the row, waiting if another transaction holds it. So the values checked after `FOR UPDATE` are current, not snapshot-stale.

3. **The sweep will not fight it.** `hv_expire_reservations` selects `FOR UPDATE SKIP LOCKED`, so a reservation locked by finalization is skipped for that batch rather than waited on. Conversely, if the sweep took the row first, finalization's `FOR UPDATE` blocks until the sweep commits and then sees `status='expired'` — and refuses.

4. **`now()` is transaction start time.** In PostgreSQL `now()` is `transaction_timestamp()`, fixed for the whole transaction. Finalization and `hv_expire_reservations` therefore both evaluate `expires_at` against a stable point, and a long-running finalization cannot have the boundary move underneath it mid-transaction. Using `clock_timestamp()` instead would make the check drift within a transaction.

5. **Everything in one transaction.** The lock, the liveness check, the ticket update, the reservation ending, the order status change, the audit row and the outbox row all commit together or not at all. Splitting any of them across transactions reintroduces the race that the lock exists to remove.

6. **Lock order.** `orders → reservations → entrant counter → tickets`. `hv_expire_reservations` iterates `ORDER BY entrant_type, entrant_ref, id` specifically so concurrent sweepers cannot deadlock on counter rows; finalization must not invert that ordering.

7. **The row count is part of the check.** `UPDATE tickets SET status='sold' WHERE reservation_id = $r AND status='reserved'` must affect exactly the line's quantity. A smaller number means something else already moved those tickets, and the transaction must not commit a partial sale.

### OPTIONS

This is an implementation invariant, not a choice of design. The only genuine option is where the check is additionally reinforced:

- **Option 1 — Application check only**, as described above.
- **Option 2 — Application check plus a schema backstop**: extend `hv_tickets_guard` so `reserved → sold` also requires the reservation to be `active` and unexpired.
- **Option 3 — Application check plus finalization expressed as a database function**, so the lock, check and updates cannot be separated by a caller.

### TRADE-OFFS

| Option | For                                                                                          | Against                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | No migration; the check sits where the business decision is made                             | Procedural — a future code path that sells tickets without the check is not stopped by anything                                                                                             |
| **2**  | Structural: the database refuses the unsafe sale regardless of caller                        | Modifies `hv_tickets_guard`, which is on the hot path of every allocation and is covered by Gates 1 and 2; also needs care that it does not forbid legitimate sales at the boundary instant |
| **3**  | The sequence is atomic by construction and reusable from both the webhook and the reconciler | Substantial PL/pgSQL; the outbox and audit writes would either move into it or be split out; harder to unit-test than TypeScript                                                            |

### REPOSITORY IMPACT

- **Option 1:** finalization code in `apps/api` (and whatever the reconciler shares with it). No migration.
- **Option 2:** a migration replacing `hv_tickets_guard`.
- **Option 3:** a migration adding the function, plus a decision about where audit and outbox writes live.

### TEST IMPACT

- **A sale from a reservation past `expires_at` but still `status='active'` is refused** — the test must construct exactly this state, which needs a short `RESERVATION_TTL_SECONDS` (the suite already does this: `cart.int.test.ts:487` and `reservations.int.test.ts:310` use `'2'`) and must run with the sweep disabled or not yet fired.
- A sale from a reservation the sweep has already expired is refused.
- Barrier-synchronised race: finalization and the sweep on the same reservation → exactly one outcome, never a half-sold order, no deadlock.
- A partial ticket update (fewer rows than the quantity) aborts the transaction.
- Under Option 2: the guard refuses the unsafe transition when attempted in raw SQL, bypassing the application entirely.
- Gates 1 and 2 still pass under Options 2 and 3.

### OWNER DECISION REQUIRED

1. Confirmation of the invariant as stated.
2. Which reinforcement option (1–3), and if Option 2, whether modifying `hv_tickets_guard` is acceptable given its Gate 1/Gate 2 coverage.

---

## 12. C10 — B10 re-allocation

### CURRENT FACT

B10's late-payment rule (`PROJECT_INITIALIZATION_REPORT.md:342-346`):

> **Late payment** (confirmed after the reservation was released):
>
> - If the draw is still live and tickets are available, **re-allocate**.
> - Otherwise the order goes to `paid_unfulfillable` and an automatic refund is raised. Where the refund goes is OPEN O7.

Re-allocation requires pointing the order at different tickets. `0016_orders.sql` prevents this three ways:

1. `hv_order_items_guard` raises on **any** `UPDATE` of `order_items` — _"an order line is fixed when the order is placed"_;
2. `REVOKE UPDATE, DELETE, TRUNCATE ON order_items FROM hv_app`;
3. `order_items_order_draw_key UNIQUE (order_id, draw_id)` forbids a second line for the same draw, and `order_items_reservation_key UNIQUE (reservation_id)` forbids reusing a reservation.

Additionally, `tickets_status_valid` admits only `'available'`, `'reserved'`, `'sold'` — there is **no `'void'`** status, although the specification's ticket state machine mentions `sold → void` "(on refund, per O7)".

### PROBLEM

The specification's first branch cannot be implemented on the Phase 5 schema. There is no way to move an order's line to a different reservation, and no way to add a replacement line.

This is not a defect. The instructed OD-3 decision — do not invent tickets, use `paid_unfulfillable`, create the refund/recovery path — is exactly what the schema permits, and order-line immutability is a protection introduced deliberately and reviewed twice.

### OPTIONS

**Option 1 — Confirm the current model.** Payment succeeds + fulfilment unavailable → `paid_unfulfillable` → refund/recovery. Re-allocation is not implemented in Phase 6. The deviation from B10 is recorded in an ADR.

**Option 2 — Weaken order-line immutability to permit re-allocation.** A migration relaxing `hv_order_items_guard` and the unique constraints, plus a restoration of `hv_app`'s privileges on `order_items`.

**Option 3 — Re-allocate via a replacement order** rather than by mutating the existing one: the original order goes to `paid_unfulfillable`, and a new order is created for the same customer with fresh reservations and linked to the original.

### TRADE-OFFS

| Option | For                                                                                                                                                                             | Against                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Matches what the schema enforces; no financial record becomes mutable; smallest Phase 6; the customer's money is returned rather than silently converted into different tickets | A customer who pays late is refunded rather than served, even when tickets remain available. Under a flat **C1** window this is the routine outcome                                                                                                                                                            |
| **2**  | Implements B10 as written                                                                                                                                                       | Makes a financial record mutable — an order could later be rewritten to point at different tickets, which is what the guard exists to prevent; reopens a reviewed decision; needs its own ADR and migration                                                                                                    |
| **3**  | Order records stay immutable; the customer can still be served                                                                                                                  | Two orders for one payment: which one does the payment belong to, which order number does the customer quote, how do caps and idempotency behave, and what happens if the replacement also fails? Each of those is its own decision. Touches ADR-0031 (order numbers) and ADR-0032 (checkout request identity) |

**On `sold → void`:** the specification's refund path assumes tickets can be voided. That value does not exist in `tickets_status_valid`, so any refund policy that voids tickets (**O7**'s proposal does) needs a migration to add it. This is not a Phase 6 blocker under Option 1, because Phase 6 only _raises_ refunds and does not complete them — but it is a fact **O7** must account for.

### REPOSITORY IMPACT

- **Option 1:** none beyond an ADR recording the deviation from B10.
- **Option 2:** a migration weakening `hv_order_items_guard`, the unique constraints and the `hv_app` revokes; an ADR superseding the reasoning in `0016`.
- **Option 3:** new schema linking orders; decisions touching ADR-0031 and ADR-0032; new cap and idempotency analysis.

### TEST IMPACT

- Under Option 1: a payment confirmed with no live reservation → order `paid_unfulfillable`, payment `succeeded`, **no ticket touched**, a `refunds` row raised with a derived idempotency key, a full audit trail; and running it twice produces exactly one refund row.
- A test asserting that `order_items` remains immutable — an `UPDATE` in raw SQL is refused by the guard, and `hv_app` lacks the privilege — so the constraint that makes re-allocation impossible is itself covered.
- Under Option 2 or 3: a substantially larger matrix, including what happens when re-allocation itself races an expiry.

### OWNER DECISION REQUIRED

1. Confirmation that Phase 6 implements **only** the `paid_unfulfillable` + refund branch (Option 1), or selection of Option 2 or 3.
2. Acknowledgement that this deviates from B10 as written, and that the deviation is recorded in an ADR.

---

## 13. C11 — Order status transitions

### CURRENT FACT

Three tables enforce their state machines **in the database**:

| Table          | Guard                                                   | Constraint raised                                         |
| -------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `draws`        | `hv_draws_guard` (`0008:177`)                           | `draws_status_transition` (`:198-199`)                    |
| `reservations` | `hv_reservations_guard` (`0009:113`, re-created `0017`) | `reservations_status_transition` (`0009:153`, `0017:105`) |
| `tickets`      | `hv_tickets_guard` (`0009:164`)                         | `tickets_status_transition` (`:189`)                      |

`hv_orders_guard` (`0016:176-192`) compares only the snapshot columns — `id`, `order_number`, `market_id`, `currency`, `user_id`, `guest_email`, `terms_version_id`, `total_minor`, `external_due_minor`, `idempotency_key`, `idempotency_digest`, `created_at` — and raises `orders_snapshot_immutable` if any changed. **`status` is deliberately excluded**, with the comment _"moving the status is Phase 6's job"_.

So at the database level an order may currently move from any status to any other, including `paid → awaiting_payment`.

Phase 5 was safe because it only ever writes one value. Phase 6 introduces every transition.

### PROBLEM

If the B7 state machine is enforced only in application code, it becomes the **only** state machine in this system not backed by the database — while being the one that decides whether money was taken and tickets were sold.

The risk is not primarily a malicious actor; it is a future code path, a support script, or a concurrent webhook applying a transition that should be impossible.

### OPTIONS

**Option A — Database transition trigger.** `hv_orders_status_guard` permitting exactly the B7 transitions and raising otherwise, following `hv_draws_guard`.

**Option B — Application/service transition guard.** All transitions go through one service method performing conditional `UPDATE … WHERE status = <expected>`, with the permitted map in TypeScript.

**Option C — Both.** The service owns the intent and the conditional update; the trigger is the backstop.

### TRADE-OFFS

| Option | For                                                                                                                                                                              | Against                                                                                                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A**  | Consistent with `draws`, `reservations` and `tickets`; holds regardless of caller, including raw SQL and future code; an invalid transition fails loudly with a named constraint | A migration; the permitted set is fixed in SQL, so extending it in P7/P8 (`partially_refunded`, wallet-only `created → paid`) needs another migration; error handling must map the constraint to a domain error, as `mapRefusal` already does for the ticket engine |
| **B**  | Errors are shaped in the domain layer; easy to extend as later phases add transitions; no migration                                                                              | Procedural. Nothing stops a second code path, a script, or a future service from writing a status directly. It would be the only unbacked state machine in the schema                                                                                               |
| **C**  | Defence in depth; the service gives good errors and the trigger guarantees correctness                                                                                           | Two places to update when a later phase adds a transition; a mismatch between them surfaces as a confusing failure                                                                                                                                                  |

**On concurrent webhook processing**, specifically: none of these three options is what makes concurrency safe. Safety comes from `SELECT … FOR UPDATE` on the order plus a **conditional** update:

```sql
UPDATE orders SET status='paid' WHERE id = $1 AND status = 'awaiting_payment'
```

A second concurrent webhook matches zero rows and must treat that as "already settled", not as an error. Options A and C add a guarantee that an _invalid_ transition cannot be written at all; they do not replace the lock or the conditional update. Option B alone relies entirely on every caller doing both correctly.

**On invalid transitions:** the concrete cases Phase 6 must refuse are `paid → awaiting_payment` (un-settling a paid order), `paid → failed`/`expired` (a late failure event overriding a success), and any transition out of `refunded`. Under A and C these raise; under B they are prevented only if the conditional update's expected value is correct at every call site.

### REPOSITORY IMPACT

- **A / C:** a migration adding `hv_orders_status_guard` — naturally part of the first Phase 6 orders migration (`0019`), or of P6-4's migration. Later phases adding transitions (P7 wallet-only `created → paid`, P10 `partially_refunded`) will each need to extend it.
- **B:** service code only.

Error mapping: a raised transition constraint must be translated into a domain error rather than surfacing as a 500, following the existing `mapRefusal` pattern.

### TEST IMPACT

- Every permitted Phase 6 transition succeeds.
- Every forbidden transition is refused — under A and C, attempted in **raw SQL** so the application is bypassed.
- Two concurrent webhooks: one transition applied, the second matches zero rows and is treated as already-settled, not as a failure.
- A late failure event after a success does not move the order.
- The constraint name is mapped to a domain error, not a 500.

### OWNER DECISION REQUIRED

1. Which option (A, B or C).
2. If A or C: whether the trigger is added in the first Phase 6 migration or in P6-4's, and acknowledgement that later phases will extend it.

---

## 14. OD-2a — Guest payment access token

### CURRENT FACT

- `GUEST_VERIFIED_EMAIL_TTL_MINUTES` default **30**; `GUEST_SESSION_TTL_HOURS` default **24** (`apps/api/src/config/env.ts:57, 61`).
- `CheckoutService.buyerOf` throws `VERIFICATION_REQUIRED` when `hasFreshVerifiedEmail` is false, and `getOrder` calls it (`checkout.service.ts:180-187, 384-389`). A guest past 30 minutes gets **404** on their own order.
- ADR-0029 makes `guest_sessions.verified_email` immutable — `hv_guest_sessions_guard` (`0012:70`) freezes `id`, `token_hash`, `created_at`, `expires_at` and enforces the verified-email consistency CHECKs. A second verification on the same session is refused.
- OD-2 is **locked**: the 30-minute binding is not extended; a guest must be able to return from the provider and retrieve their own order state; the mechanism must not authenticate the guest as a customer, must not mutate the binding, must not expose arbitrary orders, must not rely on the browser staying on the checkout page, and must not weaken authenticated authorization.
- Existing precedents in the repository:
  - `guest_sessions`: opaque token stored as SHA-256 only — `token_hash bytea`, `UNIQUE`, `CHECK (octet_length(token_hash) = 32)`, plus `expires_at` and `revoked_at` (`0012:29, 41-44`).
  - `guest_email_verifications`: hashed code, single-use (`consumed_at`), expiring, and **attempt-capped** via an `attempts` column with `CHECK (attempts >= 0)` (`0013:31-42`); `VERIFICATION_CODE_MAX_ATTEMPTS` in `@hv/domain`.
  - Rate limits are declared centrally in `RATE_LIMITS` (`apps/api/src/auth/rate-limiter.ts`) and are fail-closed on a Redis outage.

### PROBLEM

The locked requirement needs a credential that survives the 30-minute binding, works after the browser has been closed, reaches exactly one order, and grants nothing else. Each of its properties is a separate choice, and several interact.

### OPTIONS

**Generation**

- **G1.** Cryptographically random bytes (`randomBytes`), base64url-encoded — the `guest_sessions` pattern.
- **G2.** A signed, self-describing token (the order id plus a MAC) with nothing stored.

**Storage**

- **S1.** SHA-256 hash only, in a new table, with `UNIQUE` and `octet_length = 32` — matching `guest_sessions_token_hash_sha256`.
- **S2.** Stored on the `orders` row itself.
- **S3.** Nothing stored (follows from G2).

**Expiry**

- **E1.** Tied to the order's payment deadline (**C1**) plus a fixed tail for the return journey.
- **E2.** A fixed lifetime independent of the deadline (hours).
- **E3.** As long as the guest session would have lasted (24 hours).

**Rotation / reuse**

- **U1.** One token per order, reusable until expiry.
- **U2.** One token per payment attempt (interacts with **OD-4a**).
- **U3.** Single-use, exchanged on first presentation for something shorter-lived.

**Scope**

- **C-1.** Read the order's status and its payment status; trigger a provider status check.
- **C-2.** As above plus the order's line detail (draws, quantities, amounts).
- **C-3.** As C-1 plus the ability to start a **new** payment attempt on the same order.

**Information exposed**

- **I-1.** Status only — order status, payment status, amount, currency, order number.
- **I-2.** Status plus line detail.
- **I-3.** Anything `getOrder` returns today.

### TRADE-OFFS

| Choice               | For                                                                                                | Against                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1 + S1**          | Matches two existing patterns exactly; the token is revocable; a database leak exposes only hashes | A new table and a lookup on every presentation                                                                                                                              |
| **G2 + S3**          | No storage, no table, no lookup                                                                    | Cannot be revoked; cannot be rate-limited per token by row; its validity is decided entirely by the MAC, so key rotation invalidates every outstanding token at once        |
| **S2** (on `orders`) | No new table                                                                                       | `hv_orders_guard` freezes the order snapshot; a mutable token column on a financial record is a new category of column there, and rotation would mean mutating an order row |
| **E1**               | The credential lives about as long as it is useful                                                 | Under **C1** option A the deadline can be very short, so the tail must cover a customer who returns late — which is precisely the case OD-2 exists for                      |
| **E2**               | Predictable, independent of **C1**                                                                 | A credential outliving its purpose                                                                                                                                          |
| **E3**               | Consistent with the guest session's own lifetime                                                   | A 24-hour credential for a 10-minute flow                                                                                                                                   |
| **U1**               | Simple; one URL works throughout, including after a failed attempt and a retry                     | A single credential covers the whole order's life                                                                                                                           |
| **U2**               | Narrower blast radius per token                                                                    | More tokens, and the return URL must carry the right one; interacts with **OD-4a**                                                                                          |
| **U3**               | The URL-borne value is spent immediately                                                           | A return that is retried (browser back, refresh) fails, which is a common real behaviour                                                                                    |
| **C-1 / I-1**        | Minimum exposure; sufficient for a return page that reports status                                 | The customer cannot see what they bought without re-verifying                                                                                                               |
| **C-2 / I-2**        | The return page can show the order                                                                 | Line detail (draw names, quantities, amounts) becomes readable by anyone holding the URL                                                                                    |
| **C-3**              | A customer whose payment failed can retry without re-verifying                                     | A read-only credential becomes able to initiate a money movement, which enlarges it considerably                                                                            |

**Relationship to `hvGuest`.** The token must be an independent credential, not a way to reconstitute a guest. `AccessGuard` resolves `hvGuest` only on the `@Public({ identify: true })` branch, and no authorization path reads it (ADR-0029). A token presented alongside a guest cookie, or with none, must behave identically; it must not cause a guest session to be created, extended or revived.

**Relationship to the verified email.** The token must not read, write, extend or refresh `guest_sessions.verified_email`, and must not stand in for `buyerOf` anywhere a cap identity is decided. It authorizes reading one order — nothing that consumes cap allowance, creates a reservation or places an order.

**Return to the browser.** The token is issued when payment is initiated and embedded in the provider's return URL, so the customer returns holding it regardless of what happened to their tab. Consequences: it will appear in browser history, in the provider's stored return URL, and potentially in a `Referer` header if the return page loads third-party resources. Mitigations available in the repository: the `referrer-policy: no-referrer` header is already set on API responses (`app.ts:66`) — the equivalent for the web app's return page is a separate matter; and the return page could exchange the URL token for a cookie and redirect to a clean URL (a variant of U3).

**Rate limiting.** Presentation must be limited, or the token space can be probed. `RATE_LIMITS` is the established place; a per-IP limit on token presentation follows `verificationCodePerIp` (20/60m). An attempt cap per token, following `guest_email_verifications.attempts`, is also available. Both are fail-closed on a Redis outage.

### REPOSITORY IMPACT

- **G1 + S1:** a new table (the scope lock sketches `order_access_tokens`) and a repository, in P6-8. A migration.
- **G2 + S3:** no migration; a key to manage, and no revocation.
- **S2:** a mutable column on `orders` and a change to `hv_orders_guard`.
- All options: a second authorization route into `getOrder` and the payment status endpoint, added **beside** `buyerOf` rather than inside it, so the authenticated path is untouched. A new entry in `RATE_LIMITS`.
- The web return page in `apps/web`, which does not exist yet.

### TEST IMPACT

- The token reaches its own order and **no other** — a token for order A returns 404 for order B.
- It works after the 30-minute verified-email window has lapsed.
- It works with no guest cookie present, and after the guest session has expired.
- It does **not** create, extend or revive a guest session, and does not alter `verified_email`.
- It cannot place an order, modify a basket, create a reservation, or (unless C-3 is chosen) initiate a payment.
- An expired token is refused; a revoked token is refused.
- Only the hash is stored — the plaintext token appears in no table and no log.
- Presentation is rate-limited, and fails closed when Redis is unavailable.
- The authenticated path and the fresh-guest path behave exactly as they do today (regression over the existing `phase5-journey` isolation tests).
- Under U3: a repeated presentation behaves as designed rather than failing confusingly.

### OWNER DECISION REQUIRED

1. One choice from each of G, S, E, U, C and I.
2. Whether the token may initiate a new payment attempt (C-3) or is strictly read-only.
3. Whether the return URL token is exchanged for a cookie and stripped from the URL.
4. The rate limit values for token presentation.

---

## 15. OD-4a — Concurrent live payment attempts

### CURRENT FACT

- OD-4 is **locked**: an order may have several payment attempts; each has its own identity, provider reference and idempotency data; attempts are immutable except for controlled status fields; **only one successful payment may finalize an order**; duplicate successful webhooks are idempotent; later attempts never create a second paid order; the order remains the aggregate being finalized.
- B18 specifies `payments UNIQUE(provider, provider_reference)`.
- No `payments` table exists, so nothing constrains this today.
- The scope lock proposes a partial unique index `ON payments (order_id) WHERE status = 'succeeded'` to make "at most one successful payment per order" structural. That is separate from, and unaffected by, this decision.
- **O13** has not chosen a provider, so whether a provider's hosted session can be resumed after abandonment is not known.

### PROBLEM

"Multiple attempts are allowed" does not say how many may be _live_ at once. A customer who clicks "pay" twice, or opens a second tab, or retries after a timeout that the provider has not yet acknowledged, can produce several attempts in a non-terminal state simultaneously.

### OPTIONS

**Option 1 — Unlimited active attempts.** Any number of `pending`/`processing` rows per order; only the success index constrains the outcome.

**Option 2 — One active attempt at a time.** A partial unique index `ON payments (order_id) WHERE status IN ('pending','processing')`. A new attempt requires the previous one to be terminal.

**Option 3 — Bounded active attempts.** A small cap (for example three), enforced by a count check rather than a unique index.

### TRADE-OFFS

| Option | For                                                                                                                                              | Against                                                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Never blocks a customer trying to pay; no failure mode where a stuck attempt prevents a retry; simplest creation path                            | Several provider sessions can be open for one order at once. If two of them succeed, the money is taken twice and the second must be refunded — the success index prevents a second _paid order_, not a second _charge_. Provider-side cost and customer confusion                                              |
| **2**  | At most one open provider session, so a double charge is far less reachable; a clear, single "current attempt" for the UI and for reconciliation | A stuck attempt blocks retries until it is resolved — which makes the reconciler (**C2**/OD-5) load-bearing for ordinary customer experience, not just for edge cases. Needs a defined way for an attempt to become terminal without the provider answering (a timeout), and that timeout interacts with **C1** |
| **3**  | Tolerates a stuck attempt while limiting exposure                                                                                                | Neither structural (a count is a check-then-act unless done under a lock) nor unlimited; the bound is an arbitrary number without a provider to inform it                                                                                                                                                       |

**Cross-cutting consequences, whichever is chosen:**

- **Double charge is a money problem, not a data problem.** `UNIQUE (order_id) WHERE status='succeeded'` guarantees one _successful payment row_; it does not stop a provider from capturing two payments. The second would need to be recognised and refunded, which links this decision to **O7** and to the refund skeleton's completeness.
- **Interacts with OD-2a (U2).** If tokens are per-attempt, the number of live attempts determines how many tokens can be outstanding.
- **Interacts with C1.** Under a short payment window, a customer has time for only one or two attempts anyway, which narrows the practical difference between the options.
- **Depends on O13.** Whether a provider session can be resumed, and how long it stays open, is exactly the information that distinguishes these options — and it is not yet known.

### REPOSITORY IMPACT

Option 2 adds a partial unique index to the `payments` migration and requires a defined attempt-timeout path. Option 3 requires a counted check under a row lock on the order. Option 1 adds nothing.

All three need the initiation endpoint to decide what to return when an attempt already exists: the existing attempt, a new one, or a 409.

### TEST IMPACT

- Concurrent initiation requests for one order, barrier-synchronised: the outcome matches the chosen option exactly (one attempt and N conflicts, or N attempts).
- Under Option 2: a second initiation while one is live is refused with a distinguishable error; after the first becomes terminal, a new attempt succeeds; a stuck attempt is resolvable without SQL.
- Under any option: two attempts both reporting success → exactly one `succeeded` row, one `paid` order, and the second recognised rather than silently ignored.
- The idempotency key behaves as `orders.idempotency_key` does: the same key returns the same attempt; a different request under the same key is refused.

### OWNER DECISION REQUIRED

1. Which option (1–3), and if 3, the bound.
2. If Option 2: how an attempt becomes terminal without a provider answer (timeout duration), and how that relates to the **C1** payment deadline.
3. What the initiation endpoint returns when a live attempt already exists.
4. Whether this decision waits for **O13**, since provider session behaviour is the deciding information.

---

## 16. OD-6a — Unfulfillable notification

### CURRENT FACT

- OD-6 is **locked**: Phase 6 defines notification events for payment success, payment failure/expiry and refund outcome; delivery is not part of payment correctness; finalization succeeds even if email is delayed; the transactional outbox is used; **no final email copy is written in Phase 6** (per-market templates are P12).
- The outbox topic format is `CHECK (topic ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$')` (`0011:50`) — lowercase letters, underscores and dots only.
- The worker's dispatcher currently registers exactly one topic: `{ [VERIFICATION_EMAIL_TOPIC]: relay }` (`apps/worker/src/outbox/outbox.service.ts:69`). An unregistered topic **fails the event** rather than dropping it.
- Payloads containing an email address are sealed (ADR-0028).
- `audit_log` provides `occurred_at`, `actor_type`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `market_id`, `reason`, `before`, `after`, `ip`, `request_id` (`0007:13-25`).
- **O12** (compliance values, including wording) and **O7** (refund policy) are both open.

### PROBLEM

When payment succeeds but the tickets cannot be finalized, four things happen and they are independent. Conflating them produces either a silent failure or a promise the system cannot keep.

### The four concerns, separated

| Concern                   | What it is                                                                                    | Timing                                    | Depends on                                            |
| ------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| **Order status**          | `awaiting_payment → paid_unfulfillable`, in the finalization transaction                      | immediate, atomic                         | nothing outside the transaction                       |
| **Refund**                | a `refunds` row raised with a derived idempotency key; **execution and completion are later** | row raised immediately; money moves later | **O7** for destination and policy; P10 for completion |
| **Audit**                 | an `audit_log` row recording actor, before/after and reason                                   | same transaction                          | nothing                                               |
| **Customer notification** | an outbox event, relayed after commit                                                         | after commit, asynchronous                | topic registration; copy is P12                       |

The customer-facing question is what the notification asserts. At the moment it is written, the refund row exists but no money has moved, and under **O7** it is not yet decided where the money goes.

### OPTIONS

**Option 1 — No notification in Phase 6.** Status, refund row and audit only. The customer learns from the return page or from support.

**Option 2 — One event at the point of failure** (`order.unfulfillable`), stating that the payment succeeded but the entry could not be completed and that a refund is being arranged.

**Option 3 — Two events:** one at the point of failure, and a second when the refund actually completes (`refund.completed`) — which is **P10**, since Phase 6 does not complete refunds.

**Option 4 — One event, deferred until the refund completes.** Nothing is sent at the point of failure.

### TRADE-OFFS

| Option | For                                                                                                       | Against                                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Nothing is promised that the system cannot yet deliver; no copy needed before P12                         | A customer has been charged and hears nothing. The return page only helps if they are still there — and the whole premise of **OD-2** is that they may not be |
| **2**  | The charged customer is told promptly; the event is written in the same transaction, so it cannot be lost | It states that a refund is coming before **O7** has decided where it goes, so the copy must stay vague until P12                                              |
| **3**  | The customer is told what happened and, later, that the money is back                                     | The second event belongs to P10; Phase 6 would define a topic it does not emit, and the dispatcher fails unregistered topics                                  |
| **4**  | Only one message, and it is factual — the money is back                                                   | The customer is charged and silent for however long refund completion takes, which is unknown until **O7** and P10                                            |

**Constraints on any option chosen:**

- The event is written **inside** the finalization transaction and relayed after commit. Delivery never blocks, delays or fails finalization (locked OD-6).
- Any new topic must match the format CHECK and be registered in the dispatcher, or events fail loudly. That is deliberate and is the intended behaviour.
- The payload carrying the customer's address is sealed (ADR-0028).
- **No email copy is written in Phase 6.** Phase 6 decides whether an event exists and what data it carries; wording is P12 and depends on **O12**.
- The audit row is written regardless of which notification option is chosen; it is not a substitute for one.

### REPOSITORY IMPACT

Each chosen topic needs: a constant in `@hv/domain` (following `VERIFICATION_EMAIL_TOPIC`), a payload type, a dispatcher registration in `apps/worker/src/outbox/outbox.service.ts`, and a relay handler. No migration — `outbox` already exists.

### TEST IMPACT

- The outbox row is written in the **same** transaction as the status change: if the transaction rolls back, no event exists.
- Finalization succeeds when the relay is unavailable; the event is delivered later.
- The topic is registered — an unregistered topic fails the event, and a test asserts the registration exists.
- The payload is sealed and the address never appears in logs.
- The event is written exactly once for one unfulfillable order, including under duplicate webhooks.
- The refund row and the audit row exist alongside it.

### OWNER DECISION REQUIRED

1. Which option (1–4).
2. If a notification is sent at the point of failure: what it is permitted to assert about the refund before **O7** is decided.
3. The topic name(s), matching the format CHECK.

---

## 17. OD-7a — Raw payload retention

### CURRENT FACT

As [§7](#7-c5--raw-provider-payload-retention). Summarised: B18 specifies a raw payload on `payment_events`; B19 revokes `UPDATE/DELETE` on that table, so rows are permanent to the application; OD-7 forbids storing credentials and prefers normalized data; `SecretBox`/`sealPayload` exist and ADR-0028 established the pattern for sealing payloads that cannot later be redacted.

### PROBLEM

The decision must be made before the `payment_events` migration is written, because it determines that table's columns — and migrations are append-only.

### The concrete decision question

> **Does Highland Vault retain the raw bytes of provider webhook payloads after the signature has been verified?**
>
> **If no:** `payment_events` stores only normalized fields (provider, event id, event type, provider reference, amount, currency, provider status, timestamps). The raw bytes are discarded when the request ends. In a provider dispute, Highland Vault has its normalized record and the provider's own dashboard, but no byte-level copy of what was sent.
>
> **If yes**, five sub-answers are required:
>
> | #     | Question                                                                                                               | Notes for the owner                                                                                                                                                                                                                                    |
> | ----- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | **a** | **Exact reason** — what specific situation requires the raw bytes that the normalized record cannot serve?             | Typical answers: disputing a provider's account of what it sent; diagnosing an event shape we did not anticipate; a regulatory or contractual obligation. If none applies, "no" is the simpler answer                                                  |
> | **b** | **Sensitive fields** — which fields in the retained payload are personal or sensitive?                                 | Cannot be fully answered until **O13** names a provider. Typically billing name, email, address, and card _metadata_ (brand, last four, issuing country). Never a full card number or CVV — those never reach our servers under the locked SAQ-A model |
> | **c** | **Protection** — plaintext, sealed with `SecretBox` (ADR-0028's pattern), or field-redacted before storage?            | Sealing uses the existing `sealPayload`; whether it uses `OUTBOX_ENCRYPTION_KEY` or a separate key is part of this answer                                                                                                                              |
> | **d** | **Retention period** — how long are the raw payloads kept, and what deletes them?                                      | `hv_app` has no `DELETE` on this table, so deletion is an operator or migration process, not application code. "Indefinitely" is a valid answer but must be a chosen one                                                                               |
> | **e** | **Access control and redaction** — who may open a stored payload, under what permission, and is every opening audited? | Interacts with **C7**. Payload contents must never appear in logs or in any API response                                                                                                                                                               |

### OPTIONS

As [§7](#7-c5--raw-provider-payload-retention): normalized only · normalized plus sealed raw · normalized plus plaintext raw · normalized plus redacted raw.

### TRADE-OFFS

As [§7](#7-c5--raw-provider-payload-retention). The additional consideration specific to this decision: **the answer to (b) cannot be complete until O13 names a provider.** That argues for either the "no" answer or the sealed answer, both of which are safe without knowing the field list, and against the redacted answer, which requires a complete field list to be correct.

### REPOSITORY IMPACT

Determines the `payment_events` schema in P6-3's migration. If sealed: a key decision and an operator path for opening payloads. If redacted: a per-provider field list maintained in the adapter. An ADR recording the deviation from B18 under any answer except plaintext.

### TEST IMPACT

As [§7](#7-c5--raw-provider-payload-retention). Additionally, if raw is retained: a fake-provider payload deliberately containing credential-shaped fields is stored and then asserted to be unreadable in plaintext anywhere — in the table, in logs, and in every API response.

### OWNER DECISION REQUIRED

The question above, in full: the yes/no, and if yes, sub-answers (a) through (e).

---

## 18. O5 — Settlement grace period

### CURRENT FACT

**O5 is not open. It was decided.**

`PROJECT_INITIALIZATION_REPORT.md:837` lists it as: _"Settlement grace period after close for in-flight checkouts | Grace = reservation TTL (10 min) + 2 min | P9"_.

[ADR-0024](adr/0024-settlement-grace-period.md) — **Status: Accepted — 2026-09-21** (owner approval of O5, Revision 2 Part G), needed by Phase 9 — decides:

> - At `closes_at` the draw moves to `closed` and new reservations stop.
> - **Settlement runs at `closes_at` + 10-minute reservation TTL + 2 minutes (12 minutes).** By then every in-flight checkout is either confirmed or released.

Consequences recorded in that ADR: _"Reserved tickets are never eligible for the draw. Payments confirmed after settlement follow the late-payment path (refund policy, OPEN O7)."_

### PROBLEM

Phase 6 does not need an O5 decision. It needs to avoid **invalidating** one that is already accepted.

The grace is stated **arithmetically**, deriving from the 10-minute reservation TTL. Two Phase 6 decisions can break that derivation:

- **C1 option C** (extending reservations for payment) and **C1 option D** (redesigning the lifecycle) both allow a reservation to live longer than 10 minutes. ADR-0024's "by then every in-flight checkout is either confirmed or released" would no longer be true, and the ADR would need amending.
- **C1 options A and B** keep reservations within 10 minutes and leave ADR-0024 intact.

ADR-0024 also states the assumption Phase 6 relies on in the other direction: _"payments confirmed after settlement follow the late-payment path"_ — which is **C10**, and which the current schema constrains to `paid_unfulfillable` + refund.

### OPTIONS

Not a Phase 6 decision. The only Phase 6 choice is whether to select a **C1** option that requires amending ADR-0024.

### TRADE-OFFS

Choosing C1 option C or D means reopening an accepted decision and re-deriving the settlement grace before Phase 9. Choosing A or B does not.

### REPOSITORY IMPACT

None in Phase 6 under C1 options A or B. Under C or D, ADR-0024 must be amended.

**Documentation correction:** `PHASE_6_SCOPE_LOCK.md` §26 lists O5 under "Pre-existing open questions that Phase 6 touches but does not resolve". That is incorrect — O5 is closed by ADR-0024. The row's substance (that C1 option C would change what "reservation TTL" means) is right; its status is wrong. To be corrected in a later documentation pass, not in this brief.

### TEST IMPACT

None directly in Phase 6. If C1 option C or D is chosen, the settlement grace arithmetic must be re-derived and re-tested before Phase 9.

### OWNER DECISION REQUIRED

None for O5 itself. Carried into **C1 question 5**: may ADR-0024's grace arithmetic be reopened?

---

## 19. O7 — Refund policy

### CURRENT FACT

`PROJECT_INITIALIZATION_REPORT.md:836`:

> **O7** | Refund policy: destination (card vs wallet), refunds after close/settlement, fate of tickets/instant wins on refunded orders | _Proposal, not implemented until confirmed:_ Refund to original method; void tickets and decrement caps if before close; none after settlement | P6/P10

`PROJECT_STATUS.md:170` records it as needed by Phases 6/10. **No ADR exists for O7** (`docs/adr/` has no refunds ADR; the sequence runs to 0032).

ADR-0024 defers to it: _"Payments confirmed after settlement follow the late-payment path (refund policy, OPEN O7)."_

Relevant repository facts bearing on the proposal:

- B18's `refunds` shape includes `destination` (provider/wallet) — so the schema anticipates both, but **no wallet exists until P7**.
- `tickets_status_valid CHECK (status IN ('available','reserved','sold'))` — **there is no `'void'` status.** The proposal's "void tickets" is structurally impossible today and would need a migration adding the value plus a `hv_tickets_guard` transition.
- "Decrement caps" interacts with the NB-1 fix in `0010`: `hv_end_reservation` returns allowance only for tickets it frees, and sold tickets deliberately keep consuming cap. A refund that returns cap allowance is a **new** path, not an existing one, and it must use the entrant key stored on the reservation (ADR-0021, **I12**).
- `refunds.create` permission exists, granted to `finance` and `super_admin`.

### PROBLEM

Phase 6 raises refund records; it does not execute or complete them. The question is how much of O7 must be answered before Phase 6 can raise a refund correctly.

**What Phase 6 needs from O7:**

| Needed for Phase 6                                      | Why                                                                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Destination for the `paid_unfulfillable` case**       | The `refunds` row has a `destination` column that must be populated when the row is raised. With no wallet until P7, `provider` is the only reachable value — but that is a consequence of sequencing, not a decision |
| **Whether raising a refund is automatic and actorless** | Phase 6's late-payment path raises it with no operator. `refunds.actor_id` would be NULL for a system-raised refund; B18 lists `actor_id` without saying it is nullable                                               |
| **Whether tickets are affected**                        | In the `paid_unfulfillable` case, no ticket was ever sold, so nothing needs voiding. This is the one case where Phase 6 can proceed without the ticket answer                                                         |

**What Phase 6 does not need:**

| Not needed for Phase 6                     | Why                                                            |
| ------------------------------------------ | -------------------------------------------------------------- |
| Refunds after close/settlement             | Phase 9                                                        |
| Fate of instant wins on refunded orders    | Phase 8                                                        |
| Voiding sold tickets and decrementing caps | Only arises when a _fulfilled_ order is refunded, which is P10 |
| `partially_refunded`                       | P10                                                            |
| Refund to wallet                           | P7                                                             |

### OPTIONS

**Option 1 — Answer only the Phase 6 slice of O7** (destination and actor for the automatic unfulfillable refund), leaving the rest for P10.

**Option 2 — Answer O7 in full now**, including the ticket-voiding and cap-decrement policy and the post-settlement rule.

**Option 3 — Defer O7 entirely** and have Phase 6 raise refund rows with the destination and actor decided at implementation time.

### TRADE-OFFS

| Option | For                                                                                                                                                                            | Against                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **1**  | Unblocks P6-6 with the minimum decision; the rest is answered when P10 needs it                                                                                                | O7 remains open, so it must be tracked; a later full answer could imply a different shape for rows already raised |
| **2**  | One coherent policy; the `refunds` schema is designed once against the final rule; the `'void'` ticket status and the cap-decrement path are known before the table is created | Requires deciding Phase 8/9/10 questions now, several of which depend on phases not yet built                     |
| **3**  | Nothing to decide now                                                                                                                                                          | The implementer would be choosing a refund policy silently — exactly what the collaboration protocol forbids      |

**Note on the proposal's "decrement caps":** if a future refund returns cap allowance, it must read the entrant key from the reservation (which ADR-0021 bridging may have re-keyed) and must not reuse `hv_end_reservation`, whose contract is to return allowance only for tickets it moves back to `available`. That is a new function, and O7's full answer determines whether it is needed.

### REPOSITORY IMPACT

Option 1 determines two column values and possibly the nullability of `refunds.actor_id` in P6-6's migration. Option 2 additionally implies a future migration adding `'void'` to `tickets_status_valid` and a cap-restoration function, both of which would be designed now and built in P10. Option 3 has no defined impact, which is the objection to it.

### TEST IMPACT

Phase 6: a `paid_unfulfillable` order raises exactly one `refunds` row, with the chosen destination, the chosen actor representation, and a derived idempotency key; raising it twice produces one row; no ticket state changes; no cap allowance is returned.

### OWNER DECISION REQUIRED

1. Which option (1–3).
2. If Option 1: the `destination` value for an automatic unfulfillable refund, and how a system-raised refund is represented in `actor_id`.
3. Whether O7's full answer is scheduled before P6-6 or deferred to P10.

---

## 20. O9 — Major configuration changes

### CURRENT FACT

`PROJECT_INITIALIZATION_REPORT.md:841`:

> **O9** | Exact list of "major configuration changes" (sensitive operations) | _Proposal:_ Markets/settings, **payment configs**, roles/permissions, draw price/capacity after publish, instant-win definitions | P2/P10

`PROJECT_STATUS.md:172` records it as needed by Phases 2/10, with the note that _"market gate changes are treated as sensitive meanwhile"_ — the stricter reading while O9 is open (`PROJECT_STATUS.md:729`).

In the repository: `config.manage` is described as _"Change major configuration. Sensitive operation (list is OPEN O9)"_ and is granted to `super_admin` only. A `sensitive` permission requires step-up MFA within `STEP_UP_WINDOW_MS` (`AccessGuard`).

### PROBLEM

O9's proposal explicitly names **payment configs** as a major configuration change. Phase 6's **P6-7** introduces `market_payment_configs(market_id, provider_code, config_ref)` — the first payment configuration in the system.

The question is whether changing a market's payment provider configuration is a sensitive operation requiring step-up MFA, and which permission governs it.

### OPTIONS

**Option 1 — Treat payment config changes as sensitive under the existing `config.manage`**, consistent with O9's proposal and with the stricter-reading convention already applied to market gates.

**Option 2 — A dedicated permission** for payment configuration, separate from `config.manage`.

**Option 3 — Not sensitive**, governed by an ordinary permission.

**Option 4 — No write API in Phase 6.** Configuration is seeded by migration or an operator CLI, as staff roles are today (`PROJECT_STATUS.md:741`: _"An operator CLI bootstraps staff roles. There is no role-management API yet (O9 decides whether it is sensitive)"_).

### TRADE-OFFS

| Option | For                                                                                                                                             | Against                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Matches O9's own proposal and the established stricter-reading convention; no new permission; `super_admin`-only                                | Bundles payment configuration with every other major configuration change                                                                    |
| **2**  | Precise; finance or admin could manage payment configuration without holding `config.manage`                                                    | Pre-empts O9's answer by creating a permission whose place in the final list is unknown                                                      |
| **3**  | Simpler operationally                                                                                                                           | Changing which provider takes a market's money, without step-up MFA, is difficult to reconcile with how market gates and refunds are treated |
| **4**  | Defers the question entirely; follows the existing precedent for privileged bootstrap; Phase 6 needs the _table_, not necessarily an API for it | An operator must run a CLI to change payment configuration; acceptable while the fake provider is the only one (**O13**)                     |

### REPOSITORY IMPACT

Option 1: no new permission; P6-7's write path (if any) declares `config.manage` with `sensitive: true`. Option 2: a seed migration. Option 4: no API and no permission — only the table and a CLI or seed path.

### TEST IMPACT

Whichever option: deny-by-default proven for the configuration route; if sensitive, step-up MFA required; `config_ref` holds only a reference and never a secret (invariant I15), asserted against the table's contents.

### OWNER DECISION REQUIRED

1. Which option (1–4).
2. Whether Phase 6 exposes any write API for payment configuration at all, or seeds it (Option 4).
3. Whether this partially answers O9 for payment configs specifically, or waits for O9 in full at P10.

---

## 21. O13 — Production payment provider

### CURRENT FACT

`PROJECT_INITIALIZATION_REPORT.md:845`:

> **O13** | Production payment provider(s) per market | _Proposal:_ Fake provider until merchant approval | **Before P14**

`PROJECT_STATUS.md:176` records it as needed **before Phase 14**. `TASK_BOARD.md:74` for P6 reads: _"Gate 4. Fake provider; O13 before production."_

OD-8 is **locked**: no production provider is selected; Phase 6 implements a provider-agnostic port, a fake/test provider and deterministic test behaviour; no provider is hard-coded; the fake provider cannot be registered in production (a config guard refuses it).

ADR-0006 exists precisely so this can be answered late. B10 specifies the port; `packages/payments` is the named location (`:638, :661`).

### PROBLEM

O13 is **not** a Phase 6 blocker — the phase is designed around its absence. But several Phase 6 decisions would be better informed by it, and it is worth being explicit about which:

| Decision           | What O13 would tell us                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **C1**             | How long a real provider flow takes, which determines whether a 600-second (or shorter) window is realistic and what the refusal floor should be |
| **C4**             | The actual maximum payload size and the signature header name (needed for the redaction list)                                                    |
| **C5 / OD-7a (b)** | Which fields a real payload contains, which is required for the redaction option to be correct                                                   |
| **OD-4a**          | Whether a hosted session can be resumed after abandonment — the deciding fact between its options                                                |
| **O9**             | Whether payment configuration is a frequent operational task or a one-time setup                                                                 |

### OPTIONS

**Option 1 — Keep O13 open**, per OD-8. Phase 6 proceeds on the fake provider; decisions above are made on conservative assumptions and revisited when a provider is chosen.

**Option 2 — Decide O13 now**, ahead of its "before P14" schedule, so the Phase 6 decisions can be informed by real provider behaviour.

**Option 3 — Keep O13 open but gather provider characteristics now** — session lifetime, payload size, signature header, resumability — without committing to a provider, as inputs to C1, C4, C5 and OD-4a.

### TRADE-OFFS

| Option | For                                                                                        | Against                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Matches the locked OD-8 and the specification's schedule; ADR-0006 exists for exactly this | C1, OD-4a and OD-7a(b) are decided on assumption; some may need revisiting when a provider is chosen                                                            |
| **2**  | Every dependent decision is informed by fact                                               | Merchant approval is a commercial process with its own timeline; it would gate Phase 6 on something outside engineering's control, which OD-8 explicitly avoids |
| **3**  | Better inputs without a commitment; the port stays provider-agnostic                       | Characteristics gathered from a provider not ultimately chosen may not apply; the work is real but its value is conditional                                     |

### REPOSITORY IMPACT

None in Phase 6 under any option — the port is provider-agnostic by design and no provider name may appear in code, config, schema, migrations or tests (locked OD-8).

### TEST IMPACT

Phase 6 tests run entirely against the fake provider. Two tests are specifically about O13's absence: **the fake provider cannot be registered in production** (a config guard refuses it, following the `OUTBOX_ENCRYPTION_KEY` placeholder guard at `env.ts:123`), and **no provider name appears anywhere in the codebase** — a grep-style test, in the manner of the gitleaks negative control.

### OWNER DECISION REQUIRED

1. Confirmation that O13 stays open and Phase 6 proceeds on the fake provider (Option 1), or selection of Option 2 or 3.
2. If Option 3: which characteristics to gather, and which of C1, C4, C5 and OD-4a wait for them.

---

## 22. Decision checklist for owner

Each row is one question. "Blocks" names the first slice that cannot start without it.

| #   | Decision       | Question in one line                                                                                         | Blocks          |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------ | --------------- |
| 1   | **C1**         | Payment window: option A, B, C or D — and the values it needs                                                | **P6-2**        |
| 2   | **C1**         | May ADR-0024's settlement grace arithmetic be reopened? (required by C and D only)                           | **P6-2**        |
| 3   | **C1**         | May D11's production pin of `RESERVATION_TTL_SECONDS = 600` be reopened?                                     | **P6-2**        |
| 4   | **C1**         | Is `paid_unfulfillable` + refund acceptable as a routine outcome?                                            | **P6-2**        |
| 5   | **C2**         | Database option D1–D4, and provider option P1–P3                                                             | **P6-5**        |
| 6   | **C3**         | Webhook/CSRF architecture: option 1, 2, 3 or 4                                                               | **P6-3**        |
| 7   | **C4**         | Raw body: one choice each from R, M, S and F; and the webhook body limit                                     | **P6-3**        |
| 8   | **C5 / OD-7a** | Are raw payloads retained? If yes, answers (a)–(e)                                                           | **P6-3**        |
| 9   | **C6**         | Gate 4 boundary: option 1, 2 or 3                                                                            | **P6-4**        |
| 10  | **C7**         | Payment permission: option 1–4; if 1 or 2, the code, sensitivity and grants                                  | **P6-5**        |
| 11  | **C8**         | Reservation end state: `'released'`, a new `'converted'`, or sweep-collected                                 | **P6-4**        |
| 12  | **C9**         | Confirm the invariant; choose reinforcement option 1, 2 or 3                                                 | **P6-4**        |
| 13  | **C10**        | Confirm `paid_unfulfillable`-only (option 1), or select 2 or 3                                               | **P6-6**        |
| 14  | **C11**        | Order transitions: database trigger, application guard, or both                                              | **P6-2 / P6-4** |
| 15  | **OD-2a**      | Token: one choice each from G, S, E, U, C and I; read-only or may initiate                                   | **P6-8**        |
| 16  | **OD-4a**      | Concurrent attempts: unlimited, one, or bounded                                                              | **P6-2**        |
| 17  | **OD-6a**      | Unfulfillable notification: option 1–4, and what it may assert                                               | **P6-6**        |
| 18  | **O7**         | Answer the Phase 6 slice, answer in full, or defer                                                           | **P6-6**        |
| 19  | **O9**         | Payment configuration: sensitive under `config.manage`, dedicated permission, not sensitive, or no write API | **P6-7**        |
| 20  | **O13**        | Confirm it stays open (option 1), or select 2 or 3                                                           | none            |
| —   | **O5**         | **No decision needed** — closed by ADR-0024. Relevant only through C1 questions 2 and 3                      | —               |

---

## 23. Phase 6 implementation blockers

Decisions that must be answered before the named slice begins.

| Slice                                     | Blocked by                       | Why it cannot start                                                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P6-1** provider port + fake provider    | **nothing**                      | No migration, no existing behaviour touched, no open decision. This slice can begin as soon as it is approved                                                                                                                                |
| **P6-2** payment attempts + initiation    | **C1** (1–4), **OD-4a**, **C11** | C1 determines migration `0019`'s columns; OD-4a determines whether `payments` carries a second partial unique index; C11 determines whether the status trigger is added here. All three are schema decisions, and migrations are append-only |
| **P6-3** webhook persistence + intake     | **C3**, **C4**, **C5/OD-7a**     | C3 and C4 decide whether a webhook can be received at all; C5/OD-7a decides `payment_events`' columns                                                                                                                                        |
| **P6-4** atomic finalization              | **C6**, **C8**, **C9**, **C11**  | C8 decides what finalization does to the reservation; C9 decides whether the invariant is reinforced structurally; C6 decides what Gate 4 means here; C11 decides where transitions are enforced                                             |
| **P6-5** reconciliation + expiry safety   | **C2**, **C7**                   | C2 decides where the safety rule lives; C7 must exist before a route can be written, since `AccessGuard` denies any route with no policy                                                                                                     |
| **P6-6** late payment + refund skeleton   | **C10**, **O7**, **OD-6a**       | C10 decides the model; O7 decides the refund row's destination and actor; OD-6a decides whether an event is emitted                                                                                                                          |
| **P6-7** per-market payment configuration | **O9**                           | Decides whether a write API exists and under which permission                                                                                                                                                                                |
| **P6-8** web payment flow                 | **OD-2a**, **C1**                | OD-2a decides the token's whole design; C1 decides whether a countdown is meaningful                                                                                                                                                         |
| **P6-9** hardening / Gate 4               | **C6**                           | Decides what "Gate 4 passed" is permitted to claim                                                                                                                                                                                           |

**Summary: P6-1 is unblocked. Every other slice waits on at least one decision.** Nineteen decisions are listed in [§22](#22-decision-checklist-for-owner); answering questions 1–4, 6, 7, 8, 14 and 16 would unblock P6-2 and P6-3, which is the majority of the phase's schema.

---

## 24. Decisions that can remain open until later slices

| Decision                                      | Can stay open until    | Why it is safe to defer                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O13** — production provider                 | before P14             | OD-8 and ADR-0006 are built around its absence. Phase 6 runs entirely on the fake provider, and no provider name may appear anywhere. It would _inform_ C1, C4, C5 and OD-4a, but it does not gate them                                                                                        |
| **O7** — refund policy in full                | P10                    | Only the narrow Phase 6 slice (destination and actor for an automatic unfulfillable refund) is needed at P6-6. Ticket voiding, cap restoration, post-settlement rules and `partially_refunded` are all P10 — and the `'void'` ticket status does not exist yet, so none of it is reachable now |
| **O9** — major configuration list in full     | P10                    | Only the payment-config question is needed, at P6-7, and option 4 (no write API in Phase 6) would defer even that                                                                                                                                                                              |
| **O12** — compliance values including wording | P12                    | OD-6 locks that Phase 6 writes no email copy. Phase 6 decides whether an event exists and what data it carries; wording is P12                                                                                                                                                                 |
| **OD-6a** — what the notification asserts     | P6-6                   | Later than C1 and C3/C4, and independent of the schema                                                                                                                                                                                                                                         |
| **OD-2a** — token design                      | P6-8                   | The last slice that needs it. It does not constrain `payments` or `payment_events`                                                                                                                                                                                                             |
| **C6** — Gate 4 wording                       | P6-4, and finally P6-9 | Affects what is claimed, not what is built                                                                                                                                                                                                                                                     |
| Instant-win seam in finalization              | P8                     | B10 places instant-win evaluation in the same transaction, so P6-4 leaves a seam. Building the seam does not require knowing what fills it                                                                                                                                                     |
| `partially_refunded` transition               | P10                    | Phase 6 emits no partial refunds                                                                                                                                                                                                                                                               |
| Wallet interaction (`wallet_applied_minor`)   | P7                     | Stays 0 throughout Phase 6, constrained by `orders_totals_add_up`                                                                                                                                                                                                                              |

**One correction to carry forward.** `PHASE_6_SCOPE_LOCK.md` §26 lists **O5** among pre-existing open questions. O5 was closed by [ADR-0024](adr/0024-settlement-grace-period.md) on 2026-09-21. The substance of that row is right — C1 option C would change what "reservation TTL" means — but it understates the consequence: it would require **amending an accepted ADR**, not resolving an open question. To be corrected in a later documentation pass, together with any wording changes that follow from the C6 decision.

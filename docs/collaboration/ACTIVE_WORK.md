# Active Work

_Last updated: 2026-09-29_

Who is working on what **right now**, so that parallel work does not collide. Rules: [DEVELOPMENT_RULES.md](../DEVELOPMENT_RULES.md) §8–§10.

- GitHub issues and pull requests are the authority. This file is the readable summary.
- One entry per active task. Edit only your own entry.
- Add the entry when you claim a task. Update it on meaningful progress or a new blocker. Remove it in the PR that completes the task.
- An entry with no update for 5 working days is stale. Ask before taking the work over.
- Only work that has been **pushed** is visible to other developers. Also check other branches: `git branch -r --no-merged origin/develop`.

## Entry format

```text
### <Task ID> — <short title>

Developer: <name / GitHub username>
Branch: <branch>
Issue: <#number or "none yet">
PR: <#number or "none yet">
Status: IN PROGRESS | BLOCKED | IN REVIEW

Current task:
<one or two sentences: the current objective>

Affected areas:
<directories / files / modules being changed>

Avoid modifying:
<what others should not touch until this lands>

Blockers:
<blockers and open architectural questions, or "None">

Last update:
<YYYY-MM-DD — what changed>

Next:
<expected next step>
```

## Current project state

- **Phases 1–4:** complete. Phase 4 merged into `develop` (**PR #8**, `49e3903`) and released to `main` (**PR #9**, `c284825`).
- **Phase 5 (cart + checkout):** **COMPLETE.** P5-0 through P5-8 merged. The phase ends where Option A said it would: the order is `awaiting_payment`, the reservation is still active and its tickets still `reserved`.
- **Phase 6 (payments + settlement):** **P6-1 through P6-5 merged** into `develop` — PR #26 (P6-1), #27 (P6-2), #29 (P6-3), #30 (P6-4), #31 (P6-5). `develop` is at `a71e687`; CI green. Migrations `0019`–`0025`.
- **[PHASE_6_SCOPE_LOCK.md](../PHASE_6_SCOPE_LOCK.md) is the authority for Phase 6.** The phase plan in PROJECT_STATUS.md predates it; where they disagree, the scope lock wins.
- **P6-6 is consumed by P6-4**, not outstanding. Everything §22 originally listed under it — `paid_unfulfillable` (D14 = A), the automatic refund to the original instrument (D15a, D15b), `order.unfulfillable` (D16a) — shipped in P6-4, because the locked D21/D22.3/D23 outcomes need a refund at the moment finalisation decides. It is **not** a separate implementation slice.
- **P6-7** is implemented on `feature/p6-7-market-payment-config` (`1418ab2`), not yet merged.
- **P6-8 (web payment flow) is the active task**, branched from it. **P6-9** (hardening and Gate 4 sign-off) remains.
- **The web purchase journey is basket-first as of P6-8.** An order is built from the basket and must match it exactly (ADR-0032), so the draw page now adds to the basket rather than reserving directly. The allocation is unchanged — `CartService` takes the same hold through the same engine — and the reservation detail page is kept and linked from each basket line.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `a71e687`.

### Open owner decisions carried by Phase 6

Recorded so they are not mistaken for oversights. None may be decided by an implementer.

| Ref                                                                                                                   | State                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **K-3** — a provider capture against a **`cancelled`** order (`capture_without_settlement`)                           | **OPEN — owner decision required.** Detected, flagged and left unprocessed so reconciliation finds it; nothing is fulfilled, refunded or mutated. D23 covers `expired` only, and extending it would be inventing policy (I24) |
| **K-c** — what makes an ORDER failed                                                                                  | **OPEN.** `order.payment_failed` has a registered handler and **no producer**. Under D3 = B a customer whose attempt failed may start another while their deadline holds, so a failed attempt is not a failed order           |
| Manual retry after a **terminal `failed` refund**                                                                     | **OPEN**, and outside automatic retry by K-b                                                                                                                                                                                  |
| **O7** (wider refund policy), **O9** (configuration list), **O12** (compliance values), **O13** (production provider) | Open, all deferred beyond Phase 6 by design                                                                                                                                                                                   |

## Active entries

### P6-8 — Web payment flow

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p6-8-web-payment-flow` (from `feature/p6-7-market-payment-config` `1418ab2`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN REVIEW

Current task:
Making the backend purchase and payment system reachable from a browser (OD-2; **D18 = B**, **D19 = A**, **D19a**). Migration `0027_order_access_tokens`, the read-only return link, and the basket-first customer journey.

Affected areas:
`packages/db/migrations/0027_order_access_tokens.sql` (new), `apps/api/src/orders/{order-access.service,checkout.service,orders.module,markets}`, `apps/api/src/payments/{order-access.controller,payments.service,payments.module}.ts`, `apps/api/src/auth/rate-limiter.ts`, `apps/api/src/config/env.ts`, `packages/contracts/src/orders.ts`, `packages/payments/src/fake-provider.ts`, `apps/web/src/app/[market]/{basket,checkout,orders,cart-actions,checkout-actions}`, `apps/web/src/app/checkout/payments/[id]/{return,cancel}`, `apps/web/src/lib/{api,checkout}.ts`, `apps/web/src/components/entry-panel.tsx`, e2e, docs.

Avoid modifying:
`packages/db/migrations/` (`0027` is taken by this branch; the next free number is `0028`). The payment and order state machines are unchanged by this slice and must stay that way.

Blockers:
None. **Four things for the reviewer:**

1. **The web purchase journey deliberately moved to the basket.** `POST /checkout/orders` builds an order from the caller's basket and the order must match it exactly (ADR-0032), so a hold taken by the old draw-page route could never become an order — the two paths reached the same engine by different doors, and only one of them leads to checkout. The draw page now adds to the basket. **The allocation is unchanged**: `CartService` takes the same real hold, through the same ticket engine, under the same cap and locks. No second reservation or basket mechanism exists.
2. **The reservation detail page is kept**, and each basket line links to it. The hold is real and its ticket numbers are worth showing; deleting the page to simplify the new flow would have lost something true.
3. **Webhook resolution and payment authority are untouched.** Nothing in the web flow can mark an order paid. The return page presents a read-only token and prints what the database says; a forged query string, a replayed link and twenty refreshes all produce the same answer.
4. **`draws.spec.ts` and `reservations.spec.ts` were updated, not weakened.** Their assertions described the old journey. Allocation, real ticket numbers, sequential padding, the per-person cap, expiry, release, market isolation and authorization are all still asserted — one page further along.

Last update:
2026-09-29 — Implemented. 29 order-access integration tests, a new Playwright journey spec, and the two existing specs updated to the basket-first flow.
2026-09-29 — Corrective pass after the first CI run: defects A (a Server Component tried to set a cookie), B (the e2e raced a failed navigation), C (a `>= 400` assertion hid a 500) and D (a POST issued during a plain navigation, correctly refused by the CSRF hook for want of an `Origin`). Owner decision **S2**: order access is a read-only bearer-authenticated `GET /checkout/order-access` with the token in `x-hv-order-access`, and the browser return exchange stays a Route Handler. `statusByAccess` no longer reconciles. See HANDOFFS for the full record.

Next:
Owner review of the P6-8 PR.

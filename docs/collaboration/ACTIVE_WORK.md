# Active Work

_Last updated: 2026-09-28_

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
- **P6-7 (per-market payment configuration) is the active task.** P6-8 (web payment flow, `order_access_tokens`) and P6-9 (hardening and Gate 4 sign-off) remain.
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

### P6-7 — Per-market payment configuration

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p6-7-market-payment-config` (from `origin/develop` `a71e687`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN REVIEW

Current task:
Making the payment provider a property of the **market** rather than of the deployment (B10; owner decision **D17 = A**). Migration `0026_market_payment_configs`, a `PaymentProviderRegistry` that resolves per market for initiation, reconciliation and refunds, and the staff configuration surface under `config.manage`.

Affected areas:
`packages/db/migrations/0026_market_payment_configs.sql` (new), `apps/api/src/payments/{payment-provider.factory,payment-provider.registry,admin-payment-config.service,admin-payment-config.controller,payments.service,payments-reconcile.service,refunds.service,payments.module}.ts`, `apps/api/src/webhooks/webhook-intake.service.ts`, `packages/contracts/src/{admin,errors}.ts`, `packages/db/src/testing/fixtures.ts`, tests, docs.

Avoid modifying:
`packages/db/migrations/` (`0026` is taken by this branch; the next free number is `0027`). The payment and order state machines are unchanged by this slice and should stay that way.

Blockers:
None. **Three things for the reviewer:**

1. **Webhook resolution deliberately does not read the new table.** It resolves by provider code from the environment alone. Had it consulted `market_payment_configs`, a delivery for a configured provider and one for an unconfigured provider would answer differently, and the route would become a way to enumerate which markets are configured. P6-3's boundary is otherwise untouched.
2. **`config_ref` is stored and audited but nothing reads it yet.** It names which credential set a provider should use, and no production provider exists to have credential sets (OPEN O13). Wiring it to a credential lookup belongs with the provider that needs one; saying so is better than a lookup that pretends.
3. **Enabling a market in a test now requires configuring one too.** `enableMarketsForTesting` calls the new `configurePaymentsForTesting`, because a market with no provider cannot take a payment — which is the point.

Last update:
2026-09-28 — Implemented. 33 new integration tests; all 206 existing payment, finalization, reconciliation, refund and webhook tests green.

Next:
Owner review of the P6-7 PR.

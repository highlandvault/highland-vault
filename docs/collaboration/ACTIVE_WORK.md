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
- **Phase 6 (payments + settlement):** **P6-1 through P6-8 merged** into `develop` — PR #26 (P6-1), #27 (P6-2), #29 (P6-3), #30 (P6-4), #31 (P6-5), #33 (P6-7), #34 (P6-8), #35 (the P6-8 corrective pass). `develop` is at `748b9e9`; CI green (PR #66, post-merge #67). Migrations `0019`–`0027`.
- **[PHASE_6_SCOPE_LOCK.md](../PHASE_6_SCOPE_LOCK.md) is the authority for Phase 6.** The phase plan in PROJECT_STATUS.md predates it; where they disagree, the scope lock wins.
- **P6-6 is consumed by P6-4**, not outstanding. Everything §22 originally listed under it — `paid_unfulfillable` (D14 = A), the automatic refund to the original instrument (D15a, D15b), `order.unfulfillable` (D16a) — shipped in P6-4, because the locked D21/D22.3/D23 outcomes need a refund at the moment finalisation decides. It is **not** a separate implementation slice.
- **P6-7** (per-market payment configuration) merged by PR #33.
- **P6-8** (web payment flow) merged by PR #34, and its corrective pass by PR #35 — see [ADR-0035](../adr/0035-customer-payment-status-is-read-only.md) for the decision the second pass reached.
- **P6-9 (hardening and Gate 4 sign-off) is the active task**, taken one work package at a time. **WP-3** (payment-status GET semantics) is in progress; **WP-4** (integration-suite stability) and the Gate 4 matrix follow.
- **The web purchase journey is basket-first as of P6-8.** An order is built from the basket and must match it exactly (ADR-0032), so the draw page now adds to the basket rather than reserving directly. The allocation is unchanged — `CartService` takes the same hold through the same engine — and the reservation detail page is kept and linked from each basket line.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `748b9e9`.

### Open owner decisions carried by Phase 6

Recorded so they are not mistaken for oversights. None may be decided by an implementer.

| Ref                                                                                                                   | State                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **K-3** — a provider capture against a **`cancelled`** order (`capture_without_settlement`)                           | **OPEN — owner decision required.** Detected, flagged and left unprocessed so reconciliation finds it; nothing is fulfilled, refunded or mutated. D23 covers `expired` only, and extending it would be inventing policy (I24) |
| **K-c** — what makes an ORDER failed                                                                                  | **OPEN.** `order.payment_failed` has a registered handler and **no producer**. Under D3 = B a customer whose attempt failed may start another while their deadline holds, so a failed attempt is not a failed order           |
| Manual retry after a **terminal `failed` refund**                                                                     | **OPEN**, and outside automatic retry by K-b                                                                                                                                                                                  |
| **O7** (wider refund policy), **O9** (configuration list), **O12** (compliance values), **O13** (production provider) | Open, all deferred beyond Phase 6 by design                                                                                                                                                                                   |

## Active entries

### P6-9 — Hardening and Gate 4 sign-off

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p6-9-payment-status-read-only` (from `develop` `748b9e9`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN PROGRESS

Current task:
**WP-3 only** — making the customer payment-status GET genuinely read-only ([ADR-0035](../adr/0035-customer-payment-status-is-read-only.md)). The route could reach `finalization.confirm` through a trusted status check, so a GET could capture a payment, sell tickets, release holds, raise a refund and write outbox rows. It now reads the database and returns.

Affected areas:
`apps/api/src/payments/{payments.service,payments.controller}.ts`, `apps/api/test/payment-reconciliation.int.test.ts`, `apps/web/src/lib/checkout.ts` (dead `fetchPaymentStatus` removed), `docs/adr/0035-*`, docs.

Avoid modifying:
The webhook path, the P6-5 reconciler, the internal reconciliation route, the staff reconcile POST, payment provider configuration, settlement, the ticket engine, refunds policy. WP-3 touches the customer read path and nothing else.

Blockers:
None. **For the reviewer:**

1. **Payment advancement is unchanged.** The verified webhook stays authoritative and the P6-5 reconciler stays the recovery path. Two tests assert that the same payment still settles by each of them after any number of customer reads.
2. **No `POST …/check` was introduced.** There is no caller that needs one, and the staff route already provides a deliberate, audited way to ask the provider.
3. **An existing test changed meaning, not strength.** `audits an anomaly the customer status route discovers` asserted the opposite of the new rule. It now asserts that the route finds nothing and that the internal path still does — the anomaly is discovered by a scheduled check rather than by whoever refreshed.
4. **The rate-limit test was strengthened, not relaxed.** Its provider spy now watches from the first call, so it proves no read reaches the provider, rather than only that a refused one does not.

Work packages still to come:
**WP-4** integration-suite stability (two transient data points on record; mechanism unidentified, not to be called contention without evidence), the **Gate 4 matrix** G4.1–G4.13 (G4.4 deferred to Gate 6 / P8 by D8 = A), the **Phase 6 Definition of Done** (G4.10, required before the phase closes), Gate 1 and Gate 2 re-run (G4.12), and documentation reconciliation.

Last update:
2026-09-29 — WP-3 implemented: `status` no longer calls `reconcile`; ADR-0035 written; four read-only regression tests added; the dead `fetchPaymentStatus` helper removed after confirming zero callers.

Next:
Owner review of WP-3, then WP-4.

# Active Work

_Last updated: 2026-09-25_

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

- **Phases 1–3:** complete. Phase 3 merged into `develop` (PR #7, `3eb551e`); GitHub CI green on `develop`.
- **Phase 4 (Day 4):** DONE. Merged into `develop` via **PR #8** (`49e3903`) and released to `main` via **PR #9** (`c284825`) on 2026-09-23. O15 decided: sequential ticket numbers (ADR-0027). Review items carried into Phase 5 are in [PROJECT_STATUS.md](../PROJECT_STATUS.md).
- **Phase 5 (Day 5):** under way, Option A (specification-faithful), ending at `pending_payment`; payments, webhooks, RESERVED → SOLD and Gate 4 stay in Phase 6 (ADR-0006). **P5-0 to P5-6 are merged**, along with NB-3, the gitleaks placeholder fix, the ticket-engine teardown fix and the local gitleaks tooling. The remaining work is scoped as **P5-5 to P5-8** in [PROJECT_STATUS.md](../PROJECT_STATUS.md) ("Phase 5 remaining scope"), and the phase closes against the Phase 5 Definition of Done there. **P5-7 (order creation, skill answer and idempotency) is the active task.** P5-8 is not approved to start.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `210c217`.

## Active entries

### P5-7 — Order creation, skill answer and idempotency

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p5-7-order-creation` (from `origin/develop` `210c217`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN PROGRESS

Current task:
Turning a basket into an order (B7, B18, B20; ADR-0030, ADR-0031). Migration `0016_orders`; `orders` and `order_items`, server-side skill-answer validation, the accepted terms version on the order, and `Idempotency-Key` backed by a UNIQUE constraint rather than a cache. **The order ends at `awaiting_payment`**: the reservation stays active, its tickets stay `reserved`, and no payment exists.

Affected areas:
`packages/db/migrations/0016_orders.sql` (new), `packages/db/src/generated/db.ts` (codegen, 27 tables), `packages/domain/src/order-number.ts` (new), `packages/contracts/src/orders.ts` (new), `apps/api/src/orders/` (new), `apps/api/src/terms/` (two read paths for checkout), `apps/api/src/app.module.ts`, docs.

Avoid modifying:
`packages/db/migrations/` (0016 is taken by this branch; the next free number is 0017), `apps/api/src/orders/`.

Blockers:
None. **Three things for the reviewer:**

1. **The stored status is `awaiting_payment`, not `pending_payment`.** B7 names the former and Phase 6 implements its transitions literally; the planning prose used the latter informally. Same moment, and the CHECK admits the whole B7 enumeration.
2. **The checkout request is self-describing (ADR-0032).** The specification does not say whether a checkout describes the purchase or just says "convert my basket"; a read-only review confirmed the gap and the owner decided. `CreateOrderRequest` now carries `items: [{ slug, quantity, optionId? }]`, the server matches it against the locked basket, and `orders.idempotency_digest` (not in B18) hashes that semantic request so "same key, different purchase" is refusable.
3. **`order_number` is `HV-` + 10 base32 characters.** ADR-0031 left the length here; the reasoning is in `packages/domain/src/order-number.ts` and PROJECT_STATUS.

Last update:
2026-09-25 — Implemented with 39 integration tests against real PostgreSQL, including basket/request mismatch, a five-way concurrent idempotency race, same-key-different-purchase refusals, cross-customer key reuse, and positive assertions that nothing is sold and no payment table exists.

Next:
Owner review of the P5-7 PR. P5-8 does not start until this merges and the owner approves it.

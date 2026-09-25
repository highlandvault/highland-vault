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
- **Phase 5 (Day 5):** under way, Option A (specification-faithful), ending at `pending_payment`; payments, webhooks, RESERVED → SOLD and Gate 4 stay in Phase 6 (ADR-0006). **P5-0 to P5-4 are merged**, with NB-3, the gitleaks placeholder fix, the ticket-engine teardown fix and the local gitleaks tooling. The remaining work is scoped as **P5-5 to P5-8** in [PROJECT_STATUS.md](../PROJECT_STATUS.md) ("Phase 5 remaining scope"), and the phase closes against the Phase 5 Definition of Done there. **P5-5 (guest checkout access and the per-market basket) is the active task**; the three decisions that blocked it were settled on 2026-09-25 by [ADR-0031](../adr/0031-checkout-cart-terms-and-order-numbers.md). No later P5 task is approved to start.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `b352187`.

## Active entries

### P5-5 — Guest checkout access + per-market basket

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p5-5-guest-checkout-basket` (from `origin/develop` `b352187`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN PROGRESS

Current task:
The server-side basket (B4, ADR-0026, ADR-0031) and the path that lets a verified guest buy without an account. Migration `0014_carts`; `carts` and `cart_items`; three market-scoped routes under `/markets/:market/cart`. Adding a draw takes a real reservation through the **existing** allocator, so a basket holds tickets rather than intentions.

Affected areas:
`packages/db/migrations/0014_carts.sql` (new), `packages/db/src/generated/db.ts` (codegen, 23 tables), `packages/contracts/src/cart.ts` (new), `apps/api/src/cart/` (new), `apps/api/src/tickets/` (`findById`, two members made reusable, module exports), `apps/api/src/auth/rate-limiter.ts`, `apps/api/src/app.module.ts`, docs.

Avoid modifying:
`packages/db/migrations/` (0014 is taken by this branch; the next free number is 0015), `apps/api/src/cart/`.

Blockers:
None. **Two things for the reviewer:**

1. **A cart item does not copy quantity, price or currency.** The reservation already records all three under constraints tying them to the draw and the market; a second copy could only drift from the first. Money is read from the reservation.
2. **The authenticated reservation routes were not touched.** Guests reach tickets through the basket, which is the smallest change that gives guest checkout without loosening anything a session currently guards.

Last update:
2026-09-25 — Implemented with 34 integration tests against real PostgreSQL and Redis, including the guest/account boundary, market isolation attempted in raw SQL, and four concurrency cases.

Next:
Owner review of the P5-5 PR. P5-6 does not start until this merges and the owner approves it.

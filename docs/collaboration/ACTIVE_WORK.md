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
- **Phase 5 (Day 5):** under way, Option A (specification-faithful), ending at `awaiting_payment`; payments, webhooks, RESERVED → SOLD and Gate 4 stay in Phase 6 (ADR-0006). **P5-0 through P5-7 are merged**, along with NB-3, the gitleaks placeholder fix, the ticket-engine teardown fix and the local gitleaks tooling. **P5-8 (Phase 5 integration and gate hardening) is the active task, and the last in the phase.** The scope of P5-5 to P5-8 is in [PROJECT_STATUS.md](../PROJECT_STATUS.md) ("Phase 5 remaining scope"), and the phase closes against the Phase 5 Definition of Done there.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `9e0ec50`.

## Active entries

### P5-8 — Phase 5 integration and gate hardening

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p5-8-phase5-hardening` (from `origin/develop` `9e0ec50`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN PROGRESS

Current task:
Closing Phase 5. Scoped as test hardening; the opening audit found **two accepted requirements that had never been built**, so it carries real implementation: **ADR-0021 guest → account cap bridging** (migrations `0017` and `0018`) and the **B19 checkout rate limit** ADR-0030 says it relies on. Plus the integrated guest and authenticated journeys, and cross-identity order isolation.

Affected areas:
`packages/db/migrations/{0017_entrant_rekey,0018_cart_guard_bridged_entrant}.sql` (new), `packages/db/src/entrant-lock.ts` (new), `apps/api/src/tickets/{cap-bridging.repository,ticket-allocator}.ts`, `apps/api/src/auth/{auth.service,auth.module,rate-limiter}.ts`, `apps/api/src/cart/cart.service.ts`, `apps/api/src/orders/{checkout.service,orders.module}.ts`, tests, docs.

Avoid modifying:
`packages/db/migrations/` (0017 and 0018 are taken by this branch; the next free number is 0019).

Blockers:
None. **Three things for the reviewer:**

1. **Two migrations, not one.** `0017` was planned. `0018` was **found by a test**: `hv_cart_items_guard` required a guest basket to hold an email-keyed reservation, which stops being true the moment bridging charges a guest to their account.
2. **The engine now takes one advisory lock** (`lockEntrantEmail`), which ADR-0011 previously said it did not. Row locks cannot serialise a row that does not exist yet. Recorded as an ADR-0011 amendment.
3. **The checkout limit is not an answer-attempt counter.** It satisfies B19 and ADR-0030's stated premise; it does not make a 3-to-10-option question unguessable, and the code and docs say so rather than implying otherwise.

Last update:
2026-09-25 — Implemented. 8 bridging tests, 4 checkout rate-limit tests, 4 journey/isolation tests, all existing Phase 5 tests green.

Next:
Owner review of the P5-8 PR, then the Phase 5 Definition of Done can be signed off.

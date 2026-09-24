# Active Work

_Last updated: 2026-09-23_

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
- **Phase 5 (Day 5):** under way, Option A (specification-faithful), ending at `pending_payment`; payments, webhooks, RESERVED → SOLD and Gate 4 stay in Phase 6 (ADR-0006). **P5-0, NB-3, P5-1, P5-2, the ticket-engine teardown fix and the local gitleaks tooling are merged.** **P5-3 (guest sessions) is the active task.** No later P5 task is approved to start.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `5ebbdf2`.

## Active entries

### P5-3 — Guest sessions

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p5-3-guest-sessions` (from `origin/develop` `5ebbdf2`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN PROGRESS

Current task:
Guest identity for checkout (ADR-0029): migration `0012_guest_sessions`, repository and service reusing the authenticated session primitives, the `hv_guest` cookie, and guest resolution on public routes only. **It is not authentication** and cannot satisfy any authenticated or admin route. **No verification flow yet** — issuing codes is P5-4.

Affected areas:
`packages/db/migrations/0012_guest_sessions.sql` (new), `packages/db/src/generated/db.ts` (codegen, 20 tables), `apps/api/src/guests/` (new), `apps/api/src/auth/cookies.ts` (one implementation, two cookies), `apps/api/src/rbac/access.guard.ts` (public branch only), `apps/api/src/common/request-context.ts`, `apps/api/src/config/env.ts`, docs, ADR-0029.

Avoid modifying:
`packages/db/migrations/` (0012 is taken by this branch; the next free number is 0013), `apps/api/src/guests/`.

Blockers:
None.

Last update:
2026-09-24 — Implemented with 41 focused tests, including negative authorization tests that drive real guest cookies at customer and admin routes and prove they are refused.

Next:
Owner review of the P5-3 PR. P5-4 does not start until this merges and the owner approves it.

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
- **Phase 5 (Day 5):** begun, **task P5-0 only**. Scope is Option A (specification-faithful), ending at `pending_payment`; payments, webhooks, RESERVED → SOLD and Gate 4 stay in Phase 6 (ADR-0006). O12 decided (incorrect skill answer rejects the checkout). No later P5 task is approved to start.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `aec2aa9`.

## Active entries

### P5-0 — NB-1 structural reservation-end fix

Developer: Divyanshu (repository owner), working with Claude
Branch: `fix/p5-0-reservation-end-cap` (from `origin/develop` `aec2aa9`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN PROGRESS

Current task:
Make the entrant-cap decrement in `hv_end_reservation` follow the ticket rows actually freed rather than the reservation quantity, so the invariant is structural before Phase 6 introduces RESERVED → SOLD. New migration `0010_reservation_end_fix`; migration `0009` is untouched.

Affected areas:
`packages/db/migrations/0010_reservation_end_fix.sql` (new), `packages/db/test/tickets.int.test.ts` (regression tests), docs.

Avoid modifying:
`packages/db/migrations/` (0010 is taken by this branch; the next free number is 0011), `hv_end_reservation`.

Blockers:
None. NB-1 is unreachable in Phase 4 and Phase 5 because nothing writes `sold`; this lands first because Phase 6 depends on it.

Last update:
2026-09-23 — Migration written, four regression tests added. The defect was reproduced against the original 0009 function on a scratch database (cap returned to 0 while a sold ticket was still held) and the same scenario returns 1 under 0010. `pnpm verify` exit 0; integration 259/259; e2e 38/38; clean-database sequence green.

Next:
Owner review of the P5-0 PR. P5-1 does not start until this merges and the owner approves it.

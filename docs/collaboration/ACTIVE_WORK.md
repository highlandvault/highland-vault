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
- **Phase 5 (Day 5):** under way, Option A (specification-faithful), ending at `pending_payment`; payments, webhooks, RESERVED → SOLD and Gate 4 stay in Phase 6 (ADR-0006). O12 decided (incorrect skill answer rejects the checkout). **P5-0 merged (PR #11)** and the **NB-3 fixture fix merged (PR #12)**. **P5-1 (outbox) is the active task.** No later P5 task is approved to start.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `cb3813e`.

## Active entries

### P5-1 — Transactional outbox

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p5-1-outbox` (from `origin/develop` `cb3813e`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN PROGRESS

Current task:
The transactional outbox foundation: migration `0011_outbox` (table, guard trigger, `hv_claim_outbox`), `enqueueOutboxEvent` for producers, and a worker that claims and delivers due events. **No producers and no handlers yet** — P5-2 registers the first one with the mail port.

Affected areas:
`packages/db/migrations/0011_outbox.sql` (new), `packages/db/src/generated/db.ts` (codegen, 19 tables), `apps/worker/src/outbox/` (new), `apps/worker/src/worker.module.ts`, `apps/worker/test/outbox.int.test.ts` (new), docs.

Avoid modifying:
`packages/db/migrations/` (0011 is taken by this branch; the next free number is 0012), `apps/worker/src/outbox/`.

Blockers:
None.

Last update:
2026-09-24 — Outbox implemented with 17 integration tests. `SKIP LOCKED` was proven non-vacuous by comparing against a variant without it (the variant blocks on the locked tuple and times out).

Next:
Owner review of the P5-1 PR. P5-2 does not start until this merges and the owner approves it.

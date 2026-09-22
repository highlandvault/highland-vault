# Active Work

_Last updated: 2026-09-22_

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

- **Phase 1 (Day 1) Foundation:** complete and approved by the owner.
- **Phase 2 (Day 2):** DONE: merged into `develop` (PR #3; test fix PR #4). Governance follow-ups merged: PR #5 (branch policy), PR #6 (CI on `develop` pushes).
- **Phase 3 (Day 3):** IN PROGRESS, started on owner instruction on 2026-09-22.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is still at `a16ca35`.
- **GitHub CI:** runs on PRs and on pushes to `main` and `develop`; green on `develop` (`8677781`).

## Active entries

### P3 — Draws foundation + first customer vertical slice

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p3-draws` (from `origin/develop` `8677781`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub API)
PR: draft PR into `develop` (see TASK_BOARD)
Status: IN PROGRESS

Current task:
Phase 3 (Initialization Report, Part F): draw schema + lifecycle, prizes and winner positions, per-draw skill question, publishing, customer draw list/detail per market, admin draw management.

Affected areas:
`packages/db/migrations/` (0008 onwards), `packages/db/src/`, `packages/domain/src/`, `packages/contracts/src/`, `apps/api/src/draws/` (new), `apps/worker/src/draws/` (new, lifecycle sweeper), `apps/web/src/app/` (customer + admin draw pages, styles), `apps/web/e2e/`, docs.

Avoid modifying:
`packages/db/migrations/` (0008+ are taken by this branch), `apps/web/src/app/[market]/`, `apps/web/src/app/admin/`, `apps/web/src/app/layout.tsx` and global styles.

Blockers:
None. Customer pages stay unreachable on real databases until O12 lets a market be enabled; tests use fixture markets.

Last update:
2026-09-22 — Task claimed, branch created.

Next:
Migrations, domain rules, API, worker sweeper, web, tests.

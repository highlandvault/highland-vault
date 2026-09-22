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
- **T-001 collaboration layer:** approved and merged into `develop` (PR #2, `e05f270`).
- **Phase 2 (Day 2):** DONE: merged into `develop` (PR #3, `6b0ea82`; commit `b06226b`). Phase 3 not started; it needs explicit owner approval.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/develop` = `main` + PR #2 + PR #3; `origin/main` is still at `a16ca35`.
- **GitHub issues / PRs:** PR #2 and PR #3 (both merged into `develop`). The GitHub CLI is not installed on this machine, so no issue could be created or checked.

## Active entries

_None._

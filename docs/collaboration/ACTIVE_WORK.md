# Active Work

_Last updated: 2026-09-22_

Who is working on what **right now**, so that parallel work does not collide. Rules: [DEVELOPMENT_RULES.md](../DEVELOPMENT_RULES.md) §8–§10.

- GitHub issues and pull requests are the authority. This file is the readable summary.
- One entry per active task. Edit only your own entry.
- Add the entry when you claim a task. Update it on meaningful progress or a new blocker. Remove it in the PR that completes the task.
- An entry with no update for 5 working days is stale. Ask before taking the work over.
- Only work that has been **pushed** is visible to other developers. Also check other branches: `git branch -r --no-merged origin/main`.

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
- **Phase 2 (Day 2):** not started. It starts only on explicit owner instruction.
- **Repository:** one commit, `a16ca35` ("adding day1"). `main` and `develop` both point at it, locally and on `origin`.
- **GitHub issues / PRs:** none known. The GitHub CLI was not available when this file was written, so this was not checked against GitHub.

## Active entries

### T-001 — Collaboration and synchronization layer

Developer: Divyanshu (repository owner), working with Claude
Branch: `develop` (uncommitted working tree)
Issue: none yet
PR: none yet
Status: IN REVIEW

Current task:
Add the repository/GitHub-based collaboration layer: development rules, the Claude Collaboration Protocol, active work, task board, handoffs, changelog, CODEOWNERS and the PR template. Operational documentation only.

Affected areas:
`docs/DEVELOPMENT_RULES.md`, `docs/collaboration/`, `.github/CODEOWNERS`, `.github/pull_request_template.md`, `CLAUDE.md`, one link line in `README.md`, the current-phase lines in `docs/PROJECT_STATUS.md`.

Avoid modifying:
The files above until this is reviewed and committed.

Blockers:
None. Owner decisions pending: the role of the `develop` branch, the GitHub username for CODEOWNERS, and branch protection on `main`.

Last update:
2026-09-22 — Files created and verified locally. Not committed, not pushed.

Next:
Owner review. Once approved, commit (suggested branch `docs/collaboration-layer`) and open a PR into `main`.

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
- **T-001 collaboration layer:** approved and merged into `develop` (PR #2, `e05f270`).
- **Phase 2 (Day 2):** implementation complete, IN REVIEW (owner review). Not committed or pushed.
- **Branches:** `origin/develop` = `main` + PR #2. `origin/main` is still at `a16ca35`. The role of `develop` is still an owner decision (DEVELOPMENT_RULES §4).
- **GitHub issues / PRs:** PR #2 (merged). The GitHub CLI is not installed on this machine, so no issue could be created or checked.

## Active entries

### P2 — Users · Markets · Auth · RBAC · MFA · Audit · admin shell

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p2-users-markets-auth` (from `origin/develop`; local only, not pushed yet)
Issue: none yet (no GitHub CLI available)
PR: none yet
Status: IN REVIEW

Current task:
Phase 2 as defined in the Initialization Report, Part F: markets (DE disabled, legal-approval CHECK, compliance gate), users with global email, sessions, TOTP MFA + step-up, RBAC, audit log, market API guard, `/[market]` routing via the API, `/admin` shell.

Affected areas:
`packages/db/migrations/` (0002–0007), `packages/db/src/`, `packages/domain/src/`, `packages/contracts/src/`, `apps/api/src/` (new modules), `apps/web/src/`, `apps/web/e2e/`, `.env.example`, docs.

Avoid modifying:
`packages/db/migrations/` (migration numbers 0002–0007 are taken by this branch; the next free number is 0008), `apps/api/src/app.module.ts`, `apps/api/src/config/env.ts`, `apps/web/src/app/[market]/`.

Blockers:
None for the implementation. Decisions needed (details in PROJECT_STATUS.md, "Decisions needed"):

1. O12 values (`min_age`, self-exclusion) for UK and IE. Until they exist, no market can be enabled.
2. When to build email verification and password reset (with the Phase 5 outbox, or now).
3. O8: which roles must use MFA.
4. O9: which configuration changes count as sensitive.
5. Confirmation of the seeded RBAC matrix.
6. The PR's target branch (`develop` or `main`).

Last update:
2026-09-22 — Phase 2 implemented and verified. `pnpm verify` exit 0; unit 82/82, integration 133/133, e2e 11/11. Migrations 0002–0007 applied to the local dev DB. Handoff written.

Next:
Owner review. On approval: commit on this branch, push, and open the PR (target branch per decision 6). Then remove this entry and mark P2 DONE on the task board.

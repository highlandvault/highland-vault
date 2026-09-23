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
- **Phase 4 (Day 4):** IN PROGRESS. Implemented and fully verified locally, but **not committed or pushed, and no PR is open** — the branch is still at `af8645a` (the claim commit). O15 decided: sequential ticket numbers (ADR-0027). Phase 5 has not started.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is still at `a16ca35`.

## Active entries

### P4 — Ticket engine + customer entry flow

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p4-ticket-engine` (from `origin/develop` `3eb551e`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub API)
PR: none yet
Status: IN PROGRESS

Current task:
Phase 4 is implemented and fully verified locally, and is waiting to be committed: sequential ticket pool, allocation with SKIP LOCKED, per-entrant caps, 10-minute reservations and expiry, availability, customer reservation flow, admin inventory. Gates 1 and 2 pass. The work is uncommitted in the working tree; it needs an owner instruction to commit, push and open the PR.

Affected areas:
`packages/db/migrations/` (0009 onwards), `packages/domain/src/`, `packages/contracts/src/`, `apps/api/src/tickets/` (new), `apps/api/src/rbac/` (`@Public({ identify: true })`), `apps/worker/src/tickets/` (new), `apps/web/src/app/[market]/`, `apps/web/src/app/admin/draws/`, `apps/web/e2e/`, `vitest.config.mts` (integration worker cap), docs.

Avoid modifying:
`packages/db/migrations/` (0009 is taken by this branch; the next free number is 0010), `apps/api/src/tickets/`, `apps/web/src/app/[market]/draws/[slug]/`, `apps/web/src/app/[market]/reservations/`.

Blockers:
None. Guest reservations depend on guest email verification (ADR-0020, Phase 5); the engine supports the email entrant key already.

Last update:
2026-09-23 — Full verification run: unit 139/139, integration 255/255, e2e 38/38, concurrency 3/3 rounds, clean-DB migrations, secret scan, `pnpm verify` exit 0. Capped integration workers at 4 and removed two thin-margin timing assumptions in the reservation expiry tests (details in PROJECT_STATUS.md, choices 10).

Next:
Owner instruction to commit and push the branch and open the PR into `develop`. Remove this entry when it merges.

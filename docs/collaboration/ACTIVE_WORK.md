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
- **Phase 5 (Day 5):** under way, Option A (specification-faithful), ending at `pending_payment`; payments, webhooks, RESERVED → SOLD and Gate 4 stay in Phase 6 (ADR-0006). **P5-0 to P5-4 are merged**, with NB-3, the gitleaks placeholder fix, the ticket-engine teardown fix and the local gitleaks tooling. The remaining work is scoped as **P5-5 to P5-8** in [PROJECT_STATUS.md](../PROJECT_STATUS.md) ("Phase 5 remaining scope"), and the phase closes against the Phase 5 Definition of Done there. **P5-6 (market terms versions and acceptance) is the active task.** P5-0 to P5-5 are merged. No later P5 task is approved to start.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `e61e31a`.

## Active entries

### P5-6 — Market terms versions and acceptance

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p5-6-market-terms` (from `origin/develop` `e61e31a`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN PROGRESS

Current task:
Per-market terms versions and the act of accepting them (B12, ADR-0031). Migration `0015_market_terms`; `terms_versions`, `terms_acceptances` and `market_settings.active_terms_version_id`. The active version **gates checkout, not market enablement** — a market with none is still browsable but cannot take an order, which is the flag P5-7's gate turns on.

Affected areas:
`packages/db/migrations/0015_market_terms.sql` (new), `packages/db/src/generated/db.ts` (codegen, 25 tables), `packages/db/src/testing/global-setup.ts`, `packages/contracts/src/terms.ts` (new), `apps/api/src/terms/` (new), `apps/api/src/app.module.ts`, docs.

Avoid modifying:
`packages/db/migrations/` (0015 is taken by this branch; the next free number is 0016), `apps/api/src/terms/`.

Blockers:
None. **Two things for the reviewer:**

1. **No legal wording exists anywhere in this task** — no content column, no content field, none in fixtures. B12 marks it legal and Part F puts it in Phase 12. A version is a label and a moment.
2. **A fix to shared test infrastructure.** `global-setup.ts` now reproduces the production privilege model in the test template. Without it `hv_app` had _no_ privileges in any test database, so every "hv_app cannot DELETE this" assertion — including the one P5-5 merged — passed because there was no grant to revoke. They are real now.

Last update:
2026-09-25 — Implemented with 33 integration tests against real PostgreSQL, including immutability of a published version, market isolation attempted in raw SQL, guest acceptance creating no account, and the enablement gate being left alone.

Next:
Owner review of the P5-6 PR. P5-7 does not start until this merges and the owner approves it.

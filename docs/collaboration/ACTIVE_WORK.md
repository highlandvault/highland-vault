# Active Work

_Last updated: 2026-09-24_

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
- **Phase 5 (Day 5):** under way, Option A (specification-faithful), ending at `pending_payment`; payments, webhooks, RESERVED → SOLD and Gate 4 stay in Phase 6 (ADR-0006). **P5-0, NB-3, P5-1, P5-2, the gitleaks placeholder fix, the ticket-engine teardown fix, the local gitleaks tooling and P5-3 are merged.** **P5-4 (guest email verification) is the active task.** No later P5 task is approved to start.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `b940e7d`.

## Active entries

### P5-4 — Guest email verification

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p5-4-guest-email-verification` (from `origin/develop` `b940e7d`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN PROGRESS

Current task:
The verified email a guest's ticket cap is counted against (ADR-0020, ADR-0008): migration `0013_guest_email_verifications`, a six-digit code stored only as its SHA-256, and the first real **producer** for the P5-1 outbox — the code reaches the worker sealed (ADR-0028) and is delivered by the P5-2 notifications relay. Guessing is bounded in the database (10-minute expiry, 5 attempts under a row lock, single use); sending is bounded per address (3 per hour, Redis and a second check in SQL).

Affected areas:
`packages/db/migrations/0013_guest_email_verifications.sql` (new), `packages/db/src/generated/db.ts` (codegen, 21 tables), `packages/db/src/outbox.ts` (**moved** from `apps/worker`), `packages/domain/src/verification-code.ts` and `verification-email.ts` (new / **moved**), `packages/contracts/src/guests.ts` (new), `apps/api/src/guests/email-verification.*` (new), `apps/api/src/config/env.ts`, `apps/api/src/auth/rate-limiter.ts`, `apps/api/src/common/errors.ts`, docs, ADR-0020.

Avoid modifying:
`packages/db/migrations/` (0013 is taken by this branch; the next free number is 0014), `apps/api/src/guests/`, `packages/domain/src/verification-*.ts`.

Blockers:
None. **Two things for the reviewer**, neither a redesign:

1. `enqueueOutboxEvent` moved from `apps/worker/src/outbox/outbox.ts` to `packages/db/src/outbox.ts`, and the verification-email contract from `apps/worker/src/mail/verification-email.ts` to `packages/domain`. The API is the producer and the worker the deliverer, and one app cannot import another. Both old paths still re-export, so no caller changed.
2. `OUTBOX_ENCRYPTION_KEY` is now **required** by the API (the worker still treats it as required in production only). The API cannot issue a code without it, so refusing to start beats failing one request at a time. The API now also refuses a low-entropy placeholder in production, as the worker already did.

Last update:
2026-09-24 — Implemented as a vertical slice. 20 API integration tests, 12 domain unit tests and 8 producer/consumer contract tests, covering the attempt cap, single use, expiry, cross-session use, the uniform error for every failure, and that no plaintext code is in PostgreSQL, Redis or a response.

Next:
Owner review of the P5-4 PR. P5-5 does not start until this merges and the owner approves it.

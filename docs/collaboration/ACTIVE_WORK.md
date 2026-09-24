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
- **Phase 5 (Day 5):** under way, Option A (specification-faithful), ending at `pending_payment`; payments, webhooks, RESERVED → SOLD and Gate 4 stay in Phase 6 (ADR-0006). O12 decided (incorrect skill answer rejects the checkout). **P5-0 (PR #11)**, the **NB-3 fixture fix (PR #12)** and **P5-1, the transactional outbox (PR #13, `13b35ae`)** are merged. **P5-2 (mail port and the B17 notifications relay) is the active task.** No later P5 task is approved to start.
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4). `origin/main` is at `c284825`, `origin/develop` at `13b35ae`.

## Active entries

### P5-2 — Mail port and the outbox notifications relay

Developer: Divyanshu (repository owner), working with Claude
Branch: `feature/p5-2-mail-port` (from `origin/develop` `13b35ae`)
Issue: none (no GitHub CLI; PRs are opened through the GitHub web UI)
PR: none yet
Status: IN PROGRESS

Current task:
Provider-independent `MailPort` with an SMTP adapter (Mailpit in dev/test), the B17 `outbox` → `notifications` relay keyed by the outbox row id, and AES-256-GCM sealed payloads so no plaintext one-time code is stored. **No producer yet** — the guest verification flow is P5-4. No migration.

Affected areas:
`apps/worker/src/mail/` (new), `apps/worker/src/outbox/` (relay + the approved `OutboxOutcome` change), `apps/worker/src/config/env.ts`, `packages/domain/src/` (`SecretBox` moved here, sealed-payload envelope), `.github/workflows/ci.yml` (Mailpit), `.env.example`, docs, ADR-0028.

Avoid modifying:
`apps/worker/src/outbox/`, `apps/worker/src/mail/`, `packages/domain/src/{secret-box,sealed-payload}.ts`.

Blockers:
None. O14 (production email provider) stays open by design: production refuses to start without explicit mail configuration.

Last update:
2026-09-24 — Implemented with 37 focused tests. BullMQ job-lifecycle semantics were verified by experiment first: retained completed or failed jobs silently swallow a re-enqueue under the same id, which would have destroyed the retry guarantee, so notification jobs remove themselves on both outcomes.

Next:
Owner review of the P5-2 PR. P5-3 does not start until this merges and the owner approves it.

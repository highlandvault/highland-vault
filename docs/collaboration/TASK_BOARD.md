# Task Board

_Last updated: 2026-09-22_

The shared view of every task and its state. It answers the question for a new developer or Claude session: **"What am I supposed to work on?"**

GitHub Issues (and a GitHub Project, once created) are the task authority. This board mirrors them. When a task gets an issue, add the issue number. If the board and GitHub disagree, GitHub wins.

## How to find your task

1. Look under **IN PROGRESS** and **BLOCKED** for a task owned by you. That is your current task. Continue it.
2. Otherwise, look under **READY** for a task assigned to you.
3. If nothing is assigned to you, **ask the owner**. Do not pick a task from READY or BACKLOG yourself.
4. Before starting, check its dependencies here and its area in [ACTIVE_WORK.md](ACTIVE_WORK.md).

## States

| State       | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| BACKLOG     | Known and in scope, not yet approved to start or not yet specified enough |
| READY       | Approved, dependencies done, specified enough to start. May be assigned   |
| IN PROGRESS | Claimed. Owner has a branch and is working on it                          |
| BLOCKED     | Started or ready, but cannot proceed. The blocker is named in Notes       |
| IN REVIEW   | Pull request open and ready for review                                    |
| DONE        | Merged to `main` (or, for P1, approved and committed)                     |

Transitions: BACKLOG → READY (owner) → IN PROGRESS (owner claims) → IN REVIEW (PR ready) → DONE (merged). Any state except DONE can go to BLOCKED and back.

## Task IDs

- `P1`–`P15`: phase-level tasks from the Initialization Report, Part F. Each phase is split into issues when it is approved to start.
- `T-###`: other tasks, numbered in order.
- Once a task has a GitHub issue, reference it as `#<number>`. The issue number becomes the primary ID.

## Row format

| ID  | Task | Owner | Branch | Dependencies | Area | Issue / PR | Notes |
| --- | ---- | ----- | ------ | ------------ | ---- | ---------- | ----- |

"—" means not applicable, "unassigned" means nobody owns it yet.

---

## IN PROGRESS

_None._

## BLOCKED

| ID            | Task                                            | Owner      | Branch | Dependencies | Area                                  | Issue / PR | Notes                                                                                       |
| ------------- | ----------------------------------------------- | ---------- | ------ | ------------ | ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| MIG-DISCOVERY | Legacy migration discovery (continuous from P1) | unassigned | —      | —            | `tools/migration/`, `docs/migration/` | —          | Blocked by **O17**: legacy access (plugin list and sanitized WordPress DB export). ADR-0018 |

## IN REVIEW

| ID    | Task                                    | Owner             | Branch                  | Dependencies | Area                             | Issue / PR | Notes                                                                                   |
| ----- | --------------------------------------- | ----------------- | ----------------------- | ------------ | -------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
| T-001 | Collaboration and synchronization layer | Divyanshu (owner) | `develop` (uncommitted) | P1           | `docs/`, `.github/`, `CLAUDE.md` | —          | Awaiting owner review. No PR yet, so "in review" means owner review of the working tree |

## READY

_None._ Phase 2 becomes READY only on explicit owner instruction.

## BACKLOG

Phase-level tasks from the Initialization Report, Part F. Dependencies come from Part E. Scope and exit criteria are in Part F and are not repeated here.

| ID  | Task                                               | Owner      | Branch | Dependencies          | Area                                  | Issue / PR | Notes                                                         |
| --- | -------------------------------------------------- | ---------- | ------ | --------------------- | ------------------------------------- | ---------- | ------------------------------------------------------------- |
| P2  | Users · Markets · RBAC · MFA · Audit · admin shell | unassigned | —      | P1                    | db, auth, RBAC, `/admin`, `/[market]` | —          | Needs O8 and O9 during the phase. Starts on owner instruction |
| P3  | Draws                                              | unassigned | —      | P2                    | draws                                 | —          |                                                               |
| P4  | Ticket engine                                      | unassigned | —      | P3                    | tickets                               | —          | Gates 1, 2. O15 needed                                        |
| P5  | Cart + Checkout                                    | unassigned | —      | P4                    | checkout, orders, outbox              | —          | O12 skill-answer behaviour needed                             |
| P6  | Payments                                           | unassigned | —      | P5                    | `packages/payments`, webhooks         | —          | Gate 4. Fake provider; O13 before production                  |
| P7  | Wallet                                             | unassigned | —      | P6                    | wallet                                | —          | Gate 3. O7 affects refunds                                    |
| P8  | Instant wins                                       | unassigned | —      | P7                    | instant wins                          | —          | Gate 6. O16 affects physical prizes                           |
| P9  | Settlement                                         | unassigned | —      | P4, P6                | settlement                            | —          | Gate 5. O6 (part) needed                                      |
| P10 | Admin ops · postal · fulfilment · reports          | unassigned | —      | P3–P9                 | admin, postal, reports                | —          | O7, O9, O10 needed                                            |
| P11 | Referrals + Vault Meter                            | unassigned | —      | P7                    | referrals                             | —          | Gate 7. Blocked by O11 when started                           |
| P12 | Markets · Emails · Compliance                      | unassigned | —      | P2, P3, P5            | compliance, email                     | —          | Gate 8. O12 values needed                                     |
| P13 | Migration test import + QA                         | unassigned | —      | P2–P11, MIG-DISCOVERY | `tools/migration/`, QA                | —          | O14, O17 needed                                               |
| P14 | UAT + release candidate                            | unassigned | —      | P13                   | all                                   | —          | O13 needed                                                    |
| P15 | Cutover                                            | unassigned | —      | P14                   | all                                   | —          |                                                               |

Open decisions (O6–O17) are tracked in [PROJECT_STATUS.md](../PROJECT_STATUS.md#open-decisions-revision-2-part-g-still-unresolved), not here.

## DONE

| ID  | Task       | Owner | Branch                                         | Dependencies | Area       | Issue / PR | Notes                                                                                      |
| --- | ---------- | ----- | ---------------------------------------------- | ------------ | ---------- | ---------- | ------------------------------------------------------------------------------------------ |
| P1  | Foundation | owner | committed as `a16ca35` on `main` and `develop` | —            | everything | —          | Approved by the owner on 2026-09-22. Evidence in [PROJECT_STATUS.md](../PROJECT_STATUS.md) |

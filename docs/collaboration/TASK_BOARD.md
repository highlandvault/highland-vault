# Task Board

_Last updated: 2026-09-25_

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
| DONE        | Merged into `develop` (or, for P1, approved and committed)                |

Transitions: BACKLOG → READY (owner) → IN PROGRESS (owner claims) → IN REVIEW (PR ready) → DONE (merged into `develop`). Any state except DONE can go to BLOCKED and back.

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

| ID   | Task                                   | Owner             | Branch                          | Dependencies | Area                                   | Issue / PR | Notes                                                                                                     |
| ---- | -------------------------------------- | ----------------- | ------------------------------- | ------------ | -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| P5-8 | Phase 5 integration and gate hardening | Divyanshu (owner) | `feature/p5-8-phase5-hardening` | P5-7         | `packages/db` (0017, 0018), `apps/api` | none yet   | ADR-0021 cap bridging, B19 checkout limit, integrated journeys. Closes Phase 5. Next free migration: 0019 |

## BLOCKED

| ID            | Task                                            | Owner      | Branch | Dependencies | Area                                  | Issue / PR | Notes                                                                                       |
| ------------- | ----------------------------------------------- | ---------- | ------ | ------------ | ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| MIG-DISCOVERY | Legacy migration discovery (continuous from P1) | unassigned | —      | —            | `tools/migration/`, `docs/migration/` | —          | Blocked by **O17**: legacy access (plugin list and sanitized WordPress DB export). ADR-0018 |

## IN REVIEW

_None._

## READY

Phase 5's remaining work, scoped on 2026-09-25 from the specification. Full scope, constraints and per-task Definition of Done: [PROJECT_STATUS.md](../PROJECT_STATUS.md) ("Phase 5 remaining scope"). **Specified and unblocked** — the three open decisions were settled on 2026-09-25 by [ADR-0031](../adr/0031-checkout-cart-terms-and-order-numbers.md). Each still needs explicit owner instruction to start, in order.

| ID  | Task | Owner | Branch | Dependencies | Area | Issue / PR | Notes |
| --- | ---- | ----- | ------ | ------------ | ---- | ---------- | ----- |

## BACKLOG

Phase-level tasks from the Initialization Report, Part F. Dependencies come from Part E. Scope and exit criteria are in Part F and are not repeated here.

| ID  | Task                                      | Owner             | Branch | Dependencies          | Area                          | Issue / PR | Notes                                                                                                                                                                         |
| --- | ----------------------------------------- | ----------------- | ------ | --------------------- | ----------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P5  | Cart + Checkout                           | Divyanshu (owner) | —      | P4                    | checkout, orders, outbox      | —          | **Option A approved**: ends at `pending_payment`; payments/webhooks/SOLD stay in P6. Skill answer: ADR-0030. Tasks P5-0…P5-8; P5-0 to P5-7 merged, P5-8 in review (last task) |
| P6  | Payments                                  | unassigned        | —      | P5                    | `packages/payments`, webhooks | —          | Gate 4. Fake provider; O13 before production                                                                                                                                  |
| P7  | Wallet                                    | unassigned        | —      | P6                    | wallet                        | —          | Gate 3. O7 affects refunds                                                                                                                                                    |
| P8  | Instant wins                              | unassigned        | —      | P7                    | instant wins                  | —          | Gate 6. O16 affects physical prizes                                                                                                                                           |
| P9  | Settlement                                | unassigned        | —      | P4, P6                | settlement                    | —          | Gate 5. O6 (part) needed                                                                                                                                                      |
| P10 | Admin ops · postal · fulfilment · reports | unassigned        | —      | P3–P9                 | admin, postal, reports        | —          | O7, O9, O10 needed                                                                                                                                                            |
| P11 | Referrals + Vault Meter                   | unassigned        | —      | P7                    | referrals                     | —          | Gate 7. Blocked by O11 when started                                                                                                                                           |
| P12 | Markets · Emails · Compliance             | unassigned        | —      | P2, P3, P5            | compliance, email             | —          | Gate 8. O12 values needed                                                                                                                                                     |
| P13 | Migration test import + QA                | unassigned        | —      | P2–P11, MIG-DISCOVERY | `tools/migration/`, QA        | —          | O14, O17 needed                                                                                                                                                               |
| P14 | UAT + release candidate                   | unassigned        | —      | P13                   | all                           | —          | O13 needed                                                                                                                                                                    |
| P15 | Cutover                                   | unassigned        | —      | P14                   | all                           | —          |                                                                                                                                                                               |

Open decisions (O6–O17) are tracked in [PROJECT_STATUS.md](../PROJECT_STATUS.md#open-decisions-revision-2-part-g-still-unresolved), not here.

## DONE

| ID     | Task                                               | Owner             | Branch                                         | Dependencies | Area                                                                      | Issue / PR | Notes                                                                                                                                                                           |
| ------ | -------------------------------------------------- | ----------------- | ---------------------------------------------- | ------------ | ------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | Foundation                                         | owner             | committed as `a16ca35` on `main` and `develop` | —            | everything                                                                | —          | Approved by the owner on 2026-09-22. Evidence in [PROJECT_STATUS.md](../PROJECT_STATUS.md)                                                                                      |
| T-001  | Collaboration and synchronization layer            | Divyanshu (owner) | `docs/collaboration-layer`                     | P1           | `docs/`, `.github/`, `CLAUDE.md`                                          | PR #2      | Merged into `develop` (`e05f270`) on 2026-09-22                                                                                                                                 |
| P2     | Users · Markets · RBAC · MFA · Audit · admin shell | Divyanshu (owner) | `feature/p2-users-markets-auth`                | P1           | db, auth, RBAC, `/admin`, `/[market]`                                     | PR #3      | Merged into `develop` (`6b0ea82`) on 2026-09-22. Decisions still open: PROJECT_STATUS.md                                                                                        |
| P3     | Draws foundation + first customer vertical slice   | Divyanshu (owner) | `feature/p3-draws`                             | P2           | draws, API, worker, web                                                   | PR #7      | Merged into `develop` (`3eb551e`) on 2026-09-22                                                                                                                                 |
| P4     | Ticket engine + customer entry flow                | Divyanshu (owner) | `feature/p4-ticket-engine`                     | P3           | tickets, reservations, API, worker, web                                   | PR #8      | Merged into `develop` (`49e3903`) on 2026-09-23; released to `main` via PR #9 (`c284825`). O15 = sequential (ADR-0027). Phase 5 carry-over items: PROJECT_STATUS.md             |
| P5-0   | NB-1 structural reservation-end fix                | Divyanshu (owner) | `fix/p5-0-reservation-end-cap`                 | P4           | `packages/db` (migration 0010)                                            | PR #11     | Merged into `develop` (`834400f`) on 2026-09-23. Cap decrement follows rows actually freed                                                                                      |
| NB-3   | Reservation fixtures made transaction-stable       | Divyanshu (owner) | `fix/nb3-reservation-fixture-timing`           | P4           | integration tests                                                         | PR #12     | Merged into `develop` (`cb3813e`). Test-fixture fix; original CI attribution never confirmed                                                                                    |
| P5-1   | Transactional outbox                               | Divyanshu (owner) | `feature/p5-1-outbox`                          | P5-0         | `packages/db` (0011), `apps/worker`                                       | PR #13     | Merged into `develop` (`13b35ae`) on 2026-09-24. Outbox table, claim function, worker drain                                                                                     |
| P5-2   | Mail port + outbox notifications relay             | Divyanshu (owner) | `feature/p5-2-mail-port`                       | P5-1         | `apps/worker`, `packages/domain`                                          | PR #15     | Merged into `develop` (`f1d33d3`). B17 relay, sealed payloads                                                                                                                   |
| SEC-1  | Gitleaks placeholder fingerprints                  | Divyanshu (owner) | `fix/p5-2-gitleaks-placeholder`                | P5-2         | `.gitleaksignore`, test fixtures                                          | PR #16     | Merged into `develop` (`a4738ea`). Three historical fingerprints only; no rule disabled, no broad allowlist                                                                     |
| NB-4   | Ticket-engine test-pool teardown                   | Divyanshu (owner) | `fix/ticket-engine-test-pool-teardown`         | P5-2         | integration test harness                                                  | PR #17     | Merged into `develop` (`117a6fa`). `pool.end()` returns with backends still alive; teardown now waits on `pg_stat_activity`                                                     |
| TOOL-1 | Local gitleaks in `pnpm verify`                    | Divyanshu (owner) | `chore/local-gitleaks-scan`                    | SEC-1        | `tools/gitleaks/`                                                         | PR #18     | Merged into `develop` (`5ebbdf2`). Pinned 8.30.1, checksum-verified, cached; the CI failure is now reproducible locally                                                         |
| P5-3   | Guest sessions                                     | Divyanshu (owner) | `feature/p5-3-guest-sessions`                  | P5-2         | `packages/db` (0012), `apps/api`                                          | PR #20     | Merged into `develop` (`b940e7d`) on 2026-09-24. Opaque hashed token, 24 h, verified-email slot. Not authentication (ADR-0029)                                                  |
| P5-4   | Guest email verification                           | Divyanshu (owner) | `feature/p5-4-guest-email-verification`        | P5-3         | `packages/db` (0013), `packages/domain`, `packages/contracts`, `apps/api` | PR #21     | Merged into `develop` (`173fd45`) on 2026-09-25. 6-digit code, hashed, single-use, 10 min, 5 attempts, 3/address and 20/IP per hour. First outbox producer (ADR-0020, ADR-0030) |
| P5-5   | Guest checkout access + per-market basket          | Divyanshu (owner) | `feature/p5-5-guest-checkout-basket`           | P5-4         | `packages/db` (0014), `apps/api/src/cart/`                                | PR #23     | Merged into `develop` (`e61e31a`) on 2026-09-25. Server-side basket, guest checkout, market isolation enforced by composite FKs (ADR-0031)                                      |
| P5-6   | Market terms versions and acceptance               | Divyanshu (owner) | `feature/p5-6-market-terms`                    | P5-4         | `packages/db` (0015), `apps/api/src/terms/`                               | PR #24     | Merged into `develop` (`210c217`) on 2026-09-25. Versioned per-market terms, acceptance recorded per checkout identity; gates checkout, not enablement                          |
| P5-7   | Order creation, skill answer, idempotency          | Divyanshu (owner) | `feature/p5-7-order-creation`                  | P5-5, P5-6   | `packages/db` (0016), `apps/api/src/orders/`                              | PR #25     | Merged into `develop` (`9e0ec50`) on 2026-09-25. Orders end at `awaiting_payment`; self-describing request (ADR-0032)                                                           |

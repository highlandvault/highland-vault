# Handoffs

_Last updated: 2026-09-22_

A handoff is written when another developer (or another developer's Claude session) needs to continue, integrate with, or depend on your work. It carries what the code and the commit messages don't: the decisions, traps, and state that someone continuing the work needs.

- Newest handoff first.
- Write it in the branch, and reference it from the PR's **Reviewer notes**.
- A handoff is never a substitute for tests or an ADR. If it records an architecture decision, that decision needs an ADR.
- When the receiving developer has picked the work up, they change the handoff's status to `ACCEPTED`. Do not delete old handoffs. They are the project's memory.

## Handoff format

```text
### <YYYY-MM-DD> — <Task ID> — <short title>

Status: OPEN | ACCEPTED (by <name>, <date>)

Task: <Task ID, issue #, PR #>
Developer: <who is handing off>
Branch: <branch; merged or not>
Status of the work: <DONE | PARTIAL | BLOCKED>

What was completed:
- ...

Important implementation details:
- non-obvious choices, invariants, traps

Files/modules affected:
- ...

Tests executed:
- exact commands and results (for example "pnpm test:integration: 42/42 passed")
- what was NOT tested

Known issues:
- ...

Integration points:
- what other areas call this or depend on it; contracts, events, queues, tables

Next developer action:
- the first concrete thing the next person should do
```

## Extra required details for sensitive areas

A handoff that touches one of these areas must also answer the listed questions. Write "N/A" only when it really does not apply.

| Area               | Also state                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Database**       | Migrations added (file names), whether applied anywhere shared, codegen re-run, locks and isolation level relied on, `hv_app` grants |
| **Authentication** | Session and token lifetimes, MFA / step-up behaviour, what an unauthenticated or wrong-market request gets                           |
| **Payments**       | Idempotency keys, webhook signature checks, states the payment can be left in, what the redirect is and isn't allowed to do (Gate 4) |
| **Tickets**        | Allocation and reservation invariants, cap keys, expiry behaviour, concurrency tests and their repeat-run results                    |
| **Wallet**         | Ledger entries created, balance invariants, reversal path, reconciliation impact                                                     |
| **Settlement**     | Determinism inputs, grace-period handling (ADR-0024), edge cases (ADR-0025), how to re-verify a result                               |
| **Infrastructure** | Environment variables added (placeholders in `.env.example` only), Docker / CI changes, what must be run after pulling               |
| **Security**       | Threats considered, permissions required, audit log entries, anything deliberately deferred                                          |

## Handoff log

_No handoffs yet._ Phase 1 was completed by a single developer. Its state is recorded in [PROJECT_STATUS.md](../PROJECT_STATUS.md).

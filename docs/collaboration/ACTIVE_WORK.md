# Active Work

_Last updated: 2026-10-08_

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

- **Phases 1–4:** complete. Phase 4 merged into `develop` (**PR #8**, `49e3903`) and released to `main` (**PR #9**, `c284825`).
- **Phase 5 (cart + checkout):** **COMPLETE.** P5-0 through P5-8 merged (P5-8 by **PR #26**, `723c7ae`). The phase ends where Option A said it would: the order is `awaiting_payment`, the reservation is still active and its tickets still `reserved`.
- **Phase 6 (payments):** **every implementation slice is merged** — **PR #27** (P6-1, `644a759`), **#28** (P6-2, `1b38ca5`), **#29** (P6-3, `f56616a`), **#30** (P6-4, `b9d6351`), **#31** (P6-5, `a71e687`), **#33** (P6-7, `672c0d7`), **#34** and **#35** (P6-8 and its corrective pass, `b8e3133` then `748b9e9`), **#36** (P6-9, `0834263`). Migrations `0019`–`0027`. **P6-6 is consumed by P6-4**, not outstanding.
- **The customer UI is merged:** **PR #37** (UI-1 homepage, `ff8309b`), **#38** (UI-2 listing, `c2557cb`), **#40** (UI-3 detail, `6da546c`), **#41** (UI-4 basket, `71eff2a`), **#42** (UI-5 checkout, `6d3a984`), **#44** (UI-6 payment UX, `ddc4c74`), **#45** (homepage visual redesign, `b4eb8c7`), **#47** (UI-8 order history and paid ticket numbers, `94a681f`), **#48** (UI-9 MFA enrolment, `b72b8fe`). **PR #39** (`d6bfa6f`) is net zero — a reservation-countdown fix that was reverted after its own negative control disproved it.
- **`origin/develop` is at `b72b8fe`; `origin/main` at `c284825`.** CI green on PR #48 (run #91) and on `develop` after the merge (run #92).
- **[PHASE_6_SCOPE_LOCK.md](../PHASE_6_SCOPE_LOCK.md) is the authority for Phase 6.** The phase plan in PROJECT_STATUS.md predates it; where they disagree, the scope lock wins.
- **Phase 6 is not closed.** Its exit criterion is Gate 4, and the matrix is now assembled with repository evidence in [scope lock §24](../PHASE_6_SCOPE_LOCK.md#24-gate-4-definition-of-done--locked). **Every criterion except G4.4 now has evidence**, G4.8 included — `checkout-orders.int.test.ts` times the order-creation request against B10's three seconds. **G4.4 is deferred to Gate 6 / P8 by D8 = A** and must not be claimed here. What is left is one owner judgement: **G4.2 is met on its outcome invariant, not on contention**, because it and Gates 1 and 2 all race with `Promise.all` rather than the barrier §15 asks for. **Sign-off is an owner act and has not occurred.**
- **Branches:** `feature/*` → PR → `develop` → release PR → `main` (DEVELOPMENT_RULES §4).

### Open owner decisions carried by Phase 6

Recorded so they are not mistaken for oversights. None may be decided by an implementer.

| Ref                                                                                                                   | State                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **K-3** — a provider capture against a **`cancelled`** order (`capture_without_settlement`)                           | **OPEN — owner decision required.** Detected, flagged and left unprocessed so reconciliation finds it; nothing is fulfilled, refunded or mutated. D23 covers `expired` only, and extending it would be inventing policy (I24)                                                                                                                                       |
| **K-c** — what makes an ORDER failed                                                                                  | **OPEN.** `order.payment_failed` has a registered handler and **no producer**. Under D3 = B a customer whose attempt failed may start another while their deadline holds, so a failed attempt is not a failed order                                                                                                                                                 |
| Manual retry after a **terminal `failed` refund**                                                                     | **OPEN**, and outside automatic retry by K-b                                                                                                                                                                                                                                                                                                                        |
| **O7** (wider refund policy), **O9** (configuration list), **O12** (compliance values), **O13** (production provider) | Open, all deferred beyond Phase 6 by design                                                                                                                                                                                                                                                                                                                         |
| **O14** — prize photography                                                                                           | **OPEN.** No photograph exists in the repository. `Scene`'s `PHOTOS` map is commented out in full, so every slot renders drawn art; `apps/web/public/images/README.md` names the files the design expects                                                                                                                                                           |
| **Gate 4** — the Phase 6 exit criterion                                                                               | **OPEN.** Every item except **G4.4** (deferred by D8 = A) is evidenced in [scope lock §24a](../PHASE_6_SCOPE_LOCK.md). The judgement left is whether **G4.2**'s `Promise.all` racing — the method Gates 1 and 2 also use — satisfies §15's barrier requirement, or whether the barrier is adopted and Phase 4's gates revisited. The sign-off itself is the owner's |

## Active entries

### UI-10 — admin market operations

Developer: Divyanshu (owner)
Branch: `feature/ui-10-admin-market-operations` (branched from `develop` at `b72b8fe`)
Issue: none yet
PR: none yet
Status: IN PROGRESS

Current task:
**Implementation complete, verification green, awaiting review; no PR.** The four market-gate routes that had existed since Phase 2 with no interface now have one: `/admin/markets` lists every market from `GET /admin/markets` (so disabled Germany stays manageable) and `/admin/markets/:market` carries the settings, legal-approval, enable and disable forms. **No API, contract or migration change.**

Affected areas:
`apps/web/src/app/admin/markets/` (two pages, one actions module — new), `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/admin/page.tsx`, `apps/web/e2e/` (new `admin-markets.spec.ts`, two fixture paths, `global.setup.ts`), `apps/web/playwright.config.ts`, `packages/db/src/testing/` (a sign-in-capable fixture user, seeded by `e2e:prepare`).

Avoid modifying:
`apps/web/src/app/admin/markets/` and the staff fixtures in `packages/db/src/testing/fixtures.ts` until this lands.

Blockers:
None outstanding, but **two decisions are recorded for the owner** rather than taken here.

**The registration limit was NOT raised.** The task asked for `registerPerIp` to go from 20 to 30 for tests, but it is a hardcoded constant in `apps/api/src/auth/rate-limiter.ts` with no environment override, so changing it means editing `apps/api` — which the same task forbids, and which is a security value rather than test configuration. Instead the two new staff fixtures are **seeded into the e2e database** by `e2e:prepare` and given their roles by the existing operator CLI, which costs **no registrations at all**. The suite therefore still uses 20 of 20, and the limit is untouched. If the owner would rather raise it, that is a one-line change to that file and a deliberate reopening of a security value.

**Two E2E assertions were deliberately left to the integration suite**: a successful _gate change_ and a successful _legal approval_. The only market that is not already enabled is Germany, and `auth.spec.ts`, `smoke.spec.ts` and `draws.spec.ts` all assert that Germany is blocked and its settings missing. The projects run fully parallel, so no ordering or teardown makes that window safe, and `admin-markets.int.test.ts` already proves both paths. The browser instead proves the success path through a settings save that writes the values the UK already has — a real audited operation that changes nothing observable.

No open decision is resolved: **O12 stays open** and the UI defaults, suggests and validates no compliance value; O7, O8, O9, O13, O14, K-3 and K-c are untouched; Gate 4 is not reopened.

Last update:
2026-10-08 — implementation finished. `pnpm verify` green; the new admin market spec passes 10 of 10; the full Playwright suite was run and its result is recorded in the PR notes.

Next:
Owner review, then a PR into `develop`.

Phase 6's implementation slices are all merged, and the UI programme is merged through UI-9 (PR #48); **UI-10 is implemented but not merged** (above). What remains before the phase can close is the Gate 4 sign-off, which is an owner act rather than a claimable task, plus the one judgement recorded against it: whether **G4.2**'s `Promise.all` racing — the same method Gates 1 and 2 use — satisfies §15's barrier requirement.

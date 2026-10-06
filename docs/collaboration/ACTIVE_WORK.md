# Active Work

_Last updated: 2026-10-07_

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
- **The customer UI is merged:** **PR #37** (UI-1 homepage, `ff8309b`), **#38** (UI-2 listing, `c2557cb`), **#40** (UI-3 detail, `6da546c`), **#41** (UI-4 basket, `71eff2a`), **#42** (UI-5 checkout, `6d3a984`), **#44** (UI-6 payment UX, `ddc4c74`), **#45** (homepage visual redesign, `b4eb8c7`), **#47** (UI-8 order history and paid ticket numbers, `94a681f`). **PR #39** (`d6bfa6f`) is net zero — a reservation-countdown fix that was reverted after its own negative control disproved it.
- **`origin/develop` is at `94a681f`; `origin/main` at `c284825`.** CI green on PR #47 (run #89) and on `develop` after the merge (run #90).
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

### UI-9 — MFA enrolment + account security

Developer: Divyanshu (owner)
Branch: `feature/ui-9-mfa-enrolment` (branched from `develop` at `94a681f`)
Issue: none yet
PR: none yet
Status: IN PROGRESS

Current task:
**Implementation is complete and verification is green; the work is awaiting review and has no PR.** An authenticated account with no confirmed factor can now enrol TOTP at `/account/security`, confirm it, and be shown its ten recovery codes once — all without client JavaScript. **The API is unchanged**: the three MFA routes, their contracts, the schema and `apps/api/src/auth` are untouched, and enrolment stays optional for every role because **O8 is open**.

Affected areas:
`apps/web/src/app/account/security/` (three pages and one actions module), `apps/web/src/lib/mfa-handoff.ts` (new), `apps/web/src/env.ts`, `apps/web/src/lib/session.ts`, `apps/web/src/app/account/page.tsx`, `apps/web/src/app/globals.css`, `apps/web/e2e/` (new `mfa.spec.ts`, TOTP helper in `fixtures.ts`), `apps/web/playwright.config.ts`, `.env.example`.

Avoid modifying:
`apps/web/src/env.ts` and `apps/web/src/lib/mfa-handoff.ts` until this lands.

Blockers:
None. No open decision is resolved: **O8** (which roles must use MFA) stays open and nothing here forces enrolment, and O7, O9, O12, O13, O14, K-3 and K-c are untouched. Gate 4 is not reopened — no payment code is involved.

**One deployment change to know about:** the web tier now has a **new required environment variable**, `MFA_HANDOFF_KEY` (64 hex characters), which seals the enrolment handoff cookies. It is in `.env.example` as an all-zeros local placeholder and CI copies that file, but a real deployment must provision a random key through its secret manager. Without it `webServerEnv()` throws, and that is every page rather than only the new ones.

Last update:
2026-10-07 — implementation finished. `pnpm verify` green end to end; the new MFA journey passes (4 tests, including the no-JavaScript path and the sealed-cookie assertions). **One pre-existing E2E test failed and is not understood:** `reservations.spec.ts:67` ("an expired reservation shows as expired, by itself"), which waits five minutes for a hold to lapse. It failed in the full run and again in isolation, taking 6.2 and 25.2 minutes against its own 360-second budget — wall-clock dilation of the kind PROJECT_STATUS already records for this host (`net::ERR_NETWORK_IO_SUSPENDED`, PR #39). It is recorded here rather than explained away: nothing in this slice touches any of the nine modules that page imports, and the identical `router.refresh()` mechanism passes in `checkout.spec.ts` in the same run.

Next:
Owner review, then a PR into `develop`. The reservation-expiry failure should be reproduced on a quieter machine or in CI before it is attributed.

Phase 6's implementation slices are all merged, and the UI programme is merged through UI-8 (PR #47); **UI-9 is implemented but not merged** (above). What remains before the phase can close is the Gate 4 sign-off, which is an owner act rather than a claimable task, plus the one judgement recorded against it: whether **G4.2**'s `Promise.all` racing — the same method Gates 1 and 2 use — satisfies §15's barrier requirement.

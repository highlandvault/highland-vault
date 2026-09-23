# Highland Vault — Development Rules

_Last updated: 2026-09-22_

These rules apply to every developer and every Claude session working on Highland Vault. They are operational rules only. Architecture lives in the [Project Initialization Report](PROJECT_INITIALIZATION_REPORT.md) and the [ADRs](adr/README.md); current phase and verification results live in [PROJECT_STATUS.md](PROJECT_STATUS.md).

## 1. Sources of truth

Higher levels win when they disagree. A lower level never silently overrides a higher one.

```text
Platform Specification (PROJECT_INITIALIZATION_REPORT.md, Revision 2)
        ↓
Architecture + ADRs (docs/adr/)
        ↓
GitHub Issues / Project            ← task authority: what exists, who owns it
        ↓
Source Code + Tests                ← what is actually built
        ↓
Project Status / Handoffs          ← PROJECT_STATUS.md, docs/collaboration/*
```

- **GitHub Issues (and a GitHub Project, once created) are the task authority.** An issue's assignee is its owner.
- The Markdown files in `docs/collaboration/` are **persistent context**, not a replacement for issues. They exist so that a developer or a new Claude session can understand the project by reading the repository.
- If a collaboration file disagrees with GitHub, GitHub wins. Fix the file.
- If code disagrees with an ADR, stop and raise it. Do not "fix" the ADR to match the code.

## 2. How synchronization works (and what it is not)

Developers work from **separate local clones on separate computers**, each with VS Code and Claude. They synchronize through:

```text
GitHub
+ shared repository documents (docs/collaboration/*, PROJECT_STATUS.md, ADRs)
+ issues
+ pull requests
+ commits
```

This is **persistent synchronization, not live synchronization.**

- Claude sessions do **not** talk to each other. There is no real-time channel, server, or database for Claude-to-Claude communication, and none should be built.
- A Claude session knows only what has been pushed to GitHub and what is in its local clone. Work that is not pushed is invisible to everyone else.
- Git and GitHub remain responsible for detecting and resolving actual code conflicts. The collaboration files only reduce unnecessary conflicts by making active work visible.

## 3. Engineering rules

The full rules are in the Initialization Report (Parts B and B21) and the ADRs. The ones most often relevant:

- PostgreSQL is the source of truth. Money is always integer minor units, never floats.
- Concurrency is proven against real PostgreSQL only. No mocked databases.
- Applied migrations are never edited. Schema changes are new migration files.
- Never commit secrets. `.env` is git-ignored; `.env.example` holds local-only placeholders.
- Phases are gated by their Definition of Done (ADR-0019). A phase starts only on explicit owner instruction.
- An accepted ADR changes only through a new ADR that supersedes it.

## 4. Branches

| Branch       | Purpose                                                                    | Example                          |
| ------------ | -------------------------------------------------------------------------- | -------------------------------- |
| `main`       | Production / release. Protected. Changes only by release PR from `develop` | —                                |
| `develop`    | Integration and testing. Protected. Target of every task PR                | —                                |
| `feature/*`  | New functionality for a task                                               | `feature/ticket-engine`          |
| `fix/*`      | Bug fixes                                                                  | `fix/reservation-expiry-race`    |
| `refactor/*` | Behaviour-preserving restructuring, with its own task                      | `refactor/db-transaction-helper` |
| `chore/*`    | Tooling, dependencies, CI, configuration                                   | `chore/bump-vitest`              |
| `docs/*`     | Documentation only                                                         | `docs/adr-0027-refund-policy`    |

Rules:

Flow: `feature/*` (and `fix/*`, `refactor/*`, `chore/*`, `docs/*`) → PR → `develop` → release PR → `main`.

- **No direct pushes to `main` or `develop`.** Task work reaches `develop` only through a pull request. A release reaches `main` only through a pull request from `develop`.
- One task per branch. Branch names are lowercase and hyphenated, and may include the issue number (`feature/42-ticket-engine`).
- Branch from an up-to-date `develop`. Rebase or merge `develop` into your branch regularly, not only at the end.
- Delete the branch after merge.
- Task pull requests target `develop`. Only release pull requests (`develop` → `main`) target `main`, and the owner opens and approves them.
- A hotfix for production is still a `fix/*` branch and PR into `develop`, followed by a release PR to `main`, unless the owner decides otherwise for that release.

## 5. Workflow

```text
Issue
 ↓
Developer claims task (assigned on GitHub)
 ↓
Feature branch
 ↓
Claude implementation
 ↓
Tests
 ↓
Push branch (open a draft PR into develop early)
 ↓
Pull Request → develop (ready for review)
 ↓
CI
 ↓
Code review
 ↓
Merge into develop
 ↓
Task = DONE
 ↓
Release PR develop → main (owner, when a release is ready)
```

## 6. Commits

- Small, focused commits with an imperative subject line (`Add ticket allocation function`), and a body explaining _why_ when it isn't obvious.
- Reference the issue (`Refs #42`, or `Closes #42` in the PR).
- Never commit `.env`, credentials, dumps of real customer data, or generated build output.
- Never skip hooks or CI checks to get a commit through.

## 7. Pull requests, CI and review

- Use the [pull request template](../.github/pull_request_template.md). Every section is answered, even if the answer is "None".
- **Open a draft PR as soon as the branch has its first pushed commit.** A draft PR is how other developers and their Claude sessions see what you are working on.
- CI (`.github/workflows/ci.yml`) runs on every pull request. A PR is not mergeable while CI is red.
- At least one review from someone other than the author before merge. Changes in sensitive areas (see [CODEOWNERS](../.github/CODEOWNERS)) need owner review.
- The author states what was actually tested, including exactly what Claude ran. "Claude said it works" is not verification.
- Prefer squash merges so `develop` reads as one commit per task.

## 8. Task ownership

- A task is owned by the person assigned to its GitHub issue. Where no issue exists yet, the owner in [TASK_BOARD.md](collaboration/TASK_BOARD.md) applies, and an issue should be created.
- To claim a task: be assigned on the issue, set it to IN PROGRESS, add your entry to [ACTIVE_WORK.md](collaboration/ACTIVE_WORK.md), push the branch and open a draft PR.
- Never take over another developer's task or active area silently. An entry with no update for 5 working days is **stale**: ask that developer, or the owner, before taking it over.
- Only the owner starts a new phase or changes phase scope.

## 9. Shared state files

| File                                                         | Updated when                                       | By                        |
| ------------------------------------------------------------ | -------------------------------------------------- | ------------------------- |
| [PROJECT_STATUS.md](PROJECT_STATUS.md)                       | Phase state, verification results, blockers change | Whoever changes them      |
| [collaboration/ACTIVE_WORK.md](collaboration/ACTIVE_WORK.md) | Claiming, meaningful progress, blockers, finishing | The developer on the task |
| [collaboration/TASK_BOARD.md](collaboration/TASK_BOARD.md)   | A task is added or changes state                   | Task owner                |
| [collaboration/HANDOFFS.md](collaboration/HANDOFFS.md)       | Someone else must continue or integrate the work   | The handing-off developer |
| [collaboration/CHANGELOG.md](collaboration/CHANGELOG.md)     | A meaningful change lands (not every commit)       | The PR author             |
| [adr/](adr/README.md)                                        | An architecture decision is accepted               | Owner-approved only       |

To keep these files from becoming a conflict hotspot:

- Edit **only your own entry or row**. Do not reformat or reorder other people's entries.
- Update them **in your task branch**, so the change is visible in your draft PR and lands with the work.
- The PR that completes a task marks it DONE on the board, removes its ACTIVE_WORK entry and adds any CHANGELOG line. The merge makes all three true at the same moment.
- If Git reports a conflict in one of these files, keep both sides' entries. It is almost never a real disagreement.

## 10. Claude Collaboration Protocol

Every Claude session working on Highland Vault must follow this protocol.

The intended developer instruction is:

> "Sync with the Highland Vault project state and continue my assigned task."

That instruction means: run **At the beginning of a session** below, report what was found, and only then continue the task.

### At the beginning of a session

1. Read `docs/PROJECT_STATUS.md`.
2. Read `docs/PROJECT_INITIALIZATION_REPORT.md` (at least Parts A, E, F and the part covering the task's area).
3. Read `docs/DEVELOPMENT_RULES.md`.
4. Read `docs/collaboration/ACTIVE_WORK.md`.
5. Read `docs/collaboration/TASK_BOARD.md`.
6. Read relevant ADRs (`docs/adr/README.md` indexes them by area).
7. Inspect current Git branch and status.
8. Inspect relevant GitHub issue/PR where available.
9. Determine the developer's assigned task.
10. Check whether another developer is actively modifying the same area.

Claude must not blindly start coding.

Commands for steps 7, 8 and 10 (they work in both Bash and PowerShell):

```text
git fetch --all --prune
git branch --show-current
git status
git log --oneline -10 origin/develop

# Other developers' unmerged work, and which files each branch touches:
git branch -r --no-merged origin/develop
git diff --stat origin/develop...origin/<branch>

# Another branch's view of the shared state (it may be newer than main's):
git show origin/<branch>:docs/collaboration/ACTIVE_WORK.md

# If the GitHub CLI is installed and authenticated:
gh issue list --assignee @me
gh pr list --state open
gh pr view <number>
```

`git diff --stat origin/develop...origin/<branch>` is the most reliable overlap check. It shows what another branch has really changed, whether or not its ACTIVE_WORK entry is up to date.

Then report to the developer, briefly: current phase, the assigned task and its state, other active work that touches the same area, blockers, and the proposed next step. If the task, its owner, or its scope is unclear, **ask**. Do not pick a task yourself.

### Before claiming a task

Claude must verify that:

- the task is assigned/available
- another developer isn't already working on the same area
- required dependencies are complete
- relevant architecture decisions are known

If an open decision (PROJECT_STATUS.md, "Open decisions") blocks the task, say so and stop rather than choosing a value.

### During implementation

Claude should:

- stay within the assigned task
- avoid unrelated refactoring
- avoid modifying another developer's active area
- keep tests updated
- update shared state when meaningful project status changes
- record newly discovered architectural questions rather than silently deciding them

Architectural questions go in the task's ACTIVE_WORK entry under **Blockers**, or in the PR's **Reviewer notes**, and are raised with the developer. Only an owner-approved ADR settles them.

### At completion

Claude should:

1. Run relevant tests.
2. Update the task status.
3. Update `ACTIVE_WORK.md`.
4. Create a handoff when another developer needs to continue the work.
5. Update `CHANGELOG.md` for meaningful changes.
6. Prepare the PR.
7. Report exactly what changed and what was verified.

Claude commits, pushes, or opens a PR only when the developer asks. Claude never pushes to `main` or `develop`, never force-pushes a shared branch, and never changes GitHub repository settings.

## 11. Multi-developer operating model

Example of three developers working at the same time:

| Developer   | Machine                | Branch                      | Visible to others through                   |
| ----------- | ---------------------- | --------------------------- | ------------------------------------------- |
| Developer 1 | PC 1, VS Code + Claude | `feature/ticket-engine`     | Issue assignee, draft PR, ACTIVE_WORK entry |
| Developer 2 | PC 2, VS Code + Claude | `feature/customer-checkout` | Issue assignee, draft PR, ACTIVE_WORK entry |
| Developer 3 | PC 3, VS Code + Claude | `feature/admin-draws`       | Issue assignee, draft PR, ACTIVE_WORK entry |

(Illustrative only. These are not real assignments.)

Each developer's Claude reads the same repository documents and the same GitHub state. That is how it learns about the others' work, not by talking to their Claude sessions. When Developer 2's Claude sees that `feature/ticket-engine` touches `packages/db/migrations/`, it avoids adding a conflicting migration and tells Developer 2 to coordinate.

## 12. Code conflicts

- **Prevention:** claim tasks visibly, keep branches short-lived, sync with `develop` often, and check other branches' `git diff --stat` before touching a shared area.
- **Detection:** Git and GitHub detect real conflicts on rebase, merge, and in the PR.
- **Resolution:** the developer whose branch conflicts resolves it locally, re-runs the tests, and pushes. If a resolution changes behaviour in another developer's area, involve that developer.
- **Migrations:** migration files are numbered and applied in order, and applied migrations are never edited. If two branches add the same migration number, the branch that merges second renumbers its migration before merging.
- Never resolve a conflict by discarding another developer's work without talking to them.

## 13. What is manual

The system is deliberately lightweight. People are responsible for:

- creating and assigning GitHub issues, and (optionally) a GitHub Project board;
- keeping ACTIVE_WORK and TASK_BOARD entries honest;
- configuring GitHub settings. Branch protection on `main` and `develop`, required status checks, required code-owner review, and the default branch are owner decisions. They are **not** configured by this repository or by Claude;
- replacing the placeholder username in `.github/CODEOWNERS` and enabling its rules;
- reviewing and merging pull requests.

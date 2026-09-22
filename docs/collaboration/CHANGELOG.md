# Development Changelog

_Last updated: 2026-09-22_

Meaningful changes that other developers and Claude sessions need to know about. This is **not** a copy of Git history.

Record a change here when it:

- changes what another developer must do (new setup step, new environment variable, new command, new migration);
- changes a shared contract, module boundary, or convention;
- completes, blocks, or unblocks a phase or task;
- records an accepted ADR or an owner decision.

Don't record routine commits, refactors with no external effect, or test-only changes.

Format: newest first, one short line per change with its task and PR or commit. Unmerged work goes under **Unreleased**.

## Unreleased

- **T-001:** Collaboration and synchronization layer added: [DEVELOPMENT_RULES.md](../DEVELOPMENT_RULES.md) (including the Claude Collaboration Protocol), `docs/collaboration/`, `.github/CODEOWNERS` (placeholders, rules inactive), the PR template and `CLAUDE.md`. Awaiting owner review; not committed.

## 2026-09-22

- **P1:** Phase 1 (Foundation) approved by the owner. Phase 2 not started.

## 2026-09-21

- **P1:** Phase 1 Foundation committed (`a16ca35`): pnpm monorepo (`apps/{api,worker,web}`, `packages/{config,contracts,db,domain}`), Docker stack (PostgreSQL 18, Redis 7.4, Mailpit), plain-SQL migration tool (`pnpm db:migrate up | status | verify`), Kysely codegen, health endpoints, CI workflow, ADR-0001 to ADR-0026. Details and verification in [PROJECT_STATUS.md](../PROJECT_STATUS.md).

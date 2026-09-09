# Regression & CI Reference

## Architecture: Testing Modes

### 1. Interactive MCP-Driven Testing (Primary)
Load a prompt template from `vc/shared/docs/prompts/`, execute via MCP browser tools with DevTools monitoring. After each flow: export HAR, capture console logs, take screenshots. Generate bug reports in `reports/bugs/`.

### 2. CI Regression via Claude Agent SDK

`ci/run-regression.ts` runs suites headless via `@anthropic-ai/claude-agent-sdk` (chrome only, up to 3 in parallel, 90-day `history.json`). The live-progress watcher, run close-out ownership and the `regression:reap` orphan backstop are specified in [`knowledge/execution/regression-pipelines.md`](../knowledge/execution/regression-pipelines.md) — read it before touching `test-run-status.json` or the watcher.

### 3. Autonomous Interactive Regression — REMOVED 2026-08-26

Do not re-create it. Why it was removed: [`docs/decisions/regression-history.md`](../../docs/decisions/regression-history.md).

### 4. Full Test Cycle CI Pipeline (Sync → Lifecycle → Regression)
`ci/run-full-cycle.ts` orchestrates a 3-phase pipeline triggered by code changes. Phase 1 (SYNC + REVIEW) uses `/qa-test-lifecycle --ci` to detect stale test cases from PRs/diffs/module updates, update Steps/Assertions, analyze coverage gaps, and run the `/qa-review-tests` **static** dimensions (1–7, 9, 10 — dim 8 needs a browser, dim 11 is the separate `ci/run-suite-audit.ts` twin). Phase 2 (REGRESSION) delegates to `ci/run-regression.ts` to execute the affected suites. Each phase has independent skip flags and budget allocation (50%/50% of total budget). Results go to `reports/full-cycle/{RUN_ID}/`.

**Invoke:** `CHANGE_SOURCE="PR #123" npm run ci:cycle` or via `.github/workflows/full-cycle.yml`
**Triggers:** PR merge to main (auto), daily schedule (Mon-Fri 8AM UTC), manual dispatch
**npm scripts:** `ci:cycle` (full), `ci:cycle:pr` (PR-driven), `ci:cycle:sync-only` (Phase 1 only), `ci:cycle:no-sync` (skip Phase 1)

## Test Suite Manifest: `config/test-suites.json`

Central configuration for regression orchestration. Defines:
- **Browser pool**: 3 slots (playwright-chrome, playwright-firefox, playwright-edge) with fallback chain
- **Suite definitions**: 126 suites in module-aligned subdirectories under `Frontend/` and `Backend/`, with id, name, CSV file path, priority, test count, assigned agent type, and tags
- **Selection groups**: 37 groups — `smoke`, `critical`, `sprint`, `full`, `frontend`, `backend`, plus module-specific groups (`catalog`, `search`, `orders`, `auth`, `b2b`, `marketing`, `platform`, `bopis`, `payment`, `configurable-products`, `whitelabeling`, `purchase-flow`, `loyalty`, …)
- **Defaults**: max 3 parallel agents, 2 retries, 30s retry delay, HAR capture enabled

## Regression Test Suites

126 suites in `regression/suites/` organized by module (50 directories) under `Frontend/` and `Backend/`. Enriched agent-native CSV format. Full definitions in `config/test-suites.json`. **Total: 4,155 test cases** (per manifest `testCount`; the source of truth is `config/test-suites.json`).

### Suite inventory

Derived, not documented here — `config/test-suites.json` is the source of truth (`npm run suites:lint` prints totals). The suite-authoring RULES — globally unique case IDs, the `…A` / renumber naming convention, **XREF-001** (a dependency may not leave its suite CSV), the `078` split rationale — live in [`knowledge/execution/regression-suites.md`](../knowledge/execution/regression-suites.md). Read it before adding or splitting a suite.

### WORKING IN A SHARED TREE — the git prohibition, then the one-author rule

**FIRST AND STRONGEST: never run a git command that changes repository or working-tree state.**
No `stash` (push/pop/apply/drop), no `checkout` / `restore` / `switch` on paths or branches, no
`reset`, `clean`, `revert`, `rebase`, `merge`, `commit` — by any agent, in any session, for any reason,
**including "recovery"**. Read-only git is always fine (`status`, `diff`, `log`, `show HEAD:<path>`);
for a baseline, copy the file to the scratchpad or read `git show HEAD:<path>`. A command that
"failed silently" is the signal to stop and report, never to escalate to a broader one — that
escalation is exactly how 2026-08-28's `git checkout --theirs -- .` reverted **every tracked file** to
HEAD and destroyed three sessions' uncommitted work.

**`git add -A` in a shared tree commits OTHER sessions' unfinished work.** Nothing is lost, but their
half-finished work is published under your commit message and pushed where others build on it. Say
what you are about to sweep up and let the other authors say whether their half is committable.
**Calibrate, or this becomes "never run `git add -A`" and gets ignored:** the failure is publishing
another session's unfinished WORK — half-written source, a suite mid-edit, an unverified fixture. It
is *not* every file you did not personally author; sweeping up an already-tracked transient artifact
(a run-status file, a generated report) is untidiness, not the failure.

**Once it is pushed, it stays.** Never rewrite history on a shared branch to fix attribution: a
force-push breaks the branch for every session that has pulled it — a real loss traded for a cosmetic
one.

**SECOND: a suite CSV has exactly one author for the duration of a change.** Not one author per file
forever — one author per *change*: whoever is restructuring, culling or re-pointing a suite owns every
row in it until they hand it back. A second writer is forbidden even when the two are editing
"different rows", and even when both are careful. **A suite conflict is never resolved with git** —
hand it to a human or to the other author.

Why a CSV is not mergeable in practice, the disposition-is-the-artifact argument, how to fan out
analysis while serialising the write, the re-parse-after-every-write discipline (a mid-write
unparsable suite takes the manifest gate down for *everyone*), and the cross-session relay rule (a
fact sent to another session's SUBAGENT is dropped silently — the receiving session must re-issue it
in its own dispatch brief): [`knowledge/execution/regression-suites.md`](../knowledge/execution/regression-suites.md)
§Working concurrently on suites. The four measured 2026-08-28 losses behind all of it:
[`docs/decisions/regression-history.md`](../../docs/decisions/regression-history.md) §Shared-tree losses.

### Selection Groups

| Selection | Suites | Use Case |
|-----------|--------|----------|
| `smoke` | 042, 078, 078b, 078c, 078d | Daily validation before deployment |
| `critical` | 042, 078, 078b, 078c, 078d, 039, 044, 049 | P0 suites only |
| `purchase-flow` | cart + checkout + orders-frontend + payment | Purchase flow regression |
| `catalog` | 001-003, 051, 053 | Catalog module (frontend + admin) |
| `search` | 004-005, 061 | Search module (frontend + admin) |
| `orders` | 014-019 | Orders & quotes (frontend + admin) |
| `auth` | 031-033 | Authentication module |
| `b2b` | 006-010 | B2B features |
| `marketing` | 023-025, 077 | Marketing module (admin + storefront) |
| `platform` | 020-021, 049, 063 | Platform module |
| `frontend` | All Frontend/ suites minus 3 exclusions (53) | Frontend-only regression |
| `backend` | All Backend/ suites minus 4 exclusions (63) | Backend-only regression |
| `sprint` | **Plan-driven** — `/qa-regression sprint` reads `vc/shared/docs/Sprint plans/sprint-*-summary.json` → `suitesActivated[]` (auto-picks the most recent plan). Falls back to all P0+P1 suites when no plan exists or `--no-plan` is set. | Before sprint release |
| `sprint:XX-YY` | Pinned to a specific sprint plan in `vc/shared/docs/Sprint plans/` | Re-run a past sprint's regression scope |
| `full` | All 119 (126 minus the 7 excluded) | Before production release |

## CI Regression Testing

The `ci/` directory provides Docker-based CI regression using the Claude Agent SDK:

```bash
docker build -t vc-regression -f ci/Dockerfile .
docker run --rm --shm-size=2gb --env-file .env \
  -e ANTHROPIC_API_KEY=your-key \
  -e SUITE_SELECTION=smoke \
  -e TEST_ENVIRONMENT=qa \
  -e MAX_BUDGET_USD=5.0 \
  vc-regression
```

Suite selection accepts group names (`smoke`, `critical`, `catalog`, `orders`, etc.) or comma-separated IDs (`042,039,049`). CI runs up to 3 suites in parallel (configurable via `MAX_PARALLEL`). Reports go to `reports/regression/ci-YYYY-MM-DD/` (markdown + JSON summary).

**Note:** The CI `run-regression.ts` dynamically loads suite definitions from `config/test-suites.json` at startup. Selection groups are also defined in the manifest's `selections` block.

**There is no regression GitHub Actions workflow.** `regression.yml` was **removed 2026-09-08** — it ran exactly once, on 2026-02-11, from a schedule that was later commented out, and that run **failed** after 72 s. It never ran manually and never succeeded, so it documented a capability the team does not have. **The RUNNER is unaffected:** `ci/run-regression.ts` is invoked by `npm run ci:regression`, by the Docker image above, and by `full-cycle.yml` Phase 2.

The remaining pipelines (`suite-audit.yml`, `monitor.yml`, `auto-fix.yml`, `full-cycle.yml`) still have every `cron:` **commented out**, so nothing in `ci/` runs unattended (audit 2026-09-07 §4b, D9). Re-enabling one means uncommenting its `cron:` line; until then do not describe those runs as happening.

**Teams Notifications:** After each pipeline run, `ci/notify-teams.ts` sends an Adaptive Card to the configured Teams webhook. Requires `TEAMS_WEBHOOK_URL` secret.

## On-demand references (moved out of the always-loaded tier, 2026-09-08)

Each of these is read by the step that needs it and by nothing else. Anchors (`§…`) are unchanged.

| Need | Read |
|---|---|
| Per-case lane routing (`suites:lanes` / `suites:machine` / `suites:merge`), the case filter (`suites:filter`), executability + the `EX-*` codes | [`knowledge/execution/regression-lanes.md`](../knowledge/execution/regression-lanes.md) |
| Post-run promotion `Draft → Automated` (`tc:promote`, the `PR-*` hold codes) | [`knowledge/execution/regression-promotion.md`](../knowledge/execution/regression-promotion.md) |
| Pre-authoring scaffold (`tc:alloc`, `tc:scaffold --check`, the KEEP gate) | [`knowledge/execution/regression-scaffold.md`](../knowledge/execution/regression-scaffold.md) |
| Change-scoped selection (`regression:select`), existing-coverage triage (`tc:scope`), post-run triage (`/qa-triage-results`) | [`knowledge/execution/regression-selection.md`](../knowledge/execution/regression-selection.md) |
| Storefront selectors — generated surface, `selectors:sync` / `selectors:check` | [`knowledge/execution/regression-selectors.md`](../knowledge/execution/regression-selectors.md) |
| Headless CI runner internals, the App Insights monitoring twin, the suite staleness-audit twin | [`knowledge/execution/regression-pipelines.md`](../knowledge/execution/regression-pipelines.md) |
| Suite inventory rules (unique IDs, naming, XREF-001) | [`knowledge/execution/regression-suites.md`](../knowledge/execution/regression-suites.md) |

## Prompt Templates

Key prompt templates in `vc/shared/docs/prompts/`:
- `How to test Builder.io.md` - Builder.io, Virto Pages & vc-frontend testing
- `story-testing.md` - Story-level testing prompt

> **Note:** `test-runner-agent.md` is now an agent definition at `agents/test-runner-agent.md`, not a prompt template.

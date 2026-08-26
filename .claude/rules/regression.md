# Regression & CI Reference

## Architecture: Testing Modes

> Numbering is a citation, not a count: mode **3** was retired on 2026-08-26 and its slot is kept
> as a tombstone rather than renumbered, so an existing reference to "mode 4" still points at the
> pipeline it always meant. Three modes are live (1, 2, 4).

### 1. Interactive MCP-Driven Testing (Primary)
Load a prompt template from `vc/shared/docs/prompts/`, execute via MCP browser tools with DevTools monitoring. After each flow: export HAR, capture console logs, take screenshots. Generate bug reports in `reports/bugs/`.

### 2. CI Regression via Claude Agent SDK
`ci/run-regression.ts` orchestrates headless regression using `@anthropic-ai/claude-agent-sdk`. It reads suite CSVs from `regression/suites/`, injects them into prompts with the 3 regression agent definitions in `ci/agents/` (`qa-frontend-expert.md`, `qa-backend-expert.md`, `qa-testing-expert.md`), and runs suites in parallel batches (up to 3 concurrent, configurable via `MAX_PARALLEL`). Results are tracked in `reports/regression/history.json` (90-day rolling window). Teams notifications via `ci/notify-teams.ts`.

**Note:** CI mode uses only `playwright-chrome` (single headless Chromium) for all suites. The 3-browser pool (chrome/firefox/edge) applies only to interactive mode. CI environment mapping: `qa` → `FRONT_URL`/`BACK_URL`, `staging` → `VIRTO_START_FRONT`/`VIRTO_START_BACK`.

**Regression Orchestration Pipeline (interactive mode):**
1. `regression-orchestrator` agent reads `config/test-suites.json` manifest
2. Resolves suite selection (`smoke`, `critical`, `sprint`, `full`, or comma-separated IDs)
3. Assigns suites to browser pool slots (3 slots: chrome, firefox, edge)
4. Spawns sub-agents using `agents/test-runner-agent.md` template with substituted parameters (`{{SUITE_ID}}`, `{{BROWSER_SERVER}}`, `{{ENVIRONMENT_URL}}`, `{{OUTPUT_FILE}}`, etc.)
5. Each sub-agent gets an isolated browser context, executes all test cases from its CSV, writes JSON results
6. Orchestrator collects results, handles retries with browser fallback chain, produces consolidated report

**Live progress + auto-report (interactive mode):** at run start the **persistent top-level session** (the one running `/qa-regression`) launches a background watcher (`npm run report:regression:watch -- --run-id {RUN_ID}`) that opens a self-refreshing `reports/regression/{RUN_ID}/regression-report.html`. **Watcher ownership is load-bearing:** it MUST run in the persistent session's own background — **never inside a Task-dispatched sub-agent** (`regression-orchestrator`/`test-runner`), whose child processes are killed when its turn ends while the run keeps going, freezing the HTML mid-run. The owner **self-heals**: while the run is `in_progress`, if `regression-report.html` mtime is >~60s stale it relaunches the watcher (or runs one-shot `report:regression`). See `commands/qa-regression.md` Step 3. It reads `test-run-status.json` (suites flip `pending → running → done` as the orchestrator updates it) plus the per-suite `suite-*-results.json` as they land, and `<meta refresh>`-reloads until the run is `completed`, then renders the final static report and exits. **Live per-case status:** because the runner (`agents/test-runner-agent.md`) pre-seeds every case as `PENDING` at suite start and then **appends one line per case to `suite-*-cases.jsonl`** (which the reporter folds over the pre-seeded envelope while `completedAt` is empty — the old contract rewrote the whole envelope per case, which is O(n²)), a suite flagged `running` renders **pre-expanded with its cases flipping PASS/FAIL/BLOCKED/PENDING live** — you no longer wait for the whole suite to finish. The dashboard shows a run-level live banner (suites + cases evaluated, live pass/fail/blocked tally, animated in-progress bars). The HTML report is generated **automatically** — no manual `npm run report:regression` step. `scripts/regression/generate-regression-html-report.ts` also supports one-shot (`report:regression`), portable/embedded (`report:regression:portable`), and `--open`.

**Who closes a run out — and the orphan backstop.** `test-run-status.json` is written *only* by the owning orchestrator (`/qa-regression` Step 6 / `regression-orchestrator` Step 6): it creates the file `in_progress`, flips each suite `pending → running → done`, and flips the run `completed`. Runner sub-agents write only their own `suite-*-results.json`; the watcher and the reporting scripts are read-only consumers. That made a crashed orchestrator unrecoverable — the file stayed `in_progress` forever, so the watcher never reached its settle branch and Step 0's duplicate check blocked every future run. **`scripts/regression/reap-stalled-run.ts`** (`npm run regression:reap`, `regression:reap:apply`) is the deterministic backstop: it classifies a run from **file evidence** — newest mtime across the run's own results/screenshots, deliberately ignoring the watcher-written `regression-report.html`, which would otherwise make a dead run look busy forever — and marks a provably-silent one `stalled`. **`stalled` is an observation, never `completed`**: the run did not finish, and recording it as finished would put a phantom run into `history.json`. Absence of evidence never reaps (a false reap frees the interlock and lets two runs fight over the same three browser lanes), and the write re-checks the file first, so a still-alive orchestrator's own `completed` always wins. The live watcher applies the same mark when its own 45-minute idle valve trips — and that valve's stall signature folds in **per-case** counts (`watchProgressSignature`), because a single-suite run's suite count goes constant the moment the runner pre-seeds its results file.

### 3. ~~Autonomous Interactive Regression (Agent Teams)~~ — REMOVED 2026-08-26

There was a second interactive orchestrator (`autonomous-regression-orchestrator` +
`autonomous-test-runner`, ~500 lines, plus a private `scripts/regression/reporting.ts`). It is gone,
and this tombstone records why so it is not re-created:

- **Its output went where nothing reads.** It wrote `results/{RUN_ID}/`; every consumer reads
  `reports/regression/{RUN_ID}/`. So an autonomous run got no live HTML dashboard, no
  `/qa-triage-results`, no `history.json` flakiness feed, no `reap-stalled-run` backstop and no
  `compute-metrics` quality gate — it had a parallel reporting module instead.
- **It had drifted.** Its fallback chain was still `chrome → firefox → edge`; the manifest was
  reordered to put firefox LAST on 2026-08-05 precisely because firefox cannot click on this
  storefront, so firefox in second place burned a retry. It also named firefox the *preferred*
  browser for Smoke and Payment, and knew nothing of `clickDriven` or `regression:plan`.
- **Its one unique feature contradicted policy.** Auto-filing JIRA from a regression run, while
  `/qa-triage-results` and `/qa-monitoring` both deliberately stop at drafting.

What was kept: the graduated rate-limit guard and the 30/60s backoff ladder, now in
`.claude/agents/regression-orchestrator.md` Step 5. Mode 2 (headless CI) and mode 1 (interactive)
remain; the interactive one is the path in daily use.

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

**Derived, not documented here.** `config/test-suites.json` is the source of truth for every suite’s id,
name, file, domain, layer, priority, `testCount`, agent and tags (126 suites, 37 selections — the manifest's `selections` block also carries a `_doc` key that is documentation, not a group). To see the
current split: `npm run suites:lint` prints the totals, or read the manifest directly. A table copied into
this file goes stale the first time a suite is added — which is how the retired `080` release suite below
came to be documented for weeks after its CSV was deleted.

- **Release suite**: none. The master release suite `080` (`_release/080-full-regression-release.csv`) was **retired on 2026-07-31** — its CSV was deleted in commit `9dd9f3e3` and the manifest entry plus the `release` selection were removed once it was found that `release` had been resolving to a missing file (running zero cases while reporting a valid selection). For a major release, use `full` (all 119 — the 126 manifest suites minus its 7 excludes) or a plan-driven `sprint` selection. `npm run suites:lint` now hard-fails on any declared-but-absent suite CSV, so this cannot recur silently.
- **P0 suites**: 042 (Smoke), the four 078 siblings (Backend/API Smoke), 039 (CyberSource Payment), 044 (Security), 049 (Platform API)
- **`078` is four sibling suites, and the reason generalizes.** It was one 115-case / 83-minute
  suite, which made it the ENTIRE critical path of both `smoke` and `critical`: the lane pool had
  nothing to pack, so the scheduler saved 0% there while saving 42% on `full`. Splitting it took
  `smoke` from **83 min to 39** and `critical` to **60**, with no runtime code — four files where
  there was one, packed by the LPT pool that already existed.
  - **The unit of splitting is a dependency component, not a row range.** 99 of its 115 cases
    declared a dependency in `Preconditions`, 46 of them on a non-bootstrap case
    (`BSM-005 → 006 → 007`, `BSM-015 → 042 → 043`, `BSM-008 → 009 → 071`, …). A row slice cuts
    those chains and turns a slow pass into a fast cascade of BLOCKED. Computed as connected
    components of the declared graph the suite decomposes into **65 pieces, largest 13**, and those
    components line up with its Section themes — so a themed split is also dependency-closed.
  - **`[PRE:*]` coverage is the WRONG shardability gate.** `knowledge/execution/test-execution-preflight.md`
    exempts Admin SPA and API suites by design, and 078 carries zero `[PRE:*]` tags across 115
    cases. Gating on it permanently excludes exactly the suites that dominate `smoke`/`critical`.
  - **Bootstrap is replicated as state, never referenced as a case.** `BSM-001/002/011/019` (login,
    bearer token, an org exists, GraphiQL reachable) stay in `078`; the siblings restate them as
    *"Admin logged in as `{{ADMIN}}` (suite setup)"*. A case ID can live in only one file, so a
    replicated bootstrap case would break global ID uniqueness — the requirement is what travels.
  - **All four stay in `regression/suites/Backend/smoke/`.** `check-smoke-gates.ts` builds its case
    set as the UNION of the sibling CSVs in a directory, so `ADMIN-SMOKE-CHECKLIST.md` and gates
    SG-001/004/005 keep working with no checklist edit. Moving one file out silently breaks them.
- **XREF-001 — a dependency may not leave its suite CSV.** New hard gate in
  `npm run suites:lint` (`findCrossFileCaseRefs`, unit tests `scripts/unit/suite-split-integrity.test.ts`).
  A suite is the unit of dispatch: two suites can run on different lanes, in either order, or one
  without the other, so `"Admin logged in (BSM-001 passed)"` in a CSV that does not contain BSM-001
  is not a precondition, it is a wish — the case runs on whatever state the lane happens to hold.
  This is the dual of the global-ID rule above (an ID belongs to exactly one file; a dependency may
  not leave it), and it is invisible to `check-smoke-gates.ts` for the very reason that makes the
  078 split safe: that gate reads the directory's sibling CSVs as one union, so a cross-sibling
  reference passes SG-001 as valid. A token counts only when it resolves to a real case ID
  somewhere in the corpus, so prose that merely looks like one (`BL-AUTH-005`, `ECL-13.2`,
  `VCST-5089`) can never false-positive. **Ratcheted, not absolute:** 101 pre-existing violations
  across 32 suites are recorded per file in `XREF_BASELINE` — a listed file may never grow, an
  unlisted file must have zero. Same burn-down shape and same reason as `CSV_LINT_BASELINE`.
- **RESOLVED — the two `sales-rep` manifest defects flagged below are fixed** (verified 2026-08-05): the embedded-app suite was renumbered to a free id (`Backend/sales-rep/092b-sales-rep-admin-embedded-app.csv`, alongside `092-sales-rep-admin.csv`), and `Frontend/sales-rep/093-sales-rep-hub-dashboard-storefront.csv` now has a manifest entry (`id: "093"`). `config/test-suites.json` carries 126 unique ids with zero duplicates. Left here as the worked example the naming-convention rules below still reference (`092b`, `SR-EMB-*`).
- **Case IDs are globally unique across the whole corpus** — not merely unique within a suite. The runner keys per-case results and failure evidence by **bare case ID** (`suite-*-results.json` rows, `traces/{TC-ID}-FAIL-trace.json`, and `scripts/lib/regression-triage.ts` fingerprints), so two suites both declaring `CAT-001` let one run's evidence silently overwrite the other's — a real failure can read as someone else's pass. Enforced by **`npm run suites:lint`** (`findDuplicateCaseIds` in `scripts/test-cases/sync-test-suites.ts`, unit tests `scripts/unit/suite-global-case-ids.test.ts`); it scans **every CSV on disk**, orphans included, and **hard-fails** — unlike `CSV_LINT_BASELINE` there is no burn-down set, because the corpus was cleaned to zero collisions on 2026-08-03 (223 of them). IDs are harvested by the line-start scan (`extractExistingIds`), not a field parse, so the suites that aren't strictly CSV-parsable are still covered.
  **Naming convention when two suites want the same prefix** — two cases, and they are different:
  - **Re-prefix** when the suites are different *layers or domains* that merely collided on a shared prefix. The **storefront keeps the bare prefix** and the admin/back-office side takes an `…A` suffix: `CAT-*` (Frontend/catalog) vs **`CATA-*`** (051/053 admin), `ORD-*` (014 storefront) vs **`ORDA-*`** (017/018/019 admin), `SRCH-*` (004/005) vs **`SRCHA-*`** (061 admin). Where a prefix meant two unrelated things, the **documented owner keeps it**: suite 067 keeps `WL-*` (white labeling, per `knowledge/domain/white-labeling.md`) and the wishlist suite 050h became **`WISH-*`**; suite 050i keeps `CFG-GQL-*` (the gold-standard GraphQL suite) and the 9 interlopers in 072/072c became **`CFG-XAPI-*`**. Otherwise the more specific suite is qualified: 077b → **`CPN-SMK-*`**, the embedded-app half of `092` → **`SR-EMB-*`**. Re-prefixing is applied to the **whole prefix in that file**, not just the colliding rows, so each file keeps one coherent namespace and cannot collide again.
  - **Renumber into a free range** when both suites legitimately share one domain namespace and only the numbers clashed — no new prefix: `035` STORE-052…055 → 066…069, `032` AUTH-066/067 → 074/075, `003` CAT-030…040 → 068…078, plus `CFG-TEXT`/`CFG-VAR` singles.
- **Critical UI scope**: `knowledge/oracles/critical-ui-scope.md` defines the checklist of 36 components and 16 pages with applicable BL-UI invariants per cell. **Currently UNCOVERED** — its sole covering suite `048b-layout-stability.csv` (selection `layout-stability`) was removed on 2026-07-25, so all 197 applicable cells are marked `GAP`. The file is retained as the scope definition + audit-protocol reference for `/qa-design`. `npm run scope:validate` still hard-fails if a cell points at a *missing* test ID and warns on the GAP count; `--strict` makes GAPs fatal again once a replacement suite lands.

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

**Scheduled Pipeline (GitHub Actions - `.github/workflows/regression.yml`):**
- **Daily smoke**: Mon-Fri at 6:00 AM UTC — runs suite 042 ($5 budget)
- **Weekly full regression**: Sunday at 2:00 AM UTC — runs all 119 `full` suites ($80 budget — the derived budget is $144; see ci/lib/suite-caps.ts)
- **Manual trigger**: Any selection, any environment, any budget via `workflow_dispatch`

**Teams Notifications:** After each pipeline run, `ci/notify-teams.ts` sends an Adaptive Card to the configured Teams webhook. Requires `TEAMS_WEBHOOK_URL` secret.

## Online Monitoring (App Insights) — the fifth pipeline twin

Beyond the testing modes above, there is an **online monitoring** pipeline that watches Azure Application Insights for live errors instead of executing test cases. Like the others it has an interactive + headless **twin** pair:

- **Interactive:** `/qa-monitoring [frontend|backend|both] [--since=MIN] [--dry-run]` (`commands/qa-monitoring.md`)
- **Headless:** `ci/run-monitor.ts` (`npm run ci:monitor` / `ci:monitor:dry`) + `.github/workflows/monitor.yml`

It queries both layers' App Insights resources (env-resolved `APPINSIGHTS_*`, never hardcoded), **deduplicates** errors via a fingerprint store (`reports/monitoring/.seen-fingerprints.json`, carried across CI runs by `actions/cache`), **triages** new/spiking signatures (`ci/agents/monitor-triage-agent.md`), **reproduces** HIGH-confidence bugs live via the QA experts, drafts bug reports with a `## Fix Routing` block, and reports to `reports/monitoring/MONITOR-*/` + Teams (`NOTIFY_MODE=monitor`). **Detect-and-report only** — it never files a tracker ticket and never auto-fixes; a human picks up the confirmed drafts via `/qa-bug` → `/qa-fix`. KQL probes live in `ci/monitoring/queries/`. Full methodology: the `/qa-monitoring` skill.

## Scheduled Test-Case Staleness Audit — the sixth pipeline twin

Suites rot silently. `lint-test-cases.ts` GRD-001 verifies an assertion **carries** a grounded provenance tag; it never verifies the tag is **true**. A `{DOC}` whose doc changed, an `{OBSERVED}` captured against a six-month-old build, a `{BL}` citing a retired invariant — all lint green. **Dimension 11** closes that hole by porting the `/qa-review-bl` triangulation mechanism to test cases, and a scheduled job works through the ~4,155-case corpus one suite at a time.

- **Interactive:** `/qa-review-tests suite <ID> --triangulate [--fix]` (skill `.claude/skills/qa-review-tests/`, judgment rules in `triangulation-criteria.md`)
- **Headless:** `ci/run-suite-audit.ts` (`npm run ci:audit` / `ci:audit:dry`) + `.github/workflows/suite-audit.yml`

Each run audits **one** suite and opens **one draft PR** — the unit of work is the unit of review, and that PR is the human gate replacing `--fix`'s interactive confirmation. Each assertion is triangulated against **docs** (VirtoOZ) + **live** (playwright) + **source** (GitHub MCP); only **CONFIRMED** (refresh the `Audited:` stamp) and **DRIFT** (rewrite the drifted assertion) are written. MISSING / CONTRADICTORY / UNGROUNDED / RETIRE are PR-body proposals that never touch a CSV — deprecation and authoring stay human. Never auto-merges.

**Rotation** (`npm run tc:audit:queue`, `scripts/test-cases/audit-queue.ts`): risk tier (P0/revenue-critical first) → unresolvable-source last → oldest `Audited:` stamp → testCount. **The stamp is the state** — it lives in the `References` cell of the row it describes, so there is no ledger to desync and a skipped day leaves that suite at the head of the queue. The queue is keyed by **file**, not id (a defensive convention retained from when manifest id `092` was briefly carried by two suites — see the resolved note above). Weekdays only ⇒ the ~14 P0/revenue-critical suites are covered in ~3 weeks; the full 126-suite cycle is ≈25 weeks, then rolls.

**Source axis** (`npm run tc:audit:source`, `scripts/test-cases/suite-source-map.ts`): suite → module → repo, derived from `config/test-suites.json` `requiresModules` → `.claude/knowledge/execution/module-suite-map.md` → `ci/config/fix-repos.json` `routing[]`. It resolves 117/126 suites and **never invents a repo name** — an unresolvable suite scores UNGROUNDED, because a wrong repo yields a confident `file:line` for unrelated code and manufactures a false CONFIRMED.

The audit's own run artifacts (`reports/suite-audit/TCA-*/`) are gitignored pipeline working data — `.claude/rules/reports.md` has no report category for a test-case review, so the narrative ships in the PR body and the only durable artifact is the CSV diff.

## Per-Case Lane Routing — a suite is no longer the unit of execution

Lane routing used to be all-or-nothing: a suite reached the runner only if **every** non-empty
`Steps` cell carried a runner op tag. That rule is right about its own risk — handing a runner a
row it cannot parse manufactures BLOCKED cases that read as product failures — but its cost is
measurable: **169 machine-ready rows in 10 suites** ride the browser lane because a handful of
their siblings are prose. Suite `050d` sends 46 runner-native cases through a browser agent on
account of the other 3; suite `087` occupies a browser slot to run **zero** browser cases (12
machine + 3 explicitly `Manual`).

**The bigger prize is verdict quality, not wall-clock.** At the measured ~29% artefactual-BLOCKED
rate for long agent sessions (`layout-runner.ts`'s header records 47 of 161 cases BLOCKED by "cart
contaminated by earlier cases in the same session"), roughly 54 of those 169 rows currently come
back BLOCKED for reasons about *how* they ran. Those become real verdicts. The nine biggest mixed
suites also shrink their agent session by 80–95%, which removes the long-session context decay
that produces blanket-status JSON.

Three commands, run in this order by `regression-orchestrator` Step 3:

| Command | Does |
|---|---|
| `npm run suites:lanes -- <ID> --run-id <R> [--csv <resolved>]` | classify every case → `suite-{ID}-lanes.json` + `suite-{ID}-resolved.browser.csv` |
| `npm run suites:machine -- <ID> --run-id <R>` | run the machine rows via `graphql-runner.ts --case` → `suite-{ID}-results.machine.json` |
| `npm run suites:merge -- <ID> --run-id <R>` | fold the fragments → the canonical `suite-{ID}-results.json` |

`npm run suites:lanes:all` surveys the corpus and writes nothing.

**The classifier delegates to the executor's own parser.** `scripts/lib/case-classifier.ts` calls
`parseSteps`/`validateStepBlocks` (the modules `graphql-runner.ts` itself uses) and
`parseAssertions`/`classifyPredicateScoreability` (the modules that score its verdicts) — it does
not pattern-match tags with a private regex, because a static verdict derived from a second
similar-looking implementation is exactly how a classifier and a runtime drift apart. Reason codes
are a closed vocabulary (`EX-002` no steps · `EX-003` invalid op structure · `EX-010` a step line
the parser cannot type · `EX-011` no runner op · `EX-101` nothing scoreable to assert · `EX-102` an
assertion the runner cannot score · `EX-200` explicitly `Manual`).

Four rules make it safe rather than merely faster:

- **Fail-closed in one direction only.** Any doubt routes to `browser`, which is the status quo —
  so a classifier bug costs the saving, never a verdict. If `graphql-runner` still exits 2
  (structure), `machine-lane.ts` **returns the case to the browser lane** and records the
  disagreement in `errors[]`. That is cheap precisely because the machine lane runs FIRST, before
  any agent is dispatched.
- **ALL assertions must be scoreable, not one of them.** The runner's verdict is
  `failed === 0 && results.length > 0`, so a case mixing one parseable predicate with three prose
  ones would PASS on the strength of the one — a green earned by not understanding the rest. Same
  "silence is never a pass" rule as `layout-runner.ts`, applied one step earlier. This is what
  catches suite `050a`'s `CAT-GQL-131`, whose assertion reads
  `data.products.sortings[0].name is non-null OR is null` — vacuously true.
- **An explicit `Manual` is respected, never overruled.** It is the only positive use of
  `Automation_Status` (which carries 23 distinct values corpus-wide, so it cannot route anything
  else). `050h`'s `WISH-009` is the worked example; it lands in the results as `SKIPPED` with its
  reason, never as a quiet absence.
- **A legacy 11-column header is REFUSED (exit 2), never classified.** `parseSuite` maps fields
  positionally, so on those 11 suites the legacy `Steps` lands in `Test_Data` and `Expected Result`
  lands in `Steps` — routing would score real cases on the wrong columns. None of the 10 mixed
  suites has that header, so refusing costs nothing.

**Fragments plus one deterministic merger, never a shared file.** Once a suite's cases span two
writers, a shared `suite-*-results.json` is a race — and the agent's own contract is "overwrite the
whole file", so asking it to preserve another writer's rows is a rule it will break under context
pressure, at which point a real failure disappears. So: one writer per fragment
(`…-results.machine.json`, `…-results.browser.json`) and `scripts/lib/suite-results-merge.ts`.
Its invariants, each unit-tested in `scripts/unit/suite-results-merge.test.ts`:

1. **No case can be lost.** The planned set comes from the lanes file, not from the fragments — so a
   lane that dies before writing surfaces as `BLOCKED` / `lane_lost: the <lane> lane did not report
   this case`, instead of producing a smaller, greener, faster-looking suite.
2. **No case can be counted twice.** The same id in two fragments is a hard error naming both, and
   **nothing is written** — that means the split leaked.
3. **Every row carries its `lane`**, and the envelope carries per-lane counts. Without it no
   determinism trend can be read off history.
4. **Counts are recomputed from the rows**, never summed from the fragment headers (a header is one
   writer's claim about itself). A status outside PASS/FAIL/BLOCKED/SKIPPED stays untallied, so the
   four counts summing to less than `totalCases` is how an incomplete suite stays visibly
   incomplete.
5. **Idempotent** — the orchestrator re-merges on every poll so the live dashboard is not frozen
   while both lanes work. `completedAt` stays empty until every fragment closes.

Determinism moves **9.3% → 13.3%** of the corpus (385 → 554 of 4,155 cases). It also pulls four
cases OFF the fast path that are currently fed to a runner which cannot fully parse them — one of
them, `050c`'s `ORD-GQL-TODO-001`, says so in its own steps: *"[MANUAL-BLOCKED] … Do NOT run via
graphql-runner"*, and today the runner runs it and reports `EMPTY` → exit 1 → a FAIL on a
placeholder row.

## Executability — what a runner can execute, and what would move it

`npm run suites:executability` is the reporting half of `scripts/lib/case-classifier.ts`. It adds
no judgement of its own and deliberately shares the classifier with the lane planner, because a
report that disagreed with the routing would be worse than no report.

| Command | Answers |
|---|---|
| `npm run suites:executability` | per-suite machine/browser/manual/**unroutable** + the `EX-*` histogram |
| `… -- --suite <ID>` | per case, with the blocker codes and the offending token |
| `… -- --burn-down` | the backlog, cheapest first |
| `npm run suites:executability:check` | **ratchet: fails only when a suite LOSES machine cases** |

**`--check` is not the question `suites:lint` asks.** That one asks *"is the manifest in sync?"* and
fails on drift in either direction. This one asks *"did determinism regress?"* and fails **only on a
drop**, so a change that makes cases unroutable cannot ride in behind a routine `suites:sync`.

**It is deliberately NOT a gate on prose.** 84% of the corpus is prose by design — these are cases an
LLM agent drives, and most should stay that way. A gate that failed on "not machine-executable"
would be red forever, everyone would learn to pass `--warn-only`, and the signal would be dead.

**Per-suite lane counts are recorded in the manifest** (`lanes: {machine, browser, manual}`,
reconciled by `suites:sync` exactly like `testCount` and `clickDriven`, present only when a suite has
at least one machine case). So the planner and the report read one recorded answer instead of each
re-classifying 127 CSVs — and a drop shows up as manifest drift as well as a ratchet failure.

**UNROUTABLE is its own count, never folded into `browser`.** The 11 surviving legacy 11-column
suites (274 cases) are not "browser suites" — they are suites nothing can classify, because
`parseSuite` maps positionally and on them the legacy `Steps` lands in `Test_Data`. Counting them as
browser would hide 274 cases behind a number that reads like a deliberate choice.

### The measured correction to the burn-down economics

Determinism is **554 / 4,230 = 13.1%**. The backlog splits, against the grammar the GraphQL/REST
runner actually parses:

| cases | bucket |
|---|---|
| **2** | steps compile, assertions are prose |
| **54** | assertions compile, steps need normalising |
| **2,508** | prose on both sides — not a project; taken suite by suite in `/qa-review-tests` |
| **838** | explicitly `Manual` — out of scope by intent |
| **274** | UNROUTABLE — legacy header; a suite-level migration, and authoring |

**Read the small number as a finding, not an under-count.** An earlier estimate put ~365 cases one
assertion-rewrite away from determinism and ~739 one step-normalisation away. Those came from a proxy
metric — *does the assertion CONTAIN a comparison operator* — and do not survive the executor's own
parser: a storefront case asserting `[DOM] cart icon visible` can never be scoreable by a GraphQL
predicate scorer, however well it is written. Worked examples of the real cheap tranche: `050a`'s
`CAT-GQL-131`, whose assertion reads `data.products.sortings[0].name is non-null OR is null`
(vacuously true), and `027b`'s `ORGROLE-001..003`, which carry a `[NAV]` step inside an otherwise
GraphQL-shaped case.

**So the next real gain is not an authoring push — it is a DOM predicate grammar (a `ui-runner`).**
Rewriting assertions buys about **1 percentage point**; giving the browser lane a runner of its own
is what addresses the other 2,508. That reorders the plan: the authoring burn-down is a tail task,
not the next step.

## Post-Run Results Triage — `/qa-triage-results`

A regression run tells you *which* tests failed; **`/qa-triage-results [RUN_ID|latest] [--fix] [--verify]`** works out *why* each one failed and what to do. **Owned by `qa-lead-orchestrator`** (orchestrate-only Triage Orchestrator — delegates classification to `regression-triage-agent`, live verification to `qa-frontend/backend-expert`, test fixes to `/qa-review-tests`, bug drafts to `/qa-bug`; never edits a CSV, files a ticket, or calls `/qa-fix`). It reads a completed run under `reports/regression/{RUN_ID}/`, and — cloning the `/qa-monitoring` skeleton (collect → dedup → triage → live-verify → report → STOP) — classifies every FAIL into **real product bug** vs a **test defect** (`TEST_STEPS_DEFECT` / `ASSERTION_DEFECT` / `TEST_DATA_DEFECT` / `STALE_TEST`) vs `FLAKY` / `ENV` / `KNOWN_ISSUE`.

- **Collect (deterministic):** `npm run triage:collect -- <RUN_ID|latest> --record` (`scripts/lib/regression-triage.ts`) assembles each non-passing case — **FAIL, BLOCKED, and SKIPPED** (each with a `status`; only PASS and PENDING excluded) — with its `traces/*-FAIL-trace.json` (network + console w/ stack frames, FAIL only), `screenshots[]`, lane HAR path, the CSV row, a stable fingerprint, and the cross-run flaky flag. A BLOCKED is triaged for *why* (env / precondition / data / real bug); a SKIPPED for a removed feature (stale test) vs an intentional gate.
- **Classify (judgment):** `ci/agents/regression-triage-agent.md` reads the evidence (incl. **opening the screenshot** for visual/element failures) against the oracles and emits `CLASS` + severity/route/confidence + suggested fix. Ambiguous → `REAL_BUG`/`LOW` (→ live repro / human review), never relabelled as a test-defect.
- **Verify + act:** HIGH-confidence real bugs are reproduced live by `qa-frontend/backend-expert`; under `--fix`, test-defects route to `/qa-review-tests <suite> --fix` (diff + confirm) and confirmed bugs are drafted to `reports/bugs/`. **STOP** — never files a tracker ticket, never triggers `/qa-fix`.
- **Report:** `reports/regression/{RUN_ID}/triage-report.md` (three tables: confirmed bugs / test-case fixes / dismissed).
- **Flakiness feed:** `npm run triage:history` writes per-suite rows into `reports/regression/history.json` in the shape `scripts/regression/compute-metrics.ts` expects (previously the flaky/trend detector was starved — the CI runner wrote a run-level shape it couldn't read; that run-level cost log now lives in `history-ci-runs.json`).

Full methodology: the `/qa-triage-results` skill (`triage-taxonomy.md` + `routing-and-fix.md`). Interactive-first; a headless `ci/run-triage-results.ts` twin is a documented follow-up.

## Prompt Templates

Key prompt templates in `vc/shared/docs/prompts/`:
- `How to test Builder.io.md` - Builder.io, Virto Pages & vc-frontend testing
- `story-testing.md` - Story-level testing prompt

> **Note:** `test-runner-agent.md` is now an agent definition at `agents/test-runner-agent.md`, not a prompt template.

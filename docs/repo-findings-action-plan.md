# Repo Findings — Action Plan

A prioritized, condensed companion to [`repo-findings-backlog.md`](./repo-findings-backlog.md).
The backlog stays the detailed record — this file answers *"what should someone pick up next,
and how urgent is it"*. Each row cites its backlog id; read the backlog row for evidence, repro,
and the full suggested fix. Nothing here is restated prose from there.

**How to read an id.** Every id in the backlog is now unique (see [Resolved — id
collisions](#resolved--id-collisions) below for the cleanup and the old→new map). A row below may
still carry a trailing `(date)` as a plain locator into a dated batch section — that is no longer
disambiguating an id collision, just naming where the row lives.

## Done in this PR

| Id | What shipped |
|---|---|
| B-55 | `lint-claude-docs.mjs` now counts chars CRLF-normalized in all three budget sites; baseline re-derived (12 entries tightened, 0 loosened); 2 new unit tests pin it. |
| B-40 (2026-09-11) | `scaffold-rows.ts` truncates the `surface` half only, keeping `scenario` whole so sweep titles stop colliding; `lint-test-cases.ts` now resolves a bare suite id through `config/test-suites.json` instead of a raw `ENOENT`. New unit test added. |
| B-44 (2026-09-11) | `.claude/rules/test-data.md` rule 4 + `test-data-authoring.md` §DISPOSABLE FIXTURES reworded: "own accounts" isolates a user-scoped fixture but not an org-pooled balance — the unit of isolation there is the organization. |
| — | `docs/repo-findings-backlog.md`: merged the duplicate 2026-09-16 `B-53`/`B-54` write-ups (same finding, written twice) and renumbered the resulting collision to `B-56`. |
| — | `docs/repo-findings-backlog.md`: resolved all 30 remaining id collisions (below) and added the `findings:lint` uniqueness gate `B-25` proposed. |

All verified: `npm run context:check` exit 0, `npm test` green (including the two new `findings:lint`
unit tests), `npx tsc --noEmit -p ci/tsconfig.json` clean.

## Resolved — id collisions

A mechanical check (`grep -oE "^\| B-[0-9]+ \|" docs/repo-findings-backlog.md | sort | uniq -c`), run
while merging the one 2026-09-16 duplicate above, found the problem was far bigger than that one pair:
**30 ids were each used for two unrelated findings.** Two sub-classes, both now fixed:

- **Internal to the top `## Open` section itself**: `B-13` and `B-14` each appeared twice there — this
  is exactly what `B-25` had already flagged (BIKE-* products vs. the chrome/edge HAR sweep; stale
  `LOYALTY_*` GUIDs vs. the resolved `SR-FE-013a` entry) and proposed renumbering — but its own
  suggested targets (`B-26`/`B-27`) were themselves taken by other findings by the time this ran, so
  the fix picks fresh free ids instead. `B-25`'s own row is now marked RESOLVED in the backlog.
- **Top section vs. the thirteen dated `## Open — YYYY-MM-DD (...)` sections below it**: 28 more ids
  (`B-21`–`B-48`) collided between the consolidated list at the top and the historical batch sections
  further down — e.g. `B-43` was "Windows `verify:gate` exit-null" at the top (2026-09-11) and
  "`PROBE:SIZED` has no runner wiring" in the 2026-09-08 batch. Confirmed genuinely different findings
  in every case (all 30 rows read in full before deciding) — none were a restated duplicate, so
  none were merged; each pair was resolved by **keeping the top-section instance's number** (the
  consolidated, currently-actionable list, and the side most existing citations already point at
  bare) and **renumbering the dated-batch instance** to the next free id.

**Old → new id map** (dated-batch instance; the top-section instance keeps its original number):

| Old | New | Finding (dated section) |
|---|---|---|
| `B-13` (2nd instance, top section) | `B-57` | HAR capture nothing on chrome/edge lanes, VCST-5586 |
| `B-14` (2nd instance, top section) | `B-58` | RESOLVED — `089` `SR-FE-013a` redirect no longer happens |
| `B-43` (2026-09-08, VCST-5652) | `B-59` | `PROBE:SIZED` has no runner wiring |
| `B-44` (2026-09-08, VCST-5652) | `B-60` | `[PROBE:ALIGN]` compares matches document-wide |
| `B-45` (2026-09-08, VCST-5652) | `B-61` | Rotating element's `getBoundingClientRect` isn't a size measurement |
| `B-25` (2026-08-08) | `B-62` | `npm run seed:users` aborts the whole run on one password policy |
| `B-26` (2026-08-08) | `B-63` | 59 of 69 declared storefront logins fail `login_failed` |
| `B-21` (2026-08-07) | `B-64` | Per-slot browser isolation entirely unwired |
| `B-22` (2026-08-07) | `B-65` | `.env.local` vcptcore identities clobbered vcst ones |
| `B-23` (2026-08-07) | `B-66` | `.env.playwright.local` registers only 3 secret names |
| `B-24` (2026-08-07) | `B-67` | vcst `ORG_USER` account is contested |
| `B-30` (2026-08-13) | `B-68` | `seed:sales-rep-stats` MOQ-blind product discovery |
| `B-31` (2026-08-13) | `B-69` | `seed:sales-rep-stats` duplicate-cart creation on re-seed |
| `B-32` (2026-08-13) | `B-70` | `td:reconcile` [11] blind to cart-shaped aliases |
| `B-29` (2026-08-12) | `B-71` | BA-guide screenshots gitignored |
| `B-27` (2026-08-11) | `B-72` | `td:validate` red on `main`, invalid `@td(ADDR_NY.*)` |
| `B-28` (2026-08-11) | `B-73` | `td:reconcile` red on vcptcore for an uninstalled-module fixture |
| `B-33` (2026-08-17) | `B-74` | `.env.local` clobber recurrence — `USER_EMAIL` + `TEST_USER_ID` |
| `B-34` (2026-08-17) | `B-75` | Skyflow card has no headless creation path |
| `B-35` (2026-08-17) | `B-76` | `customerSalesReps` returns `totalCount: 0` on vcptcore-qa |
| `B-36` (2026-08-18, SR-HD) | `B-77` | `buildStatisticsWindows()` `prevWeek` mismatches the storefront |
| `B-37` (2026-08-18, SR-HD) | `B-78` | `probe-sales-rep-statistics.mjs` broken by VCST-5647 |
| `B-38` (2026-08-18, 2nd) | `B-79` | `ACME_BUYER` lockout repair dropped org association |
| `B-39` (2026-08-18, 2nd) | `B-80` | No rep fixture on vcptcore-qa has a seeded phone |
| `B-40` (2026-08-18, 2nd) | `B-81` | Suite 090 preconditions understate what the env can do |
| `B-41` (2026-08-18, 2nd) | `B-82` | No secret NAME registered for vcptcore-qa `admin` |
| `B-42` (2026-08-20) | `B-83` | HAR capture dead on all three lanes (stray legacy file) |
| `B-46` (2026-09-08, VCST-5891) | `B-84` | `B-83`'s stray-file blocker gone, HAR still nothing |
| `B-47` (2026-09-08, VCST-5891) | `B-85` | No runner probe for computed TYPOGRAPHY properties |
| `B-48` (2026-09-08, VCST-5891) | `B-86` | `{{STORYBOOK_URL}}` trailing slash → empty Storybook page |

**The uniqueness lint `B-25` proposed** now exists: `npm run findings:lint`
(`scripts/maintenance/lint-findings-backlog.mjs`), wired into `npm test`, fails the build the moment
two `| B-NN |` rows share a number — pinned by `scripts/unit/lint-findings-backlog.test.mjs`.

**In-repo cross-references:** re-checked with `grep -noE "\bB-[0-9]{2}\b"` across the repo (excluding
these two files and worktree copies). Every real hit — `docs/decisions/unit-test-roi.md`,
`.claude/knowledge/execution/when-to-write-a-test.md`, `.claude/skills/qa-test/coverage-triage.md`,
`.claude/skills/qa-test/ui-kit-class.md`, `scripts/maintenance/td-validate-all.mjs`,
`scripts/test-cases/lint-test-cases.ts`, `scripts/unit/scaffold-rows.test.ts` — cites a **top-section**
id (`B-32`, `B-33`, `B-35`, `B-36`, `B-40`, `B-46`, `B-47`), none of which were renumbered, so no
code or knowledge-base file needed a change. Commit messages are immutable history and were left as-is
per the task that requested this cleanup.

## P0 — active gate/data corruption or silent-wrong-verdict risk

These fail in the expensive direction: green build, wrong answer, no error anywhere.

| Id | One-line |
|---|---|
| B-48 (2026-09-15) | A gutted guard lets a unit test write mock GUIDs into the **tracked** `aliases.vcst.json`; latent, not yet active. |
| B-47 (2026-09-15) | Two numeric literals in the `catalog-edge` fixture are checked by neither the unit test nor the drift guard. |
| B-45 (2026-09-11) | `[PRE:*]` preconditions are declarative-only — no runner executes them — so 472 "isolated" cases run against whatever session/cart exists. |
| B-44 (2026-09-11) | Org-pooled loyalty balance: separate accounts in one org still collide; only convention prevented corruption so far. *(rule reworded in this PR — the fixture-lane-split action itself is still open, see [live-env punch list](#live-env-only-punch-list))* |
| B-42 (2026-09-11) | No independent party checks that seeded fixtures are actually discriminating; `td:validate` green proves resolvability, not correctness. |
| B-41 (2026-09-11) | Two loyalty seeders read a moved route, tolerate its 404, and silently report balance `0`. |
| B-39 (2026-09-11) | Nothing validates GraphQL embedded in suite CSVs against the live schema; a required-arg change already disarmed 8 cases in 3 suites. |
| B-01 | `036-bopis-store-selector.csv` references 5 undefined aliases, so `td:validate` is red **repo-wide** — verify still reproducing (old finding, no recent re-check on file). |
| B-60 | `[PROBE:ALIGN]` compares matches document-wide, producing phantom multi-hundred-px drift on any selector that isn't uniquely scoped — an active false-FAIL generator for anyone authoring an alignment case today. |
| B-63 | 59 of 69 declared storefront logins fail `login_failed` — the root cause behind `B-64`; scale makes this the most consequential single item in the whole backlog. |
| B-82 | Admin-SPA password for vcptcore-qa has no secret NAME registered, so it gets typed in the clear — a secret-hygiene issue in a public repo. |
| B-77 | `buildStatisticsWindows()`'s `prevWeek` window doesn't match what the storefront actually requests — already produced one near-miss false regression report. |
| B-86 | `{{STORYBOOK_URL}}` already ends in `/`; the natural `…/iframe.html` composition double-slashes to a silently empty Storybook page at HTTP 200. |
| B-50 (2026-09-10, second section) | `passwordExpired: true` on a fixture silently blocked 32/32 cases in suite 015; the account signs in fine, so nothing looks broken. |
| B-56 | A missing FileExperienceApi upload scope fails inside an HTTP 200 behind an optimistic progress bar — reads as a front-end bug, costs browser-session hours. |

## P1 — a gate is red, unusable, or structurally blind for a whole class of work

| Id | One-line |
|---|---|
| B-46 (2026-09-15) | `td:validate:missions-e2e` has been red on a clean checkout and had never run in CI. |
| B-43 (2026-09-11) | `verify:gate` silently `exit null`s every sub-command on Windows; the sheet prints as if the gate ran. |
| B-38 (2026-09-11) | `/qa-deploy-pr`'s Jira dev-status lookup is dead on this instance for every ticket, silently. |
| B-33 (2026-09-10) | `tc:scope --domain` misses ~2/3 of at-risk rows for a UI-kit/token change that touches every domain and belongs to none. |
| B-34 (2026-09-10) | Focus-indicator coverage matrix has been all-`GAP` for 7 weeks; `scope:validate` warns instead of failing. |
| B-30 (2026-09-10) | A completed C1 run isn't recorded into `history.json`, so `verify:gate` reports `CANNOT EVALUATE` for a run that demonstrably happened. |
| B-31 (2026-09-10) | The pipeline forbids persisting the AC condition table, then a later gate asks to recompute percentages from it — contradictory rules. |
| B-27 (2026-09-10) | `suites:review` passes a case whose Steps call a hook-blocked MCP tool; it would BLOCK at execution, not authoring. |
| B-26 (2026-09-11, recurrence 3) | The visual lane (`4v`) is structurally guaranteed `SKIPPED` for any authenticated or mobile surface — third recurrence. |
| B-21 (2026-09-10) | `tc:scaffold --check` green-lights a case bound to a `@td()` alias that doesn't exist. |
| B-24 | `seed:membership-lock:verify` exits 1 for a state the run deliberately seeded, so nobody trusts a red exit anymore. |
| B-04 | `bl:lint` (the primary QA oracle's own linter) is not wired as a gate anywhere — it could sit visibly broken (150 Blocker findings, two concatenated copies) unnoticed. Triage `B-03`'s noise first, then wire it in. |
| B-76 | `customerSalesReps` returns `totalCount: 0` on vcptcore-qa despite a correct underlying graph — needs module-source investigation. |
| B-79 | An account-lockout repair silently dropped the org membership it was supposed to preserve. |
| B-49 (2026-09-10, second section) | `regression-orchestrator` can end its turn mid-flight; the notification reads as completion and invites a duplicate dispatch racing one browser lane. |
| B-52 (2026-09-15, second section) | HAR capture has now been "fixed" three times and stayed broken each time; the fix is unverified until a preflight *observes* a written file. |
| B-53 (merged 2026-09-16) | One untracked orphan CSV takes down `suites:lint` for every author, tree-wide. |
| mirror-parity CRLF (unnumbered, "Two pre-existing gate failures") | 3 of the 4 byte-identity mirror files fail on Windows-checkout line endings — needs a decision (normalize the guard vs. `.gitattributes -text` pin). Note: the sibling item in that same section (BUDGET-004) is now resolved by `B-55` in this PR. |
| 2026-09-17 batch (4 items, unnumbered) | `suites:merge` can destructively overwrite a 100%-browser suite's results; `summary.json` has no scaffold so it's easy to bypass the schema; two `/qa-test` runs sharing one working tree has no guard; a lane-reported finding can silently fall out of `summary.json` between return and filing. Each needs its own small fix — see the backlog section directly. |

## P2 — tooling/wiring gaps blocking specific coverage (feature work, not a bug)

| Id | One-line |
|---|---|
| B-32 (2026-09-10) | Focus-ring contrast isn't derived from the token source, so a palette edit can silently drop below 3:1. |
| B-35 (2026-09-10) | 4 UI-kit code paths (no-indicator radio, PDP nav arrows ≥5 images, review modal ≥2 images, Datatrans secure-fields) have no live surface on this store to exercise them. |
| B-36 (2026-09-10) | `prefers-reduced-motion` can't be emulated on the Chrome DevTools visual lane. |
| B-37 (2026-09-10) | No domain map exists yet for the design-system/UI-kit surface — run `/qa-domain-map design-system`. |
| B-59/B-85/B-51 (design-system PROBE gaps) | Three runner probes don't exist yet — `PROBE:SIZED` (per-size tokens), `PROBE:TYPOGRAPHY` (computed font props), `PROBE:COLALIGN` (horizontal column alignment). Three consecutive UI-kit tickets couldn't land durable coverage for this reason; ship together, one file (`scripts/lib/measure-layout.ts` + `layout-runner.ts`), one dispatch switch. Scope each **per element/column, not document-wide max−min**, or each reproduces `B-60`'s phantom-drift class. |
| B-07 | 18 non-duplicate cases were lost when suite `080` was retired; 3 have no equivalent anywhere in the corpus. |
| B-18 | The SPA-soft-404 vacuous-assertion pattern was fixed in 2 cases; the corpus needs a sweep (`rg "FRONT_URL}}/product/"`) for the rest. |
| B-68/B-69/B-70 (sales-rep-stats) | MOQ-blind product discovery, duplicate-cart creation on re-seed, and `td:reconcile` blind to cart-shaped aliases — three related seeder bugs, one file. |
| B-73 | `td:reconcile` fails permanently on vcptcore for a fixture whose owning module isn't installed there; should skip, not fail. |
| B-19 | Seeded sales-rep orders carry null `CategoryId`, so the Top Sellers category filter has almost no standing coverage. |
| B-11 | `seed-sales-rep.mjs` can't self-heal a TEMPORARY lockout the way `user-provision.mjs` already does — a good candidate to lift the existing clear-lockout helper into a shared path. |
| B-03 | `bl:lint` reports ~99 Medium findings, most likely a false-traceability matching bug in the linter itself, not real gaps — triage before wiring `B-04`. |
| B-17 | Suite 088 carries ~40 pre-existing lint findings (invalid `Automation_Status`, missing `[WAIT]`s) that bury any real regression in a *new* row and block `--fail-on=High` ever being turned on for that file. |
| B-23 | Two writers (the pipeline orchestrator and the discovery-lane agent) are both authorized to amend one Test Model file with no stated single-writer rule — the repo already has this rule for suite CSVs; state it here too. Doc-only, cheap. |

## Needs an owner decision, not a fix

| Id | Decision needed |
|---|---|
| B-05 | Mid-drag visual states have no permitted tooling path — narrow hook exemption vs. a new primitive. |
| B-09 | Chrome DevTools MCP has no `--secrets` — give Playwright throttling, or bridge via a shared CDP endpoint. |
| B-15 | `salesRepTopSellers` requires `storeId`; a case's own Steps say to omit it — fix the API's DX, or fix the case? |
| B-20 | Top Sellers "Revenue" is pre-discount list price, not money received — rename the column, or change the aggregate? |
| B-22 (2026-09-09) | Test Model 260-line cap forces history deletion every round — raise the cap, define what old rounds may compress, or split to an appendix? |
| B-29 (2026-09-10) | `MULTI_ORG_USER` fixture carries an extra membership row not in its documented shape — deliberate provisioning, or drift? |
| B-75 | Skyflow cards have no headless creation path at all — accept browser-seeded-only, or get a vault-token API from the module? |
| chrome-devtools-mcp profile isolation (unnumbered) | `--isolated` flag, a tracked per-agent config, or document it as single-instance-per-machine? |

## Live-env-only punch list

Not code — run against an environment the next time someone is already touching it.

| Id | Env | Action |
|---|---|---|
| B-44 (2026-09-11) | vcst / vcptcore | Seed a second `AGENT-TEST` organization so backend/frontend loyalty lanes stop sharing one org's pooled balance. |
| B-13 | vcst | Rename 4 configurable products to the `AGENT-TEST-` prefix + SEO fields, reseed. |
| B-14 | vcst | Re-run the loyalty-fixtures seeder so the overlay drops 2 dead member GUIDs. |
| B-12 / B-80 | vcst / vcptcore | Seed a phone number onto at least one rep fixture. |
| B-19 | vcst/vcptcore | Set `CategoryId` on sales-rep order line items (or route seeding through real checkout). |
| B-64 | vcst | Populate the 3 `AGENT_SLOT{1,2,3}_PASSWORD` vars — verify still unset, this finding is 6+ weeks old. |
| B-63 | vcst | Reconcile ~60 drifted storefront credentials — large, needs a decision on force-reconcile blast radius first. |
| B-74 / B-65 | vcst / vcptcore | `.env.local` still risks clobbering identity keys across envs — the proposed `DV-0xx` guard was never built; build it, then this class stops recurring. |
| B-82 | vcptcore | Register `ADMIN_PASSWORD_VCPTCORE` (+ siblings) in `.env.playwright.local`. |
| B-50 (2026-09-10, second section) | vcptcore | Clear `passwordExpired` on `ORG_USER_EMAIL` via `resetpassword` (the `PUT` route silently no-ops). |
| B-54 (merged 2026-09-16) | vcptcore_qa1 | Run the configurable-products seeder so `aliases.vcptcore_qa1.json` gets written. |

## Stale / resolved / superseded (no action — kept for traceability)

| Id | Status |
|---|---|
| B-28 | RESOLVED 2026-09-10 in the backlog itself. |
| B-10, B-58 | RESOLVED — see backlog rows for the fix. |
| B-78 | Fixed inline the same session it was found; residual ask (non-zero exit on schema errors) still open, folded into P2 above. |
| B-08 | "Fixed on the VCST-5367 branch" per the backlog text — verify that branch is merged to `main`; if not, this is still effectively open. |
| B-16 | Per team memory (`feedback_firefox_cart_dropdown_quirk` / agents.md's own Firefox note), `playwright-firefox` has been click-capable again since 2026-09-08 — likely resolved, verify before re-triaging. |
| B-83, B-84 | Both superseded by `B-52`'s correction — treat `B-52` as the canonical current HAR-capture status, not these two. |

## Not attempted here, and why

- Anything above needing a **live probe, seed, or reconcile** to implement or verify (see the punch
  list) — no live-env access from this session, and several (B-63's 60-account reconcile) need a
  blast-radius decision first regardless.
- **New runner PROBEs** (`PROBE:SIZED`/`TYPOGRAPHY`/`COLALIGN`) — real feature work, one coordinated
  PR, not a quick fix.
- **Gate/schema redesigns** (B-31's AC-table persistence, B-39's GraphQL-in-CSV validation, B-42's
  discriminating-fixture re-derivation) — each needs a design decision before code.

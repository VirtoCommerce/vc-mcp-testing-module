# Testing checklist — VCST-5733 "[E2E] All Customer Orders"

**Path:** FULL · **Flow:** feature-test · **Type:** Story · **Priority:** Medium (P2) · **Layer:** cross-layer (api + module + storefront) · **visual_surface:** true
**Env:** vcst-qa — `FRONT_URL=https://vcst-qa-storefront.govirto.com`, `BACK_URL=https://vcst-qa.govirto.com`, store `B2B-store`
**Build (deployed, probed):** platform `3.1063.0` · `SalesRep 3.1007.0-pr-14-5569` · `Xapi 3.1021.0-pr-84-0180` · `XOrder 3.1010.0` · theme `2.57.0-pr-2444-5946`
**Under test: three unmerged PRs, all live** — `vc-module-sales-rep#14`, `vc-frontend#2444`, `vc-module-x-api#84`
**Test Model:** `reports/ba/test-models/VCST-5733-2026-09-02.md` (25 scenarios) · **Evidence:** `./screenshots/`

Verdicts are `PASS` / `FAIL` / `BLOCKED` / `SKIPPED` / `NOT-RUN`. Written at Step 3, updated in place at 5e.

## Deploy prerequisites (gate — checked before execution)

| # | Prerequisite | Why it matters | Verdict |
|---|---|---|---|
| P1 | `salesRepCustomerOrders` + `salesRepCustomerOrder` present on `/graphql/sales-rep` | absent on a `dev` build — a validation error, not a null | **PASS** (introspected) |
| P2 | Indexed order search enabled + `CustomerOrder` index built | the Orders module **throws** when off, and it is off by default; the documented symptom is "a working dashboard and a failing customer-orders page" | **PASS** (92 orders returned live) |
| P3 | `XOrder ≥ 3.1009.0` (SalesRep#14 floor) and platform `≥ 3.1052.0` (Xapi#84 floor) | a module compiled against a higher floor passes the lenient manifest gate then fails at first resolve with `FILE_NOT_FOUND` | **PASS** (3.1010.0 / 3.1063.0) |
| P4 | Theme artifact on the env matches PR #2444 | without it the three storefront routes do not exist | **PASS** (declared `2.57.0-pr-2444-5946` in `vc-deploy-dev@vcst-qa`) |

## Story ACs — atomic conditions

| # | Condition | AC | Covering case | Verdict |
|---|---|---|---|---|
| C1 | The customer profile's `All orders →` opens the **customer-scoped** route, not the cross-customer list and not `/account/orders` | AC-1 | SR-CO-001 | NOT-RUN |
| C2 | Every row's organization is the org navigated from | AC-2 | SR-CO-001, SR-GQL-122 | NOT-RUN |
| C3 | No order from any other organization appears, in rows **or** in the count | AC-2 | SR-GQL-123 | NOT-RUN |
| C4 | An order the rep did **not** place IS present (creator-agnostic scope — the defect the story exists to fix) | AC-2 | SR-GQL-121, SR-CO-001 | NOT-RUN |
| C5 | Breadcrumb on the customer-scoped route reads `… / My customers / {customer} / Orders` | AC-3 | SR-CO-002 | NOT-RUN |
| C6 | Breadcrumb on the cross-customer route names **no** single customer | AC-3 | SR-CO-003 | NOT-RUN |
| C7 | The breadcrumb customer segment is a working link back to the profile (mouse **and** keyboard) | AC-3/AC-5 | SR-CO-004 | NOT-RUN |
| C8 | Paging via Previous/Next + numbered pages re-fetches and pages are **disjoint** | AC-4a | SR-CO-007, SR-GQL-128 | NOT-RUN |
| C9 | Keyword search matches by order number | AC-4b | SR-CO-* (search row) | NOT-RUN |
| C10 | Sorting by Date reverses, and reversal is observable | AC-4c | SR-CO-001 | NOT-RUN |
| C11 | Which columns are sortable is stated (AC-4 implies "sort" unconditionally; only Date shows an affordance in the implementation screenshot) | AC-4c | SR-CO-001 | NOT-RUN |
| C12 | Returning to the profile keeps it in its Orders context | AC-5 | SR-CO-005 | NOT-RUN |

## Gap conditions (no AC covers these — from 1d, each mapped to an invariant)

| # | Condition | Oracle | Covering case | Verdict |
|---|---|---|---|---|
| G1 | A rep cannot read the orders of a customer they do not serve (list **and** by-id) | BL-SR-002 (membership half) | SR-GQL-123, SR-GQL-129 | NOT-RUN |
| G2 | A **per-org locked** membership excludes that org while unlocked orgs still resolve | BL-SR-002, BL-SR-011 | SR-GQL-124 | NOT-RUN |
| G3 | A non-whitelisted `facet` is dropped and never aggregates across the index (**scope-leak defence**) | BL-SR-002 | SR-GQL-125 | NOT-RUN |
| G4 | Facet counts sum to the scope total and ignore their own axis' selection | PROPOSED-BL-SR-034 | SR-GQL-126 | NOT-RUN |
| G5 | An unrecognized facet name is dropped, not rejected | — | SR-GQL-127 | NOT-RUN |
| G6 | A zero-customer rep gets the "no data" state, distinct from "nothing matched" | BL-SR-012 | SR-CO-009 | NOT-RUN |
| G7 | Changing a filter resets paging to page 1 | PROPOSED-BL-SR-035 | SR-CO-006 | NOT-RUN |
| G8 | Created-date range includes orders on both boundary days in the rep's local timezone | BL-SR-001 | SR-CO-008 | NOT-RUN |
| G9 | An order the rep did **not** place opens read-only — no Pay-now / Reorder | {SPEC} PR#2444 | SR-CO-010 | NOT-RUN |
| G10 | An order the rep **did** place opens on the buyer page with actions intact | {SPEC} PR#2444 | SR-CO-011 | NOT-RUN |
| G11 | A **typed** buyer-page URL for a served customer's order the rep did not place is refused (two pages, two authorization rules, one order) | {HYPOTHESIS} | SR-CO-012 | NOT-RUN |
| G12 | A locked **account** is refused at query time on a token issued before the lock | {OBSERVED} — PR#14 breaking change | SR-GQL-* / see note | NOT-RUN |
| G13 | Deep-link / refresh of a filtered URL restores the view or degrades safely, never losing customer scope | UIP-DEEP/REFRESH | SR-CO-014 | NOT-RUN |
| G14 | A failed or slow facet request leaves the filter drawer honest, not stale from the previous customer | VCST-5589 precedent | SR-CO-015 | NOT-RUN |
| G15 | Multi-organization customer: only the navigated-from org's orders show, and the page says which org | PROPOSED-BL-SR-033 | SR-GQL-122 | NOT-RUN |

## Visual axis (`visual_surface: true` — design + accessibility, `skills/qa-test/visual-axis.md`)

Invariant failures may fail the ticket; `vs. DESIGN` drift is advisory and never fails.

| # | Condition | Axis | Verdict |
|---|---|---|---|
| V1 | WCAG 2.2 AA on the filters drawer — keyboard reach to every status checkbox and both date inputs, visible focus, target size | `BL-A11Y-001..004` (**blocking**) | NOT-RUN |
| V2 | Filters drawer usable at 375px — Apply/Reset reachable, no clipping, no overflow | `BL-UI-002` + `[OVERFLOW] [TOUCH]` (**blocking**) | NOT-RUN |
| V3 | Order-status chips / money / dates use design-system tokens, no literals | design-system consistency (**blocking**) | NOT-RUN |
| V4 | Grid, drawer and breadcrumb vs the Claude Design spec (`DESIGN_SYSTEM_PROJECT_ID`) | `vs. DESIGN` (**advisory only**) | NOT-RUN |
| V5 | Localized `statusDisplayValue` / `formattedAmount`; no raw enum, no `sales-rep.*` i18n key | `BL-SR-013` (**blocking**) | NOT-RUN |
| V6 | Search box and filter chips do not reflect or execute injected markup | VCST-5558 precedent (**blocking**) | NOT-RUN |

## Known divergences — recorded, never filed (self-declared in PR #2444)

| Divergence | Note |
|---|---|
| A BOPIS order's pickup-point action is missing from the hub order page | Template duplication from `order-details.vue`; extraction deferred |
| The filters panel uses its own **rolling-window** date presets, not the shared calendar-aligned component | Deliberate behaviour choice, not a refactor gap |
| Paging by the last `edges{cursor}` repeats a row; a non-numeric cursor silently restarts | Upstream shared `Xapi.Core` connection arithmetic, documented as unfixed. **Reproduced live.** Only the storefront's *choice* of cursor is in scope (C8) |
| `totalCount` is an index upper bound; a page may return a row short between a write and a reindex | By design (`ISalesRepOrderVisibilityService` re-scopes loaded rows). **Never file as a bug** without confirming a reindex did not just run |

## Uncovered conditions — stated, not omitted

| Condition | Why uncovered |
|---|---|
| Screen-reader output on the filters drawer | Manual-only; may never be reported as PASS (`visual-axis.md`) |
| Five of the six WCAG 2.2 additions | Manual-only |
| `salesRepCustomerOrders` on the **default** `/graphql` endpoint | Registered there too ("a convenience view, not an isolation boundary"), but the gate lives in the shared builders; covered indirectly by the scoped-endpoint cases. Not separately asserted this run |
| Store isolation (`SR_REP_SECOND_STORE`, Electronics store) | Subsumed by the permanent `storeid` term filter proven in SR-GQL-125 |
| `ORDER_BUYER_PLACED`-shaped order in an **unserved** org (the 4th authorship×scope cell) | Deliberately unseeded — adds no discrimination over the three provisioned fixtures |

## Findings held below the 5d severity floor

`Low`/P3 findings are dropped from the tracker, never from the run. Each keeps its `reports/bugs/open/` draft.

**Not filed (below severity floor): _to be completed at 5d_**

## Incidental findings (outside this ticket's scope)

| Finding | Detail |
|---|---|
| `td:validate` is **red corpus-wide**, pre-existing | `@td(ADDR_NY.*)` is invalid `@td()` syntax in the **P0 smoke suite** `042-smoke-tests.csv` (90/91 refs resolve). Identical in HEAD and the working tree, so not from this run. A **test defect** → `/qa-review-tests --fix`, not a product bug |
| `PUT /api/platform/security/users` silently discards `lockoutEnd` in both directions | Returns `{succeeded:true, errors:[]}` while changing nothing. Working endpoints are `POST …/users/{GUID}/lock|/unlock` (**GUID only**; the email form returns `{succeeded:false, errors:[]}`). Consequence: `clearRepStaleLockout()` logged success while doing nothing, so the documented remedy for REG-2026-08-24-1806 (104 cases BLOCKED at `/connect/token`) had never worked. **Fixed** in `seed-sales-rep.mjs` with a read-back. **The same broken pattern remains in `scripts/lib/user-provision.mjs` (~518–520, ~527, ~1047)**, serving the b2b/loyalty user families — needs an owner, wider blast radius than this ticket |
| TechFlow top-sellers were already contaminated before this run | Dominated by `msne2e`/`loyzero` orders from other suites. Not made worse — the new fixtures pin dedicated product slots and the shaped BL-SR-008 rankings are bit-identical after seeding |

# Testing Checklist — VCST-3912

`[Support] #38981 — Price restriction on order, catalog, pricing modules` · Story · High · status `Testing`
Run: 2026-09-10 · Path **FULL** · Flow `feature-test` · Env target **vcptcore-qa** · Model: [`VCST-3912-2026-09-10.md`](../../../ba/test-models/VCST-3912-2026-09-10.md)

## Verdict — BLOCKED (not executed)

**Nothing below was run.** vcptcore-qa (and every other environment) pins `VirtoCommerce.Orders 3.1014.0`; PR [#472](https://github.com/VirtoCommerce/vc-module-order/pull/472) is open and 12 commits ahead of `dev`. A live probe of `POST /api/order/customerOrders/search` returns orders with **no `withPrices` key** — the feature's headline wire contract is absent. Deployable artifact **does** exist: `VirtoCommerce.Orders_3.1015.0-pr-472-dfa3.zip` in `vc3prerelease` (HTTP 200), consumable via an AzureBlob pin on vc-deploy-dev `vcptcore-qa`.

Every item is `NOT RUN`. Cases are authored and appended as `Draft`; run them with
`/qa-regression 017,050c --ids ORDA-104..ORDA-122,ORD-GQL-014` once the pin lands.

## Gates

| Gate | Where | Result |
|---|---|---|
| Model complete (10 clauses) | 1e | PASS (inline) |
| Existing coverage disposed | 2a | PASS (inline) |
| **Artifacts reviewed + data resolved** | **Step 3** | **APPROVE** — fresh `qa-lead-orchestrator` in Verifier Mode, re-derived from source. Confirmed the `ORDA-118` leak against the diff independently, confirmed the `ORDA-115` withdrawal, confirmed the REPAIR touched `Preconditions` only, and confirmed zero Critical/High lint findings land on any of the 20 new rows. |
| Execution evidenced | Step 4 | **NOT REACHED** — BLOCKED-on-deploy |
| Triage + AC/DoD sound · Filing sound · Release gate · Promotion | 5b · 5d · 5e · 5g | **NOT REACHED** |

## Conditions → coverage

Story ACs first. **1d graded all four non-testable or partial** — two are structural claims, two are deliverable-presence checks — so the gap-ACs, not these, carry the run.

| # | Condition | Source | Case | Status |
|---|---|---|---|---|
| 1 | `ICustomerOrderDataProtectionService` owns the decision on every read/save path | AC-1 | ORDA-104, 105 | NOT RUN |
| 2 | A denied caller's order comes back with prices zeroed | AC-2 | ORDA-105, 109 | NOT RUN |
| 3 | A denied caller's save does not destroy stored prices | AC-2 | ORDA-110 | NOT RUN |
| 4 | A sample demonstrates extending the rule | AC-3 | ORDA-113, 115 | NOT RUN |
| 5 | Documentation exists for implementing this in other modules | AC-4 | — | **UNCOVERED — and unmeetable as written.** AC-4 names `IEntityDataProtectionService`, which **does not exist in the shipped diff**. Only `docs/data-protection-architecture.md` defines it, marked `Status: Proposal`, targeting `VirtoCommerce.Platform.Core`. Not a QA-testable condition; raise with the story author. |
| 6 | Search: every one of the 30 monetary fields zeroed, `withPrices` false | gap | ORDA-105 | NOT RUN |
| 7 | Indexed search does not leak prices through sort/filter ordering | gap-21 | ORDA-107 | NOT RUN — **known-open per the dev's own doc** |
| 8 | GET by id/number/outerId: 404 vs 403 does not enable order enumeration | gap-1/2 | ORDA-106 | NOT RUN |
| 9 | Store scope ∩ requested = ∅ returns zero orders, not all stores | gap-5 | ORDA-108 | NOT RUN — **known-open, marked "By design" in review, no unit test** |
| 10 | Nested captures/refunds under a payment are zeroed at every depth | gap-4 | ORDA-109 | NOT RUN |
| 11 | Restore-on-write holds for create, update, patch **and** import | gap | ORDA-110, 119 | NOT RUN |
| 12 | Export by a permitted admin contains real prices | gap | ORDA-111 | NOT RUN |
| 13 | Export with no `HttpContext` does not silently zero the backup | gap-20 | ORDA-112 | NOT RUN — **known-open, "By design"; contradicts the doc's own rule #4** |
| 14 | Export → import round trip does not write withheld zeros as real prices | gap | ORDA-119 | NOT RUN |
| 15 | Independent Payment/Shipment endpoints redact identically | gap-19 | ORDA-114 | NOT RUN — **known-open; the doc states child services are unprotected today** |
| 16 | A custom `CanReadPrices` on a null principal denies, never 500s | gap-3 | ORDA-115 | NOT RUN — **hypothesis withdrawn.** The base service returns `false` for `user is null` and the sample guards `user != null`; the `cursor[bot]` 500 was fixed between `a2d4cfa` and `dfa3864`. Row retained as a `BL-AUTH-017` guard on the extension point only; non-reproduction is the expected result. |
| 17 | `Discounts` / `TaxDetails` / `FeeDetails` carry no money after redaction | **new** | ORDA-118 | NOT RUN — **found this run; in no review comment and not in the architecture doc** |
| 18 | Redacting a cache-owned instance does not strip prices for the next entitled caller | gap | ORDA-116 | NOT RUN |
| 19 | Granting/revoking `order:read_prices` takes effect with no re-login | BL-PLAT-001 | ORDA-117 | NOT RUN |
| 20 | Admin SPA masks from `withPrices`, not a client-side permission check, across all six price surfaces | gap | ORDA-113, 120–122 | NOT RUN |
| 21 | Storefront/xAPI order surface distinguishes withheld from zero | gap | ORD-GQL-014 | NOT RUN — **schema refreshed 2026-09-10 confirms `CustomerOrderType` has no `withPrices` field** |
| 22 | Catalog and pricing legs of the origin requirement | comment 2026-02-24 | — | **OUT OF SCOPE of this PR.** The ticket summary and Modules field name catalog + pricing, and the origin requirement names four data classes; the diff touches **orders only**, and only the *price* aspect. Sibling `VP-8998` is the plausible home — **unconfirmed**. Raise with the story author. |
| 23 | Performance: every save now pays one extra read, even for a fully-privileged caller | gap-17 | — | **UNCOVERED** — no NFR budget stated on the ticket; the doc flags it as an open question. Not filed; below the bar without a stated budget. |

## Visual conditions (`visual_surface: true` — 10 Admin SPA blade/widget files changed)

| Condition | Case | Status |
|---|---|---|
| All six price surfaces mask for a denied user (order list grid · line items · order-totals widget · invoice · shipment · operation-tree widget) — the inventory comes from the customer's own analysis attachment | ORDA-113 | NOT RUN |
| Deep-link straight to an order-detail blade masks with no list context loaded (`UIP-DEEP`) | ORDA-120 | NOT RUN |
| Force-refresh mid-flow preserves masking (`UIP-REFRESH`); bundle hash must be confirmed changed first — Admin SPA carries a 4h `max-age` (`VC-DEPLOY-003`) and a stale bundle masquerades as a masking failure | ORDA-121 | NOT RUN |
| Payload failure masks **closed** — no price flash (`UIP-NET`) | ORDA-122 | NOT RUN |
| `BL-UI-004` content boundary on the rewritten order-list price cell template | ORDA-113 | NOT RUN |
| `BL-A11Y-*` on the masked cells | — | **SKIPPED** — the visual lane never dispatched; nothing to audit until the build lands. Not a pass. |

## Step 2a — existing coverage disposed

`tc:scope` over `purchase-flow` + `platform-config`: **27 hits, 22 `WILL_RUN`, 0 `FILTERED_OUT`, 5 `NOT_EXECUTING`**; 6 suites `unscannable` (legacy 11-column headers: `056`, `063`, `064`, `065`, `073`, `076` — **stated, not skipped**; `064` matters here because it is CSV import/export). `unmatchedObservables`: none.

> **Re-running `tc:scope` now returns 35 hits / 30 `WILL_RUN`, not 27 / 22 — and that is expected.** The extra 8 are this run's **own** newly-authored rows (`ORDA-104`, `105`, `111`, `113`, `117`, `120`, `121`, `122`) plus `ORDA-057`, which only started matching the `read_prices` observable **after** the REPAIR corrected its permission names. 35 − 8 = 27. The figures above are the **pre-authoring** scan the dispositions were made against; nothing was missed. Verified independently at the Step-3 verifier gate.

| Disposition | Rows | Action taken |
|---|---|---|
| `REPAIR` | `ORDA-057` — the **only** existing case covering `order:read_prices`, and it named `orders:read_prices` / `orders:update_shipments`, which **do not exist** (live permission catalogue confirms `order:` singular) | **Applied** — mechanics only, oracle untouched. Re-linted: CRLF (567) and BOM preserved, 70 rows still parse, no new finding. **But the row has empty `Assertions` and zero `Failure_Signals`, so it cannot fail** — it is vacuous coverage, and ORDA-104..122 are the real thing. Strengthening it is `/qa-review-tests --fix` work, out of this run's scope. |
| `CONFIRMED` | the remaining 26 hits — checkout/cart/BOPIS/payment rows matching only on the phrase *"order total"* | none; the change does not alter any total, only who may read it |
| `RE-BASE` | none | C1's exact set is therefore the new Draft ids only |
| `SUPERSEDED` | none | — |

## Regression scope

- **C1** — `ORDA-104..ORDA-122` + `ORD-GQL-014`, exact set. **Not run** (blocked).
- **C2** — not scoped and not run: a change-scoped Critical sweep against a build that does not carry the change would measure the old build. Recorded as `not-assessed`, **never as a pass**.
- **Exclusions** — every suite contributed zero cases this run, because nothing executed.

## Incidental findings (not filed)

- `npm run suites:lint` is **already red on `main`**, unrelated to this ticket: `regression/suites/Backend/subscription/093-subscription-admin.csv` exists on disk with no manifest entry, so it can never be selected. Left alone (one-author-per-CSV); belongs to whoever owns suite 093.
- Suite `017` baseline: **293 Critical / 230 High** lint findings, all pre-existing legacy-TestRail-import debt (untagged steps, empty assertions). Not introduced by this run.
- VirtoOZ `PlatformDeveloperGuide` → *scope-based-permissions* teaches the authorize-then-mutate-criteria pattern **this PR replaces**, using `OrderAuthorizationHandler` as its worked example. Shipping VCST-3912 dates the platform's canonical authorization tutorial. Documentation drift, distinct from AC-4, and owned by platform docs rather than this ticket.
- Below the severity floor: none. Nothing was executed, so nothing was observed to grade.

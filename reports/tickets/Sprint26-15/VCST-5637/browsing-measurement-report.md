# VCST-5637 — x-catalog **browsing** measurement (ES calls + total time)

**Ticket:** VCST-5637 (Task, High) — *Deduplicate the product search within a request in x-catalog, behind an overridable seam*
**Check type:** performance measurement, cross-env A/B — **browsing** scope
**Env:** BEFORE `vcptcore-qa` XCatalog `3.1014.0` (no seam) · AFTER `vcst-qa` XCatalog `3.1016.0-pr-106-3559` (seam present)
**Date:** 2026-08-06 · **Verdict: PASS** (change behaves exactly as specified)
**Method:** `.claude/knowledge/execution/es-call-ab-method.md`

## Summary — where the reduction actually is

| Workload | Before | After | Change |
|---|---|---|---|
| **Cart read/write** (measured earlier, same ticket) | **9** | **3.5** | **−61%** ✅ |
| **Mechanism control** — 4 identical searches in one request | **4** | **1** | **−75%** ✅ |
| Browsing — PLP / PDP / search / category nav *(this report)* | 1–7 | 1–7 | **no change** |

The dedup **works** — the `4 → 1` control fired on the after build in the same telemetry windows these
browsing numbers come from — and it **does nothing for catalog browsing**. That is the correct outcome,
not a defect.

**Whether the fix helps depends on whether a request repeats itself.** Cart asks for the *same* products
several times inside one request (pricing, inventory and validation each arrive through a separate mediator
dispatch → byte-identical `SearchRequest`s → collapsed). Browsing asks for *different* products every time:
a PLP issues one search for the listing plus one per variation-bearing product, each carrying a different
master product id. Nothing is a duplicate, so nothing collapses.

Had it collapsed them it would have served **wrong products** — one product's variation set for a different
parent. The distinct-criteria control (4 → 4 on *both* builds) exists to prove it does not. The browsing
null result and that control are the same fact seen twice.

Browsing's own inefficiency is a **variations N+1**, a separate and still-open lever.

## Measurement 1 — ES product `_search` calls per GraphQL request

Verbatim `vc-theme-b2b-vue` query text (captured live, theme `2.55.0-pr-2417`), byte-identical on both
arms; only `[GQL-VARS]` differ, since ids differ per catalog. Sent straight to each **backend**. 1 VU,
0% overlap. Every repetition uses a **distinct** target so each is cache-cold.

| Arm | BEFORE | n | AFTER | n | Δ |
|---|---|---|---|---|---|
| **CTRL — 4 byte-identical aliases** *(positive control)* | **4** | 5 | **1** | 12 | **−75%** ✅ |
| **CTRL — 4 distinct-criteria aliases** *(negative control)* | **4** | 3 | **4** | 1 | unchanged ✅ |
| PLP, zero-variation category | 1 | 2 | **1** | 7 | unchanged (at floor) |
| **PLP, variation-rich category** | 5,5,6,6,7 → **6** | 5 | 6,6,7,8,7,7,8,6,7,7,8 → **7** | 11 | **unchanged** |
| PDP, non-variation product | **2** | 9 | **2** | 13 | unchanged |
| PDP, variation product | 2,2,1 → **2** | 3 | **2** | 5 | unchanged |
| Keyword search + facets | 2,1,2,1,2,1 → **1–2** | 6 | 1×10, 2 → **1** | 11 | unchanged |
| Category navigation *(declared non-goal)* | **1** | 3 | **1** | 4 | unchanged ✅ as designed |

**The two control rows are what make the null result trustworthy.** The positive control drops 4 → 1 in
the *same telemetry windows* the browsing numbers come from, so "browsing unchanged" means *no redundancy
was present*, not *the instrument was blind*. The negative control staying at 4 on both builds shows the
key is complete and does not over-collapse.

## Measurement 2 — the mechanism, established **within each env**

Cross-catalog comparison can always be argued with. This one cannot: same build, same query text, same
page size (`first:16`), only the variation profile differs.

| Same build | zero-variation PLP | variation-rich PLP | variation products in page |
|---|---|---|---|
| AFTER (vcst-qa) | **1** | **7** | 5 |
| BEFORE (vcptcore-qa) | **1** | **6** | 6 |

So per request: **ES product searches ≈ 1 + (variation-bearing products in the page)**. The extra searches
come from the `variations` resolver, one per master product — **distinct** requests, hence not dedupable.
Per the method's residual table (§6), a count that **scales with collection size is an N+1**, whose lever
is **batching into one by-ids call**, not a request-scoped cache.

## Measurement 3 — total time

| Arm | BEFORE req ms (median) | AFTER req ms | BEFORE ES ms | AFTER ES ms |
|---|---|---|---|---|
| CTRL (4 identical) | 8 | 9 | **18** | **5** |
| PLP variation-rich | 66 | 101 | 26–35 | 70–116 |
| Keyword search | 92 | 171 | 32 | 104 |

**No browsing time saving is claimed, because no browsing calls were removed.** ES time falls only on the
CTRL arm, tracking its 4 → 1 drop — the fix converts calls into time exactly where it removes calls.

**Cross-env latency is not comparable and is reported for completeness only** (method §5): AFTER is
*slower* on several arms, driven by catalog size (4 523 vs 2 537 products) and a different ES cluster/DB
tier — not by this change. A within-env before/after would be needed to claim browsing latency, and there
is no call-count change to produce one.

## Conclusions

1. **PASS** — the seam is correct: it collapses identical in-request searches, leaves distinct ones alone,
   and leaves the declared non-goal (category search) untouched.
2. **Browsing gains nothing**, by construction. The ticket claimed cart, and only cart; nothing is missing.
3. **New finding (pre-existing, out of scope for this ticket):** a PLP issues one extra ES product search
   per variation-bearing product — up to **7–8 searches for a 16-item page**. Recommend a follow-up to
   batch the `variations` resolver into a single by-ids load; sibling in spirit to VCST-5640. Not filed.

## Caveats a reader should know

- **Adaptive sampling is asymmetric.** `vcst-qa` carries live traffic (`itemCount` 2–8) while `vcptcore-qa`
  is idle (mostly 1), so AFTER needed 3–4× the request volume for comparable n. Each retained record is one
  real request with real counts, and a request shares its multiplier with its own dependencies.
- **Repeat passes warm the platform cache.** Supplementary passes over already-used offsets produced some
  `esProduct = 0` rows on the BEFORE side; those are cache hits and are excluded from the cold medians.
- **Discovery warmed the first replication.** An initial pass (11:38–11:39Z) read only 1 search/request and
  looked like "browsing is already at the floor". It was wrong — thin n plus targets pre-warmed by the
  discovery queries. Superseded by the high-volume cold runs above; recorded because the naive version of
  this measurement reports the opposite conclusion.
- **Catalogs necessarily differ.** Page size, facet count and variation profile were matched as closely as
  the two catalogs allow, and the variation profile is reported per cell rather than averaged away.

## Appendix — reproducing

| Layer | What |
|---|---|
| Load generator | `npx tsx scripts/graphql/graphql-runner.ts --case <csv>:<ID> --schema-cache <per-env>` |
| Harnesses | `PERF-5637-BRW2-*` (8 arms × 2 envs), `PERF-5637-BRW3-*` (VARPLP / PLAINPLP / CTRL) |
| Instrument | Azure Application Insights, KQL over `requests` ⋈ `dependencies` on `operation_Id` |
| Metric | count of `dependencies` whose `name` ends `-product-active/_search`, per request; `sqlDeps`/`totalDeps` as controls; `duration` + summed ES time for the time question |
| Windows | 11:44:17–11:45:22Z (rep2) · 11:47:50–11:48:14Z (rep3) · 11:49:12–11:49:54Z + 11:50:57–11:51:50Z (supplementary) |

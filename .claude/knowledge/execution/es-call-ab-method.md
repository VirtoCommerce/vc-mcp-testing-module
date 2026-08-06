# Measuring ES / dependency calls per request — cross-env A/B method

How to answer "did this change reduce backend calls?" for an xAPI change, comparing a **pre-fix**
deployment against a **fixed** one. Written from the VCST-5637 run (x-catalog product-search dedup),
where the naive versions of this measurement were wrong three different ways.

Scope: **call counts**, which transfer across deployments. **Not latency** — see §5.

## 1. Pick the two environments

| Role | How to confirm it really is the baseline |
|---|---|
| BEFORE | `vc-deploy-dev@<env-branch>` `backend/packages.json` shows the module at a version **without** the change |
| AFTER | same file shows the prerelease/fixed version, and the live platform agrees |

Live platform version: `curl -sk <BACK_URL>/ | grep -oE "Version ?= ?'[0-9.]+[^']*'"` — the login page
carries it. `/health` lies during a restart (`reference_platform_live_version_from_login_page`).

## 2. Drive identical work on both sides

The count is only comparable if the **request shape** is identical. Two traps:

- **Never drive each storefront** — theme versions differ per env, so the GraphQL query text differs, so
  the resolution graph differs. Send the *same query text* straight to each backend.
- **Seed the same cart shape** (same line-item count, same quantity). Products necessarily differ between
  catalogues; shape is what matters.

Harnesses: a runner-native CSV case via `scripts/graphql/graphql-runner.ts --case <csv>:<ID>` for a fixed
sequence, or `vc-perf`'s k6 `cart-read-loop` for sustained load.

### Fixture selection is load-bearing — filter, don't take the first N

`addItem` **silently no-ops** (no error, `itemsQuantity` just comes up short) when the product is not
addable. Both of these are correct platform behaviour and will empty your cart:

- `isBuyable: true` **with `availableQuantity: 0`** — buyable ≠ in stock.
- **`minQuantity > 1`** (MOQ) — a quantity-1 add no-ops.

So discover with all four conditions and pin the result:

```graphql
products(storeId: "…" first: 60 cultureName: "en-US" currencyCode: "USD" query: "") {
  items { id name hasVariations minQuantity
          availabilityData { isBuyable isAvailable availableQuantity } } }
```
Keep `isBuyable && isAvailable && availableQuantity > 0 && minQuantity <= 1 && !hasVariations`, then pass
the ids explicitly (`PRODUCT_IDS` for k6; `Test_Data` for a runner case). Exclude configurable products —
they need a configuration, not a plain `addItem`.

Note some envs have **zero tracked inventory** (vcptcore-qa at time of writing): there, only
`isTrackInventory: false` products are addable at all, and there may be very few.

## 3. Count the calls — App Insights, joined on `operation_Id`

```
requests
| where timestamp between (datetime(<run-start>) .. datetime(<run-end>))
| where name == 'POST graphql/'        // the runner sends no operationName → unnamed
| project rid=operation_Id, ts=timestamp, rdur=duration, samp=itemCount
| join kind=leftouter (
    dependencies
    | where timestamp > ago(30m)
    | summarize esProd=todouble(countif(name endswith '-product-active/_search')),
                allDeps=todouble(count()),
                sqlN=todouble(countif(type=='SQL')) by operation_Id
  ) on $left.rid == $right.operation_Id
| project ts, esProduct=toint(coalesce(esProd,0.0)), sqlDeps=toint(coalesce(sqlN,0.0)),
          totalDeps=toint(coalesce(allDeps,0.0)), reqMs=round(rdur,0), samp
| order by ts asc
```

- `leftouter` + `coalesce` keeps a zero-search request as `0` instead of dropping it.
- **Always carry `totalDeps` alongside.** If the total moves as much as the slice you changed, something
  other than your change is moving — that row is what stops a fix being credited with an unrelated win.
- **Report per-request rows, not just an average.** The distribution is the finding at small n.
- KQL gotchas on the Azure MCP path: `has_any` and `let` return empty — use `or contains` chains; `sql`
  is a reserved token, so alias it (`sqlN`).

## 4. Three artifacts that will fool you

1. **Cold start dominates.** A first request against an idle env measured **1613 ms / 75 SQL** where the
   warm steady state was **20 ms / 3 SQL** — same build, same cart. Always compare **warm vs warm**, and
   discard the first run of each cell.
2. **Repeated identical requests are not independent samples.** Platform caches warm within seconds: eight
   identical cart reads fell from 6 searches / 317 ms to 1 search / 10 ms *on the pre-fix build*. A
   repeat-and-average therefore measures the cache, not the code. Only the cold request discriminates for
   a *count*; for steady-state load use sustained k6 traffic instead.
3. **Adaptive sampling.** `itemCount > 1` means the record represents that many requests. Per-request
   integrity survives (a request and its dependencies share the multiplier), but you cannot label which
   individual operation a retained record was — space configs apart in time and read the window.

## 5. Counts transfer; latency does not

Cross-env latency is not comparable — different catalogue size, DB tier, index size, sibling module
versions. Report counts cross-env, and take latency from **one** env across its own deploy, or from k6 at
a fixed rate. Expect the two to disagree: removing calls to a component that is not the bottleneck reduces
counts with no p95 movement. That is a real result, not a failed measurement.

## 6. Reading the residual — is there anything left to remove?

Vary the input size and see whether the count follows:

| Observation | Meaning | Lever |
|---|---|---|
| count **scales** with item/collection size | N+1 — one call per element | batch into one by-ids call |
| count **flat**, > 1 | a fixed set of *distinct* call shapes | make them byte-identical so a request-scoped dedup collapses them, or cache across requests |
| count **flat**, = 1 | at the floor for this request | only a cross-request cache goes lower |

Worked example: after VCST-5637, cart-read ES product searches measured **2–3, flat** from 1 to 8 line
items and identical whether items shared a product or were all distinct — so no N+1 remained, and further
reduction is a question of collapsing distinct shapes, not batching.

Second worked example (browsing, VCST-5637): a PLP measured **1 + one per variation-bearing product in the
page** — 1 for a zero-variation category, 6–8 for a variation-rich one at `first:16`. Count **scales** ⇒
N+1 ⇒ the lever is batching the `variations` resolver into one by-ids load. A request-scoped dedup does
nothing here, because each extra search carries a *different* master product.

## 7. A null result is only a result if you ship a positive control

"We changed X and the count did not move" is indistinguishable from "the instrument was blind" unless, **in
the same telemetry window**, you also run a case where the count is *known* to move. Ship both:

| Control | Shape | Must show |
|---|---|---|
| **positive** | N byte-identical calls in ONE request | BEFORE `N`, AFTER `1` — the mechanism fires |
| **negative** | N calls differing in one argument | `N` on **both** — the key is complete, no over-collapse |

In the VCST-5637 browsing run the browsing arms were flat 1→1 and 6→7 while the positive control in the
same windows went 4→1. That pairing is what licensed "browsing has no redundancy to remove" instead of
"the measurement is broken" — and the two readings recommend opposite engineering decisions.

## 8. Three more traps this method hit

1. **Your own discovery queries warm the targets you are about to measure.** The first replication read
   1 search/request across the board and looked like "already at the floor"; the categories had been
   enumerated by a discovery pass minutes earlier. Discover targets, then measure **different** ones — or
   measure first and discover later.
2. **Sampling is asymmetric between a busy env and an idle one.** A traffic-carrying env sampled at
   `itemCount` 2–8 while the idle baseline retained nearly everything, so the *fixed* side yielded ~1/4 the
   records for the same request volume. Budget 3–4× the volume on the busy side, and read `itemCount` per
   row rather than assuming parity.
3. **Prove the mechanism WITHIN one env.** Cross-catalog cells can always be argued with (different
   products, facets, index size). Holding build, query text and page size fixed and varying only the input
   property — here the variation profile — makes the causal claim without crossing environments at all.
   Do this *before* reaching for the cross-env delta.

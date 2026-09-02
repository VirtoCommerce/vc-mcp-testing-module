# VCST-5346 — Testing Checklist (Artifact B)

**Ticket:** VCST-5346 · [Missions][Frontend] Missions & Challenges · Story · Epic VCST-5320
**Path:** FULL · **Flow:** feature-test · `--iterate --max-rounds 2`
**Env:** vcst-qa @ Platform `3.1061.0`, Loyalty `3.1006.0-pr-14-da8a`, theme `2.57.0-pr-2396-80d1-80d1e3b9` (deployed = declared, asset `index-DI9BAQOT.js` verified in artifact), store `B2B-store` USD/en-US
**Build delta since the 2026-08-27 run:** exactly two commits — `5a677230` *feat: add currency code*, `80d1e3b9` *fix: register loyalty routes regardless of auth state*
**Fixtures:** `MSN_E2E_*` re-minted this run; handle in force is **`20260902085919-b156`** (the prior set was found consumed — recorded `InProgress 0%`, live `Completed 100%`; a later re-seed inside the 6 h sweep floor left stale missions colliding on reward attribution, so a full `--max-age-hours 0` sweep was required and the handle moved twice). Cases resolve the handle through `@td(MSN_E2E_RUN.run_id)`, so only this transcribed value was ever stale.
**Dual-currency fixture (added this run):** `MSN_E2E_PRODUCT_A` now carries a second price — `10 USD` / `34 EUR` — and is already a goal item of `MSN_E2E_PERSKU`, so it renders in that mission's featured-SKU modal. `MSN_E2E_PRODUCT_B` stays single-priced as the in-modal control (it renders `0 EUR` in an EUR session, which is what proves the reading was genuinely taken in EUR). The amounts differ deliberately: every currency on this platform is registered at `exchangeRate: 1`, so equal amounts would make a *converting* implementation indistinguishable from a correctly *selecting* one — 10/34 separates selection, 1:1 conversion and `AllPrices.FirstOrDefault()` from a single reading pair.
**Evidence:** `reports/tickets/Sprint26-17/VCST-5346/screenshots/`
**Test Model:** `reports/ba/test-models/VCST-5346-2026-09-02.md`

**Scope decision (operator, this run):** AC-1 is tested-around, not tested — see the AC-1 block below.

## AC-2 / AC-3 conditions

| # | Condition (atomic, observable) | Covering case | Verdict |
|---|---|---|---|
| 2.a | Card shows the mission's localized name | MSNF-011 (existing) | NOT-RUN |
| 2.b | Card shows the mission description | MSNF-011 (existing) | NOT-RUN |
| 2.c | Card shows the reward amount | MSNF-042/043 (existing) | NOT-RUN |
| 2.d | Card shows days remaining | MSNF-017 (existing) | NOT-RUN |
| 2.e | Card shows the goal **target** (not only amount spent) | **MSNF-077** (new) | NOT-RUN |
| 2.f | Modal shows the goal target | MSNF-042 (existing) | NOT-RUN |
| 2.g | Card progress value equals backend `currentValue` | MSNF-015 (existing) | NOT-RUN |
| 2.h | Untranslated locale → default-locale name, never the raw internal key | MSNF-068 (existing) | NOT-RUN |
| 2.i | Untranslated locale → description present, not dropped | MSNF-068 (existing) | NOT-RUN |
| 2.j | Goal amount and progress amount share one currency on a single card | **MSNF-075** (new) | NOT-RUN |
| 3.a | SKU modal lists each target SKU with its required quantity | MSNF-026 (existing) | NOT-RUN |
| 3.b | SKU modal "targets met" counter is correct | MSNF-025 (existing) | NOT-RUN |
| 3.c | Card and modal report the same progress on an unchanged cart | **MSNF-079** (new) · VCST-5824 open | NOT-RUN |
| 3.d | Every SKU-modal price equals that SKU's PDP price in the session currency | **MSNF-073** (new) — *the test for `5a677230`* | NOT-RUN |
| 3.e | SKU-modal cart subtotal sums one currency and is labelled with it | **MSNF-078** (new) | NOT-RUN |

## Gap conditions (no story AC — from 1d)

| # | Condition | Covering case | Verdict |
|---|---|---|---|
| G5 | Partially-successful payload still renders every mission that resolved | **MSNF-074** (new) — *VCST-5843 Done but fix absent from branch* | NOT-RUN |
| G6 | Anonymous `/account/missions` → sign-in with `returnUrl`, not 404 | **MSNF-072** `[JOURNEY]` (new) — *the test for `80d1e3b9`* | NOT-RUN |
| G6b | In-session sign-in reveals the Missions nav entry without a reload | **MSNF-076** (new) — *regression introduced by `80d1e3b9`* | NOT-RUN |
| G7 | Zero missions available → dedicated empty state, distinct from the error state | MSNF-007 (existing) | NOT-RUN |
| G8 | Zero-target / zero-reward / expired missions each render a defined state | MSNF-059 + 075d MSN-016 | NOT-RUN |
| G11 | Mission controls expose distinct accessible names; modal background hidden from AT | MSNF-046/047 (existing) · VCST-5826 open | NOT-RUN |
| G12 | 375 px SKU modal does not truncate product names | MSNF-023 (existing) · VCST-5831 open | NOT-RUN |
| G13 | Points-history row identifies its granting mission | **MSNF-080** (new) — BL-LOY-015 VIOLATED backend-side | NOT-RUN |

## Uncovered conditions — stated, not dropped

| Condition | Why uncovered |
|---|---|
| **AC-1a** — new-mission notification is displayed | **NOT IMPLEMENTED at either layer.** Backend emits no notification (0 `PushMessage`/`INotification`/`SendAsync`/template hits; manifest declares no notification dependency); the frontend PR adds no notification surface. Precisely designed in frames F4/F8. Operator decision: route to PO, do not fail this run's scope. |
| **AC-1b** — completion notification shows points awarded | Same. Designed in frame F5 (points total + per-mission breakdown + two CTAs). |
| **AC-1c** — a dismissed notification does not re-show | Unreachable while AC-1a/b are unimplemented. |
| **G1 / G2** — displayed progress vs `BL-LOY-016` (order total incl. shipping+tax, net discount) and `BL-LOY-017` (cash-currency lines only) | Backend accrual link (L1–L5), owned by sibling VCST-5319 (ran 2026-09-01, verdict FAIL). Out of this story's L6 display scope; a wrong number here is that ticket's defect, not this one's. |
| **G4** — cancelled order reverses its mission contribution | **BL-LOY-019 VIOLATED — the reversal mechanism does not exist in product.** Recorded so its absence is not mistaken for coverage; backend scope. |
| **G10** — mission progress under a B2B org switch: per-contact or per-org? | Undefined by the story. Needs a PO answer before it is testable at all. |
| **UIP-TABS / UIP-INPUT** | Named in the model, not authored this run. `MSNF-UIP-BACK-001`, `MSNF-UIP-EXPIRE-001` and `MSNF-UIP-STORAGE-001` already exist in 083c as Draft, so the gap is narrower than the previous model's — `UIP-BACK` was listed here in error and is in fact covered. |
| **`culture × currency` (model scenario #18)** | The model's Reduction keeps this cell explicitly (`AfterMediatorSend` formats top-level money by `CultureName` while product price resolves off `currencyCode`). Pending the Step-3 re-verify: if MSNF-075 does not gain a culture arm, this cell is uncovered and stays listed here rather than being claimed by the model. |
| Points-history row **currency** | Matrix cell `Points-history × L6c` is a declared `GAP` — no AC governs the page, so no case was authored for it. |
| **MSNF-073 EUR arm** — a mission featured-SKU priced in a second currency | **Fixture limitation, not a product gap.** The `AGENT-TEST-*` mission products are USD-only: an EUR session returns `€0.00` for every one of them, so the EUR arm cannot discriminate a correct implementation from a broken one. The general catalog *does* carry a partial EUR pricelist (e.g. `$349.00` / `€455.00` on the same SKU — the exact pair from the original VCST-5821 report), so the discriminating control exists in the catalog but is not wired to a mission. Closing this properly needs a dual-currency featured-SKU fixture; recorded as a follow-up, not run here. |

## Live API evidence captured at pre-flight (before browser execution)

Probing `loyaltyMissionProgress` directly at both session currencies on the deployed build:

| Observation | Result |
|---|---|
| USD session → featured-SKU prices | `$10.00`, `$42.50`, `$30.00`, `$99.00` — all `currency.code = USD` |
| EUR session → same rows | all `currency.code = EUR` (amounts `€0.00`, see the fixture limitation above) |
| Cross-currency leak (the VCST-5821 symptom) | **not reproducible** — no row's currency differs from the session currency |
| `errors[]` on a full nested `product` selection | **none** — the resolver that threw for VCST-5842 now resolves cleanly |

Two consequences carried into execution: the `5a677230` currency fix **does** propagate to the nested `items[].product` price (settling 1c's open source question in the fix's favour), and **MSNF-074 has no organic trigger on this build** — with VCST-5842 fixed, the partial-payload path is no longer reached by itself, so the absent `errorPolicy` is a **latent** defect needing a deliberate trigger to demonstrate, not a live outage.

### The BL-PRICE-005 line on MSNF-073 — what it actually tests

BL-PRICE-005 requires that a product with no price list in the selected currency **shows as unavailable**, not as a zero amount. Probed live on the single-priced control `MSN_E2E_PRODUCT_B`:

| Session | Price | `availabilityData` |
|---|---|---|
| USD | `$10.00` | `isAvailable=true · isBuyable=true · isInStock=true` |
| EUR | `€0.00` | `isAvailable=false · isBuyable=false · isInStock=false` |

So **the platform already signals unavailability correctly** — the invariant is satisfied at the data layer, and `€0.00` is just the price field carrying no meaningful value. The mission query at `80d1e3b9` **does select `availabilityData`** (via the shared `availabilityData.graphql` fragment), so the modal holds the flags it needs.

That makes this line a real, undecided UI check rather than a foregone red: does `sku-mission-modal.vue` **honour** those flags — presenting the row as unavailable with no active stepper or add-to-cart — or does it render a buyable-looking `€0.00` row? If the latter, the finding is mission-modal-specific and **in scope**; if the row is correctly disabled, the assertion passes and no finding exists. Either way this is not the storefront-wide "EUR prices are zero" env condition, which is a data fact about the pricelist and not a defect of this ticket.

## Findings held below the 5d severity floor

*(filled at 5d — `Low`/P3 findings keep their `reports/bugs/open/` draft and are named here because on any run this file is the durable record)*

`Not filed (below severity floor): ` — **to be completed at 5d**

## Regression scope (Artifact C)

`083c`, `083d`, `075d` · `--cases critical --also-ids MSNF-072..MSNF-080` · no `--target` time trim (operator decision).
Narrowed from the selector's fail-open 62-suite / 392-min set on 1c's source evidence that the shared `client-app/core/api/graphql/types.ts` change is inert (one doc-comment reword plus one optional loyalty-only input field, both TypeScript-only). **Every suite dropped by that narrowing is named in the Step-5 report's Scope Exclusions.**

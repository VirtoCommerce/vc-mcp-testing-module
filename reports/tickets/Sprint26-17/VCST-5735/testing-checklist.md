# Testing checklist — VCST-5735 "Update compare products design"

**Path:** FULL (Story) · **Flow:** feature-test · **Env:** vcst-qa — theme `2.57.0-pr-2452-d1e4-d1e45b04`
(PR #2452, **open**), Platform `3.1063.0` · **Model:** `reports/ba/test-models/VCST-5735-2026-09-03.md`

> The ticket declares **no acceptance criteria** (`1. No requirements.`) and no DoD. Conditions below are
> derived from the 11 description bullets + the readable Claude Design prototype + the PR diff. The
> verdict is therefore scoped to a specification the ticket does not contain — stated here, and again in
> the 5e report, so nobody reads a PASS as "it matches an agreed spec".

## Functional conditions

| # | Condition | Case | Verdict | Evidence |
|---|---|---|---|---|
| 1 | End-to-end: add 2 products from catalog → correct tabs → Differences → pin → add to cart → cart holds the line | CMP-001 `[JOURNEY]` | NOT-RUN | |
| 2 | Table settles and stays interactive with divergent quantity constraints (3x: no loop symptom; **prod build, so the dev-only warning could not appear either way** — the source-level pattern is unsettled) | CMP-002 | NOT-RUN | |
| 3 | Clear category **and** Clear all are reachable below `md` (375 px) | CMP-003 | NOT-RUN | |
| 4 | A sixth add in a full category is refused with a message and the badge is unchanged (3x: clamp enforced at ADD time — the ghost state is unreachable via the UI) | CMP-004 | NOT-RUN | |
| 5 | Clear all is confirmation-gated; Cancel changes nothing; Restore returns the exact pre-clear list (3x: the predicted duplicate race is structurally impossible) | CMP-005 | NOT-RUN | |
| 6 | A single-product tab disables the Differences toggle and reports a coherent row count (3x: no empty board; counter reads "Differ: 0 of 15" above 15 rendered rows) | CMP-006 | NOT-RUN | |
| 7 | Removing the middle column of three removes only that product | CMP-007 | NOT-RUN | |
| 8 | A pre-v2 compare list in localStorage resolves to a clean empty state | CMP-008 | NOT-RUN | |
| 9 | 3 products at 375 px: label column locked, document does not scroll, names legible | CMP-009 | NOT-RUN | |
| 10 | Differences does not surface a row whose two cells render identically (3x: `differs` compares **RAW** values — inverted from the source reading; two `9999+` cells counted as differing) | CMP-010 | NOT-RUN | |
| 11 | Parent-category and child-category products do not yield two identically-labelled tabs | CMP-011 | NOT-RUN | |
| 12 | A configurable product offers a customize link, never an inert add-to-cart | CMP-012 | NOT-RUN | |
| 13 | A failed configured-price lookup does not silently show the base price | CMP-013 | NOT-RUN | |
| 14 | Add to cart from the table honours MOQ and pack size (assert the **rendered cart**) | CMP-014 | NOT-RUN | |
| 15 | Switching organization does not carry the previous org's comparison and prices | CMP-015 | NOT-RUN | |
| 16 | Two configurations differing only in a file section stay separate entries | CMP-016 | NOT-RUN | |
| 17 | Two configuration sections sharing a display label render as separate rows | CMP-017 | NOT-RUN | |
| 18 | Switching currency refreshes prices or states they are unavailable | CMP-018 | NOT-RUN | |
| 19 | An add/remove in one browser tab updates an open compare page in another (3x net-new: sync is live, not reload-gated) | CMP-019 | NOT-RUN | |
| 20 | The per-tab counter and the global nav badge stay mutually coherent (3x net-new: "3 of 5 in Laser Printers" beside a badge of 7) | CMP-020 | NOT-RUN | |

## Visual axis (`visual_surface: true`) — design + accessibility

Design source: the Claude Design prototype (`ui_kits/storefront/CompareScreenV2.jsx`), read live and
extracted to the scratchpad. The root `Compare v2 - standalone.html` is a **bundled** prototype whose
declared values are not statically extractable → recorded `unresolved`, not guessed at.

| # | Condition | Invariant / axis | Blocks? | Verdict |
|---|---|---|---|---|
| V1 | No layout shift across the sticky full→compact header morph | BL-UI-003 | yes | NOT-RUN |
| V2 | Document does not scroll horizontally at 375/768/1920; only the table's own scroller does | BL-UI-004 | yes | NOT-RUN |
| V3 | Row cells share height; columns stay aligned between the header and body tables | BL-UI-005 | yes | NOT-RUN |
| V4 | Interactive controls meet the touch-target floor at 375 px | BL-UI-006 | yes | NOT-RUN |
| V5 | Keyboard: every control reachable, visible focus, no trap | BL-A11Y-001 | **no — files separately** | NOT-RUN |
| V6 | Accessible names on icon-only controls (remove, pin, boolean glyphs) | BL-A11Y-002 | **no — files separately** | NOT-RUN |
| V7 | Contrast ≥ 4.5:1 / 3:1 on the Coffee and Red gated themes | BL-A11Y-003 | **no — files separately** | NOT-RUN |
| V8 | axe-core: zero Critical/Serious; table exposes product↔attribute association | BL-A11Y-004 | **no — files separately** | NOT-RUN |
| V9 | Live custom properties match the generated design tokens (no literals) | design-system | yes | NOT-RUN |
| V10 | `vs. DESIGN` diff against the prototype's declared geometry and copy | spec diff | **no — advisory** | NOT-RUN |

**Known divergences already established — advisory, never failures:** the prototype derives categories
from a hardcoded title/vendor regex while the implementation uses breadcrumbs, so **tab labels will not
match the prototype and that is expected**; the prototype renders a `Share` button that the
implementation omits (the ticket never asked for one); the prototype's own row component renders neither
the "dot + amber fill" its header comment promises nor anything `differs`-driven, so the **diff marking
has no reliable design oracle** and is `UNSPEC`, not DRIFT.

## Existing-coverage triage (Step 2a) — 13 rows, all in `Frontend/catalog/002-product-detail.csv`

All 13 are `FILTERED_OUT` under `--cases critical` (**zero would run**), and none has ever been audited.

| Disposition | Cases | Action |
|---|---|---|
| CONFIRMED (still true) | CAT-030, CAT-COMP-001, CAT-COMP-007 | none |
| **RE-BASE** (expected value conflicts with v2) | CAT-031, CAT-032, CAT-034, CAT-COMP-002, CAT-COMP-006, CAT-COMP-009 | carried into **C1 `--ids`**; rewritten at 5a with the run's own evidence, **not** before it |
| **REPAIR** (mechanics only — a "compare bar" that does not exist) | CAT-033, CAT-COMP-003, CAT-COMP-005, CAT-COMP-008 | **deferred to `/qa-review-tests file 002 --fix`, not hand-edited here** — see below |

**Why the REPAIRs were deferred rather than applied inline.** The rule fixes a `REPAIR` before the run so a
stale row cannot manufacture a BLOCKED that reads as a product failure. These four never execute in this
run's scope (all `FILTERED_OUT`), so they can manufacture nothing — and the staleness is **pre-existing**,
not caused by VCST-5735: the phrase appears **28 times** in the file, and two of those occurrences
(`CAT-030`, `CAT-COMP-002`) are the *correct* assertions that no compare bar exists, so a blanket edit
would corrupt the very rows that are right. Against that, `suites:lint`/`sync` hard-fail on a parse error
anywhere in the corpus, and **8 peer sessions are live in this tree** — a mid-write invalid CSV takes every
author's gate down (measured previously at ~15 minutes). Routing the fix to its owning mechanism is the
lower-risk, scope-correct call. Recorded in `summary.json.coverage_triage`, not silently dropped.

Two **pre-existing** defects found here, neither caused by this ticket:
- `CAT-030`–`CAT-034` all cite **`BL-CAT-007`**, which is *"Multi-FFC inventory aggregation"* — false
  traceability. `bl:lint` cannot see it because the ID resolves. → `/qa-review-tests` Dim 6.
- `CAT-COMP-003/005/006/008/009` assert a *"compare bar"* that `CAT-030` in the same file explicitly says
  does not exist. The suite contradicts itself, and did so before this PR.

## Uncovered / not attempted — stated, not omitted

**Step 3x closed at its box with four charter items unreached. These are unexplored, NOT clean:**
- **The sticky header collapse and any overlap with the site header were never probed** — and this is the
  v1 regression surface the ticket exists to fix (`overflow:hidden` on an ancestor killing
  `position:sticky`). Source-checked ancestors are clean, but the app layout could not be read statically.
  Carried into Step 4's visual lane as V1's first obligation.
- The legacy-payload migration (8), the parent-vs-child tab collision (11) and the org switch (15) were
  not reached and remain `{HYPOTHESIS}` — they are authored as such, and a PASS on them at Step 4 is the
  first real evidence either way.

- **`PROD_CMP_NOCAT`** (a product with zero Category breadcrumbs → the `uncategorized` tab): only
  testable if such a product exists in this catalog. If 3a cannot build one, condition 11's zero-category
  half is **uncovered** and says so rather than passing by absence.
- **Screen-reader output** and 5 of the 6 WCAG 2.2 additions remain manual-only and are **never reported
  as PASS** here.
- **Currency (18)** may be BLOCKED rather than FAIL on this env — vcst-qa has no EUR product pricelist,
  so a EUR switch renders `0.00` for reasons unrelated to this ticket.
- **`td:validate` exits 1** on a PRE-EXISTING unrelated break (`@td(ADDR_NY.*)` in smoke suite `042` is
  invalid syntax). Recorded, not fixed here, and it does not gate this ticket.

## Findings held below the 5d severity floor

_To be completed at 5d. A `Low`/P3 finding is not filed to the tracker but its `reports/bugs/open/low/`
draft path is listed here — on any path this file is the only durable record that it was found at all._

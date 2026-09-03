# AC ↔ implementation — VCST-5735 "Update compare products design"

**Ticket type:** Story · **Path:** FULL · **Env:** vcst-qa @ theme `2.57.0-pr-2452-d1e4-d1e45b04`
(vc-frontend PR #2452, **open**), Platform `3.1063.0` · **Written:** 2026-09-03

> **Written retroactively, and the reason matters.** `ac-analysis.md` was terminal-only when this run
> executed, so 1d's output died with its own step: of **19 `NOT-FOUND`** predictions, exactly **one**
> became a test case (CMP-003), and eighteen are **unrecoverable without re-running 1d**. The five unbuilt
> promises the 5b verifier found live are almost certainly among those eighteen — predicted, dropped,
> rediscovered the expensive way. That measurement is why the file is now persisted
> (`.claude/rules/reports.md` §1).
>
> **This file is reconstructed from the ticket's own description plus what was measured**, not from 1d's
> lost output. Rows are marked with their evidence source; nothing here is inferred.

## Where the specification lives

**In the description.** There is **no acceptance-criteria field** on this ticket — and an earlier version
of this run's artifacts claimed that field read `1. No requirements.`, which is **false**: that string
appears nowhere on VCST-5735. Retracted on the ticket (comment 108215). The description's **ten** bullets
are the spec, and several carry directly measurable criteria.

## Per-bullet verdict

| # | Bullet | Measurable criterion in the prose | Verdict | Evidence |
|---|---|---|---|---|
| 1 | Category tabs with counts | per-category split; counts | **SATISFIED** | CMP-009/011 |
| 2 | Sticky header collapses full → compact | v1's `overflow:hidden` no longer disables sticky | **SATISFIED** (the v1 defect is fixed: clip-chain clean, `overlapPx = 0` at 1920/768/375) | visual axis V1 |
| 2 | …the morph itself | — | **DRIFT** — collapsing removes 144px of document height mid-scroll; never fires below `md` | **VCST-5874** |
| 3 | "Differences only" filter | *"hiding, not just highlighting"* | **SATISFIED** — it hides | CMP-006 |
| 3 | …differences marked with a dot + soft amber row fill | dot; amber fill | **NOT BUILT** — pure index zebra | **VCST-5872** |
| 4 | Pin rows to top | *"shown even in Differences only mode"* | **PARTIAL** — pinning works at ≥`md`; the pin control is `display:none` below it, so the criterion is untestable there | **VCST-5871** |
| 5 | Simplified product cards | compact card replaces v1's card with qty stepper | **SATISFIED** | CMP-024 |
| 6 | Empty rows auto-hidden | rows with no value for any product removed | **SATISFIED** — 9 rows → 5 | 5b verifier |
| 7 | Tooltips on real terms | mobile: opens as a **bottom sheet** | **NOT BUILT** — the info trigger is absent from the DOM at 375px | **VCST-5873** |
| 8 | Add/remove/clear flow | *"+ Add slot to restore removed items"*; *"Clear category behind a confirmation dialog"* | **PARTIAL** — no add affordance renders at 0 < N < 5; Clear controls hidden below `md` | CMP-024, **VCST-5871** |
| 9 | Locked label column + 2 product columns per viewport | 2 columns per viewport | **PARTIAL** — label column locked and document does not h-scroll (CMP-009 PASS); **the 2-columns-per-viewport half is NOT asserted by any case** | gap |
| 9 | Horizontal-scroll indicator (peek/arrow) | — | **NOT BUILT** | **VCST-5873** |
| 9 | Scroll-snap | — | **NOT BUILT** — `scroll-snap-type: none` on both scrollers | **VCST-5873** |
| 9 | **≥44px touch targets** | **≥44px** | **CONTRADICTS** — pin 26×26, remove 32×32, cart 38×38, tabs 32, All/Differences 32; gap 2px vs 8px min | **VCST-5882** |
| 9 | Duplicate "Add to cart" CTA at the bottom | — | **NOT BUILT** | **VCST-5873** |
| 9 | Secondary actions in an overflow (⋯) menu | — | **NOT BUILT** — and the controls it should carry are CSS-hidden | **VCST-5871** |
| 10 | Booleans as check/minus icons **rather than text** | *rather than text*; **minus** glyph | **DRIFT** — ships icon *and* text; negative glyph is a cross | below floor, `open/low/` |

## The one that was nearly lost, and how

Bullet 9's **≥44px** is a number the ticket states outright. It was graded against `BL-UI-006`'s two-tier
rule — under which 26/32/38px are the UI kit's deliberate sizes and therefore a *design-system tradeoff* —
by this session **and** by an independent peer session, and **neither read the ticket**. An in-scope
requirement violation was one approval away from shipping as an accessibility advisory that blocks nothing.

Precedence, now written into `/qa-test` 1d: **ticket-stated number > BL invariant > design spec > UX
heuristic.** An internal invariant's tolerance band describes what a design system may trade off; it cannot
excuse a figure the ticket specifies.

## Gaps in this run's own coverage
- **Bullet 9, "2 product columns per viewport"** — no case asserts the column count at any viewport.
- **Bullet 2, morph CORRECTNESS** — only the resulting shift was measured, never that full → compact
  renders the specified compact card (thumbnail + name + price + cart/remove).

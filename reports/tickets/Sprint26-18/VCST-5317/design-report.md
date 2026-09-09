# VCST-5317 — Visual / a11y / design-system lane (`/qa-test` Step 4v)

**Surface:** organization switcher inside the Account-menu popover (`listbox "Organizations"`), `{FRONT_URL}`
**Build:** `Ver. 2.58.0-pr-2469-83d6-83d6e5d5` (confirmed in footer before and after every state)
**Browser:** Chrome DevTools MCP, 1920×1080 · **Live preset:** Red (`--color-primary-500: #e52121`) — a WCAG-gated preset
**States driven:** V2 (one locked, non-active org) · V7 (ALL locked → `/403`) · teardown → V1
**Scope:** `critical-ui-scope.md` #11 Header, #19 VcDropdownMenu, #6 Popover. Desktop-only (see F-U2).

## Verdict per axis

| Axis | Verdict | Basis |
|---|---|---|
| **a11y** (WCAG 2.2 AA + `BL-A11Y-001..004`) | **FAIL** | F-A1 (1.4.11), F-A2 (1.4.13 / APG), F-A3 (4.1.2) |
| **design-system** | **PASS** | 0 off-grid values; every colour resolves to a token |
| **`vs. DESIGN`** | **SKIPPED** | Ticket carries no Prototype link; no global default project (`DESIGN_SYSTEM_PROJECT_ID` removed 2026-09-03). A skip is not a pass. |
| **`BL-UI-001..006`** | **PASS** (001 not instrumented) | table below |

## Finding F2 — **REFUTED**

Discovery-session F2 claimed the disabled row exposes *"no accessible name and no tooltip node"*. It does:

```
option "AGENT-TEST-Org-TechFlow-20260310"
  description="This organization is locked. Contact your administrator for access."
  disableable disabled selectable aria-selected="false"
```

DOM: `<button disabled title="This organization is locked. Contact your administrator for access."
role="option">`. The `title` becomes the **accessible description**, so the locked state *is* programmatically
determinable (**4.1.2 PASS**) and the reason *is* in the a11y tree (**1.1.1 PASS** — the padlock is
`aria-hidden="true"`, so it is decorative-redundant, not the sole carrier). The row is still announced as an
`option` inside the listbox — not silently dropped. **axe-core 4.10.2 reports zero violations on the switcher.**

F2's *observation* was nevertheless real, for a different cause — see **F-A2**.

## Findings

| ID | Sev | Ref | Finding |
|---|---|---|---|
| **F-A1** | **High** | WCAG **1.4.11** | Keyboard focus ring on the switcher options is `outline: 2px solid color(srgb .898 .129 .129 / 0.3)` with `outline-offset: -2px` (drawn inside, over the white row). Composited over the effective background → **1.63:1**; elsewhere in the popover alpha `0.4` → **1.93:1**. Required **≥3:1**. `:focus-visible` confirmed true under real `Tab`. Ring colour is `--color-primary-500` at alpha, so this is **preset-dependent and site-wide** — pre-existing, **not** introduced by PR #2469. |
| **F-A2** | **Medium** | WCAG **1.4.13**; ARIA APG listbox | The locked reason is delivered **only** as a native `title` tooltip, and that tooltip is **shadowed by a nested `title`**: the inner `div.vc-radio-button` carries `title="<org name>"` and occupies **82.8%** of the 256px row. `elementFromPoint` + title-resolution across 8 sample points: **6/8 points return the org name**, only the ~26px icon strip (~10% of the row) returns the lock message. Compounding it, the row uses native `disabled` (not `aria-disabled`), so it is **removed from the tab order** — measured: Tab goes user-link → Logout → BuildRight option → *straight past the locked row*, `lockedOptionIsActive: false` while still in the DOM. `tabindex="0"` on that button is dead code. Net: a keyboard-only sighted user can **never** see the reason; a mouse user only sees it by hovering the padlock. A native `title` also fails 1.4.13 Hoverable/Persistent (auto-dismisses, cannot be hovered). |
| **F-A3** | **Medium** | WCAG **4.1.2** | V7: `role="listbox" aria-label="Organizations"` contains **0 of 2 focusable options** — every option is natively `disabled`, and neither the listbox nor the options carry `aria-disabled`. The widget is exposed to AT as an operable listbox while being wholly inert, with no programmatic state saying so. |
| **F-U1** | **Medium** (UX) | Nielsen #1 Visibility, #9 Recovery | V7 all-locked dead-end. The popover renders only two greyed org names — `popoverCopy` is literally `"AGENT-TEST-Org-BuildRight-20260310 AGENT-TEST-Org-TechFlow-20260310"`, **no empty state, no explanatory copy** (`hasEmptyState: false`). `aria-selected="true"` sits on a **disabled** option (the active org). The header still advertises `AGENT-TEST-Org-BuildRight-20260310` as the current org although that membership is locked. `/403` copy is generic — *"You do not have permissions to access the requested page"* — and never mentions a locked organization, even though the string exists in 13 locale files. Mitigating: Logout is present in the popover and `/403` offers a HOME PAGE link, so it is not a total trap. |
| **F-U2** | **Medium** (parity) | AC-1 | **Mobile has no lock indication whatsoever.** At ≤500px the account menu is replaced by the hamburger, which renders the current org as **non-interactive text** (plain `<span>`, `interactive: false`), with `orgListbox: false` and **`lockIcons: 0`**. In V7 — where the *active* org is locked and every route 403s — the mobile header shows a normal-looking org name with no padlock, no tooltip and no disabled state. AC-1's rendered "Locked label" has no mobile equivalent. |
| **F-X1** | **Low** (out of scope) | WCAG 1.4.3 | Incidental, found by the same axe pass: Builder.io CMS block `"shop now"` — `#ffffff` on `#d84786` = **4.06:1**, needs 4.5:1. Editorial/CMS content, unrelated to PR #2469. |

## Explicit NON-findings (do not re-file)

- **Disabled row text and padlock stroke are `#a3a3a3` on white = 2.52:1 — EXEMPT.** WCAG 1.4.3 and 1.4.11 both
  exempt inactive UI components, the `disabled` attribute is genuinely present and exposed, and axe agrees
  (0 violations). This is the real-exemption case, not the phantom node of
  `feedback_unexposed_disabled_inflates_contrast_count`.
- `#a3a3a3` **is** `--color-neutral-400`: token-driven, not a hardcoded literal.
- Group header *"Organizations"* = **7.49:1** (PASS).
- 6 axe `incomplete` items, all *"background could not be determined because overlapped by another element"* —
  an artefact of measuring with the popover deliberately open, not a defect. Manual-verification only.

## `BL-UI` invariants

| Invariant | Result | Measurement |
|---|---|---|
| BL-UI-001 no shift on initial render | **not instrumented** | CLS observer was not installed before first paint; not claimed as a pass |
| BL-UI-002 spacing on derived grid | **PASS** | 250-element sweep of the popover subtree → **0 off-grid**. `padding: 4px 12px`, `gap: 6px`, row `h: 48` — all in `SPACING_GRID_PX` (read this session from `scripts/lib/design-tokens.generated.ts`) |
| BL-UI-003 no state-induced shift | **PASS** | 8 header probes, popover open vs closed: **Δtop/Δleft = 0.00px on all 8**; banner height 40→40; `scrollWidth` 1905→1905. Popover overlays, never displaces (#6 satisfied) |
| BL-UI-004 content stays in container | **PASS** | `scrollWidth 1905 ≤ innerWidth 1920`; no `overflow:hidden` clipping in the subtree; at 500px `485 ≤ 500` |
| BL-UI-005 aligned groups | **PASS** | Both rows `256×48`; centres 147.5 / 195.5 (exactly 48 apart); padlock centre 195.5 == row centre 195.5 → **0px drift** |
| BL-UI-006 / WCAG 2.5.8 targets | **PASS** | Both options `256×48` — clears the 24×24 AA gate and the 44×44 mobile guidance |

Keyboard extras: **Escape closes the popover and returns focus to the Account-menu trigger** (2.1.2 / 2.4.3 PASS).

## Caveats

- **Coffee preset not exercised.** The storefront resolves its preset from store config, not a user control;
  the live value was Red (`#e52121`). Coffee is **SKIPPED**, not PASS, on this surface.
- **Dark mode not exercised.** The `Theme: light` toggle did not apply (`data-theme` stayed `null`, background
  stayed `#ffffff`); recorded as not-applied rather than a dark-mode pass.
- **375px unreachable.** The Chrome window clamps at 500px minimum on this lane, so F-U2 was measured at 500px.
- Native `title` tooltips are OS-level widgets and do not appear in CDP screenshots; F-A2's evidence is the
  `elementFromPoint` title-resolution probe, which is how the browser itself resolves the tooltip.

## Evidence

`reports/tickets/Sprint26-18/VCST-5317/screenshots/`
- `V2-account-popover-org-switcher-1920-light.png` — V2, one locked row with padlock
- `V2-keyboard-focus-on-enabled-option-ring-1.63to1.png` — F-A1, real `Tab` focus ring
- `V7-403-page-all-locked-1920.png` — F-U1, generic `/403` copy
- `V7-all-locked-switcher-dead-end-1920.png` — F-U1/F-A3, every row disabled incl. the selected one

## Lane state

`--teardown` run; frontend lane back at V1 with **`zero residue confirmed`**. V6
`IMPERSONATE_TARGET_BLOCKED` intact and untouched. `:verify` exits `VERIFY FAILED: 2 locked leg(s)` — both are
on **`--lane backend`** (`MULTI_ORG_TF_BR`, still at V7), which belongs to the parallel agent and was
deliberately not touched. **My lane is clean.**

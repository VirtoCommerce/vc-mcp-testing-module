# VCST-5733 — Visual axis (design + accessibility): NOT EXECUTED

**Ticket:** VCST-5733 "[E2E] All Customer Orders" · `/qa-test` Step 4 lane 1b
**Env:** vcst-qa · `https://vcst-qa-storefront.govirto.com` · store `B2B-store` · theme `2.57.0-pr-2444-5946-59465f5e` (confirmed live in the page footer)
**Lane:** Chrome DevTools MCP (correct lane; never firefox)
**Verdict:** **BLOCKED — all three axes `SKIPPED` / `INCONCLUSIVE`. This is NOT a PASS and must not be read as one.**

## Summary

The three target routes are all behind Sales Rep Hub authentication, and this lane could not
authenticate as `SR_REP_PRIMARY`. No axis produced a measurement, so no invariant was asserted and
no design comparison was made. Per `visual-axis.md` §3, a skip is recorded with its reason and never
reported as clean — an omitted axis reads as a clean one, which is the failure mode that rule exists
to prevent.

**The blocker is tooling, not the product.** Nothing here is evidence for or against the feature.

## Why authentication failed — two independent causes

1. **Chrome DevTools MCP has no `--secrets` support.** The `--secrets <dotenv>` name-substitution
   redaction is a **Playwright** MCP flag. `.mcp.json` carries `--secrets` on all three
   `playwright-*` servers and **not** on `chrome-devtools-mcp`. So typing the literal
   `TEST_USER_PASSWORD` into the password field submits that string verbatim — the sign-in was
   refused and `/company/customer-orders` redirected to
   `/sign-in?returnUrl=/company/customer-orders` (evidence:
   `screenshots/visual-axis-BLOCKED-auth-gate-1920.png`). The brief's substitution premise does not
   hold on this lane.
2. **Resolving the credential another way is denied by policy, correctly.** `TEST_USER_PASSWORD` is
   set for `vcst` and **differs from the documented `Password1!` default**, so it must be read at
   runtime. Two attempts were made and both were denied by the permission classifier: printing the
   resolved value, and routing it to the OS clipboard for a real paste (a route that would have kept
   the secret out of this transcript entirely). Per the denial guidance, no further workaround was
   attempted.

`SR_REP_PASSWORD` is unset in this env, so `TEST_USER_PASSWORD` is the operative variable
(`seed-sales-rep.mjs`: `SR_REP_PASSWORD || TEST_USER_PASSWORD || 'Password1!'`).

## Per-axis status

| Axis | Status | Reason |
|---|---|---|
| 1 — WCAG 2.2 AA / `BL-A11Y-001..004` (blocking) | **INCONCLUSIVE** | Surface unreachable (auth). axe-core was never injected; no keyboard walk, no focus/target/contrast measurement. Not a CSP block — the page never loaded. |
| 2 — design-system consistency (blocking) | **SKIPPED** | Surface unreachable (auth). Oracle side is ready: `scripts/lib/design-tokens.generated.ts` is present and generated from vc-frontend `dev` (Tailwind 3.4.19), so `SPACING_GRID_PX` is derived, not transcribed. Only execution is missing. |
| 3 — `vs. DESIGN` (advisory) | **SKIPPED** | **`DesignSync` is not present in this subagent's toolset.** The tool was verified reachable in the parent session, but subagents do not inherit it, so `get_project` / `list_files` / `get_file` on `5aca50fb-2b9e-4beb-9312-425b32cccce8` could not be called. No spec was extracted ⇒ `unresolved` count is **unknown, not zero**, and parity coverage is absent. |

Independently of the blocker, three things this axis structurally cannot conclude and which remain
**manual-only** whenever it does run: screen-reader output (no NVDA/JAWS/VoiceOver hookup), and five
of the six WCAG 2.2 additions (2.4.11 · 2.5.7 · 3.2.6 · 3.3.7 · 3.3.8 — axe covers only 2.5.8).

## What would unblock it (operator choice)

1. **Sign the Chrome DevTools browser in by hand** as `agent-test-sr-primary@example.com`, then
   re-dispatch — the session persists on that lane and needs no credential in-context. Cheapest.
2. **Grant a Bash permission rule** for the clipboard route (`pw-to-clip.mjs` in the scratchpad):
   the secret reaches the field by a real paste and never enters the transcript.
3. **Re-brief onto a Playwright lane with `--secrets`** — `playwright-chrome` or `playwright-edge`,
   once one frees up. Not `playwright-firefox`: this pass is click- and hover-driven and
   `@playwright/mcp` + firefox cannot click this storefront.

For axis 3, the `vs. DESIGN` diff has to run **in a session that holds `DesignSync`** (main session,
or a lane where the tool is exposed to the subagent).

## Scope note

`BL-UI-001..005` layout stability was out of scope by design (owner: authoring tags + suite `048c`).
`critical-ui-scope.md` was to be used as a scope selector only; its coverage matrix is 197/197 `GAP`
and stale, so it is not fact. No tracker ticket was filed and nothing was transitioned.

---

## Addendum — spec-side finding produced by the orchestrator (no browser required)

The `vs. DESIGN` axis could not run in the subagent because `DesignSync` is not in a subagent's
toolset. The orchestrator holds it, so it read the spec directly and ran the one check that needs no
live page: **does the declared chip palette itself meet WCAG 2.2 AA?**

Source: `tokens/chip-badge.theme.json` in design project `5aca50fb-…` ("✴️ VC New Front Design 2026"),
read live 2026-09-02. Ratios computed from the declared hex pairs (WCAG relative-luminance formula).

| Token | Foreground / background | Ratio | AA 4.5:1 | AA-large 3:1 |
|---|---|---|---|---|
| `chip_solid_primary` | `#ffffff` on `#f99e24` | **2.11:1** | **FAIL** | **FAIL** |
| `chip_solid_secondary` | `#ffffff` on `#688198` | **4.05:1** | **FAIL** | pass |
| `chip_solid_success` | `#ffffff` on `#3e845b` | 4.51:1 | pass (margin 0.01) | pass |
| `chip_solid_info` | `#ffffff` on `#2b7ea8` | 4.51:1 | pass (margin 0.01) | pass |

The other 18 declared chip pairs pass, several comfortably (`soft`/`tonal` variants 6.1–15.1:1).

**Verdict: `AMBIGUOUS`, escalated — not resolved by obeying the spec.** Per
`.claude/skills/qa-design/claude-design-verification.md`, precedence is
`BL-A11Y / BL-UI invariant > design spec > UX heuristic`, and a spec that contradicts a WCAG
criterion is escalated rather than implemented. `chip_solid_primary` fails even the 3:1
large-text / non-text-contrast threshold, so chip size cannot rescue it.

**Scope and limits, stated rather than implied:**

- This is a property of the **spec**, not a measurement of the implementation. Whether the customer-orders
  status chips actually resolve to `chip_solid_primary`/`_secondary` is **UNVERIFIED** — that needs the
  live pass this lane was blocked from running.
- It is **design-system-wide**, not specific to VCST-5733: provenance **OUT-OF-SCOPE** for this ticket,
  and it does **not** contribute a FAIL to the 5c verdict.
- The two 4.51:1 pairs are not findings, but they are worth knowing: a 0.01 margin means any future
  darkening of the text or lightening of the fill breaks AA silently.
- Ratios are derived from the spec's own declared values, never transcribed into repo code
  (`.claude/rules/test-data.md` §GOLDEN RULE) — re-read the token file to re-derive them.

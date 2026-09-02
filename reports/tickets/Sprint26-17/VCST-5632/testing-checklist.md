# VCST-5632 — Testing Checklist

**Path:** fast · **Flow:** feature-test · **Type:** Task (P2/Medium)
**Env:** vcmp-dev Vendor Portal — serves `@vc-shell/framework` **2.5.0**, build id `16355`, `last-modified` 2026-08-26 13:31:42 GMT
**Verdict: BLOCKED (deploy gate)** — the four sub-task fixes are on `main` but in **no released version**, so no AC is live-verifiable on this environment.

## Deploy gate — why this run did not execute live

| Check | Result |
|---|---|
| Served framework version | `"2.5.0"` in `vc-shell-framework16355.js` **and** `vc-shell-vendors16355.js` |
| App build time | 2026-08-26 13:31:42 GMT — identical build to the 2026-08-26 QA run |
| PRs #343–#347 merged | 2026-09-01 14:22–14:23Z (six days *after* the served build) |
| `git merge-base --is-ancestor <fix> v2.5.0` | **fails for all five** — ahead by 29–33 commits |
| npm `@vc-shell/framework@latest` | still `2.5.0`; the fixes exist only as per-PR prereleases `2.5.0-pr343…pr347` |

Re-running the live checklist here would reproduce the original failures and manufacture a false REOPEN
against a release lag. `/qa-deploy-pr` does **not** apply: `vc-shell` has no deploy workflow and vcmp-dev
is redeployed manually behind a caret-ranged framework pin.

## Conditions

Substituted instrument: the fixes' own unit tests at `main`, with a **v2.5.0 source revert as the dated RED
baseline** (test files held at `main`). This proves each fix's *mechanism*; it is **not** a live-behaviour
verdict, and it does not discharge any AC that requires the running app.

| # | Condition | Verdict | Evidence |
|---|---|---|---|
| AC-1 | Focus never `<body>` after the 5 transitions | **NOT-RUN (env)** | owned by VCST-5670; code-level proof there |
| AC-2 | Escape / close (X) / Cancel → opener | **NOT-RUN (env)** | passed 3/3 on 2.5.0 (2026-08-26); unchanged by these PRs |
| AC-2 | Popup opened while focus already loose → fallback | **PASS (code only)** | RED→GREEN `usePopup.test.ts:425` + `:458`, `vc-app.test.ts:244` (#346 / VCST-5814) |
| AC-2 | Backdrop click → opener | **BLOCKED (tooling)** | backdrop centre covered; not measured on 2.5.0 either — still unmeasured |
| AC-3a | Nothing behind a maximized blade Tab-reachable | **NOT-RUN (env)** | passed on 2.5.0 (complete boundary proof) |
| AC-3a/3b | Teleported `VcPopover` escapes `inert` | **PASS (code only)** | RED→GREEN `vc-popover.test.ts:110`, `DesktopLayout.test.ts:156` (#345 / VCST-5815) |
| AC-3a | Mobile slide-out sidebar + maximized blade | **BLOCKED** | state not constructible on this build; unchanged |
| AC-3b | Not exposed to the accessibility tree | **NOT-RUN (env)** | needs the scoped `axe.run` A/B — ARIA snapshot does **not** model `inert` |
| AC-4 | Modal traps focus | **NOT-RUN (env)** | passed on 2.5.0 (HeadlessUI) |
| AC-4 | Maximized blade traps focus | **NOT ADJUDICATED** | implementation deliberately contradicts the AC as written — see below |

## Uncovered conditions, stated explicitly

- **Every env-dependent AC is NOT-RUN**, not passed. Nothing above may be read as a live verdict.
- **AC-4 remains an open product decision, not a QA finding.** The 2026-09-01 comment argues a maximized
  blade is met *through* `inert` rather than a trap, and that trapping a non-modal region would be a WCAG
  2.1.2 (Level A) keyboard-trap failure. That reasoning is sound on its face, but the ticket is in test
  against an AC its implementation contradicts and **no one has ruled on it**. Nothing is filed for it.
  It needs a ruling from whoever owns accessibility conformance, and AC-4 should then be rewritten to the
  outcome rather than left as a contradicted line.
- **No screen-reader (AT) pass was run** — structural `inert` proof is not a listening test.
- **No change-scoped regression**: no regression suite covers vc-shell / the Vendor Portal.
- **No App Insights correlation**: no component is configured for vcmp-dev.

## Findings held below the 5d severity floor

**None.** No new defect was found by this run — it did not execute against the product.

**Evidence:** `reports/tickets/Sprint26-17/VCST-5632/screenshots/` (16 captures, from the 2026-08-26 run;
this run added none — no browser session was justified against a stale build).

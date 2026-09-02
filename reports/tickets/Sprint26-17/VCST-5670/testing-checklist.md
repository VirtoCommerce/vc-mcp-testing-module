# VCST-5670 — Testing Checklist

**Path:** fast · **Flow:** feature-test · **Type:** Task (P2/Medium)
**Env:** vcmp-dev Vendor Portal — serves `@vc-shell/framework` **2.5.0**, build id `16355`, `last-modified` 2026-08-26 13:31:42 GMT
**Verdict: BLOCKED (deploy gate)** — PR #344 (the fix for the one reopening failure) is on `main` but in no released version.

## Deploy gate — why this run did not execute live

The build serving vcmp-dev is *the same build* the 2026-08-26 run tested (identical `last-modified` and
build id), and reports framework `"2.5.0"` in both served chunks. PR #344 merged 2026-09-01 14:22:42Z and
is **30 commits ahead of tag v2.5.0** (`git merge-base --is-ancestor` fails); npm `latest` is still 2.5.0.
So the code that fixes VCST-5812 is not on this environment, and a live re-test would reproduce the
original `<body>` failure and manufacture a false REOPEN.

## Conditions

Substituted instrument: PR #344's own unit test at `main`, with a **v2.5.0 source revert as the dated RED
baseline** (`BladeHeader.test.ts` held at `main`, `BladeHeader.vue` reverted).

| # | Condition | Verdict | Evidence |
|---|---|---|---|
| 1 | Sign-in → focus not `<body>` | **NOT-RUN (env)** | passed 3/3 on 2.5.0 (`main` workspace region) |
| 2 | Blade open (row click) | **NOT-RUN (env)** | passed 3/3 on 2.5.0 (documented decline path) |
| 3 | Maximize — header button | **NOT-RUN (env)** | passed 3/3 on 2.5.0 (`button "Restore"`) |
| 4 | Restore — header button | **NOT-RUN (env)** | passed 3/3 on 2.5.0 (`button "Maximize"`) |
| 5 | **Maximize/Restore via `mod+\` with focus on the control** | **PASS (code only)** | RED→GREEN `BladeHeader.test.ts:429` — *"moves focus to the replacement control when the state is toggled from outside"* |
| 6 | Save → focus not `<body>` | **NOT-RUN (env)** | passed 2/2 on 2.5.0, but *by accident* — see below |
| 7 | Target documented per transition | **PARTIAL** | 4 transitions documented; the shortcut path still undocumented in the ticket |
| 8 | **Verified by live measurement, not only unit tests** | **FAIL (unmet by construction)** | this run is unit-test-only — see below |
| 9 | Maximize control Tab-reachable, Enter **and** Space operable | **NOT-RUN (env)** | passed on 2.5.0 |

The fix shape is worth recording, because it is the right one: #344 moves the handoff out of the
`onExpand`/`onCollapse` click handlers into a `watch` on `renderingState.maximized`, so the header button
and the `mod+\` shortcut are covered by **one** path instead of the click handlers only. That is precisely
the mechanism the 2026-08-26 failure identified (`keepFocusOnExpandControl()` was reachable only from the
handlers; the chord dispatched elsewhere).

## Uncovered conditions, stated explicitly

- **AC-3 ("verified by measurement in a running app, not only in unit tests") cannot be met by this run.**
  It is unmet *by the AC's own wording*, not by oversight: the code-level RED→GREEN is exactly the
  "only in unit tests" evidence the AC excludes. This ticket cannot reach TESTED without a deployed build.
- **Condition 6 (Save) passes today for the wrong reason.** That path is untouched by #286/#344; saving
  *remounts* the blade, so `vc-blade.vue`'s `onMounted(focusIfLoose)` catches the loose focus. It would
  regress silently if the blade ever stopped remounting on save. Worth a deliberate target — noted, not filed.
- **No change-scoped regression**: no regression suite covers vc-shell / the Vendor Portal.
- **No App Insights correlation**: no component is configured for vcmp-dev.

## Findings held below the 5d severity floor

**None.** No new defect was found by this run — it did not execute against the product.

**Evidence:** `reports/tickets/Sprint26-17/VCST-5670/screenshots/` (7 captures, from the 2026-08-26 run;
this run added none — no browser session was justified against a stale build).

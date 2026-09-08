---
applicability: universal
applicability_rationale: "Per-browser rendering differences. Cross-VC universal."
---

# Browser Quirks — Cross-Browser Testing Reference

## iOS Safari

- `100vh` includes toolbar — use `dvh` (dynamic viewport height) instead
- Fixed positioning breaks during keyboard open
- Momentum scroll traps — elements can "trap" touch scrolling
- Safe area insets needed for notch devices
- Auto-zoom on inputs with font-size < 16px — always verify mobile form inputs

## Safari Desktop

- `<input type="date">` renders native picker differently than Chrome
- `backdrop-filter` has performance issues
- `position: sticky` inside overflow containers may break

## Firefox

- Scrollbar styling: `::-webkit-scrollbar` not supported (use `scrollbar-width` / `scrollbar-color`)
- Subgrid support varies
- `gap` may not work in older flexbox contexts

### "playwright-firefox cannot click here" — candidate mechanisms (2026-09-08) and the probe

**Symptom (confirmed 6× on the team's Windows machines, 2026-06 → 2026-08):** `browser_click` on the
`playwright-firefox` MCP lane resolves the element, then times out on Playwright's *"visible, enabled
and stable"* wait — on fully visible, non-moving elements (CLS 0, fixed rect). `browser_type` and
navigation work. Raw `playwright-core` + firefox in a single foreground window clicks the same element,
headed and headless. A browser-revision re-install changed nothing.

**Probe run 3 (2026-09-08, valid) — occlusion is NOT the lane cause, and there is now a reproducer.**

| variant | foreground | covered (rAF) | uncovered |
|---|---|---|---|
| `chromium-control` | OK 44 ms | OK (121) | OK |
| `firefox-default` | OK 102 ms | **OK 96 ms (rAF 0)** | OK |
| `firefox-reduced-motion` | OK 102 ms | **TIMEOUT (rAF 0)** | **TIMEOUT** |

Two results, both load-bearing:

1. **Firefox clicked fine while fully covered with rAF at 0**, so the occlusion pref in
   `config/mcp-playwright-firefox.config.json` **is not the fix** for this lane. It stays only because it
   removes one known way to stop the refresh driver; do not cite it as the cause.
2. **`reducedMotion: 'reduce'` stalls the click deterministically** — covered *and* uncovered, on an element
   Chromium clicks in 40 ms — at exactly the reported signature: *"waiting for element to be visible, enabled
   and stable"* with none of the `scrolling into view` lines that follow it on a healthy click. Under reduced
   motion the storefront drops its 3 animations, nothing needs painting, the refresh driver idles, and the
   Windows-Firefox **5-consecutive-rAF-ticks** stability check can never complete. Playwright emulates
   `reducedMotion: 'no-preference'` by default, so this is not what the MCP lane sets — but it is a
   **one-window, on-demand reproduction of the lane's failure mode**, which is what a fix can be tested
   against without three browsers and a monitor layout.

**Working hypothesis:** the stall signature means *the refresh driver stopped ticking*, whatever stopped it.
Occlusion is one trigger (and Firefox recovered from it here); an idle page under reduced motion is another.
Probe v4 tests candidate fixes against the reproducer: a 1 px infinite CSS animation injected before page JS
(keeps the driver alive regardless of cause), headless, and the occlusion pref. It also records the rAF rate
in the 500 ms before **each** click attempt, so "dead rAF ⇒ stall" is measured per attempt rather than inferred.

**Probe runs 1–2 (2026-09-08, invalid).** Two defects in the probe itself, kept here because they explain the
numbers in those logs:

- **The target was unclickable for every engine.** `a[href]:visible` matched the storefront's `skip-link` at
  `y = −29`. Playwright calls it visible, then loops on *"element is outside of the viewport"* until the
  timeout — on Firefox **and on Chromium**. So the click timeouts in runs 1–2 were the probe's, not the
  lane's. A Chromium control that fails now means *bad target*, never *Firefox bug*.
- **The cover landed on the wrong monitor.** The machine is dual-head (Firefox reported a 3440×1440 screen,
  Chromium 1920×1080); the cover opened at 0,0 and missed, so Firefox kept ticking at **121 rAF/2 s**.
  **Except once** — in the `reduced-motion` run the cover happened to land on Firefox's monitor, rAF fell to
  **0**, and the click stalled at exactly *"waiting for element to be visible, enabled and stable"* with no
  further progress. That is the reported symptom, reproduced by accident.

**What those runs did settle:** rect jitter is **1 distinct rect in 12 frames** on every engine, so the
storefront is still and rect movement is not the trigger — what matters is whether the rAF ticks arrive at all.

**Shipped facts the candidates rest on:**

1. Playwright's *stable* check samples the element rect on consecutive `requestAnimationFrame` ticks and
   on **Windows + Firefox demands 5 identical ticks** (`rafCountForStablePosition()` is
   `process.platform === "win32" ? 5 : 1`; Chromium, WebKit and non-Windows Firefox need 1).
2. Since Firefox 102, **Windows window-occlusion tracking** is on by default: a window fully covered by
   other windows is treated as hidden — rAF periods lengthen and then **stop**, `document.hidden` stays
   `true` (Mozilla bugs 1712854, 1732733; Marionette hit the same class in 1802473). Three headed
   1920×1080 browsers on one desktop means the firefox window sits under the two Chromium windows.
3. No rAF ticks → the 5-tick wait never completes → the MCP's **default 5 s action timeout** fires with
   the element still reported visible and enabled.
4. `fill()` waits for visible + enabled + **editable, not stable**, and navigation has no actionability
   wait — so typing and navigating keep working while every click dies. Chromium is immune because
   Playwright launches it with `--disable-backgrounding-occluded-windows` /
   `--disable-renderer-backgrounding`; Playwright sets Firefox's background *timer* prefs but not the
   occlusion pref.

It is not a Firefox rendering bug, not the storefront, and not the MCP's click code — it is the MCP's
*headed, three-windows-at-once* topology meeting a Windows-only Firefox power-saving feature.

**Config change (in the repo, kept, NOT the fix — measured):** `config/mcp-playwright-firefox.config.json` →
`launchOptions.firefoxUserPrefs` `{ "widget.windows.window_occlusion_tracking.enabled": false }`. The MCP
spreads `launchOptions` into `browserType.launch()`, so the pref does reach Firefox, and it removes one way
the refresh driver can stop. Run 3 showed it is not what the lane needs — plain Firefox clicked fine while
fully covered. Restart the MCP server after any config change.

**Prove any fix before touching a lane rule:** `node scripts/maintenance/firefox-click-probe.mjs --url <storefront>`
on a Windows machine (v4, ~5 min). It runs `chromium-control` and `firefox-default` as controls, then the
**reproducer** (`ff-repro-reducedmotion`) and three candidates on top of it — `+keepalive` (a 1 px infinite
CSS animation injected before page JS), `+headless`, `+pref-off`. Each phase clicks `--repeat` times
(default 3) with `trial: true` (full actionability wait, no real click) and records the rAF ticks in the
500 ms before each attempt; the footer prints how many failing attempts had a dead rAF and how many passing
ones did.

Exit 0 requires the control to pass, the reproducer to stall, and at least one candidate to clear it on every
attempt — the RESULT line names the winner. Apply that candidate to
`config/mcp-playwright-firefox.config.json`, re-run the lane for real, and only then: drop
`NOT ON playwright-firefox` from the click-driven suites' plan marking, restore firefox as a real third slot,
and rewrite the box in `.claude/rules/agents.md` §Parallel Execution. Until then the box stands.

**If no candidate clears the reproducer, the fix is not a launch option.** The remaining lever is the
actionability wait itself — a force-click skips the stable check entirely — which is an `@playwright/mcp`
capability question, not a config one. Report that rather than inventing a pref.

## Edge

- Generally Chrome-compatible (Chromium-based)
- Extension-injected console noise — filter out `extension://` messages
- **High-contrast mode** (Edge/Windows): Verify components remain usable, borders visible, focus indicators work

## WebKit — NOT Available on Windows

WebKit is not available on Windows via Playwright. Use Edge or Chrome as fallback. Do not attempt WebKit installation.

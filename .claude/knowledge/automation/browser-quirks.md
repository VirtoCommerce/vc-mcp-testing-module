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

**Probe run 1 (2026-09-08, the team's Windows machine, `firefox-click-probe` v1):** under a covering window
Firefox kept ticking rAF (121 per 2 s, `document.hidden` false) **and the trial click timed out even
uncovered, in both variants**. So the occlusion mechanism below is **not confirmed** — it may still be a
second contributor under the MCP's three-window topology, but it is not what the probe reproduced. What v1
could not tell (it took the first `a[href]` in DOM order, possibly an off-screen skip-link, and cut the call
log) is *which* actionability state stalled. Probe v2 targets a visible link, prints the full call log,
measures per-frame rect jitter of the target, and adds a Chromium control and a `reducedMotion` variant.
The 5-ticks-in-a-row rule (fact 1) with any frame-to-frame rect jitter is now the leading candidate.

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

**Config change (in the repo, harmless, not yet shown to matter):** `config/mcp-playwright-firefox.config.json` → `launchOptions.firefoxUserPrefs`
`{ "widget.windows.window_occlusion_tracking.enabled": false }`. The MCP spreads `launchOptions` into
`browserType.launch()`, so the pref reaches Firefox. Restart the MCP server after the change. Running the
firefox lane headless would also avoid it (a headless window is never occluded); the pref keeps the lane
headed like the other two.

**Prove any fix before touching a lane rule:** `node scripts/maintenance/firefox-click-probe.mjs --url <storefront>`
on a Windows machine that showed the bug. v2 runs `firefox-default`, `firefox-pref-off`,
`firefox-reduced-motion` and `chromium-control` against the same visible link: per variant a foreground
`trial: true` click (full actionability wait, no real click), 12-frame rect jitter, running-animation count,
then the same under a kiosk cover window, then uncovered. Exit 0 only when a firefox variant clicks under
every condition; the RESULT line names it. Only on that result: drop `NOT ON playwright-firefox` from the
click-driven suites' plan marking, restore firefox as a real third slot, and rewrite the box in
`.claude/rules/agents.md` §Parallel Execution. Until then the box stands — the rule was measured, and no
fix is yet.

## Edge

- Generally Chrome-compatible (Chromium-based)
- Extension-injected console noise — filter out `extension://` messages
- **High-contrast mode** (Edge/Windows): Verify components remain usable, borders visible, focus indicators work

## WebKit — NOT Available on Windows

WebKit is not available on Windows via Playwright. Use Edge or Chrome as fallback. Do not attempt WebKit installation.

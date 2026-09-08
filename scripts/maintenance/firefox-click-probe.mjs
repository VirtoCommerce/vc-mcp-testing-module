#!/usr/bin/env node
/**
 * firefox-click-probe — A/B reproduction of "playwright-firefox cannot click here".
 *
 * WHAT IT TESTS. `.claude/rules/agents.md` records that `browser_click` on the firefox lane resolves the
 * element and then times out on Playwright's "visible, enabled and stable" gate — on fully visible,
 * non-moving elements, on the team's Windows machines, confirmed 6×. `browser_type` and navigation work.
 *
 * Shipped facts the probe measures against:
 *   1. Playwright's "stable" check samples the element's rect on consecutive `requestAnimationFrame`
 *      ticks and on **Windows + Firefox demands 5 identical ticks in a row** (`rafCountForStablePosition()`
 *      is `process.platform === "win32" ? 5 : 1`; Chromium, WebKit and non-Windows Firefox need 1).
 *      Any frame-to-frame jitter of the target's rect — a running CSS animation on an ancestor, a
 *      smooth-scroll settling, a sticky header transform — breaks "5 in a row" on Firefox while Chromium
 *      passes on the first repeat.
 *   2. Windows Firefox ≥ 102 tracks window occlusion: a window fully covered by other windows stops
 *      `requestAnimationFrame` (Mozilla bugs 1712854, 1732733, 1802473) — so no ticks, no stability, and
 *      the MCP's default 5 s action timeout fires. Pref: `widget.windows.window_occlusion_tracking.enabled`.
 *   3. `fill()` waits for visible + enabled + editable and **not** stable, so typing works either way.
 *
 * Probe runs 1–2 (2026-09-08, the team's Windows machine) taught the probe two things:
 *   - `a[href]:visible` matched the storefront's `skip-link` at y = −29 — Playwright calls it visible, then
 *     reports "element is outside of the viewport" forever, on EVERY engine including Chromium. So v1/v2's
 *     click timeouts were the probe's, not Firefox's. v3 picks the first link whose box lies INSIDE the
 *     viewport (`data-ff-probe` marker set from the page), and a Chromium control that fails means "bad
 *     target", never "Firefox bug".
 *   - The machine has two monitors (Firefox reported a 3440×1440 screen, Chromium 1920×1080). The cover
 *     window opened on the other monitor, so Firefox kept ticking (121 rAF/2 s) — except once, when the
 *     cover happened to land on Firefox's monitor: rAF fell to 0 and the click stalled at "waiting for
 *     element to be visible, enabled and stable" — the original symptom, reproduced by accident. Rect jitter
 *     was 1/12 (still) everywhere, so the 5-frame rule alone is ruled out; OCCLUSION is the mechanism to
 *     prove. v3 places the kiosk cover on Firefox's own monitor (screen origin from `screen.availLeft/Top`)
 *     and marks a covered run whose rAF stayed high as COVER MISSED so it cannot be misread.
 *
 * Variants (default: all):
 *   firefox-default        — as the MCP lane launches it
 *   firefox-pref-off       — + firefoxUserPrefs occlusion tracking off (config/mcp-playwright-firefox.config.json)
 *   firefox-reduced-motion — + contextOptions.reducedMotion = 'reduce'
 *   chromium-control       — same element, same steps, Chromium
 *
 * Per variant: open the storefront, wait for the target to be visible, record UA / screen / running
 * animations / 12-frame rect jitter, `click({ trial: true })` in the foreground (full actionability wait,
 * NO real click — nothing navigates), then cover the window with a kiosk Chromium window, re-measure
 * rAF ticks + `document.hidden` + jitter + trial click, uncover, trial click again.
 *
 * Reading the table:
 *   - chromium-control must pass everywhere; if it does not, the target is wrong — fix the probe, not Firefox.
 *   - firefox-default: covered rAF ≈ 0 and covered click TIMEOUT stalled at "visible, enabled and stable",
 *     foreground + uncovered OK → occlusion reproduced.
 *   - firefox-pref-off: covered rAF stays ≈ 120 and covered click OK → the config pref is the fix. Exit 0.
 *   - a covered row with rAF > 20 on firefox-default is marked COVER MISSED — re-run; nothing was tested.
 * Exit 0 when firefox-pref-off passes foreground + covered + uncovered AND its cover was not missed.
 *
 * Usage:
 *   node scripts/maintenance/firefox-click-probe.mjs --url <storefront> [--variant all|<a,b,...>]
 *        [--target <css>] [--settle <ms, default 12000>] [--json]
 *   TEST_ENV=vcst node scripts/maintenance/firefox-click-probe.mjs     # FRONT_URL from the env loader
 *
 * Runs on the MCP lane's OWN Playwright when `@playwright/mcp` is installed in node_modules (it bundles a
 * newer `playwright` than the repo's ^1.61); otherwise the top-level copy, and the header says which.
 * Install that copy's browsers:  node node_modules/@playwright/mcp/node_modules/playwright/cli.js install firefox chromium
 * Read-only against the storefront (trial clicks only). Not wired to CI — it needs a desktop.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const rootRequire = createRequire(import.meta.url);
let pwPath = rootRequire.resolve('playwright');
let pwSource = 'top-level copy';
try {
  pwPath = createRequire(rootRequire.resolve('@playwright/mcp/package.json')).resolve('playwright');
  pwSource = "the MCP lane's own copy";
} catch (e) {
  pwSource = `top-level copy — @playwright/mcp not resolvable here: ${String(e.code || e.message).slice(0, 60)}`;
}
// `import()` of an absolute path must be a file:// URL — on Windows a bare `C:\...` is read as a `c:` scheme.
const pwModule = await import(pathToFileURL(pwPath).href);
const { firefox, chromium } = pwModule.default ?? pwModule; // playwright's entry is CJS: named exports live on `default`
const pwVersion = JSON.parse(readFileSync(pwPath.replace(/index\.(m?js)$/, 'package.json'), 'utf8')).version;

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : dflt;
};
let URL_ = arg('url', process.env.FRONT_URL);
if (!URL_) {
  // Last resort: run the layered env loader (`.env.defaults` → `.env.<TEST_ENV>` → `.env.local`) and read
  // FRONT_URL through process.env (rules/test-data.md). The loader exits the process when CORE vars are
  // missing, which is why `--url` is the primary path for a probe that needs no credentials.
  await import('../../config.js');
  URL_ = process.env.FRONT_URL;
}
// Default target: the first <a href> whose box lies fully inside the viewport (chosen in-page, marked with
// `data-ff-probe`). Playwright's `:visible` is NOT enough — an off-viewport skip-link passes it (runs 1–2).
const TARGET = arg('target', '[data-ff-probe]');
async function markTarget(page) {
  return page.evaluate(() => {
    document.querySelectorAll('[data-ff-probe]').forEach((el) => el.removeAttribute('data-ff-probe'));
    for (const a of document.querySelectorAll('a[href]')) {
      const r = a.getBoundingClientRect();
      const cs = getComputedStyle(a);
      if (r.width < 8 || r.height < 8) continue;
      if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) continue;
      if (cs.visibility === 'hidden' || cs.opacity === '0' || cs.pointerEvents === 'none') continue;
      a.setAttribute('data-ff-probe', '1');
      return true;
    }
    return false;
  });
}
const SETTLE_MS = Number(arg('settle', '12000'));
const JSON_OUT = argv.includes('--json');
const OCCLUSION_PREF = 'widget.windows.window_occlusion_tracking.enabled';

const VARIANTS = {
  'firefox-default': { engine: 'firefox', prefs: {}, context: {} },
  'firefox-pref-off': { engine: 'firefox', prefs: { [OCCLUSION_PREF]: false }, context: {} },
  'firefox-reduced-motion': { engine: 'firefox', prefs: {}, context: { reducedMotion: 'reduce' } },
  'chromium-control': { engine: 'chromium', prefs: {}, context: {} },
};
const wanted = arg('variant', 'all');
const variantNames = wanted === 'all' ? Object.keys(VARIANTS) : wanted.split(',').map((s) => s.trim()).filter(Boolean);
for (const v of variantNames) if (!VARIANTS[v]) { console.error(`Unknown variant "${v}". Known: ${Object.keys(VARIANTS).join(', ')}`); process.exit(2); }

if (!URL_) {
  console.error('No storefront URL: pass --url or set FRONT_URL (TEST_ENV=<env> loads .env.<env>).');
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.error(`[note] platform is ${process.platform}: the 5-frame stability rule and occlusion tracking are Windows-only; results here do not transfer.`);
}

const firstLine = (e) => String(e?.message || e).split('\n')[0];
const callLog = (e) => String(e?.message || e).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 14);

async function rafStats(page) {
  // Count rAF ticks for 2 s. The setTimeout is the escape hatch for a window whose rAF has stopped
  // entirely (Playwright already disables Firefox's background TIMER throttling, so timers still fire).
  return page.evaluate(() => new Promise((resolve) => {
    let ticks = 0;
    const t0 = performance.now();
    const step = () => { ticks++; if (performance.now() - t0 < 2000) requestAnimationFrame(step); else resolve({ ticks, hidden: document.hidden }); };
    requestAnimationFrame(step);
    setTimeout(() => resolve({ ticks, hidden: document.hidden, timedOut: true }), 4000);
  })).catch((e) => ({ error: firstLine(e) }));
}

// The measurement Playwright's stable check makes, done by hand: the target's rect on 12 consecutive
// frames. `distinct` > 1 means the 5-in-a-row rule can fail on an element a human would call still.
async function rectJitter(target) {
  return target.evaluate((el) => new Promise((resolve) => {
    const rects = [];
    let n = 0;
    const step = () => {
      const r = el.getBoundingClientRect();
      rects.push([r.x, r.y, r.width, r.height].map((v) => +v.toFixed(3)).join(','));
      if (++n < 12) requestAnimationFrame(step); else resolve(rects);
    };
    requestAnimationFrame(step);
    setTimeout(() => resolve(rects), 4000);
  })).then((rects) => ({ frames: rects.length, distinct: new Set(rects).size, first: rects[0], last: rects[rects.length - 1] }))
    .catch((e) => ({ error: firstLine(e) }));
}

async function trialClick(target) {
  const t0 = Date.now();
  try {
    await target.click({ trial: true, timeout: 5000 });
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, log: callLog(e) };
  }
}

const results = [];
for (const name of variantNames) {
  const v = VARIANTS[name];
  const row = { variant: name, engine: v.engine, prefs: v.prefs, context: v.context };
  let browser, cover;
  try {
    const type = v.engine === 'firefox' ? firefox : chromium;
    browser = await type.launch({ headless: false, ...(v.engine === 'firefox' ? { firefoxUserPrefs: v.prefs } : {}) });
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'en-US', ...v.context });
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    row.ua = await page.evaluate(() => navigator.userAgent);
    row.screen = await page.evaluate(() => ({ w: screen.width, h: screen.height, left: screen.availLeft ?? 0, top: screen.availTop ?? 0, dpr: devicePixelRatio, inner: `${innerWidth}x${innerHeight}`, win: `${screenX},${screenY} ${outerWidth}x${outerHeight}` }));

    // Let the SPA render before choosing a target: wait for any in-viewport link, up to 30 s.
    let marked = false;
    for (let i = 0; i < 30 && !marked; i++) {
      if (TARGET === '[data-ff-probe]') marked = await markTarget(page).catch(() => false);
      else marked = (await page.locator(TARGET).count().catch(() => 0)) > 0;
      if (!marked) await new Promise((r) => setTimeout(r, 1000));
    }
    const target = page.locator(TARGET).first();
    try {
      if (!marked) throw new Error(`no link inside the ${row.screen.inner} viewport after 30 s`);
      await target.waitFor({ state: 'visible', timeout: 10_000 });
    } catch (e) {
      row.targetError = `target never became usable: ${firstLine(e)}`;
    }
    if (!row.targetError) {
      row.target = await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), href: el.getAttribute('href'), rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n)).join(',') };
      }).catch((e) => ({ error: firstLine(e) }));
      row.animations = await page.evaluate(() => document.getAnimations().length).catch(() => 'n/a');
      row.foregroundRaf = await rafStats(page);
      row.foregroundJitter = await rectJitter(target);
      row.foregroundClick = await trialClick(target);

      // Occlude with a kiosk Chromium window on the SUBJECT'S monitor (its screen origin), sized to that
      // screen — full-screen, above the taskbar, launched AFTER the subject so it lands on top. Occlusion
      // tracking needs FULL coverage; on a two-monitor desk a cover at 0,0 lands on the wrong screen (run 2).
      cover = await chromium.launch({ headless: false, args: ['--kiosk', `--window-position=${row.screen.left},${row.screen.top}`, `--window-size=${row.screen.w},${row.screen.h}`] });
      const coverPage = await (await cover.newContext({ viewport: null })).newPage();
      await coverPage.goto('about:blank');
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      row.coveredRaf = await rafStats(page);
      // A firefox window that is really covered stops ticking (runs 1–2: 121 when the cover missed, 0 when it
      // landed). With the occlusion pref OFF it keeps ticking by design, so the check applies to the others.
      row.coverMissed = v.engine === 'firefox' && !v.prefs[OCCLUSION_PREF] && (row.coveredRaf.ticks ?? 0) > 20;
      row.coveredJitter = await rectJitter(target);
      row.coveredClick = await trialClick(target);

      await cover.close(); cover = undefined;
      await new Promise((r) => setTimeout(r, 1500));
      row.uncoveredClick = await trialClick(target);
    }
  } catch (e) {
    row.fatal = firstLine(e);
  } finally {
    await cover?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
  results.push(row);
}

const fmtClick = (c) => (!c ? '—' : c.ok ? `OK ${c.ms} ms` : `TIMEOUT ${c.ms} ms`);
const fmtJ = (j) => (!j ? '—' : j.error ? 'err' : `${j.distinct}/${j.frames}`);
const fmtRaf = (r, missed) => (!r ? '—' : r.error ? 'err' : `${r.ticks}${r.hidden ? ' hidden' : ''}${missed ? ' COVER MISSED' : ''}`);

if (JSON_OUT) {
  console.log(JSON.stringify({ url: URL_, target: TARGET, platform: process.platform, playwright: pwVersion, playwrightSource: pwSource, settleMs: SETTLE_MS, results }, null, 2));
} else {
  console.log(`firefox-click-probe v3 — ${URL_} — ${process.platform} — playwright ${pwVersion} (${pwSource}) — target "${TARGET}" — settle ${SETTLE_MS} ms\n`);
  console.log('variant                | fg click        | fg jitter | anim | covered rAF/2s | cov jitter | covered click   | uncovered click');
  console.log('-----------------------|-----------------|-----------|------|----------------|------------|-----------------|----------------');
  for (const r of results) {
    if (r.fatal) { console.log(`${r.variant.padEnd(22)} | FATAL: ${r.fatal}`); continue; }
    if (r.targetError) { console.log(`${r.variant.padEnd(22)} | ${r.targetError}`); continue; }
    console.log(`${r.variant.padEnd(22)} | ${fmtClick(r.foregroundClick).padEnd(15)} | ${fmtJ(r.foregroundJitter).padEnd(9)} | ${String(r.animations).padEnd(4)} | ${fmtRaf(r.coveredRaf, r.coverMissed).padEnd(14)} | ${fmtJ(r.coveredJitter).padEnd(10)} | ${fmtClick(r.coveredClick).padEnd(15)} | ${fmtClick(r.uncoveredClick)}`);
  }
  console.log('\n(jitter = distinct rects / frames sampled; 1/12 is a still element. anim = document.getAnimations().length)');
  for (const r of results) {
    if (r.fatal || r.targetError) continue;
    console.log(`\n[${r.variant}] ${r.ua}`);
    console.log(`  screen ${r.screen.w}x${r.screen.h} at ${r.screen.left},${r.screen.top} @${r.screen.dpr} | window ${r.screen.win} | inner ${r.screen.inner} | target <${r.target?.tag}> "${r.target?.text}" href=${r.target?.href} rect=${r.target?.rect}`);
    if (r.foregroundJitter && r.foregroundJitter.distinct > 1) console.log(`  jitter fg: first ${r.foregroundJitter.first} → last ${r.foregroundJitter.last}`);
    for (const [label, c] of [['foreground', r.foregroundClick], ['covered', r.coveredClick], ['uncovered', r.uncoveredClick]]) {
      if (c && !c.ok) { console.log(`  ${label} click call log:`); for (const l of c.log) console.log(`    ${l}`); }
    }
  }
}

const byName = Object.fromEntries(results.map((r) => [r.variant, r]));
const ok3 = (r) => !!r && !r.fatal && !r.targetError && r.foregroundClick?.ok && r.coveredClick?.ok && r.uncoveredClick?.ok;
const cr = byName['chromium-control'];
const dflt = byName['firefox-default'];
const prefOff = byName['firefox-pref-off'];
const controlOk = !cr || ok3(cr);
const occlusionReproduced = !!dflt && !dflt.coverMissed && dflt.foregroundClick?.ok && !dflt.coveredClick?.ok && (dflt.coveredRaf?.ticks ?? 99) <= 20;
const fixProven = controlOk && ok3(prefOff) && (prefOff.coveredRaf?.ticks ?? 0) > 20;
if (!JSON_OUT) {
  console.log('');
  if (cr && !controlOk) console.log('RESULT: chromium-control failed — the TARGET is wrong (see its call log); nothing about Firefox was tested. Pass --target <css> for a link you can see.');
  else if (dflt?.coverMissed) console.log('RESULT: the cover MISSED the firefox window (rAF kept ticking) — re-run; if it keeps missing, drag nothing, just tell me the two monitor layouts.');
  else if (occlusionReproduced && fixProven) console.log('RESULT: CONFIRMED — covered firefox-default stops ticking and stalls at "visible, enabled and stable"; firefox-pref-off keeps ticking and clicks. The config pref is the fix.');
  else if (occlusionReproduced) console.log('RESULT: occlusion REPRODUCED on firefox-default, but firefox-pref-off did not pass every condition — read its rows; the pref alone is not enough.');
  else if (ok3(dflt)) console.log('RESULT: firefox-default clicks under every condition here — the lane failure needs the MCP topology to reproduce; report and stop.');
  else console.log('RESULT: mixed — attach the full table + call logs to the finding; do not change any lane rule.');
}
process.exit(fixProven && occlusionReproduced ? 0 : 1);

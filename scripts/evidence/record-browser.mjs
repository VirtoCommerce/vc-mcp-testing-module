#!/usr/bin/env node
/**
 * Record browser evidence (video / frames) for a bug that lives in a TRANSITION
 * rather than in a single screen — a redirect that fires on its own, a flash of
 * wrong content, a layout jump, an element that disappears.
 *
 * Built for INTERMITTENT defects: `--runs N --until <substring>` replays the same
 * scenario until the symptom appears, keeps the recording of the run that caught
 * it and throws the rest away. That is the piece that was missing while chasing
 * VCST-5900 (12 clean runs produced 14 useless videos that had to be sorted by hand).
 *
 * Zero new dependencies: recording is Playwright's own `recordVideo`, and frame
 * extraction reuses the ffmpeg binary Playwright already ships.
 *
 * Usage
 *   node scripts/evidence/record-browser.mjs --url <url> [options]
 *
 *   --url <url>            Page to open. Required.
 *   --runs <n>             Attempts (default 1). Each run is a FRESH browser.
 *   --until <substr>       Symptom: the page URL comes to contain this substring.
 *                          Runs stop at the first match. Prefer a value with NO
 *                          leading slash ("login", not "#!/login"): Git Bash on
 *                          Windows rewrites a leading slash into a filesystem path
 *                          ("#!/login" arrives as "#!C:/Program Files/Git/login").
 *                          Either drop the slash or prefix the command with
 *                          MSYS_NO_PATHCONV=1.
 *   --wait <ms>            Observation window per run (default 6000).
 *   --headed               Show the window. A headless browser is faster and can
 *                          win a race the real one loses — try this first when a
 *                          timing bug will not reproduce.
 *   --throttle             CPU 4x + Slow-4G via CDP, to widen a race window.
 *                          Chromium only. Say so in the report: it is a
 *                          demonstration of the race, not an organic repro.
 *   --channel <name>       chrome | msedge (default: bundled Chromium).
 *   --frames <n>           Also extract n frames per second as PNGs.
 *   --gif                  Also write a GIF. Needs a SYSTEM ffmpeg on PATH; the
 *                          bundled one cannot encode GIF and this is skipped with
 *                          a reason instead of failing.
 *   --fps <n>              GIF frame rate (default 5).
 *   --out <dir>            Output dir (default test-results/evidence/<timestamp>).
 *   --keep-all             Keep recordings of runs that did NOT match --until.
 *
 * Exit code: 0 = recorded (and matched, when --until was given), 1 = never matched.
 *
 * Artifacts land under test-results/ which is gitignored — deliberately. Video is
 * evidence for a tracker attachment, not a repo asset: see .claude/rules/reports.md §5.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const flags = new Set(['headed', 'throttle', 'gif', 'keep-all']);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (flags.has(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

/** A system ffmpeg can encode GIF/MP4; Playwright's bundled build cannot (webm/png only). */
function findFfmpeg() {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
    return { bin: 'ffmpeg', full: true };
  }
  const root = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ms-playwright')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root).filter(d => d.startsWith('ffmpeg-')).sort().reverse()) {
    for (const name of ['ffmpeg-win64.exe', 'ffmpeg-mac-x64', 'ffmpeg-mac-arm64', 'ffmpeg-linux', 'ffmpeg-linux-arm64']) {
      const bin = join(root, dir, name);
      if (existsSync(bin)) return { bin, full: false };
    }
  }
  return null;
}

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return { ok: r.status === 0, stderr: (r.stderr || '').trim() };
}

async function recordOnce({ url, runIndex, outDir, waitMs, headed, throttle, channel, until }) {
  const browser = await chromium.launch({
    headless: !headed,
    ...(channel ? { channel } : {}),
  });
  // A fresh context per run: no cache, no storage — the state a user arriving
  // from an emailed link is actually in.
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    locale: 'en-US',
    recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();

  if (throttle) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
  }

  const timeline = [];
  const t0 = Date.now();
  let seen = null;
  let matched = false;
  const sampler = setInterval(() => {
    const u = page.url();
    if (u === seen) return;
    seen = u;
    timeline.push({ ms: Date.now() - t0, url: u });
    if (until && u.includes(until)) matched = true;
  }, 50);

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  } catch (err) {
    timeline.push({ ms: Date.now() - t0, url: `NAVIGATION FAILED: ${err.message}` });
  }
  // Keep watching after load: the symptom may be a self-inflicted redirect that
  // lands well after the load event.
  const deadline = Date.now() + Number(waitMs);
  while (Date.now() < deadline && !matched) await page.waitForTimeout(100);
  if (matched) await page.waitForTimeout(750); // let the end state render into the video
  clearInterval(sampler);

  const finalUrl = page.url();
  await context.close(); // flushes the .webm
  const rawVideo = await page.video()?.path();
  await browser.close();

  let video = rawVideo;
  if (rawVideo && existsSync(rawVideo)) {
    video = join(outDir, `run-${String(runIndex).padStart(2, '0')}${matched ? '-MATCH' : ''}.webm`);
    renameSync(rawVideo, video);
  }
  return { matched, finalUrl, timeline, video };
}

function extractFrames(ffmpeg, video, outDir, perSecond) {
  const dir = join(outDir, 'frames');
  mkdirSync(dir, { recursive: true });
  // -r (output rate) rather than the fps FILTER: the bundled ffmpeg build enables
  // only pad/crop/scale, so `-vf fps=` is unavailable there.
  const r = run(ffmpeg.bin, ['-y', '-i', video, '-r', String(perSecond), '-f', 'image2', join(dir, 'frame-%03d.png')]);
  if (!r.ok) return { ok: false, reason: r.stderr.split('\n').slice(-3).join(' ') };
  return { ok: true, dir, count: readdirSync(dir).filter(f => f.endsWith('.png')).length };
}

function makeGif(ffmpeg, video, outDir, fps) {
  if (!ffmpeg.full) {
    return {
      ok: false,
      reason: "Playwright's bundled ffmpeg has no GIF encoder (webm/png only). "
        + 'Install a system ffmpeg (winget install Gyan.FFmpeg) and re-run with --gif.',
    };
  }
  const palette = join(outDir, 'palette.png');
  const gif = join(outDir, 'evidence.gif');
  const p = run(ffmpeg.bin, ['-y', '-i', video, '-vf', `fps=${fps},scale=960:-1:flags=lanczos,palettegen`, palette]);
  if (!p.ok) return { ok: false, reason: p.stderr.split('\n').slice(-3).join(' ') };
  const g = run(ffmpeg.bin, ['-y', '-i', video, '-i', palette,
    '-lavfi', `fps=${fps},scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse`, gif]);
  rmSync(palette, { force: true });
  if (!g.ok) return { ok: false, reason: g.stderr.split('\n').slice(-3).join(' ') };
  return { ok: true, gif };
}

const args = parseArgs(process.argv.slice(2));
if (!args.url) {
  console.error('Usage: node scripts/evidence/record-browser.mjs --url <url> [--runs N] [--until <substr>]'
    + ' [--wait ms] [--headed] [--throttle] [--channel chrome|msedge] [--frames N] [--gif] [--out dir] [--keep-all]');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = resolve(args.out || join('test-results', 'evidence', stamp));
mkdirSync(outDir, { recursive: true });

// Git Bash rewrites an argument that starts with "/" into a Windows path. Silently
// matching against the mangled value would report "not reproduced" for a symptom
// that was never actually being watched for.
if (args.until && /Program Files|:[\\/]/.test(args.until)) {
  console.error(`--until looks path-mangled by the shell: "${args.until}"`);
  console.error('Drop the leading slash (e.g. --until login) or prefix with MSYS_NO_PATHCONV=1.');
  process.exit(2);
}

const runs = Number(args.runs || 1);
const ffmpeg = findFfmpeg();
const kept = [];
let match = null;

console.log(`Recording ${runs} run(s) → ${outDir}`);
if (args.until) console.log(`Symptom: page URL contains "${args.until}"`);

for (let i = 1; i <= runs; i++) {
  const res = await recordOnce({
    url: args.url,
    runIndex: i,
    outDir,
    waitMs: args.wait || 6000,
    headed: !!args.headed,
    throttle: !!args.throttle,
    channel: args.channel,
    until: args.until,
  });

  const verdict = args.until ? (res.matched ? 'MATCH' : 'no match') : 'recorded';
  console.log(`\n--- run ${i}/${runs}: ${verdict} → ${res.finalUrl}`);
  for (const t of res.timeline) console.log(`    ${String(t.ms).padStart(5)}ms  ${t.url}`);

  if (res.matched || !args.until || args['keep-all']) {
    kept.push(res.video);
    console.log(`    video: ${res.video}`);
  } else if (res.video) {
    rmSync(res.video, { force: true }); // a race needs many attempts; do not hoard the misses
  }
  if (res.matched) { match = res; break; }
}

const primary = match?.video || kept[0];
if (primary && ffmpeg) {
  if (args.frames) {
    const f = extractFrames(ffmpeg, primary, outDir, Number(args.frames));
    console.log(f.ok ? `\nFrames: ${f.count} PNG(s) in ${f.dir}` : `\nFrames failed: ${f.reason}`);
  }
  if (args.gif) {
    const g = makeGif(ffmpeg, primary, outDir, Number(args.fps || 5));
    console.log(g.ok ? `GIF: ${g.gif}` : `GIF skipped: ${g.reason}`);
  }
} else if ((args.frames || args.gif) && !ffmpeg) {
  console.log('\nffmpeg not found (neither on PATH nor in the Playwright cache) — video only.');
}

if (args.until) {
  console.log(`\n===== ${match ? `reproduced on run ${kept.length}` : `NOT reproduced in ${runs} run(s)`} =====`);
  if (!match) {
    console.log('A run of misses is data, not a pass: report the attempt count and the conditions,');
    console.log('and do not describe the defect as reproducible on demand.');
  }
  process.exit(match ? 0 : 1);
}

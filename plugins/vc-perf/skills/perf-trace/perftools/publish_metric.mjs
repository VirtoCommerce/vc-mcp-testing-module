#!/usr/bin/env node
/*
 * publish_metric.mjs — Redis PUBLISH and search-backend call volume inside an L2 load window,
 * normalized per iteration, from an `aspire otel spans <resource> --follow --format Json` capture.
 * Node only, no dependencies.
 *
 * WHAT IT ANSWERS
 *   "Did this change actually reduce the cache-invalidation storm / the number of searches, and how
 *   much wall time do they really occupy?" — the two questions a raw span count answers wrongly.
 *
 * UNION, NEVER SUM
 *   Fire-and-forget calls overlap heavily. Measured on one backend: Redis PUBLISH was 55% of all
 *   spans but the union of merged intervals was 1-2.5% of the window, while the naive sum was ~35x
 *   larger. Span count and duration-sum are both non-metrics under overlap; only the union of merged
 *   intervals is a share of wall time.
 *
 * WHY A WINDOW
 *   The capture is started before k6 and stopped after it, and `--follow` also replays the
 *   dashboard's ring-buffer history — measured 35 minutes of capture around a 7 minute run. A raw
 *   total therefore also counts background-job, idle and previous-run activity. The load window is
 *   derived from HTTP *server* spans, which exist only while traffic is driven: they are clustered on
 *   idle gaps and the busiest cluster is taken as the run.
 *
 * DENORMALISE BEFORE CLAIMING A WIN
 *   A per-iteration figure moves with BOTH numerator and denominator. Measured: PUBLISH/iteration
 *   halved while publishes/second rose 16% — the "win" was throughput, not less work. Read the
 *   absolute in-window count and the window length alongside the ratio, both of which are printed.
 *
 * USAGE
 *   node perftools/publish_metric.mjs <spans.json> <iterations> [--search-host <substr>]
 *
 *   <spans.json>     `aspire otel spans <resource> --follow --format Json` output
 *   <iterations>     metrics.iterations.values.count from the k6 summary (note the `.values.` level)
 *   --search-host    substring matching the search backend's span destination (default `elastic`);
 *                    a managed cluster shows e.g. `...elastic-cloud.com:9243`
 *
 * Both sides of an A/B MUST be measured with this same script and the same flags.
 */

import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const positional = [];
let searchHost = 'elastic';
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--search-host') { searchHost = args[++i]; }
    else { positional.push(args[i]); }
}
const [file, iterArg] = positional;

if (!file || !iterArg) {
    console.error('usage: node publish_metric.mjs <spans.json> <iterations> [--search-host <substr>]');
    process.exit(1);
}
const iterations = Number(iterArg);

const spans = { pub: [], server: [], search: [] };

const rl = readline.createInterface({ input: fs.createReadStream(file) });
rl.on('line', line => {
    if (!line.trim()) { return; }
    let arr;
    try { arr = JSON.parse(line); } catch { return; }
    for (const s of arr) {
        const st = Date.parse(s.timestamp);
        const en = st + (s.durationMs || 0);
        if (s.name === 'PUBLISH') { spans.pub.push([st, en]); }
        // Health probes and the dashboard run for the whole capture, so including them would stretch
        // the window far past the k6 run and dilute the per-iteration figure with background-job
        // activity. Only load-bearing request spans define the window.
        if (s.kind === 'Server' && !/health|\{controller=/i.test(s.name)) { spans.server.push(st); }
        if ((s.destination || '').includes(searchHost) && s.name === 'search') { spans.search.push([st, en]); }
    }
});

// Merged-interval total: summing overlapping span durations counts the same wall clock many times
// over (2560 fire-and-forget publishes inside one 7 ms window sum to ~44 s).
function union(intervals) {
    if (!intervals.length) { return 0; }
    const iv = intervals.slice().sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [curStart, curEnd] = iv[0];
    for (let i = 1; i < iv.length; i++) {
        const [s, e] = iv[i];
        if (s <= curEnd) { curEnd = Math.max(curEnd, e); }
        else { total += curEnd - curStart; curStart = s; curEnd = e; }
    }

    return total + curEnd - curStart;
}

// Contiguous runs of publishes; a gap this large separates distinct invalidation episodes.
const BURST_GAP_MS = 50;
function bursts(intervals) {
    const starts = intervals.map(x => x[0]).sort((a, b) => a - b);
    const out = [];
    let n = 1;
    for (let i = 1; i < starts.length; i++) {
        if (starts[i] - starts[i - 1] <= BURST_GAP_MS) { n++; }
        else { out.push(n); n = 1; }
    }
    out.push(n);

    return out.sort((a, b) => b - a);
}

rl.on('close', () => {
    if (!spans.server.length) {
        console.error('no HTTP server spans - cannot establish the load window');
        process.exit(2);
    }
    const IDLE_GAP_MS = 60_000;
    const starts = spans.server.slice().sort((a, b) => a - b);
    const clusters = [[starts[0], starts[0], 1]];
    for (let i = 1; i < starts.length; i++) {
        const last = clusters[clusters.length - 1];
        if (starts[i] - last[1] <= IDLE_GAP_MS) { last[1] = starts[i]; last[2]++; }
        else { clusters.push([starts[i], starts[i], 1]); }
    }
    const load = clusters.sort((a, b) => b[2] - a[2])[0];
    const [winStart, winEnd] = load;
    if (clusters.length > 1) {
        console.log(`note: ${clusters.length} activity blocks in capture; using the busiest (${load[2]} request spans)`);
    }
    const inWindow = iv => iv.filter(([s]) => s >= winStart && s <= winEnd);

    const pub = inWindow(spans.pub);
    const search = inWindow(spans.search);
    const b = bursts(pub);
    const big = b.filter(x => x >= 100);

    console.log(`load window       : ${((winEnd - winStart) / 1000).toFixed(0)}s   iterations: ${iterations}`);
    console.log(`PUBLISH  in-window: ${pub.length}  (${(pub.length / iterations).toFixed(1)} /iteration)`);
    console.log(`  union wall      : ${(union(pub) / 1000).toFixed(1)}s  (${(100 * union(pub) / (winEnd - winStart)).toFixed(2)}% of window)`);
    console.log(`  bursts >=100    : ${big.length}  carrying ${(100 * big.reduce((a, c) => a + c, 0) / (pub.length || 1)).toFixed(1)}% of publishes`);
    console.log(`  top burst sizes : ${b.slice(0, 8).join(', ')}`);
    console.log(`search   in-window: ${search.length}  (${(search.length / iterations).toFixed(1)} /iteration)  [host ~ ${searchHost}]`);
    console.log(`  union wall      : ${(union(search) / 1000).toFixed(1)}s  (${(100 * union(search) / (winEnd - winStart)).toFixed(2)}% of window)`);
    if (!search.length) {
        console.log('  (0 matched - check --search-host against the `destination` field in the capture)');
    }
});

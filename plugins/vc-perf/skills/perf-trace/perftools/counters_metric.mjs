#!/usr/bin/env node
/*
 * counters_metric.mjs — per-operation report of in-process counters a module emits as attributes on
 * each request's own span, read from an `aspire otel spans <resource> --follow --format Json` capture.
 * Node only, no dependencies.
 *
 * WHAT IT ANSWERS
 *   "How many times per request does this operation build a validation context / load products /
 *   clone the cart?" — the half of the L3 question `op_attrib` structurally cannot answer, because
 *   work that never leaves the process emits no client span to attribute.
 *
 * WHY IT IS NOT SUBJECT TO THE 1-VU RULE
 *   `op_attrib` attributes downstream calls by TIME CONTAINMENT, which is only valid when request
 *   intervals do not overlap. These counters ride on the request's own server span, so reading them
 *   is a group-by, not an attribution — it stays correct under concurrency. (The counts themselves
 *   are still per-request, so a concurrent run reports the same per-request distribution.)
 *
 * WHAT THE EMITTING SIDE MUST GET RIGHT
 *   The module must tag the REQUEST's activity, not `Activity.Current`. On a backend with
 *   Application Insights enabled, `Activity.Current` inside a request is a parentless
 *   `Microsoft.ApplicationInsights.OperationContext` — Internal, unrecorded, never exported, and the
 *   ASP.NET activity is not reachable from its parent chain either. Tags written there are dropped
 *   silently and completely. The ASP.NET-side source of truth is
 *   `HttpContext.Features.Get<IHttpActivityFeature>()?.Activity`. Symptom of getting this wrong:
 *   this tool reports "no server spans carry an attribute with prefix X" on a run you know emitted them.
 *
 * DISTRIBUTION, NOT AVERAGE
 *   The counts are exact integers per request, so the interesting figure is the spread. A counter
 *   that is constant across every request is a FIXED cost per invocation; one that tracks input size
 *   is a PER-ITEM multiplier. Averaging the two together hides exactly that distinction — which is
 *   the cheapest discriminator available for "is this per-item or batched?", and it costs one run
 *   rather than one reading of the source. So min/median/max is printed and a varying counter marked.
 *
 * COUNT IS NOT COST
 *   A high count is a lead, never a finding. Pair it with a duration (an `<prefix>time.*` attribute
 *   accumulated by the emitting side) before ranking anything: measured on one VC backend, a
 *   cart-to-order conversion ran 9-18x per request and cost 0.1-0.5% of request time.
 *
 * USAGE
 *   node perftools/counters_metric.mjs <spans.json> --prefix <attribute-prefix>
 *
 *   <spans.json>  `aspire otel spans <resource> --follow --format Json` output (one JSON array per line)
 *   --prefix      attribute-name prefix the module emits, e.g. `opus.`. REQUIRED and deliberately has
 *                 no default: a wrong-but-plausible default would report an empty table, which is
 *                 indistinguishable from "the code under test emitted nothing".
 *
 *   Attributes whose name continues `time.` after the prefix are treated as accumulated milliseconds
 *   (rounded to 0.1) rather than exact counts.
 */

import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const positional = [];
let prefix = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prefix') { prefix = args[++i]; }
    else { positional.push(args[i]); }
}
const [file] = positional;

if (!file || !prefix) {
    console.error('usage: node counters_metric.mjs <spans.json> --prefix <attribute-prefix>');
    console.error('  e.g. node counters_metric.mjs spans.json --prefix opus.');
    process.exit(1);
}

// Requests are self-labelled by the harness `OP_TAG=1` knob appending `?op=<name>`; the runtime
// records it as `url.query`. Unlabelled requests are kept under `(unlabelled)` rather than dropped,
// so a run with OP_TAG unset reports totals instead of silently reporting nothing.
const OP_RE = /(?:^|[?&])op=([^&]*)/;

const byOp = new Map();
let serverSpans = 0;
let labelled = 0;

const rl = readline.createInterface({ input: fs.createReadStream(file) });
rl.on('line', line => {
    if (!line.trim()) { return; }
    let arr;
    try { arr = JSON.parse(line); } catch { return; }
    for (const s of arr) {
        if (s.kind !== 'Server') { continue; }
        const a = s.attributes || {};
        const counters = Object.keys(a).filter(k => k.startsWith(prefix));
        if (!counters.length) { continue; }

        serverSpans++;
        const m = OP_RE.exec(a['url.query'] || '');
        if (m) { labelled++; }
        const op = m ? decodeURIComponent(m[1]) : '(unlabelled)';

        if (!byOp.has(op)) { byOp.set(op, { requests: 0, counters: new Map() }); }
        const entry = byOp.get(op);
        entry.requests++;
        for (const key of counters) {
            const short = key.slice(prefix.length);
            if (!entry.counters.has(short)) { entry.counters.set(short, []); }
            entry.counters.get(short).push(Number(a[key]) || 0);
        }
    }
});

function median(values) {
    const v = values.slice().sort((a, b) => a - b);
    const mid = v.length >> 1;

    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

rl.on('close', () => {
    if (!serverSpans) {
        console.error(`no server spans carry an attribute with prefix \`${prefix}\`.`);
        console.error('either the build under test predates the counters, the capture missed the load,');
        console.error('or the emitting code tagged Activity.Current instead of IHttpActivityFeature.');
        process.exit(2);
    }
    // A run where nothing is labelled produces output identical in shape to a correct one, so say it loudly.
    if (!labelled) {
        console.log(`WARNING: 0 of ${serverSpans} counter-bearing requests carry an \`op=\` label.`);
        console.log('  set OP_TAG=1 for the run, or this runtime does not record `url.query` on server spans.');
    }

    // A counter that never fires on an operation is absent from that operation's spans, not zero —
    // printing it as 0 would claim a measurement that was never taken.
    const allCounters = [...new Set([...byOp.values()].flatMap(e => [...e.counters.keys()]))].sort();
    console.log(`counters (per request), prefix \`${prefix}\`: ${allCounters.join(', ')}`);
    console.log('');
    console.log('op'.padEnd(26) + 'n'.padEnd(6) + allCounters.map(c => c.padEnd(24)).join(''));

    for (const [op, entry] of [...byOp.entries()].sort((a, b) => b[1].requests - a[1].requests)) {
        const cells = allCounters.map(c => {
            const v = entry.counters.get(c);
            if (!v) { return '-'.padEnd(24); }
            // Timings are continuous, so a min==max collapse would be an accident of rounding.
            const round = c.startsWith('time.') ? (x => Math.round(x * 10) / 10) : (x => x);
            const lo = round(Math.min(...v));
            const hi = round(Math.max(...v));
            const cell = lo === hi ? String(lo) : `${round(median(v))} [${lo}..${hi}] *`;

            return cell.padEnd(24);
        });
        console.log(op.padEnd(26) + String(entry.requests).padEnd(6) + cells.join(''));
    }

    console.log('');
    console.log('* = varies across requests (median [min..max]); a constant is a fixed cost per invocation.');
    console.log('- = the counter never fired on this operation (absent, not measured as zero).');
    console.log('`time.*` counters are accumulated milliseconds; the rest are exact counts.');
});

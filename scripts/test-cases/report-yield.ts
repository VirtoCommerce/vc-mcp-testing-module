/**
 * `npm run tc:yield` — what the test corpus actually caught, joined to how its
 * cases are written.
 *
 * This closes the loop the rest of the work could only predict. Assertion class
 * and step cost are properties of the case TEXT; this reads the OUTCOME out of
 * `reports/bugs/**` and puts the two side by side, so the claim "strong
 * assertions catch more" becomes checkable rather than argued.
 *
 * READ THE DENOMINATORS BEFORE THE RATIOS. On the day this shipped only ~22 of
 * 128 bug reports named a case, so every per-case number here rests on a small,
 * non-random sample: the reports that name a case are disproportionately the
 * ones found BY a regression run, which is exactly the population most likely to
 * have a case. That bias inflates "attributed" and it does not go away by
 * ignoring it — it goes away as the `**Found by:**` convention fills in. Until
 * then this is a baseline to measure drift against, not a verdict.
 *
 * It writes nothing. `bugs_found` is derived here and in compute-metrics.ts at
 * read time; nothing is transcribed into history.json (GOLDEN RULE).
 *
 * Usage:
 *   npx tsx scripts/test-cases/report-yield.ts [--json] [--unknown] [--limit N]
 */
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import {
  collectAttributions,
  indexAttributions,
  loadKnownCaseIds,
  type Attribution,
} from "../lib/defect-attribution.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const BUGS_ROOT = join(REPO_ROOT, "reports", "bugs");
const SUITES_ROOT = join(REPO_ROOT, "regression", "suites");


/** Shared CLI arg reading. Hand-rolled copies drifted: `--limit` was read as
 *  `argv[0]` when the flag was absent, so `--unknown` became NaN and silently
 *  emptied the report's main table. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
function intFlag(argv: readonly string[], flag: string, fallback: number): number {
  const raw = flagValue(argv, flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`✗ ${flag} expects a non-negative number, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "n/a";
}

function main(): void {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const showUnknown = argv.includes("--unknown");
  const limit = intFlag(argv, "--limit", 20);

  const known = loadKnownCaseIds(SUITES_ROOT);
  const rows: Attribution[] = collectAttributions(BUGS_ROOT, known);
  const idx = indexAttributions(rows);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          knownCaseIds: known.size,
          total: idx.total,
          attributed: idx.attributed,
          byCase: Object.fromEntries(idx.byCase),
          bySuite: Object.fromEntries(idx.bySuite),
          byRunSuite: Object.fromEntries(idx.byRunSuite),
          unattributedBySource: Object.fromEntries(idx.unattributedBySource),
          rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\nDefect attribution — ${idx.total} bug report(s), ${known.size} known case ids\n`);
  console.log(`  named a case ....... ${idx.attributed} (${pct(idx.attributed, idx.total)})`);
  console.log(`  did NOT ............ ${idx.total - idx.attributed} (${pct(idx.total - idx.attributed, idx.total)})`);

  console.log(`\n  Unattributed by how the bug was found — this is where cases AREN'T:`);
  const bySrc = [...idx.unattributedBySource.entries()].sort((a, b) => b[1] - a[1]);
  for (const [src, n] of bySrc) console.log(`    ${String(src).padEnd(12)} ${n}`);

  const caught = [...idx.byCase.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`\n  Cases credited with catching a bug: ${caught.length} of ${known.size} (${pct(caught.length, known.size)})`);
  for (const [id, bugs] of caught.slice(0, limit)) {
    console.log(`    ${id.padEnd(20)} ${bugs.length}  ${bugs[0]}`);
  }
  if (caught.length > limit) console.log(`    ... ${caught.length - limit} more`);

  const suites = [...idx.bySuite.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`\n  Suites credited: ${suites.length}`);
  for (const [id, bugs] of suites.slice(0, limit)) console.log(`    suite ${id.padEnd(6)} ${bugs.length}`);
  if (suites.length > limit) console.log(`    ... ${suites.length - limit} more`);

  const unknown = rows.flatMap((r) => r.unknownCaseIds);
  if (unknown.length) {
    console.log(
      `\n  ${unknown.length} case-shaped id(s) named by a bug do not exist in the corpus — renamed,` +
        `\n  retired, or a typo. Reported rather than dropped: a bug pointing at a case that is gone` +
        `\n  is a broken audit trail, not an absence.${showUnknown ? "" : " Re-run with --unknown to list."}`,
    );
    if (showUnknown) for (const u of [...new Set(unknown)].sort()) console.log(`    ${u}`);
  }

  console.log(
    `\n  DENOMINATOR WARNING: only ${idx.attributed} of ${idx.total} reports name a case, and those are` +
      `\n  disproportionately the ones found BY a regression run — the population most likely to have` +
      `\n  a case at all. Treat per-case numbers as a baseline to measure drift against, not a verdict.` +
      `\n  The bias shrinks as the **Found by:** convention (see .claude/commands/qa-bug.md) fills in.\n`,
  );
}

const isCli = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) main();

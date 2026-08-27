/**
 * Rank test cases by how much detection they buy for what they cost.
 *
 * WHY THIS EXISTS
 * ---------------
 * The corpus grows every day and a full regression is ~14 h of wall clock, but
 * roughly half of it buys nothing: 1,909 of 3,969 cases (48% — 53% on Frontend)
 * carry no assertion that can fail on a wrong value, and 66% of Frontend cases
 * are >=6-step walkthroughs. That combination is the worst possible trade: the
 * maximum cost to run and near-zero probability of catching anything, because a
 * presence check only fails when an element is absent entirely.
 *
 * This script makes that trade VISIBLE per case, with a reason for every verdict.
 * It deliberately prints reasons rather than a bare score: Google deployed a
 * bug-prediction score company-wide and measured no change in behaviour (Lewis
 * et al., ICSE 2013) — an unexplained number gets ignored, so the output has to
 * say WHY a case is weak and what would fix it.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a yield measurement. "Has this case ever caught a bug?" is still not
 * computable here: history.json is suite-granular, its `bugs_found` is empty in
 * every row, and per-case `durationMs` is written by the runner then discarded at
 * fold. So this ranks by assertion STRENGTH and STEP COST — properties of the
 * case text — and says so. When per-case history lands, `yield` becomes a fourth
 * signal; until then no verdict here claims a case is dead, only that it cannot
 * discriminate.
 *
 * FAIL-CLOSED, in the expensive direction
 * ---------------------------------------
 * A wrongly demoted case silently removes coverage; a wrongly kept one costs
 * minutes. So every doubt resolves to KEEP, and DEMOTE requires ALL of:
 * presence-only assertions AND >=6 steps AND not on the risk floor AND no
 * deliberate design stamp. Anything cheap, high-priority or deliberately
 * designed is STRENGTHEN (fix the assertion) — never DEMOTE.
 *
 * Usage:
 *   npx tsx scripts/test-cases/rank-cases.ts [--suite <csv>] [--layer frontend|backend]
 *                                            [--verdict DEMOTE|STRENGTHEN|KEEP] [--json] [--limit N]
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { parseSuite, type Row } from "./append-test-cases-to-suite.js";
import { classifyAssertionStrength, hasDiscriminatingAssertion } from "./lint-test-cases.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SUITES_ROOT = join(REPO_ROOT, "regression", "suites");

/** Steps at or above which a case is "expensive to run" (long walkthrough). */
export const EXPENSIVE_STEPS = 6;
/** Priorities that are never demoted regardless of assertion strength. */
export const RISK_FLOOR = new Set(["Critical", "P0"]);
/** Statuses whose cases actually consume regression time today. */
const RUNNING_STATUSES = new Set(["Automated", "Draft", "Reviewed", "Semi-Automated", ""]);

export type Verdict = "KEEP" | "STRENGTHEN" | "DEMOTE";

export interface CaseRank {
  id: string;
  suite: string;
  priority: string;
  status: string;
  /** Strongest assertion class present. */
  best: string;
  discriminating: boolean;
  steps: number;
  assertions: number;
  hasDesignStamp: boolean;
  verdict: Verdict;
  /** Human-readable, one clause per contributing signal. */
  reasons: string[];
}

function lines(cell: string): string[] {
  return (cell ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Strongest class present, by the ladder's own order. */
export function bestStrength(assertionLines: readonly string[]): string {
  const order = ["INV", "REL", "DER", "SHAPE", "PRES", "UNKNOWN"];
  let bestIdx = order.length - 1;
  for (const l of assertionLines) {
    const idx = order.indexOf(classifyAssertionStrength(l));
    if (idx >= 0 && idx < bestIdx) bestIdx = idx;
  }
  return assertionLines.length ? order[bestIdx] : "NONE";
}

/** Pure ranking of one row. Exported so the tests exercise it without file IO. */
export function rankCase(row: Row, suite: string): CaseRank {
  const aLines = lines(row.Assertions);
  const sLines = lines(row.Steps);
  const discriminating = hasDiscriminatingAssertion(aLines);
  const priority = (row.Priority ?? "").trim();
  const status = (row.Automation_Status ?? "").trim();
  const refs = row.References ?? "";
  // A stamp means a human/agent deliberately declared what defect this probes
  // (the /qa-test Step 1e contract). Deliberate design is evidence of intent, so
  // it blocks demotion even when the assertions are currently weak.
  const hasDesignStamp = /\bArchetype:\s*[A-Za-z]/.test(refs);

  const reasons: string[] = [];
  let verdict: Verdict = "KEEP";

  if (!aLines.length) {
    reasons.push("no assertions at all — the case checks nothing");
    verdict = RISK_FLOOR.has(priority) ? "STRENGTHEN" : "DEMOTE";
  } else if (!discriminating) {
    reasons.push(
      `every assertion is presence-only (${bestStrength(aLines)}) — cannot fail on a wrong value`,
    );
    verdict = "STRENGTHEN";
    if (
      sLines.length >= EXPENSIVE_STEPS &&
      !RISK_FLOOR.has(priority) &&
      !hasDesignStamp
    ) {
      reasons.push(`${sLines.length} steps to run for a check that cannot discriminate`);
      verdict = "DEMOTE";
    }
  }

  // Explain every block on demotion, so a KEEP/STRENGTHEN is attributable too.
  if (!discriminating && verdict !== "DEMOTE") {
    if (RISK_FLOOR.has(priority)) reasons.push(`${priority} — risk floor, never demoted; fix it instead`);
    if (hasDesignStamp) reasons.push("carries a deliberate Archetype stamp — strengthen, do not retire");
    if (sLines.length < EXPENSIVE_STEPS) reasons.push(`only ${sLines.length} steps — cheap to keep and fix`);
  }
  if (discriminating) reasons.push(`strongest assertion class: ${bestStrength(aLines)}`);
  if (!RUNNING_STATUSES.has(status)) {
    reasons.push(`Automation_Status "${status}" — already out of the regression lane`);
    verdict = "KEEP";
  }

  return {
    id: row.ID ?? "<no id>",
    suite,
    priority,
    status,
    best: bestStrength(aLines),
    discriminating,
    steps: sLines.length,
    assertions: aLines.length,
    hasDesignStamp,
    verdict,
    reasons,
  };
}

function collectSuites(layer?: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".csv")) out.push(full);
    }
  };
  walk(SUITES_ROOT);
  if (!layer) return out.sort();
  const want = layer.toLowerCase() === "frontend" ? "Frontend" : "Backend";
  return out.filter((f) => f.includes(`${sep}${want}${sep}`)).sort();
}

export function rankSuiteFile(file: string): CaseRank[] {
  const text = readFileSync(file, "utf-8");
  let rows: Row[];
  try {
    rows = parseSuite(text).rows;
  } catch {
    // A legacy-header or unparsable suite is REPORTED, never silently skipped —
    // absence from a ranking reads as "nothing to fix here", which is a lie.
    return [
      {
        id: "<unparsable>", suite: file, priority: "", status: "", best: "NONE",
        discriminating: false, steps: 0, assertions: 0, hasDesignStamp: false,
        verdict: "KEEP",
        reasons: ["suite is not field-parsable (legacy header?) — excluded from ranking, not cleared"],
      },
    ];
  }
  const rel = file.slice(REPO_ROOT.length + 1);
  return rows.map((r) => rankCase(r, rel));
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const asJson = argv.includes("--json");
  const suite = get("--suite");
  const layer = get("--layer");
  const wantVerdict = get("--verdict");
  const limit = Number(get("--limit") ?? "40");

  const files = suite ? [resolve(suite)] : collectSuites(layer);
  let ranks = files.flatMap(rankSuiteFile);
  const total = ranks.length;
  if (wantVerdict) ranks = ranks.filter((r) => r.verdict === wantVerdict.toUpperCase());

  const counts = { KEEP: 0, STRENGTHEN: 0, DEMOTE: 0 } as Record<Verdict, number>;
  for (const r of files.flatMap(rankSuiteFile)) counts[r.verdict]++;

  if (asJson) {
    console.log(JSON.stringify({ total, counts, cases: ranks }, null, 2));
    return;
  }

  console.log(`\nRanked ${total} case(s) across ${files.length} suite(s)`);
  console.log(
    `  KEEP ${counts.KEEP}   STRENGTHEN ${counts.STRENGTHEN}   DEMOTE-candidate ${counts.DEMOTE}\n`,
  );
  // Worst first: DEMOTE, then most steps wasted.
  const order: Record<Verdict, number> = { DEMOTE: 0, STRENGTHEN: 1, KEEP: 2 };
  ranks.sort((a, b) => order[a.verdict] - order[b.verdict] || b.steps - a.steps);
  for (const r of ranks.slice(0, limit)) {
    console.log(`${r.verdict.padEnd(10)} ${r.id.padEnd(18)} ${r.priority.padEnd(9)} ${r.steps}st/${r.assertions}as  ${r.suite.split(sep).pop()}`);
    for (const why of r.reasons) console.log(`           · ${why}`);
  }
  if (ranks.length > limit) console.log(`\n… ${ranks.length - limit} more (raise --limit or use --json)`);
  console.log(
    `\nRanked by assertion strength and step cost — NOT by measured yield.\n` +
      `"Has this case ever caught a bug?" is not computable yet (history.json is suite-granular,\n` +
      `bugs_found is empty in every row, per-case durationMs is discarded at fold). No verdict here\n` +
      `claims a case is dead — only that it cannot discriminate. DEMOTE means "stop paying for it in\n` +
      `regression", never "delete it".`,
  );
}

const isCli = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) main();

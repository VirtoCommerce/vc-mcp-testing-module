/**
 * Per-CASE lane classification — the single decision point for "can the runner execute
 * this row, or does it need a browser agent?"
 *
 * WHY THIS EXISTS. Lane routing is a SUITE-level decision today, and the rule is
 * all-or-nothing: `ci/lib/lane-classifier.ts` sends a suite to the fast path only when
 * EVERY non-empty `Steps` cell carries a runner op tag. That rule is right for its job —
 * handing a runner a row it cannot parse manufactures BLOCKED cases that read as product
 * failures — but its cost is measured: **188 machine-ready rows in 14 mixed suites** ride
 * the browser lane because a handful of their siblings are prose. Suite 050h is the
 * clearest case: 29 of 34 rows are runner-native, and one explicitly-Manual case
 * (WISH-009) sends all 34 through a browser agent.
 *
 * The point is not mainly speed. At the measured ~29% artefactual-BLOCKED rate for long
 * agent sessions, roughly 54 of those 188 rows currently return BLOCKED for reasons about
 * HOW they ran — a contaminated cart, a drifted session — rather than about the product.
 * Routing them to the runner turns those into real verdicts.
 *
 * THE CLASSIFIER DELEGATES TO THE EXECUTOR'S OWN PARSER. It does not pattern-match tags
 * with a private regex: it calls `parseSteps` / `validateStepBlocks` (the modules
 * `scripts/graphql/graphql-runner.ts` itself uses) and `parseAssertions` /
 * `classifyPredicateScoreability` (the modules that score its verdicts). A static verdict
 * derived from a second, similar-looking implementation is exactly how a classifier and a
 * runtime drift apart, and the failure mode is a case routed to a runner that cannot run
 * it. Same reason `lint-test-cases.ts` T-005 delegates rather than re-deriving.
 *
 * FAIL-CLOSED. Every uncertainty routes to `browser`, which is the status quo — so a
 * classifier bug costs the wall-clock saving, never a verdict. Being wrong the other way
 * (claiming a row is machine-ready when it is not) produces a BLOCKED that looks like a
 * product failure, which is the expensive direction.
 */
import { parseSteps, validateStepBlocks, type StepBlock } from "./graphql-case-parser.js";
import { classifyPredicateScoreability, parseAssertions } from "./graphql-assertions.js";

/**
 * Bumped whenever a routing decision changes. Recorded in every lanes file so a stale
 * plan can be detected rather than silently followed.
 */
export const CLASSIFIER_VERSION = "1.0.0";

export type CaseLane = "machine" | "browser" | "manual";

/** Reason codes — a closed vocabulary, deliberately not prose. */
export type BlockerCode =
  | "EX-002" // no Steps to execute
  | "EX-003" // runner op blocks are structurally invalid (unmatched OP/EXEC, undeclared label)
  | "EX-010" // a step line the executor's parser cannot type
  | "EX-011" // no runner op at all — this is browser prose
  | "EX-101" // no scoreable assertion: the runner would have nothing to judge
  | "EX-102" // an assertion the runner cannot score
  | "EX-200"; // explicitly Manual — a human decision, respected

export interface CaseVerdict {
  id: string;
  lane: CaseLane;
  /** Empty exactly when `lane === "machine"`. `code` + the offending token, never prose. */
  blockers: Array<{ code: BlockerCode; detail: string }>;
}

/** The columns the classifier reads. A subset of the enriched CSV, so tests need no fixture file. */
export interface ClassifiableRow {
  ID: string;
  Steps: string;
  Assertions: string;
  Automation_Status?: string;
}

const RUNNER_OP_KINDS = new Set<StepBlock["kind"]>([
  "GQL-OP",
  "GQL-EXEC",
  "REST",
  "REST-OP",
  "REST-EXEC",
]);

/**
 * `Manual` is the ONE field value that routes a case, and only in the opt-out direction.
 * `Automation_Status` carries 23 distinct values across the corpus (case-dupes, free text
 * like `'Draft (SERIAL — isolate; restore ALL after)'`), so it cannot be trusted to route
 * anything positively — but an explicit `Manual` is a human saying "a person runs this",
 * and overriding that with a compiler verdict would be the wrong kind of clever.
 * Suite 050h's WISH-009 is the worked example.
 */
function isExplicitlyManual(row: ClassifiableRow): boolean {
  return (row.Automation_Status ?? "").trim().toLowerCase() === "manual";
}

export function classifyCase(row: ClassifiableRow): CaseVerdict {
  const id = (row.ID ?? "").trim();
  const blockers: CaseVerdict["blockers"] = [];

  if (isExplicitlyManual(row)) {
    return { id, lane: "manual", blockers: [{ code: "EX-200", detail: "Automation_Status=Manual" }] };
  }

  const steps = (row.Steps ?? "").trim();
  if (!steps) {
    return { id, lane: "browser", blockers: [{ code: "EX-002", detail: "empty Steps" }] };
  }

  const blocks = parseSteps(row.Steps);

  // A line the executor's own parser could not type. It would be silently skipped at
  // runtime, so the case would report a verdict on a subset of its own steps.
  for (const b of blocks) {
    if (b.kind === "UNKNOWN") blockers.push({ code: "EX-010", detail: b.tag || b.raw.slice(0, 40) });
  }

  if (!blocks.some((b) => RUNNER_OP_KINDS.has(b.kind))) {
    blockers.push({ code: "EX-011", detail: "no [GQL-OP]/[GQL-EXEC]/[REST*] block" });
  }

  for (const err of validateStepBlocks(blocks)) blockers.push({ code: "EX-003", detail: err });

  // Assertions: EVERY predicate must be scoreable, not merely one of them.
  //
  // The runner's verdict is `failed === 0 && results.length > 0 ? PASS`. A case mixing one
  // scoreable predicate with three prose ones would therefore PASS on the strength of the
  // one — a false green earned by the runner not understanding the other three. This is
  // the same "silence is never a pass" rule `layout-runner.ts` enforces at runtime, applied
  // one step earlier so the row never reaches the runner at all. `info` assertions
  // ({OBSERVED}/{HYPOTHESIS} evidence journal) are not predicates and are excluded.
  const { assertions } = parseAssertions(row.Assertions ?? "");
  if (assertions.length === 0) {
    blockers.push({ code: "EX-101", detail: "no scoreable assertion" });
  }
  for (const a of assertions) {
    if (classifyPredicateScoreability(a) !== "scoreable") {
      blockers.push({ code: "EX-102", detail: `[${a.kind}] ${a.predicate.slice(0, 40)}` });
    }
  }

  return { id, lane: blockers.length === 0 ? "machine" : "browser", blockers };
}

export interface SuiteLanes {
  machine: string[];
  browser: string[];
  manual: string[];
  verdicts: CaseVerdict[];
}

/** Classify a whole suite, preserving CSV row order within each lane. */
export function classifySuiteCases(rows: readonly ClassifiableRow[]): SuiteLanes {
  const verdicts = rows.map(classifyCase);
  return {
    machine: verdicts.filter((v) => v.lane === "machine").map((v) => v.id),
    browser: verdicts.filter((v) => v.lane === "browser").map((v) => v.id),
    manual: verdicts.filter((v) => v.lane === "manual").map((v) => v.id),
    verdicts,
  };
}

/** Blocker-code tally, cheapest-to-fix first — the burn-down view. */
export function blockerHistogram(verdicts: readonly CaseVerdict[]): Array<{ code: BlockerCode; count: number }> {
  const counts = new Map<BlockerCode, number>();
  for (const v of verdicts) {
    // Count a case once per distinct code, not once per occurrence.
    for (const code of new Set(v.blockers.map((b) => b.code))) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
}

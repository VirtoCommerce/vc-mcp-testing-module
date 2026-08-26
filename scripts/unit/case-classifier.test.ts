// Unit tests for scripts/lib/case-classifier.ts — the per-case lane decision.
//
// The expensive failure this guards is one-directional. Routing a machine-ready row to the
// browser costs wall-clock. Routing a row the runner CANNOT parse to the runner produces a
// BLOCKED that reads as a product failure — the runner reports a verdict on a subset of the
// case's own steps, and nobody can tell from the report. So most of these tests assert
// FAIL-CLOSED: on any doubt the answer must be `browser`, which is the status quo.
//
// Run: `npx tsx --test scripts/unit/case-classifier.test.ts` / `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  blockerHistogram,
  classifyCase,
  classifySuiteCases,
  CLASSIFIER_VERSION,
  type ClassifiableRow,
} from "../lib/case-classifier.ts";
import { parseSuite } from "../test-cases/append-test-cases-to-suite.ts";
import { loadManifest } from "../../ci/lib/suite-manifest.ts";
import { classifyLane } from "../../ci/lib/lane-classifier.ts";

/**
 * A minimal runner-native case, in the grammar the runner actually parses (see the
 * gold-standard suite 050i): the op tag stands alone and the query follows on indented
 * lines; assertions carry `label=`.
 */
function machineRow(over: Partial<ClassifiableRow> = {}): ClassifiableRow {
  return {
    ID: "GQL-001",
    Steps: ["[GQL-OP cart]", "  query { cart { id itemsQuantity } }", "[GQL-EXEC cart]"].join("\n"),
    Assertions: "[ERRORS label=cart] errors[] empty",
    Automation_Status: "Automated",
    ...over,
  };
}

const codesOf = (row: ClassifiableRow) => classifyCase(row).blockers.map((b) => b.code);

// ---- the happy path ----------------------------------------------------------------

test("a fully runner-native case routes to the machine lane with no blockers", () => {
  const v = classifyCase(machineRow());
  assert.equal(v.lane, "machine");
  assert.deepEqual(v.blockers, [], "a machine verdict must carry no blockers");
  assert.equal(v.id, "GQL-001");
});

test("blockers are empty EXACTLY when the lane is machine", () => {
  // The invariant the rest of the pipeline relies on to explain itself.
  const rows = [
    machineRow(),
    machineRow({ Steps: "[ACT] click the 'Sign up' button" }),
    machineRow({ Automation_Status: "Manual" }),
    machineRow({ Steps: "" }),
  ];
  for (const r of rows) {
    const v = classifyCase(r);
    assert.equal(v.blockers.length === 0, v.lane === "machine", `${v.lane} with ${v.blockers.length} blockers`);
  }
});

// ---- each blocker code -------------------------------------------------------------

test("EX-200: an explicit Manual is respected, not overruled by the compiler", () => {
  // Suite 050h's WISH-009 is the worked example: a human decided a person runs it. A
  // classifier that "knows better" here silently deletes that decision.
  const v = classifyCase(machineRow({ Automation_Status: "Manual" }));
  assert.equal(v.lane, "manual");
  assert.deepEqual(codesOf(machineRow({ Automation_Status: "Manual" })), ["EX-200"]);
  // Case-insensitive, whitespace-tolerant — the column has 23 distinct values in the corpus.
  assert.equal(classifyCase(machineRow({ Automation_Status: "  manual " })).lane, "manual");
  // But only the EXACT value opts out. Free text that merely contains it does not.
  assert.notEqual(classifyCase(machineRow({ Automation_Status: "Draft (was Manual)" })).lane, "manual");
});

test("EX-002: an empty Steps cell is browser, never machine", () => {
  assert.deepEqual(codesOf(machineRow({ Steps: "   " })), ["EX-002"]);
  assert.equal(classifyCase(machineRow({ Steps: "" })).lane, "browser");
});

test("EX-011: browser prose with no runner op stays on the browser lane", () => {
  const v = classifyCase(
    machineRow({ Steps: "[NAV] {{FRONT_URL}}/cart\n[ACT] click 'Checkout'", Assertions: "[DOM] order confirmation visible" }),
  );
  assert.equal(v.lane, "browser");
  assert.ok(v.blockers.some((b) => b.code === "EX-011"));
});

test("EX-010: a step line the executor's parser cannot type blocks the case", () => {
  // The runner would skip the line silently and then report a verdict on the rest — the
  // case would look decided when it was only partly executed.
  const v = classifyCase(
    machineRow({ Steps: "[GQL-OP c]\n  query { cart { id } }\n[GQL-EXEC c]\n[TOTALLY-MADE-UP] do a thing" }),
  );
  assert.equal(v.lane, "browser");
  assert.ok(v.blockers.some((b) => b.code === "EX-010"), JSON.stringify(v.blockers));
});

test("EX-003: structurally invalid op blocks are caught by the executor's own validator", () => {
  // A [GQL-OP] with no matching [GQL-EXEC] never sends anything.
  const v = classifyCase(machineRow({ Steps: "[GQL-OP cart]\n  query { cart { id } }" }));
  assert.equal(v.lane, "browser");
  assert.ok(v.blockers.some((b) => b.code === "EX-003"), JSON.stringify(v.blockers));
});

test("EX-101: a case with nothing scoreable to assert can never be machine", () => {
  // `layout-runner.ts`'s rule, applied one step earlier: silence is never a pass. The
  // runner's verdict is `failed === 0 && results.length > 0`, so a case with zero parsed
  // assertions would otherwise be judged by nothing at all.
  const v = classifyCase(machineRow({ Assertions: "" }));
  assert.equal(v.lane, "browser");
  assert.ok(v.blockers.some((b) => b.code === "EX-101"));
});

test("EX-102: ONE prose assertion among scoreable ones is enough to block", () => {
  // This is the rule most worth being strict about. The runner would score the parseable
  // predicate, find nothing failed, and return PASS — a green earned by not understanding
  // the other assertions.
  const v = classifyCase(
    machineRow({
      Assertions: "[ERRORS label=cart] errors[] empty\n[DATA label=cart] the cart looks about right to a human",
    }),
  );
  assert.equal(v.lane, "browser", "a mixed assertion block must not be machine-executed");
  assert.ok(v.blockers.some((b) => b.code === "EX-102"), JSON.stringify(v.blockers));
});

test("a blocker's detail names the offending token, so a burn-down is actionable", () => {
  const v = classifyCase(machineRow({ Steps: "[GQL-OP c]\n  q\n[GQL-EXEC c]\n[NOPE] x" }));
  const b = v.blockers.find((x) => x.code === "EX-010")!;
  assert.ok(b.detail.length > 0, "a blocker with no detail cannot be acted on");
  assert.ok(/NOPE/i.test(b.detail), `detail should name the tag, got "${b.detail}"`);
});

// ---- suite-level shape -------------------------------------------------------------

test("classifySuiteCases partitions every case exactly once, in CSV order", () => {
  const rows: ClassifiableRow[] = [
    machineRow({ ID: "A-001" }),
    machineRow({ ID: "A-002", Automation_Status: "Manual" }),
    machineRow({ ID: "A-003", Steps: "[ACT] click 'x'" }),
    machineRow({ ID: "A-004" }),
  ];
  const r = classifySuiteCases(rows);
  assert.deepEqual(r.machine, ["A-001", "A-004"], "machine ids keep CSV order");
  assert.deepEqual(r.manual, ["A-002"]);
  assert.deepEqual(r.browser, ["A-003"]);
  assert.equal(r.machine.length + r.browser.length + r.manual.length, rows.length);
  assert.equal(r.verdicts.length, rows.length);
});

test("an empty suite classifies cleanly instead of throwing", () => {
  const r = classifySuiteCases([]);
  assert.deepEqual(r, { machine: [], browser: [], manual: [], verdicts: [] });
});

test("blockerHistogram counts each case once per distinct code", () => {
  // Two EX-010s in one case is one case needing attention, not two.
  const row = machineRow({ Steps: "[GQL-OP c]\n  q\n[GQL-EXEC c]\n[NOPE] a\n[ALSO-NOPE] b" });
  const h = blockerHistogram([classifyCase(row)]);
  assert.deepEqual(h, [{ code: "EX-010", count: 1 }]);
});

test("CLASSIFIER_VERSION is a semver string — a lanes file records it to detect staleness", () => {
  assert.match(CLASSIFIER_VERSION, /^\d+\.\d+\.\d+$/);
});

// ---- against the real corpus -------------------------------------------------------
//
// These are the numbers the whole change exists for. Asserted against the actual suites so
// a regression in the classifier shows up as a drop in routable rows rather than as a
// quieter run nobody questions.

const manifest = loadManifest();

function classifyRealSuite(file: string) {
  const parsed = parseSuite(readFileSync(file, "utf-8").replace(/^﻿/, ""));
  return classifySuiteCases(parsed.rows as unknown as ClassifiableRow[]);
}

test("the corpus has a meaningful machine-executable share", () => {
  let cases = 0;
  let machine = 0;
  for (const s of manifest.suites) {
    let r;
    try { r = classifyRealSuite(s.file); } catch { continue; }
    cases += r.verdicts.length;
    machine += r.machine.length;
  }
  assert.ok(cases > 4000, `expected the full corpus, saw ${cases} cases`);
  assert.ok(
    machine >= 520,
    `machine-executable rows dropped to ${machine} of ${cases} — the classifier got stricter, or cases regressed`,
  );
});

test("mixed suites strand machine-ready rows on the browser lane — the thing this fixes", () => {
  let stranded = 0;
  const suites: string[] = [];
  for (const s of manifest.suites) {
    if (classifyLane(s) !== "browser") continue; // already on a machine lane
    let r;
    try { r = classifyRealSuite(s.file); } catch { continue; }
    if (r.machine.length > 0) {
      stranded += r.machine.length;
      suites.push(s.id);
    }
  }
  assert.ok(stranded >= 150, `expected >= 150 stranded rows, found ${stranded} in ${suites.join(",")}`);
  assert.ok(suites.includes("050d") && suites.includes("050h"), `expected the known mixed suites, got ${suites}`);
});

test("050d agrees with the human judgement recorded in REG-2026-08-24-1806", () => {
  // That run's notes put 050d on the browser lane by hand, with the reason: 46 of its 49
  // cases are runner-native and 3 are not. The classifier must reach the same split — this
  // is the one place the corpus records a person doing this job correctly.
  const suite = manifest.suites.find((s) => s.id === "050d")!;
  const r = classifyRealSuite(suite.file);
  assert.equal(r.machine.length, 46, "050d's machine count no longer matches the recorded human split");
  assert.equal(r.browser.length + r.manual.length, 3);
});

test("087 has no browser cases at all — a whole suite can leave the browser pool", () => {
  // 12 machine + 3 explicitly Manual. Under the all-or-nothing suite rule this occupies a
  // browser slot to run zero browser cases.
  const suite = manifest.suites.find((s) => s.id === "087")!;
  const r = classifyRealSuite(suite.file);
  assert.equal(r.browser.length, 0, "087 gained a browser case — it can no longer skip the browser pool");
  assert.ok(r.machine.length >= 12);
  assert.ok(r.manual.length >= 1, "its Manual cases must still be reported, never silently dropped");
});

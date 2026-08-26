// Unit tests for ci/lib/suite-caps.ts — the DERIVED per-suite execution caps.
//
// These assert against the REAL config/test-suites.json, not a fixture. The whole point of
// the module is that the old global constants were arithmetically wrong for the actual
// corpus, so a fixture would let the bug back in the moment the manifest changed.
//
// Run: `npx tsx --test scripts/unit/suite-caps.test.ts` / `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  budgetFor,
  caseCountOf,
  globalBudgetFor,
  maxTurnsFor,
  minutesOf,
  timeoutMsFor,
  SETUP_TURNS,
  TURNS_PER_CASE,
  TURNS_MIN,
  TURNS_MAX,
  TIMEOUT_MIN_MINUTES,
  TIMEOUT_MAX_MINUTES,
} from "../../ci/lib/suite-caps.ts";

interface ManifestSuite {
  id: string;
  testCount: number;
  estimatedMinutes: number;
}

const manifest = JSON.parse(readFileSync("config/test-suites.json", "utf-8")) as {
  suites: ManifestSuite[];
  selections: Record<string, { all?: true; include?: string[]; exclude?: string[] }>;
};

function suite(id: string): ManifestSuite {
  const found = manifest.suites.find((s) => s.id === id);
  assert.ok(found, `manifest is missing suite ${id} — update this test, do not delete it`);
  return found;
}

/** Resolve a simple `{all,exclude}` / `{include}` selection. */
function selection(name: string): ManifestSuite[] {
  const rule = manifest.selections[name];
  assert.ok(rule, `manifest is missing selection "${name}"`);
  if (rule.include) return rule.include.map((id) => suite(id));
  const excluded = new Set(rule.exclude ?? []);
  return manifest.suites.filter((s) => !excluded.has(s.id));
}

// ---- suite 078: the suite every old default got wrong -------------------------------
//
// 115 cases, 83 estimated minutes. Under the old constants it got 100 turns (fewer than it
// has cases) and a 10-minute timeout (12% of its estimate), and reported the resulting
// truncation as "not a real failure".

test("078: turn cap exceeds its case count instead of falling short of it", () => {
  const s = suite("078");
  const turns = maxTurnsFor(s);
  assert.equal(s.testCount, 115, "manifest drift: 078's case count changed");
  assert.equal(turns, SETUP_TURNS + s.testCount * TURNS_PER_CASE);
  assert.ok(turns >= 690, `expected >= 690 turns, got ${turns}`);
  assert.ok(turns > s.testCount, "a turn cap below the case count guarantees truncation");
  assert.ok(turns > 100, "must beat the old global MAX_TURNS=100");
});

test("078: timeout exceeds its own estimate instead of cutting it at 12%", () => {
  const s = suite("078");
  const minutes = timeoutMsFor(s) / 60_000;
  assert.equal(s.estimatedMinutes, 83, "manifest drift: 078's estimate changed");
  assert.ok(minutes > s.estimatedMinutes, "a timeout below the estimate is a guaranteed kill");
  assert.ok(minutes >= 175, `expected the ceiling to apply, got ${minutes}`);
  assert.ok(minutes > 10, "must beat the old global 10-minute SUITE_TIMEOUT_MS");
});

// The invariant, checked across the WHOLE manifest rather than the suites we thought of.
// This is what caught the first draft's flat 180-minute ceiling, which would have killed
// suite 050m (estimated 245 min) before its own expected duration — recreating the exact
// defect this module fixes.
test("EVERY manifest suite gets a timeout strictly greater than its own estimate", () => {
  const offenders = manifest.suites
    .map((s) => ({ id: s.id, estimate: minutesOf(s), timeout: timeoutMsFor(s) / 60_000 }))
    .filter((s) => s.timeout <= s.estimate);
  assert.deepEqual(
    offenders,
    [],
    `these suites would be killed before their estimate: ${offenders
      .map((o) => `${o.id} (${o.timeout} <= ${o.estimate})`)
      .join(", ")}`,
  );
});

test("EVERY manifest suite gets more turns than it has cases", () => {
  const offenders = manifest.suites
    .filter((s) => s.testCount > 0)
    .map((s) => ({ id: s.id, cases: s.testCount, turns: maxTurnsFor(s) }))
    .filter((s) => s.turns <= s.cases);
  assert.deepEqual(
    offenders,
    [],
    `these suites cannot reach their last case: ${offenders
      .map((o) => `${o.id} (${o.turns} turns for ${o.cases} cases)`)
      .join(", ")}`,
  );
});

// ---- `full`: the selection that could never finish under its own budget -------------

test("full: derived global budget covers the selection, unlike the old $80 default", () => {
  const suites = selection("full");
  const minutes = suites.reduce((sum, s) => sum + minutesOf(s), 0);
  assert.equal(suites.length, 116, "manifest drift: full's suite count changed");
  assert.equal(minutes, 2775, "manifest drift: full's total estimate changed");

  const budget = globalBudgetFor(suites);
  assert.ok(budget >= 140, `expected >= $140, got $${budget.toFixed(2)}`);
  assert.ok(budget > 80, "must beat the workflow's old MAX_BUDGET_USD=80, which always truncated");
});

test("smoke: derived budget is proportionally small, not a flat floor", () => {
  const smoke = globalBudgetFor(selection("smoke"));
  const full = globalBudgetFor(selection("full"));
  assert.ok(smoke > 0);
  assert.ok(smoke < full / 10, "a 2-suite selection must not be budgeted like the whole corpus");
});

// ---- clamps and degenerate inputs --------------------------------------------------

test("turn cap clamps at both ends", () => {
  assert.equal(maxTurnsFor({ testCount: 0 }), TURNS_MIN, "a zero-case suite still gets the floor");
  assert.equal(maxTurnsFor({}), TURNS_MIN, "a suite with no testCount gets the floor, not NaN");
  assert.equal(maxTurnsFor({ testCount: 100_000 }), TURNS_MAX, "an absurd count is capped");
});

test("timeout clamps at the floor, and the ceiling never undercuts the estimate", () => {
  assert.equal(timeoutMsFor({}) / 60_000, TIMEOUT_MIN_MINUTES, "no estimate => floor, not zero");
  assert.equal(timeoutMsFor({ estimatedMinutes: 1 }) / 60_000, TIMEOUT_MIN_MINUTES);
  // A suite far above the normal ceiling still gets more than its estimate, not the ceiling.
  const huge = timeoutMsFor({ estimatedMinutes: 10_000 }) / 60_000;
  assert.ok(huge > 10_000, `ceiling must yield to the estimate, got ${huge}`);
  // A suite below the ceiling is capped by it.
  assert.equal(timeoutMsFor({ estimatedMinutes: 100 }) / 60_000, TIMEOUT_MAX_MINUTES);
});

test("degenerate manifest values never produce NaN", () => {
  for (const bad of [
    { testCount: Number.NaN, estimatedMinutes: Number.NaN },
    { testCount: -5, estimatedMinutes: -5 },
    { testCount: Number.POSITIVE_INFINITY, estimatedMinutes: Number.POSITIVE_INFINITY },
  ]) {
    assert.ok(Number.isFinite(maxTurnsFor(bad)), `maxTurnsFor(${JSON.stringify(bad)}) not finite`);
    assert.ok(Number.isFinite(timeoutMsFor(bad)), `timeoutMsFor(${JSON.stringify(bad)}) not finite`);
    assert.ok(Number.isFinite(minutesOf(bad)));
    assert.ok(Number.isFinite(caseCountOf(bad)));
  }
});

// ---- per-suite budget --------------------------------------------------------------

test("budgetFor: takes the larger of own-size and proportional share", () => {
  const small = { estimatedMinutes: 10 };
  // Plenty remaining => the proportional share dominates.
  const rich = budgetFor(small, 100, 20);
  assert.ok(rich > 10 * 0.04 * 1.25, "with head-room the share should win");
  // Nothing remaining => falls back to what the suite itself implies, never 0.
  const poor = budgetFor(small, 0, 20);
  assert.ok(poor > 0, "a suite must never be dispatched with a zero budget");
});

test("budgetFor: remainingMinutes of 0 does not divide by zero", () => {
  const b = budgetFor({ estimatedMinutes: 10 }, 50, 0);
  assert.ok(Number.isFinite(b) && b > 0, `expected a finite positive budget, got ${b}`);
});

test("budgetFor: a bigger suite is never budgeted below a smaller one", () => {
  const remaining = 100;
  const totalMinutes = 200;
  const big = budgetFor({ estimatedMinutes: 100 }, remaining, totalMinutes);
  const small = budgetFor({ estimatedMinutes: 5 }, remaining, totalMinutes);
  assert.ok(big > small, "budget must scale with the work");
});

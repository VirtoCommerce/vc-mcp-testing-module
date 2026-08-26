// Unit tests for the per-case lane CLIs: scripts/regression/plan-lanes.ts and the
// evidence-reading helpers in scripts/regression/machine-lane.ts.
//
// The classifier and the merger are tested in their own files. What is tested HERE is the
// glue that can lose or corrupt data on disk:
//
//   - the legacy-header refusal. `parseSuite` maps fields POSITIONALLY, so on one of the 11
//     surviving 11-column suites the legacy `Steps` lands in `Test_Data` and `Expected
//     Result` lands in `Steps`. Classifying that file would route cases confidently on the
//     wrong cells. The planner must REFUSE (exit 2), never guess.
//   - the browser CSV. It must carry the canonical header and exactly the browser rows, and
//     it must be readable by the same parser the agents use.
//
// Run: `npx tsx --test scripts/unit/lane-planner.test.ts` / `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMNS, parseSuite } from "../test-cases/append-test-cases-to-suite.ts";
import { evidenceFileFrom, failedAssertionFrom } from "../regression/machine-lane.ts";

const scratch = mkdtempSync(join(tmpdir(), "lane-planner-"));
const PLANNER = join("scripts", "regression", "plan-lanes.ts");

/**
 * Run a `.ts` CLI portably.
 *
 * NOT `spawnSync("npx", …)`: on Windows the executable is `npx.cmd`, so a bare "npx" ENOENTs
 * and every CLI test fails on that leg only. The repo already documents this trap
 * (`scripts/test-data/author-fixtures.ts`) and its own tests use `process.execPath`
 * (`ado-form-visibility.test.mjs`). Invoking tsx's CLI entry directly keeps that convention
 * and needs no shell, so a temp path with a space cannot be re-split by one.
 */
const TSX_CLI = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, PLANNER, ...args], { encoding: "utf-8", env: process.env });
}

// ---- the legacy-header refusal ----------------------------------------------------

test("a legacy 11-column suite is REFUSED with exit 2, never classified", () => {
  // The positional-mapping hazard, made concrete. Guessing here would route real cases on
  // the strength of the wrong columns.
  const dir = join(scratch, "legacy");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "064-legacy.csv");
  writeFileSync(
    file,
    ["ID,Title,Section,Priority,Type,Estimate,Preconditions,Steps,Expected Result,References,Automation_Status",
     "LEG-001,t,s,High,Functional,5m,none,[GQL-OP x],ok,,Draft"].join("\n") + "\n",
  );
  const r = runCli([file, "--out", dir]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /positionally/, "the refusal must explain WHY, not just refuse");
});

test("an unknown suite id exits 1 rather than planning nothing silently", () => {
  const r = runCli(["ZZZ-not-a-suite", "--out", scratch]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown suite/i);
});

// ---- planning a real suite --------------------------------------------------------

test("050h plans 29 machine / 4 browser / 1 manual and writes both artefacts", () => {
  const dir = join(scratch, "050h");
  mkdirSync(dir, { recursive: true });
  const r = runCli(["050h", "--run-id", "TEST", "--out", dir, "--json"]);
  assert.equal(r.status, 0, r.stderr);

  const lanes = JSON.parse(r.stdout) as {
    suiteId: string;
    classifierVersion: string;
    machineSourceCsv: string;
    browserCsv: string;
    counts: { total: number; machine: number; browser: number; manual: number };
    planned: Array<{ id: string; lane: string }>;
    blockers: Array<{ id: string; codes: string[] }>;
  };
  assert.equal(lanes.suiteId, "050h");
  assert.deepEqual(lanes.counts, { total: 34, machine: 29, browser: 4, manual: 1 });
  assert.equal(lanes.planned.length, 34, "the plan must name every case — the merger trusts it");
  assert.match(lanes.classifierVersion, /^\d+\.\d+\.\d+$/);

  // The machine lane runs the ORIGINAL csv: the runner resolves @td()/{{VAR}} itself, so an
  // already-resolved copy would be resolved twice.
  assert.match(lanes.machineSourceCsv, /050h-graphql-wishlist\.csv$/);

  // Every non-machine case explains itself, so the backlog is actionable.
  const nonMachine = lanes.planned.filter((p) => p.lane !== "machine").map((p) => p.id).sort();
  assert.deepEqual(lanes.blockers.map((b) => b.id).sort(), nonMachine);
});

test("the browser CSV carries the canonical header and exactly the browser rows", () => {
  const dir = join(scratch, "050h-csv");
  mkdirSync(dir, { recursive: true });
  const r = runCli(["050h", "--run-id", "TEST", "--out", dir]);
  assert.equal(r.status, 0, r.stderr);

  const csvPath = join(dir, "suite-050h-resolved.browser.csv");
  const parsed = parseSuite(readFileSync(csvPath, "utf-8"));
  assert.deepEqual(parsed.header, COLUMNS, "the agent's own parser must accept this file");
  assert.equal(parsed.rows.length, 4, "only the browser rows — the agent is handed a smaller file, not a filter rule");

  const lanes = JSON.parse(readFileSync(join(dir, "suite-050h-lanes.json"), "utf-8")) as {
    planned: Array<{ id: string; lane: string }>;
  };
  const expected = lanes.planned.filter((p) => p.lane === "browser").map((p) => p.id).sort();
  assert.deepEqual(parsed.rows.map((r) => r.ID).sort(), expected);
});

test("a suite with no browser rows writes no browser CSV and says so", () => {
  // 087 is 12 machine + 3 explicitly Manual: under the old all-or-nothing rule it occupied a
  // browser slot to run zero browser cases.
  const dir = join(scratch, "087");
  mkdirSync(dir, { recursive: true });
  const r = runCli(["087", "--run-id", "TEST", "--out", dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /needs NO browser slot/);
  const lanes = JSON.parse(readFileSync(join(dir, "suite-087-lanes.json"), "utf-8")) as { browserCsv: string; counts: { browser: number } };
  assert.equal(lanes.counts.browser, 0);
  assert.equal(lanes.browserCsv, "", "no browser rows must mean no browser file, not an empty one");
});

test("--dry-run writes nothing", () => {
  const dir = join(scratch, "dry");
  mkdirSync(dir, { recursive: true });
  const r = runCli(["050h", "--run-id", "TEST", "--out", dir, "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.throws(() => readFileSync(join(dir, "suite-050h-lanes.json"), "utf-8"));
});

test("--all surveys the corpus, writes nothing, and finds the known mixed suites", () => {
  const r = runCli(["--all", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { mixed: Array<{ id: string; machine: number }> };
  const ids = out.mixed.map((m) => m.id);
  for (const id of ["050d", "050h", "087"]) assert.ok(ids.includes(id), `${id} missing from the survey`);
  assert.ok(out.mixed.reduce((s, m) => s + m.machine, 0) >= 200, "the survey lost machine-ready rows");
});

// ---- machine-lane evidence helpers ------------------------------------------------

test("evidenceFileFrom reads the runner's published EVIDENCE_FILE line", () => {
  // The runner prints this deliberately, for an aggregator. Parsing prose instead would be
  // a second, drift-prone contract.
  const stdout = ["  200 OK — 41ms — 0 errors", "Evidence: reports/.../WISH-001-123.json", "EVIDENCE_FILE=WISH-001-123.json"].join("\n");
  assert.equal(evidenceFileFrom(stdout), "WISH-001-123.json");
  assert.equal(evidenceFileFrom("no evidence line here"), undefined);
});

test("failedAssertionFrom returns the FIRST failed assertion, and tolerates a missing file", () => {
  const dir = join(scratch, "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ev.json"),
    JSON.stringify({
      assertions: [
        { passed: true, raw: "[ERRORS label=a] errors[] empty" },
        { passed: false, raw: "[COUNT label=a] data.x.length = 2" },
        { passed: false, raw: "[DATA label=a] data.y is non-null" },
      ],
    }),
  );
  assert.equal(failedAssertionFrom(dir, "ev.json"), "[COUNT label=a] data.x.length = 2");
  assert.equal(failedAssertionFrom(dir, "missing.json"), undefined);
  assert.equal(failedAssertionFrom(dir, undefined), undefined);
});

test("failedAssertionFrom falls back to kind+predicate when raw is absent", () => {
  const dir = join(scratch, "evidence2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ev.json"), JSON.stringify({ assertions: [{ passed: false, kind: "COUNT", predicate: "data.x.length = 2" }] }));
  assert.equal(failedAssertionFrom(dir, "ev.json"), "[COUNT] data.x.length = 2");
});

test("corrupt evidence JSON does not throw — losing one detail beats losing the report", () => {
  const dir = join(scratch, "evidence3");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ev.json"), "{ not json");
  assert.doesNotThrow(() => failedAssertionFrom(dir, "ev.json"));
  assert.equal(failedAssertionFrom(dir, "ev.json"), undefined);
});

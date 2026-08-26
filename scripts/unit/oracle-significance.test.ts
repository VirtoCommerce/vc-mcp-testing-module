// Unit tests for scripts/knowledge/oracle-significance.ts — the significance model that
// sets `/qa-review-oracles` promotion ORDER and the promotion BAR, plus the ECL pattern-row
// parser that feeds it. Pure functions only (both CLIs are main()-guarded).
// Run: `npx tsx --test scripts/unit/oracle-significance.test.ts` / `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  demandPoints,
  gate,
  meetsBar,
  normalizeFrequency,
  rankOrder,
  scoreBl,
  scoreEcl,
  tierFor,
  NON_INVARIANT_PREFIXES,
  PROMOTION_BAR,
  type EclRow,
} from "../knowledge/oracle-significance.ts";
import { parseLibrary } from "../knowledge/lint-ecl.ts";

const bl = (over: Partial<Parameters<typeof scoreBl>[0]> = {}) =>
  scoreBl({ id: "BL-CART-001", severity: "P1-data", citingCases: 0, inOracle: true, ...over });

const row = (over: Partial<EclRow> = {}): EclRow => ({ frequency: "Medium", status: "[OBSERVED]", blRefs: [], ...over });

// ---- demand is laddered, not linear ------------------------------------------

test("demand: bracket boundaries, and 0 cases scores nothing", () => {
  assert.equal(demandPoints(0).points, 0);
  assert.equal(demandPoints(1).points, 10);
  assert.equal(demandPoints(2).points, 10);
  assert.equal(demandPoints(3).points, 20);
  assert.equal(demandPoints(9).points, 20);
  assert.equal(demandPoints(10).points, 30);
  assert.equal(demandPoints(29).points, 30);
  assert.equal(demandPoints(30).points, 40);
});

test("demand saturates, so a huge cluster cannot outrank the model by arithmetic alone", () => {
  // 362 citing cases is the real ECL-14.1 figure; it must score the same as 30.
  assert.equal(demandPoints(362).points, demandPoints(30).points);
});

test("demand is defensive about junk input", () => {
  assert.equal(demandPoints(-5).points, 0);
  assert.equal(demandPoints(3.7).points, 20);
});

// ---- BL: severity, floors, caps ----------------------------------------------

test("BL: a P0 never falls below the promotion bar, even uncited", () => {
  const s = bl({ severity: "P0-revenue", citingCases: 0 });
  assert.equal(s.tier, "T2");
  assert.ok(meetsBar(s.tier), "an uncited P0 is still worth carrying");
});

test("BL: a low-severity uncited invariant lands below the bar — the prune signal", () => {
  const s = bl({ severity: "P2-ux", citingCases: 0 });
  assert.equal(s.tier, "T3");
  assert.equal(meetsBar(s.tier), false);
});

test("BL: demand alone can lift a P2 back over the bar", () => {
  assert.equal(bl({ severity: "P2-ux", citingCases: 30 }).tier, "T2");
});

test("BL: an untagged ENTRY is capped at T3 however much cites it — unassessable is never significant", () => {
  const s = bl({ severity: "", citingCases: 200 });
  assert.equal(s.tier, "T3");
  assert.match(s.caps.join(" "), /unclassified severity/);
  assert.match(s.unresolved.join(" "), /no severity tag/);
});

test("BL: an untagged CANDIDATE rides demand to T2 but can never reach T1 unclassified", () => {
  const s = scoreBl({ id: "BL-L10N-001", severity: "", citingCases: 200, inOracle: false });
  assert.equal(s.tier, "T2");
  assert.match(s.caps.join(" "), /ceiling T2 until triangulation assigns a severity tag/);
});

test("BL: the same candidate reaches T1 once triangulation assigns a P0 tag", () => {
  assert.equal(scoreBl({ id: "BL-L10N-001", severity: "P0-revenue", citingCases: 200, inOracle: false }).tier, "T1");
});

test("BL: BL-CROSS carries the oracle's own cross-domain premium", () => {
  const cross = scoreBl({ id: "BL-CROSS-002", severity: "P1-data", citingCases: 3, inOracle: true });
  const plain = scoreBl({ id: "BL-CART-002", severity: "P1-data", citingCases: 3, inOracle: true });
  assert.equal(cross.score - plain.score, 10);
});

test("BL: non-invariant prefixes are EXCLUDED at any demand, and name their redirect", () => {
  for (const prefix of Object.keys(NON_INVARIANT_PREFIXES)) {
    const s = scoreBl({ id: `${prefix}-001`, severity: "P0-revenue", citingCases: 400, inOracle: false });
    assert.equal(s.tier, "EXCLUDED", `${prefix} must never be promotable`);
    assert.equal(meetsBar(s.tier), false);
    assert.ok(s.exclusion?.redirect, `${prefix} must say where the traceability goes instead`);
    assert.equal(gate("MISSING", s.tier).apply, false);
  }
});

// ---- ECL: closed vocabularies only, never prose -------------------------------

test("frequency: the closed vocabulary, with a parenthetical qualifier allowed", () => {
  assert.equal(normalizeFrequency("High").value, "High");
  assert.equal(normalizeFrequency("  low-medium ").value, "Low-Medium");
  assert.equal(normalizeFrequency("High (false bug)").value, "High");
});

test("frequency: an ambiguous or empty cell resolves to null WITH a reason — it never guesses", () => {
  const span = normalizeFrequency("Low/Medium/High");
  assert.equal(span.value, null);
  assert.match(span.reason!, /outside the closed vocabulary/);
  assert.equal(normalizeFrequency("").value, null);
  assert.equal(normalizeFrequency("—").value, null);
});

test("ECL: an unreadable Frequency contributes zero and is reported, not inferred", () => {
  const s = scoreEcl({ id: "ECL-9.9", citingCases: 0, rows: [row({ frequency: "Low/Medium/High" })] });
  assert.equal(s.contributions.find((c) => c.signal === "frequency")!.points, 0);
  assert.equal(s.unresolved.length, 1);
});

test("ECL: status scores by observed SHARE — 'has one observed row' would not discriminate", () => {
  const mostly = scoreEcl({ id: "ECL-1.1", citingCases: 0, rows: [row(), row(), row(), row({ status: "[THEORETICAL]" })] });
  const partly = scoreEcl({ id: "ECL-1.2", citingCases: 0, rows: [row(), row({ status: "[THEORETICAL]" }), row({ status: "[THEORETICAL]" })] });
  const none = scoreEcl({ id: "ECL-1.3", citingCases: 0, rows: [row({ status: "[THEORETICAL]" })] });
  const points = (s: ReturnType<typeof scoreEcl>) => s.contributions.find((c) => c.signal === "status")!.points;
  assert.equal(points(mostly), 25); // 3/4 = 75%, the band boundary
  assert.equal(points(partly), 15); // 1/3 = 33%
  assert.equal(points(none), 5);
  // Just under the boundary must NOT round up into the confirmed band.
  const justUnder = scoreEcl({ id: "ECL-1.4", citingCases: 0, rows: [row(), row(), row({ status: "[THEORETICAL]" }), row({ status: "[THEORETICAL]" })] });
  assert.equal(points(justUnder), 15);
});

test("ECL: a theoretical-only, low-frequency, uncited section sits below the bar", () => {
  const s = scoreEcl({ id: "ECL-9.9", citingCases: 0, rows: [row({ frequency: "Low", status: "[THEORETICAL]" })] });
  assert.equal(s.tier, "T3");
});

test("ECL: a section with no parseable row is capped at T3 rather than scored on demand", () => {
  const s = scoreEcl({ id: "ECL-13.4", citingCases: 400, rows: [] });
  assert.equal(s.tier, "T3");
  assert.match(s.caps.join(" "), /no pattern row parsed/);
});

test("ECL: a BL-linked row adds the normative-testability premium exactly once", () => {
  const linked = scoreEcl({ id: "ECL-14.1", citingCases: 0, rows: [row({ blRefs: ["BL-GQL-001"] }), row({ blRefs: ["BL-GQL-002"] })] });
  const plain = scoreEcl({ id: "ECL-14.2", citingCases: 0, rows: [row(), row()] });
  assert.equal(linked.score - plain.score, 8);
});

// ---- the gate: the bar governs GROWTH, not CORRECTION -------------------------

test("gate: a confirmed MISSING below the bar is HELD, not written", () => {
  const d = gate("MISSING", "T3");
  assert.equal(d.apply, false);
  assert.match(d.reason, /HELD/);
});

test("gate: a confirmed MISSING at or above the bar is applied", () => {
  assert.equal(gate("MISSING", "T2").apply, true);
  assert.equal(gate("MISSING", "T1").apply, true);
});

test("gate: a DRIFT correction applies at ANY tier — holding it would leave a known-false rule", () => {
  for (const tier of ["T1", "T2", "T3"] as const) assert.equal(gate("DRIFT", tier).apply, true);
  assert.equal(gate("CONFIRMED", "T3").apply, true);
  assert.equal(gate("DUPLICATE", "T3").apply, true, "a merge shrinks the oracle; the growth bar does not apply");
});

test("gate: the evidence bar still outranks the significance bar", () => {
  for (const v of ["CONTRADICTORY", "UNGROUNDED", "RETIRE"] as const) {
    const d = gate(v, "T1");
    assert.equal(d.apply, false, `${v} must route to the proposals file even at T1`);
  }
});

test("tierFor: a cap beats a floor, so P0 + unclassified cannot promote itself", () => {
  assert.equal(tierFor(90, { cap: "T3", floor: "T2" }), "T3");
  assert.equal(tierFor(0, { floor: "T2" }), "T2");
  assert.equal(PROMOTION_BAR, "T2");
});

// ---- ordering ----------------------------------------------------------------

test("rankOrder: tier, then score, then demand, then id — total and stable", () => {
  const mk = (id: string, citingCases: number, severity: string) => ({
    item: { id, citingCases },
    score: scoreBl({ id, severity, citingCases, inOracle: true }),
  });
  const ordered = rankOrder([
    mk("BL-CART-002", 0, "P2-ux"), // T3
    mk("BL-CART-003", 30, "P0-revenue"), // T1
    mk("BL-CART-004", 0, "P0-revenue"), // T2
  ]);
  assert.deepEqual(ordered.map((r) => r.item.id), ["BL-CART-003", "BL-CART-004", "BL-CART-002"]);
});

// ---- the model's input contract: ECL rows are read by COLUMN NAME -------------

test("parseLibrary: the 7-column chapter shape reads Frequency by name, not by index", () => {
  // The generic tables put Frequency at index 2; the VC-specific ones insert `BL Invariant`
  // and `ECL Ref`, which is exactly where positional parsing starts reading the wrong cell.
  const md = [
    "## 14. VC-Specific Patterns",
    "### 14.1 GraphQL xAPI Error Patterns",
    "| Pattern | Description | Frequency | Impact | BL Invariant | ECL Ref | Status |",
    "|---|---|---|---|---|---|---|",
    "| **Partial data** | errors[] with data | High | silent failure | BL-GQL-001 | ECL-1.1 | [OBSERVED] |",
    "### 14.2 Generic Shape",
    "| Pattern | Description | Frequency | Impact | Status |",
    "|---|---|---|---|---|",
    "| **Index lag** | stale results | Medium | wrong list | [THEORETICAL] |",
  ].join("\n");
  const { sections } = parseLibrary(md);
  assert.equal(sections.length, 2);
  assert.deepEqual(
    sections[0].rows.map((r) => [r.frequency, r.status, r.blRefs]),
    [["High", "[OBSERVED]", ["BL-GQL-001"]]],
  );
  assert.deepEqual(
    sections[1].rows.map((r) => [r.frequency, r.status, r.blRefs]),
    [["Medium", "[THEORETICAL]", []]],
  );
});

test("parseLibrary: a table above the first section defines nothing", () => {
  const md = ["| Pattern | Description | Frequency | Impact | Status |", "|---|---|---|---|---|", "| x | y | Low | z | [OBSERVED] |"].join("\n");
  assert.deepEqual(parseLibrary(md).sections, []);
});

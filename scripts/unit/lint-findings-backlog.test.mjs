import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findDuplicateIds } from "../maintenance/lint-findings-backlog.mjs";

const BACKLOG_URL = new URL("../../docs/repo-findings-backlog.md", import.meta.url);

test("findDuplicateIds: no false positive on a clean two-row table", () => {
  const text = [
    "| # | Finding | Impact | Fix |",
    "|---|---|---|---|",
    "| B-01 | first finding | impact | fix |",
    "| B-02 | second finding | impact | fix |",
  ].join("\n");
  assert.deepEqual(findDuplicateIds(text), []);
});

test("findDuplicateIds: catches a duplicate B-NN across two rows, with both line numbers", () => {
  const text = [
    "| # | Finding | Impact | Fix |",
    "|---|---|---|---|",
    "| B-13 | first finding | impact | fix |",
    "| B-14 | second finding | impact | fix |",
    "| B-13 | third finding, wrongly reusing B-13 | impact | fix |",
  ].join("\n");
  const dupes = findDuplicateIds(text);
  assert.deepEqual(dupes, [{ id: "B-13", lines: [3, 5] }]);
});

test("findDuplicateIds: catches a duplicate even when the two rows are in different sections", () => {
  // B-25 mirrors the real defect class: a top-section row and a row in a dated batch section further
  // down the same file reusing the same id for two unrelated findings.
  const text = [
    "## Open",
    "",
    "| # | Finding | Impact | Fix |",
    "|---|---|---|---|",
    "| B-25 | top-section finding | impact | fix |",
    "",
    "## Open — 2026-08-08 (some batch)",
    "",
    "| # | Finding | Impact | Fix |",
    "|---|---|---|---|",
    "| B-25 | unrelated dated-batch finding | impact | fix |",
  ].join("\n");
  const dupes = findDuplicateIds(text);
  assert.deepEqual(dupes, [{ id: "B-25", lines: [5, 11] }]);
});

test("findDuplicateIds: does not flag a B-NN mentioned in prose, only the row's own id column", () => {
  // A row is allowed to reference another id in its Finding/Impact/Fix prose (cross-reference, a
  // "renumbered from B-NN" note, a strikethrough of its own old id) without that counting as a second
  // row under that id — only a `| B-NN |` at the START of a row is the id declaration.
  const text = [
    "| # | Finding | Impact | Fix |",
    "|---|---|---|---|",
    "| B-57 | *(renumbered from B-13)* HAR capture produced nothing, related to B-13 above | impact | see B-13 |",
    "| B-13 | BIKE-* products issue | impact | fix |",
  ].join("\n");
  assert.deepEqual(findDuplicateIds(text), []);
});

test("findDuplicateIds: tolerates CRLF line endings (checkout-invariant, same discipline as B-55)", () => {
  const text = ["| B-01 | a | b | c |", "| B-01 | d | e | f |"].join("\r\n");
  const dupes = findDuplicateIds(text);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].id, "B-01");
});

test("the real docs/repo-findings-backlog.md has no duplicate B-NN ids", () => {
  const text = readFileSync(fileURLToPath(BACKLOG_URL), "utf8");
  const dupes = findDuplicateIds(text);
  assert.deepEqual(
    dupes,
    [],
    `duplicate B-NN id(s) found: ${dupes.map((d) => `${d.id} (lines ${d.lines.join(", ")})`).join("; ")}`
  );
});

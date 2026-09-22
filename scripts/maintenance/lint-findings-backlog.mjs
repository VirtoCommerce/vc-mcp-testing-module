#!/usr/bin/env node
/**
 * lint-findings-backlog — uniqueness gate for `docs/repo-findings-backlog.md`'s `B-NN` ids.
 *
 *   npm run findings:lint        exit 1 on a duplicate id, 0 otherwise
 *   npm run findings:lint -- --json
 *
 * WHY. `B-25` in the backlog itself proposed this after finding `B-13`/`B-14` each reused for two
 * unrelated findings within the top `## Open` section. Left unbuilt, the defect recurred twice more
 * and went unnoticed for weeks each time: the 2026-09-16 batch minted its own `B-53`/`B-54` a second
 * time (merged in a later PR), and a full sweep on 2026-09-22 found the file had accumulated **30**
 * ids each reused for two unrelated findings — 2 internal to the top section, 28 colliding between
 * the top section and one of the dated `## Open — YYYY-MM-DD (...)` batch sections further down.
 * Nothing caught any of it: `context:check` walks `.claude/**` + `CLAUDE.md`, not `docs/`, and the
 * backlog is prose, not a linted manifest like `regression/suites/**`. This is the one-line assert
 * `B-25` asked for, finally wired in.
 *
 * A collision is expensive here specifically because the file's own convention
 * ("Move a row to Resolved with the date") makes the id the citation contract — `docs/repo-findings-
 * action-plan.md` and several `.claude/**` files cite rows by bare `B-NN`, and a second row under the
 * same id makes "B-14 is done" ambiguous in exactly the file meant to be the unambiguous worklist.
 *
 * SCOPE. Only `| B-NN |` at the START of a table row (the finding-row id column) is checked — not
 * every `B-NN` mention in prose (a resolved row legitimately references its own old id in strikethrough
 * text, a "renumbered from" note, or a cross-reference to another row). Two rows sharing an id is the
 * defect; a row that TALKS ABOUT another id is normal and does not collide.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BACKLOG = new URL("../../docs/repo-findings-backlog.md", import.meta.url);
const json = process.argv.includes("--json");

/**
 * Returns the duplicate ids found in `text`, each with every 1-based line number it appears on.
 * Pure and file-independent so it can be unit-tested directly.
 */
export function findDuplicateIds(text) {
  const lines = text.split(/\r?\n/);
  const seenAt = new Map(); // id -> [lineNo, ...]
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\|\s*(B-\d+)\s*\|/);
    if (!m) continue;
    const id = m[1];
    if (!seenAt.has(id)) seenAt.set(id, []);
    seenAt.get(id).push(i + 1);
  }
  const dupes = [];
  for (const [id, lineNos] of seenAt) {
    if (lineNos.length > 1) dupes.push({ id, lines: lineNos });
  }
  // Stable, readable order: by id number.
  dupes.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  return dupes;
}

function main() {
  if (!existsSync(BACKLOG)) {
    // Unreadable source is a checkout fact, not a lint failure — same convention as domain:check.
    console.log("[findings:lint] docs/repo-findings-backlog.md not found — nothing to check");
    process.exit(0);
  }
  const text = readFileSync(BACKLOG, "utf8");
  const dupes = findDuplicateIds(text);

  if (json) {
    console.log(JSON.stringify({ duplicates: dupes }, null, 2));
  } else if (dupes.length) {
    console.log(`[findings:lint] ${dupes.length} duplicate id(s) in docs/repo-findings-backlog.md:`);
    for (const d of dupes) {
      console.log(`  ${d.id}  used on lines ${d.lines.join(", ")} — renumber one to the next free B-NN`);
    }
  } else {
    console.log("[findings:lint] OK — every B-NN id in docs/repo-findings-backlog.md is unique");
  }

  process.exit(dupes.length ? 1 : 0);
}

// Only run as a CLI, not when imported by the unit test. Same idiom as sync-storefront-selectors.mjs.
const isCli = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) main();

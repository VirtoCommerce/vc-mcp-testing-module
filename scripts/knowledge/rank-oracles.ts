/**
 * Promotion queue for the two shared oracles — `npm run oracles:rank`.
 *
 * Answers the question the evidence bar does not: of everything that IS or COULD BE in
 * `business-logic.md` / `e-commerce-edge-cases-library.md`, WHICH entries are worth the
 * audit budget and worth carrying? It wires the lint parsers (the single source of the
 * oracle + citation inventory) to `oracle-significance.ts` (the single source of the
 * scoring model) and prints one ranked queue.
 *
 * Two consumers, one order:
 *   - `/qa-review-oracles` Step 0 — scope the run to the head of this queue instead of
 *     auditing in file order.
 *   - `/qa-review-oracles` Step 3 — a MISSING verdict below the T2 bar is HELD, not written
 *     (`gate()`); a correction to an existing entry is applied regardless of tier.
 *
 * Usage:
 *   npm run oracles:rank                      # both axes, top 20 of each, human table
 *   npm run oracles:rank -- --axis=bl --all   # every BL row
 *   npm run oracles:rank -- --tier=T3         # what is NOT worth promoting (the prune list)
 *   npm run oracles:rank -- --candidates      # dangling cited ids only (pure demand)
 *   npm run oracles:rank:json                 # machine-readable, for a skill to relay
 *
 * Reporting only — it never edits an oracle, never edits a CSV, and exits 0 unless its
 * own inputs are unreadable. Truncation always announces itself.
 */
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { parseOracle, buildCoverage } from "./lint-bl.ts";
import { parseLibrary, buildCitations } from "./lint-ecl.ts";
import {
  gate,
  rankOrder,
  scoreBl,
  scoreEcl,
  meetsBar,
  PROMOTION_BAR,
  type Ranked,
  type Score,
  type Tier,
} from "./oracle-significance.ts";

type Axis = "bl" | "ecl";

interface Row {
  id: string;
  axis: Axis;
  /** `entry` = already in the oracle; `candidate` = a cited id with no entry (MISSING). */
  kind: "entry" | "candidate";
  label: string;
  severity: string;
  citingCases: number;
}

function collectBl(repoRoot: string): Ranked<Row>[] {
  const oracle = join(repoRoot, ".claude", "knowledge", "oracles", "business-logic.md");
  const invariants = parseOracle(readFileSync(oracle, "utf-8"));
  const coverage = buildCoverage(join(repoRoot, "regression", "suites"));
  const known = new Set(invariants.map((i) => i.id));

  const rows: Ranked<Row>[] = invariants.map((inv) => {
    const citingCases = (coverage.byBl.get(inv.id) ?? []).length;
    const item: Row = { id: inv.id, axis: "bl", kind: "entry", label: inv.title, severity: inv.severity, citingCases };
    return { item, score: scoreBl({ id: inv.id, severity: inv.severity, citingCases, inOracle: true }) };
  });

  for (const ref of coverage.referenced) {
    if (known.has(ref)) continue;
    const citingCases = (coverage.byBl.get(ref) ?? []).length;
    const item: Row = { id: ref, axis: "bl", kind: "candidate", label: "(cited, no entry — MISSING candidate)", severity: "", citingCases };
    rows.push({ item, score: scoreBl({ id: ref, severity: "", citingCases, inOracle: false }) });
  }

  // An unreadable suite is absent from the citation map, so every demand figure below is a
  // floor, not a count. Surfaced, never swallowed — same rule as BLC-005.
  if (coverage.unparsed.length)
    console.error(`[oracles:rank] WARNING — ${coverage.unparsed.length} suite CSV(s) unparsable; BL demand counts are LOWER BOUNDS (bl:lint BLC-005 lists them)`);

  return rankOrder(rows);
}

function collectEcl(repoRoot: string): Ranked<Row>[] {
  const library = join(repoRoot, ".claude", "knowledge", "oracles", "e-commerce-edge-cases-library.md");
  const { sections } = parseLibrary(readFileSync(library, "utf-8"));
  const citations = buildCitations(join(repoRoot, "regression", "suites"));
  const known = new Set(sections.map((s) => s.id));

  const rows: Ranked<Row>[] = sections.map((s) => {
    const citingCases = (citations.byEcl.get(s.id) ?? []).length;
    const item: Row = { id: s.id, axis: "ecl", kind: "entry", label: s.title, severity: "", citingCases };
    return { item, score: scoreEcl({ id: s.id, citingCases, rows: s.rows }) };
  });

  for (const [id, cases] of citations.byEcl) {
    if (known.has(id)) continue;
    const item: Row = { id, axis: "ecl", kind: "candidate", label: "(cited, no section — ADD-or-REMAP candidate)", severity: "", citingCases: cases.length };
    rows.push({ item, score: scoreEcl({ id, citingCases: cases.length, rows: [] }) });
  }

  if (citations.unparsed.length)
    console.error(`[oracles:rank] WARNING — ${citations.unparsed.length} suite CSV(s) unparsable; ECL demand counts are LOWER BOUNDS (ecl:lint ECLC-003 lists them)`);

  return rankOrder(rows);
}

function tierCounts(rows: Ranked<Row>[]): string {
  const order: Tier[] = ["T1", "T2", "T3", "EXCLUDED"];
  return order
    .map((t) => [t, rows.filter((r) => r.score.tier === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${n} ${t}`)
    .join(" · ");
}

function why(score: Score): string {
  const parts = score.contributions.filter((c) => c.points > 0).map((c) => `${c.signal} +${c.points}`);
  if (score.caps.length) parts.push(`capped (${score.caps.length})`);
  if (score.unresolved.length) parts.push(`unresolved ×${score.unresolved.length}`);
  return parts.join(", ") || "no scoring signal";
}

function printAxis(axis: Axis, rows: Ranked<Row>[], opts: { top: number; all: boolean; tier?: Tier; candidatesOnly: boolean }): void {
  let shown = rows;
  if (opts.candidatesOnly) shown = shown.filter((r) => r.item.kind === "candidate");
  if (opts.tier) shown = shown.filter((r) => r.score.tier === opts.tier);

  console.log(`\n${axis.toUpperCase()} — ${rows.length} row(s): ${tierCounts(rows)}`);
  console.log(`  promotion bar: ${PROMOTION_BAR} · ${rows.filter((r) => meetsBar(r.score.tier)).length} at/above, ${rows.filter((r) => !meetsBar(r.score.tier)).length} below`);

  const limit = opts.all ? shown.length : Math.min(opts.top, shown.length);
  for (const r of shown.slice(0, limit)) {
    const flag = r.item.kind === "candidate" ? " [candidate]" : "";
    console.log(
      `  ${r.score.tier.padEnd(8)} ${String(r.score.score).padStart(3)}  ${r.item.id.padEnd(16)} ${r.item.citingCases
        .toString()
        .padStart(3)} case(s)  ${r.item.severity ? r.item.severity.padEnd(12) : "".padEnd(12)} ${r.item.label.slice(0, 54)}${flag}`,
    );
    for (const c of r.score.caps) console.log(`${" ".repeat(14)}└ cap: ${c}`);
    for (const u of r.score.unresolved) console.log(`${" ".repeat(14)}└ unresolved: ${u}`);
    if (r.score.exclusion) console.log(`${" ".repeat(14)}└ redirect: ${r.score.exclusion.redirect}`);
    if (r.item.kind === "candidate") console.log(`${" ".repeat(14)}└ gate: ${gate("MISSING", r.score.tier).reason}`);
    else console.log(`${" ".repeat(14)}└ ${why(r.score)}`);
  }
  if (limit < shown.length) console.log(`  … ${shown.length - limit} more row(s) not listed (use --all)`);
}

/**
 * Full breakdown for one id — the call an auditor makes at Step 3 with the severity tag the
 * triangulation just assigned (`--severity=P0-revenue`), so the gate decision that lands in
 * the audit report is re-derived rather than asserted.
 */
function explainOne(collected: Record<string, Ranked<Row>[]>, id: string, severity: string | undefined, json: boolean): void {
  const hit = Object.values(collected)
    .flat()
    .find((r) => r.item.id.toLowerCase() === id.toLowerCase());
  if (!hit) {
    console.error(`[oracles:rank] ${id} is neither an entry nor a cited id — nothing to score. It has no demand signal at all.`);
    process.exit(1);
  }
  const score =
    hit.item.axis === "bl" && severity !== undefined
      ? scoreBl({ id: hit.item.id, severity, citingCases: hit.item.citingCases, inOracle: hit.item.kind === "entry" })
      : hit.score;
  const verdict = hit.item.kind === "candidate" ? "MISSING" : "DRIFT";
  const decision = gate(verdict, score.tier);

  if (json) {
    console.log(JSON.stringify({ ...hit.item, assumedSeverity: severity ?? null, score, verdict, decision }, null, 2));
    return;
  }
  console.log(`\n${hit.item.id} — ${hit.item.kind} on the ${hit.item.axis.toUpperCase()} axis`);
  if (severity !== undefined) console.log(`  severity assumed for this call: ${severity || "(none)"}`);
  console.log(`  ${hit.item.citingCases} citing case(s) · score ${score.score} · tier ${score.tier}`);
  for (const c of score.contributions) console.log(`    ${c.points >= 0 ? "+" : ""}${c.points}  ${c.signal} — ${c.note}`);
  for (const c of score.caps) console.log(`    cap: ${c}`);
  for (const u of score.unresolved) console.log(`    unresolved: ${u}`);
  if (score.exclusion) console.log(`    redirect: ${score.exclusion.redirect}`);
  console.log(`  gate (${verdict}): ${decision.apply ? "APPLY" : "HOLD"} — ${decision.reason}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const json = argv.includes("--json");
  const all = argv.includes("--all");
  const candidatesOnly = argv.includes("--candidates");
  const axisArg = argv.find((a) => a.startsWith("--axis="))?.split("=")[1];
  const tierArg = argv.find((a) => a.startsWith("--tier="))?.split("=")[1] as Tier | undefined;
  const top = Number(argv.find((a) => a.startsWith("--top="))?.split("=")[1] ?? 20);
  const explain = argv.find((a) => a.startsWith("--explain="))?.split("=")[1];
  const assumedSeverity = argv.find((a) => a.startsWith("--severity="))?.split("=")[1];
  const axes: Axis[] = axisArg === "bl" || axisArg === "ecl" ? [axisArg] : ["bl", "ecl"];

  const collected: Record<string, Ranked<Row>[]> = {};
  try {
    for (const axis of axes) collected[axis] = axis === "bl" ? collectBl(repoRoot) : collectEcl(repoRoot);
  } catch (e) {
    console.error(`[oracles:rank] cannot read an input: ${(e as Error).message}`);
    process.exit(2);
  }

  if (explain) {
    explainOne(collected, explain, assumedSeverity, json);
    return;
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          bar: PROMOTION_BAR,
          axes: Object.fromEntries(
            Object.entries(collected).map(([axis, rows]) => [
              axis,
              rows.map((r) => ({
                ...r.item,
                score: r.score.score,
                tier: r.score.tier,
                promotable: meetsBar(r.score.tier),
                gate: r.item.kind === "candidate" ? gate("MISSING", r.score.tier) : gate("DRIFT", r.score.tier),
                contributions: r.score.contributions,
                caps: r.score.caps,
                unresolved: r.score.unresolved,
                exclusion: r.score.exclusion,
              })),
            ]),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\nOracle promotion queue — significance model: scripts/knowledge/oracle-significance.ts`);
  for (const axis of axes) printAxis(axis, collected[axis], { top, all, tier: tierArg, candidatesOnly });
  console.log(
    `\n  Order = tier, then score, then demand. The bar governs GROWTH (a MISSING entry) — a correction to an existing entry is applied at any tier.\n  Ranking is not a verdict: everything here still has to clear the docs+live+source evidence bar in /qa-review-oracles.`,
  );
}

const isCli = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) main();

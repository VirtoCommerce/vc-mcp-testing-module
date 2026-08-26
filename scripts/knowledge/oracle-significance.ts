/**
 * Significance scoring for the two shared oracles — the deterministic core that
 * decides PROMOTION ORDER (`/qa-review-oracles` Step 0) and the PROMOTION BAR
 * (Step 3), so a triangulated-and-confirmed entry is not automatically an entry
 * worth carrying.
 *
 * Why this exists. The evidence bar in `bl-audit-criteria.md` / `ecl-audit-criteria.md`
 * answers "is this TRUE?" — it never answers "is this WORTH HAVING?". Both oracles grew
 * against a truth gate alone (211 BL invariants, 54 ECL sections), and the value is not
 * evenly spread: 25 invariants are cited by no test case at all, while single dangling
 * clusters carried 51 and 92 citing cases waiting for an entry that did not exist. The
 * audit budget was being spent in file order rather than in value order, and every
 * confirmed candidate landed regardless of whether anything would ever read it.
 *
 * The model is deliberately small, integer, and fully attributable: every score carries
 * the contributions that produced it, so a promotion decision can be re-derived and
 * argued with rather than trusted. Three rules keep it honest:
 *
 *  1. **Never derive value from prose.** The ECL `Impact` column ("Double charge, order
 *     duplication") is free text; scoring it would mean a regex judging severity. Only
 *     closed vocabularies score: the BL severity tag, the ECL `Frequency` and `Status`
 *     columns. An unparseable cell becomes an `unresolved` note contributing ZERO — it
 *     never guesses a value, and it caps the tier (see rule 3).
 *  2. **Demand is bounded.** Citing-case count is the strongest signal — promoting one
 *     entry at a cited id retroactively makes N citations true — but it is laddered, not
 *     linear, so a 92-case cluster cannot outrank every P0 in the corpus by arithmetic.
 *  3. **Fail-closed upward.** Missing severity, no parseable rows, or a not-yet-classified
 *     candidate CAPS the tier at T2 (or T3) instead of inferring one. Unassessable is
 *     never "significant"; the fix is to classify it, not to promote it.
 *
 * Pure functions only — no file, network or CLI access. `rank-oracles.ts` wires it to the
 * lint parsers; `scripts/unit/oracle-significance.test.ts` pins the model.
 */

export type Tier = "T1" | "T2" | "T3" | "EXCLUDED";

/** Tiers in ascending significance, for comparisons. `EXCLUDED` sits outside the order. */
export const TIER_ORDER: Tier[] = ["T3", "T2", "T1"];

/** The bar `/qa-review-oracles` Step 3 promotes at: T2 and above. */
export const PROMOTION_BAR: Tier = "T2";

export interface Contribution {
  signal: string;
  points: number;
  note: string;
}

export interface Score {
  score: number;
  tier: Tier;
  contributions: Contribution[];
  /** Tier ceilings that fired, each with its reason. A cap is never silent. */
  caps: string[];
  /** Closed-vocabulary cells that could not be read. Each contributes 0 and is reported. */
  unresolved: string[];
  /** Set only for `EXCLUDED` — why this id may never enter the oracle, and where it belongs. */
  exclusion?: { reason: string; redirect: string };
}

// ---------------------------------------------------------------------------
// Shared signal: demand (how many test cases cite the id)
// ---------------------------------------------------------------------------

/** `[minimum citing cases, points]`, highest bracket first. */
export const DEMAND_LADDER: ReadonlyArray<readonly [number, number]> = [
  [30, 40],
  [10, 30],
  [3, 20],
  [1, 10],
  [0, 0],
];

export function demandPoints(citingCases: number): Contribution {
  const n = Math.max(0, Math.trunc(citingCases));
  const [min, points] = DEMAND_LADDER.find(([m]) => n >= m)!;
  return {
    signal: "demand",
    points,
    note: n === 0 ? "cited by no test case" : `cited by ${n} case(s) (${min}+ bracket)`,
  };
}

// ---------------------------------------------------------------------------
// BL axis
// ---------------------------------------------------------------------------

/** The oracle's own severity vocabulary (`business-logic.md` §Severity Tags). */
export const SEVERITY_POINTS: Readonly<Record<string, number>> = {
  "P0-security": 40,
  "P0-revenue": 35,
  "P1-data": 20,
  "P1-ux": 12,
  "P2-ux": 4,
};

/** A P0 is never "not worth having", however little cites it. */
const P0_FLOOR_TIER: Tier = "T2";

/**
 * Prefixes that are NOT invariants and may never be promoted, whatever their demand.
 * Each was declined on a real audit (BL-AUDIT-2026-08-24) after citing cases had already
 * accumulated against it — demand alone would have promoted all three, which is precisely
 * the failure this table prevents. Cite the redirect in the audit report so the traceability
 * moves rather than being destroyed.
 */
export const NON_INVARIANT_PREFIXES: Readonly<Record<string, { reason: string; redirect: string }>> = {
  "BL-PERF": {
    reason: "performance budgets are environment- and hardware-specific; an invariant here would violate the oracle's env-agnostic rule",
    redirect: ".claude/knowledge/execution/performance-thresholds.md",
  },
  "BL-COMPAT": {
    reason: "browser-engine quirks are tooling facts, not platform invariants",
    redirect: ".claude/knowledge/automation/browser-quirks.md",
  },
  "BL-API": {
    reason: "a coverage tag, not a normative rule — heterogeneous cases sharing one label",
    redirect: "the owning domain's own BL-* invariant",
  },
};

export interface BlInput {
  id: string;
  /** Raw severity tag, `""` when absent/malformed (BLL-002). */
  severity: string;
  citingCases: number;
  /** false ⇒ a MISSING candidate (a dangling cited id), not yet an entry. */
  inOracle: boolean;
}

export function domainPrefixOf(id: string): string {
  return id.replace(/-\d+[A-Z]?$/, "");
}

export function scoreBl(input: BlInput): Score {
  const prefix = domainPrefixOf(input.id);
  const excluded = NON_INVARIANT_PREFIXES[prefix];
  if (excluded) {
    return {
      score: 0,
      tier: "EXCLUDED",
      contributions: [demandPoints(input.citingCases)],
      caps: [`${prefix} is a non-invariant class — ${excluded.reason}`],
      unresolved: [],
      exclusion: { reason: excluded.reason, redirect: excluded.redirect },
    };
  }

  const contributions: Contribution[] = [demandPoints(input.citingCases)];
  const caps: string[] = [];
  const unresolved: string[] = [];

  const sevPoints = SEVERITY_POINTS[input.severity];
  if (sevPoints === undefined) {
    unresolved.push(
      input.severity
        ? `severity tag "${input.severity}" is outside the oracle vocabulary`
        : "no severity tag (BLL-002)",
    );
    contributions.push({ signal: "severity", points: 0, note: "unclassified — contributes nothing" });
    caps.push("unclassified severity caps the tier at T3 — tag it before promoting, never infer the tag");
  } else {
    contributions.push({ signal: "severity", points: sevPoints, note: input.severity });
  }

  if (prefix === "BL-CROSS") {
    contributions.push({
      signal: "cross-domain",
      points: 10,
      note: "BL-CROSS — the oracle's own highest-value class (catches what single-domain testing misses)",
    });
  }

  if (!input.inOracle && sevPoints === undefined) {
    // A dangling cited id carries demand but no classification yet. Demand alone can reach
    // T2, never T1 — the severity that would justify T1 has not been assigned.
    caps.length = 0;
    caps.push("candidate not yet in the oracle and not yet classified — demand-only score, ceiling T2 until triangulation assigns a severity tag");
  }

  const score = contributions.reduce((n, c) => n + c.points, 0);
  const cap: Tier | undefined = caps.length
    ? (!input.inOracle && sevPoints === undefined ? "T2" : "T3")
    : undefined;
  const floor: Tier | undefined = input.severity.startsWith("P0-") ? P0_FLOOR_TIER : undefined;

  return { score, tier: tierFor(score, { cap, floor }), contributions, caps, unresolved };
}

// ---------------------------------------------------------------------------
// ECL axis
// ---------------------------------------------------------------------------

export type Frequency = "High" | "Low-High" | "Medium" | "Low-Medium" | "Low";

export const FREQUENCY_POINTS: Readonly<Record<Frequency, number>> = {
  High: 20,
  "Low-High": 14,
  Medium: 12,
  "Low-Medium": 7,
  Low: 4,
};

const FREQUENCY_LOOKUP = new Map<string, Frequency>(
  (Object.keys(FREQUENCY_POINTS) as Frequency[]).map((f) => [f.toLowerCase(), f]),
);

/**
 * Read a `Frequency` cell. Accepts the closed vocabulary, optionally followed by a
 * parenthetical qualifier (`High (false bug)`), and NOTHING else — a slash-range like
 * `Low/Medium/High` is genuinely ambiguous and returns `null` with a reason rather than
 * silently taking its first token.
 */
export function normalizeFrequency(raw: string): { value: Frequency | null; reason?: string } {
  const cell = raw.trim();
  if (!cell || cell === "—") return { value: null, reason: "empty Frequency cell" };
  const head = cell.split(/\s*\(/)[0].trim().toLowerCase();
  const hit = FREQUENCY_LOOKUP.get(head);
  if (hit) return { value: hit };
  return { value: null, reason: `Frequency "${cell}" is outside the closed vocabulary` };
}

export interface EclRow {
  frequency: string;
  /** `[OBSERVED]` / `[THEORETICAL]`, raw. */
  status: string;
  /** BL ids the row maps to (7-column chapter shape); empty for the 5-column shape. */
  blRefs: string[];
}

export interface EclInput {
  id: string;
  citingCases: number;
  rows: EclRow[];
}

export function scoreEcl(input: EclInput): Score {
  const contributions: Contribution[] = [demandPoints(input.citingCases)];
  const caps: string[] = [];
  const unresolved: string[] = [];

  // Status scores by SHARE, not by presence. 175 of 213 rows in the library are
  // `[OBSERVED]`, so "has at least one observed row" is true of almost every section and
  // discriminates nothing. The share does: a section that is mostly confirmed-here is
  // release-walk material (`/qa-checklist`), one that is mostly `[THEORETICAL]` is charter
  // material (`/qa-exploratory`) — a real difference in what the entry buys.
  const observed = input.rows.filter((r) => /OBSERVED/i.test(r.status)).length;
  const classified = input.rows.filter((r) => /OBSERVED|THEORETICAL/i.test(r.status)).length;
  if (classified === 0) {
    contributions.push({ signal: "status", points: 0, note: "no [OBSERVED]/[THEORETICAL] row parsed" });
    if (input.rows.length > 0) unresolved.push("no row carries a [OBSERVED]/[THEORETICAL] status");
  } else {
    const share = observed / classified;
    const [points, band] =
      share >= 0.75 ? ([25, "≥75% confirmed on this platform"] as const)
      : share > 0 ? ([15, "partly confirmed on this platform"] as const)
      : ([5, "[THEORETICAL] only — charter material, not checklist material"] as const);
    contributions.push({
      signal: "status",
      points,
      note: `${observed}/${classified} [OBSERVED] — ${band}`,
    });
  }

  let best: Frequency | null = null;
  for (const row of input.rows) {
    const { value, reason } = normalizeFrequency(row.frequency);
    if (!value) {
      if (reason) unresolved.push(reason);
      continue;
    }
    if (best === null || FREQUENCY_POINTS[value] > FREQUENCY_POINTS[best]) best = value;
  }
  contributions.push(
    best
      ? { signal: "frequency", points: FREQUENCY_POINTS[best], note: `max row frequency ${best}` }
      : { signal: "frequency", points: 0, note: "no readable Frequency cell — contributes nothing" },
  );

  if (input.rows.some((r) => r.blRefs.length > 0)) {
    contributions.push({
      signal: "bl-linked",
      points: 8,
      note: "at least one row maps to a BL-* invariant — the pattern is normatively testable",
    });
  }

  if (input.rows.length === 0) {
    caps.push("no pattern row parsed — capped at T3; a section whose table cannot be read is unassessable, not significant");
  }

  const score = contributions.reduce((n, c) => n + c.points, 0);
  return {
    score,
    tier: tierFor(score, { cap: input.rows.length === 0 ? "T3" : undefined }),
    contributions,
    caps,
    unresolved,
  };
}

// ---------------------------------------------------------------------------
// Tiering
// ---------------------------------------------------------------------------

export const TIER_THRESHOLDS: ReadonlyArray<readonly [Tier, number]> = [
  ["T1", 55],
  ["T2", 30],
  ["T3", 0],
];

/** Apply the thresholds, then any cap (ceiling) and floor. Cap wins over floor. */
export function tierFor(score: number, bounds: { cap?: Tier; floor?: Tier } = {}): Tier {
  let tier = TIER_THRESHOLDS.find(([, min]) => score >= min)![0];
  if (bounds.floor && TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(bounds.floor)) tier = bounds.floor;
  if (bounds.cap && TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(bounds.cap)) tier = bounds.cap;
  return tier;
}

export function meetsBar(tier: Tier, bar: Tier = PROMOTION_BAR): boolean {
  if (tier === "EXCLUDED") return false;
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(bar);
}

// ---------------------------------------------------------------------------
// The promotion gate
// ---------------------------------------------------------------------------

export type Verdict = "CONFIRMED" | "DRIFT" | "MISSING" | "DUPLICATE" | "CONTRADICTORY" | "UNGROUNDED" | "RETIRE";

export interface GateDecision {
  apply: boolean;
  /** Human-readable justification — goes verbatim into the audit report row. */
  reason: string;
}

/**
 * Decide whether a triangulated verdict may be written to the oracle.
 *
 * The significance bar governs GROWTH, never CORRECTION. A DRIFT verdict on an entry that
 * already exists is a fix to something the oracle currently states wrongly — holding it back
 * because the entry scored low would leave a known-false rule in a file other skills judge
 * against, which is strictly worse than a low-value-but-true one. Same for a CONFIRMED
 * provenance refresh and a DUPLICATE merge (which shrinks the oracle). Only MISSING — a NEW
 * entry — has to clear the bar, because that is the only verdict that makes the oracle bigger.
 */
export function gate(verdict: Verdict, tier: Tier, bar: Tier = PROMOTION_BAR): GateDecision {
  if (verdict === "CONTRADICTORY" || verdict === "UNGROUNDED" || verdict === "RETIRE")
    return { apply: false, reason: `${verdict} — unconfirmed or destructive; routes to the proposals file (evidence bar, unchanged)` };

  if (tier === "EXCLUDED")
    return { apply: false, reason: "EXCLUDED — a non-invariant class; record the redirect, never promote" };

  if (verdict === "MISSING") {
    return meetsBar(tier, bar)
      ? { apply: true, reason: `MISSING · ${tier} — confirmed and at/above the ${bar} significance bar` }
      : { apply: false, reason: `MISSING · ${tier} — confirmed but below the ${bar} bar; HELD, not written (report it, do not grow the oracle)` };
  }

  return { apply: true, reason: `${verdict} · ${tier} — correction to an existing entry; the bar governs growth, not correction` };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export interface Ranked<T> {
  item: T;
  score: Score;
}

/** Audit/promotion order: tier, then score, then demand, then id — total and stable. */
export function rankOrder<T extends { id: string; citingCases: number }>(rows: Ranked<T>[]): Ranked<T>[] {
  const tierRank = (t: Tier) => (t === "EXCLUDED" ? -1 : TIER_ORDER.indexOf(t));
  return [...rows].sort(
    (a, b) =>
      tierRank(b.score.tier) - tierRank(a.score.tier) ||
      b.score.score - a.score.score ||
      b.item.citingCases - a.item.citingCases ||
      a.item.id.localeCompare(b.item.id),
  );
}

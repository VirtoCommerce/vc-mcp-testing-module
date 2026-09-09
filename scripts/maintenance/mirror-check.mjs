#!/usr/bin/env node
/**
 * mirror:check — the `.claude/` ↔ `plugins/vc-fix/` mirror, declared rather than assumed.
 *
 * WHY. `vc-fix` is deliberately self-contained: it duplicates the root's `knowledge/`, agents,
 * hooks and several skills rather than referencing them, because Claude Code documents no reliable
 * way for an installed plugin to resolve a bare relative path against its own root (CLAUDE.md
 * §Project Overview). Duplication is therefore the design — but until now the only thing enforcing
 * it was `mirror-parity.test.mjs`, which listed the pairs that already happened to be identical.
 * Every other shared path was governed by prose, and the 2026-09-07 audit's item 13 measured the
 * result: 64 of 92 shared paths diverged, with no record anywhere of which divergences were meant.
 *
 * WHAT THIS CHANGES. Every shared path now lands in exactly one of three buckets, and the third
 * one must be DECLARED:
 *
 *   identical   byte-for-byte. Any drift fails.
 *   structural  identical once the paths that MUST differ between the two trees are normalised
 *               (see PATH_REWRITES). Any CONTENT drift fails. This bucket is new — those files
 *               were previously ungated, because byte-parity could never hold for them.
 *   forked      a real content difference, which must appear in FORKS with a reason. An
 *               UNDECLARED fork fails the gate; a declared fork that has become identical fails
 *               too, so the registry cannot rot (same burn-down shape as XREF_BASELINE).
 *
 * WHAT THE AUDIT GOT WRONG, measured here 2026-09-09. Item 13 proposed re-syncing the diverged
 * files. Checked one by one, the divergences are overwhelmingly DELIBERATE and a blind re-sync
 * would break the plugin: `vc-bug-catalog.md` de-links `skills/qa-sbtm/*` because vc-fix does not
 * ship it, `storefront-selectors.md` drops the `/qa-design` reference for the same reason,
 * `sign-off-templates.md` replaces `@qa-lead-orchestrator` with "assign in your tracker", and every
 * `skills/project-init/*` file is AHEAD of the root, not behind it. The 2026-09-08 BL/ECL re-sync
 * worked precisely because those two files carried no plugin-specific adaptation; that is the
 * exception, not the rule. So the deliverable is a declared, gated ledger — not a sync.
 *
 * Usage:  npm run mirror:check  [--json]
 * Exit:   0 = every shared path is identical, structural, or declared. 1 = otherwise.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ROOT_DIR = ".claude";
export const PLUGIN_DIR = "plugins/vc-fix";
const EXTS = [".md", ".mjs", ".js", ".json"];

/**
 * Paths that are REQUIRED to differ between the two trees, mapped to a common token.
 *
 * Each entry is a structural fact about the two layouts, not a convenience:
 *  - the root cites the plugin by its in-repo path (`plugins/vc-fix/x`); inside the plugin that is
 *    just `x`;
 *  - `quality-gates.md` and the browser-lane reference moved out of the root's always-loaded
 *    `rules/` tier into `knowledge/execution/` (2026-09-07 audit action 3); the plugin keeps its
 *    own copies under its bundled `.claude/rules/`, which is correct for a plugin that ships them;
 *  - the `/qa-fix` routing data lives at `ci/config|lib/...` in the root and is relocated into
 *    `skills/qa-fix-routing/` in the plugin, which resolves it off `import.meta.url` (CLAUDE.md).
 *
 * Normalising these is what makes CONTENT drift visible. Without it a one-word change to a shared
 * doc hides behind a path difference that was always going to be there.
 */
export const PATH_REWRITES = [
  [/plugins\/vc-fix\//g, ""],
  [/(?:\.\.\/)*(?:ci\/config|skills\/qa-fix-routing)\/fix-repos\.json/g, "@FIXREPOS"],
  [/(?:\.\.\/)*(?:ci\/lib|skills\/qa-fix-routing)\/repo-router\.ts/g, "@ROUTER"],
  [/(?:\.\.\/)*(?:ci\/lib|skills\/qa-fix-routing)\/module-registry\.ts/g, "@MODREG"],
  [/(?:\.\.\/)*(?:ci\/config|skills\/qa-fix-routing)\/\.module-registry\.cache\.json/g, "@MODCACHE"],
  [/(?:\.\.\/)*(?:\.claude\/)?rules\/quality-gates\.md/g, "@QUALITY_GATES"],
  [/(?:\.\.\/)*(?:\.claude\/)?knowledge\/execution\/quality-gates\.md/g, "@QUALITY_GATES"],
  [/(?:\.\.\/)*(?:\.claude\/)?rules\/mcp-browsers\.md/g, "@BROWSERS"],
  [/(?:\.\.\/)*(?:\.claude\/)?knowledge\/execution\/browser-lanes\.md/g, "@BROWSERS"],
  [/(?:\.\.\/)*(?:\.claude\/)?rules\/([a-z-]+\.md)/g, "@RULES/$1"],
  [/(?:\.\.\/)*\.claude\//g, "@CLAUDE/"],
  [/(?:\.\.\/)+/g, "@REL/"],
  [/\.claude\//g, "@CLAUDE/"],
];

/** The closed vocabulary of reasons a shared path is allowed to fork. */
export const REASONS = {
  "plugin-scope":
    "vc-fix does not ship some surface the root has (suites, seeders, the qa-* agent roster, sibling skills), so the plugin copy omits or annotates it. Syncing would reintroduce references a client cannot follow.",
  "plugin-ahead":
    "the PLUGIN is canonical and the root copy is a fossil. /project-init is developed against the installed-plugin layout (VC_FIX_HOME vs CLAUDE_PLUGIN_ROOT), so the plugin gets the work and the root copy is not on any path that runs.",
  "root-ahead":
    "the ROOT is canonical and the plugin copy is a frozen snapshot. Needs a manual, adaptation-preserving re-sync — NOT an overwrite, because the plugin copy carries scope edits of its own.",
  "tracker-agnostic":
    "the root is JIRA-specific where the plugin must serve Azure Boards clients too, so the plugin speaks slots and tracker-neutral wording.",
  "plugin-frontmatter":
    "plugin-only skill frontmatter (e.g. disable-model-invocation) that would change behaviour if applied in this repo.",
  "plugin-note":
    "the executable content is in lock-step; the plugin copy carries an extra comment addressed to whoever edits the mirror.",
  undecided:
    "DECLARED BUT NOT ADJUDICATED. Nobody has decided which side wins or why. This is the burn-down list — pick a side, record the real reason, and remove the entry.",
};

/**
 * Every shared path that legitimately differs, and why.
 *
 * Line counts are deliberately NOT stored here: a transcribed count is correct once and then rots
 * silently (.claude/rules/test-data.md GOLDEN RULE). `mirror:check` prints the live numbers.
 */
export const FORKS = {
  "agents/frontend-reviewer.md": "plugin-scope",
  "agents/fullstack-backend.md": "undecided",
  "agents/fullstack-frontend.md": "undecided",
  "agents/qa-backend-expert.md": "plugin-scope",
  "agents/qa-frontend-expert.md": "plugin-scope",
  "agents/qa-testing-expert.md": "plugin-scope",
  "hooks/enforce-real-user.mjs": "plugin-note",
  "knowledge/README.md": "plugin-scope",
  "knowledge/agents/README.md": "plugin-scope",
  "knowledge/agents/developers/shared-instructions.md": "undecided",
  "knowledge/agents/qa/shared-instructions.md": "plugin-scope",
  "knowledge/api/graphql-schema.md": "root-ahead",
  "knowledge/api/graphql-test-cases-runner.md": "plugin-scope",
  "knowledge/architecture/vc-frontend-architecture.md": "plugin-scope",
  "knowledge/architecture/vc-module-architecture.md": "undecided",
  "knowledge/automation/storefront-selectors.md": "plugin-scope",
  "knowledge/domain/catalog.md": "plugin-scope",
  "knowledge/domain/store-settings.md": "plugin-scope",
  "knowledge/execution/live-discovery.md": "plugin-scope",
  "knowledge/execution/module-suite-map.md": "plugin-scope",
  "knowledge/execution/tracker-ops.md": "undecided",
  "knowledge/oracles/critical-ui-scope.md": "plugin-scope",
  "knowledge/oracles/vc-bug-catalog.md": "plugin-scope",
  "skills/project-init/SKILL.md": "plugin-ahead",
  "skills/project-init/derive-context.mjs": "plugin-ahead",
  "skills/project-init/discover-repos.mjs": "plugin-ahead",
  "skills/project-init/ensure-session.mjs": "plugin-ahead",
  "skills/project-init/gen-mcp.mjs": "plugin-ahead",
  "skills/project-init/gen-profile.mjs": "plugin-ahead",
  "skills/project-init/probe-lib.mjs": "plugin-ahead",
  "skills/project-init/reconcile-profile.mjs": "plugin-ahead",
  "skills/project-init/scaffold-env.mjs": "plugin-ahead",
  "skills/project-init/scaffold-secrets.mjs": "plugin-ahead",
  "skills/project-init/verify-access.mjs": "plugin-ahead",
  "skills/project-init/write-env.mjs": "plugin-ahead",
  "skills/qa-checklist/SKILL.md": "plugin-scope",
  "skills/qa-checklist/backend-admin-checklists.md": "plugin-scope",
  "skills/qa-checklist/checklist-creation-guide.md": "plugin-scope",
  "skills/qa-checklist/domain-checklists.md": "plugin-scope",
  "skills/qa-checklist/graphql-checklist.md": "plugin-scope",
  "skills/qa-defect/SKILL.md": "plugin-frontmatter",
  "skills/qa-defect/defect-lifecycle-workflow.md": "undecided",
  "skills/qa-defect/defect-report-templates.md": "tracker-agnostic",
  "skills/qa-evidence/SKILL.md": "plugin-frontmatter",
  "skills/qa-evidence/output-paths.md": "undecided",
  "skills/qa-evidence/sign-off-templates.md": "plugin-scope",
  "skills/qa-investigate/SKILL.md": "plugin-scope",
  "skills/qa-investigate/bug-investigation-flow.md": "undecided",
  "skills/qa-investigate/evidence-and-root-cause.md": "plugin-scope",
  "skills/qa-monitoring/SKILL.md": "plugin-scope",
  "skills/qa-risk/SKILL.md": "plugin-frontmatter",
  "skills/vc-docs/SKILL.md": "undecided",
  "skills/vc-self-check/SKILL.md": "undecided",
};

/**
 * The self-diagnostics containment core. These are held to BYTE identity and are called out
 * separately because a one-sided drift here is a security regression, not a documentation one:
 * both copies are registered and hooks are AND-gated, so a stale copy denies what the fresh one
 * allows, and the redaction / closed-schema upstream path is what keeps client data from leaving.
 * Originally guarded by `scripts/unit/mirror-parity.test.mjs` (PR #143).
 */
export const CONTAINMENT_CORE = [
  "hooks/redact.mjs",
  "hooks/expected.mjs",
  "hooks/session-telemetry.mjs",
  "skills/vc-self-check/deliver.mjs",
  "skills/vc-self-check/upstream-reduce.mjs",
];

// --- mechanics ---------------------------------------------------------------------------------

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

export function canonicalise(text) {
  let s = text.replace(/\r\n/g, "\n");
  for (const [re, to] of PATH_REWRITES) s = s.replace(re, to);
  return s;
}

/** `identical` · `structural` · `forked`. */
export function classify(rootText, pluginText) {
  if (rootText === pluginText) return "identical";
  if (canonicalise(rootText) === canonicalise(pluginText)) return "structural";
  return "forked";
}

/** Lines present on exactly one side, after canonicalisation — the live drift size. */
export function driftSize(rootText, pluginText) {
  const xs = canonicalise(rootText).split("\n");
  const ys = canonicalise(pluginText).split("\n");
  const sy = new Set(ys);
  const sx = new Set(xs);
  return {
    rootOnly: xs.filter((l) => l.trim() && !sy.has(l)).length,
    pluginOnly: ys.filter((l) => l.trim() && !sx.has(l)).length,
  };
}

export function auditMirror(root = ROOT) {
  const a = new Set(walk(join(root, ROOT_DIR)));
  const b = new Set(walk(join(root, PLUGIN_DIR)));
  const shared = [...a].filter((p) => b.has(p)).sort();

  const buckets = { identical: [], structural: [], forked: [] };
  for (const p of shared) {
    const x = readFileSync(join(root, ROOT_DIR, p), "utf-8");
    const y = readFileSync(join(root, PLUGIN_DIR, p), "utf-8");
    const kind = classify(x, y);
    buckets[kind].push(kind === "forked" ? { path: p, ...driftSize(x, y) } : { path: p });
  }

  const forkedPaths = new Set(buckets.forked.map((f) => f.path));
  return {
    shared,
    rootOnly: [...a].filter((p) => !b.has(p)).length,
    pluginOnly: [...b].filter((p) => !a.has(p)).length,
    ...buckets,
    /** A fork nobody declared — the gate's whole point. */
    undeclared: buckets.forked.filter((f) => !(f.path in FORKS)),
    /** Declared with a reason that is not in the vocabulary. */
    badReason: buckets.forked.filter((f) => f.path in FORKS && !(FORKS[f.path] in REASONS)),
    /** Declared as forked but no longer forked — remove the entry so the ledger cannot rot. */
    staleDeclarations: Object.keys(FORKS).filter((p) => !forkedPaths.has(p)).sort(),
    /** Containment-core files that are not byte-identical. */
    containmentDrift: CONTAINMENT_CORE.filter((p) => !buckets.identical.some((f) => f.path === p)),
    undecided: buckets.forked.filter((f) => FORKS[f.path] === "undecided"),
  };
}

// --- CLI ---------------------------------------------------------------------------------------

function main() {
  const r = auditMirror();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(
      `[mirror:check] ${r.shared.length} shared path(s) — ${r.identical.length} identical, ` +
        `${r.structural.length} structural, ${r.forked.length} declared fork(s). ` +
        `${r.rootOnly} .claude-only, ${r.pluginOnly} plugin-only.`,
    );
    const byReason = {};
    for (const f of r.forked) (byReason[FORKS[f.path] ?? "UNDECLARED"] ??= []).push(f);
    for (const k of Object.keys(byReason).sort()) console.log(`   ${String(byReason[k].length).padStart(3)}  ${k}`);
    if (r.undecided.length > 0) {
      console.log(
        `[mirror:check] burn-down: ${r.undecided.length} fork(s) declared "undecided" — nobody has picked a side:`,
      );
      for (const f of r.undecided) console.log(`     ${f.rootOnly} root-only / ${f.pluginOnly} plugin-only  ${f.path}`);
    }
  }

  let failed = false;
  const fail = (msg, rows) => {
    failed = true;
    console.error(`[mirror:check] FAIL — ${msg}`);
    for (const row of rows) console.error(`  - ${row}`);
  };
  if (r.containmentDrift.length > 0)
    fail(
      "the self-diagnostics containment core is NOT byte-identical. Both copies are registered and hooks are AND-gated, so the stale one denies what the fresh one allows",
      r.containmentDrift,
    );
  if (r.undeclared.length > 0)
    fail(
      `${r.undeclared.length} undeclared fork(s). Sync the pair, or add it to FORKS in scripts/maintenance/mirror-check.mjs with a reason from REASONS`,
      r.undeclared.map((f) => `${f.path}  (${f.rootOnly} root-only / ${f.pluginOnly} plugin-only)`),
    );
  if (r.badReason.length > 0)
    fail("fork(s) declared with a reason outside the closed vocabulary", r.badReason.map((f) => `${f.path} → "${FORKS[f.path]}"`));
  if (r.staleDeclarations.length > 0)
    fail(
      "fork(s) declared in FORKS that are no longer forked — delete the entry so the ledger stays honest",
      r.staleDeclarations,
    );
  if (!failed) console.log("[mirror:check] OK");
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("mirror-check.mjs")) main();

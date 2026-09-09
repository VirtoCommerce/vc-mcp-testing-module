// Guards the `.claude/` ↔ `plugins/vc-fix/` mirror.
//
// This file used to carry its own hardcoded list of pairs that must stay byte-identical. That list
// could only ever name the files that already happened to match, which is why the 2026-09-07 audit
// found 64 of 92 shared paths diverged with nothing watching them. The list is now DERIVED from
// `scripts/maintenance/mirror-check.mjs` — one registry, one vocabulary of reasons, and a fork that
// nobody declared fails rather than passing silently.
//
// The security argument for byte-identity on the containment core is unchanged (PR #143): the
// self-diagnostics hooks ship twice, BOTH copies are registered, and hooks are AND-gated, so a
// stale copy denies whatever the fresh one allows — and the hardened redaction plus the
// default-deny closed-schema upstream path are what keep client data from leaving the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditMirror,
  classify,
  canonicalise,
  driftSize,
  FORKS,
  REASONS,
  CONTAINMENT_CORE,
} from "../maintenance/mirror-check.mjs";

// ---- the live corpus ---------------------------------------------------------------------------

const audit = auditMirror();

test("the self-diagnostics containment core is byte-identical on both surfaces", () => {
  assert.deepEqual(
    audit.containmentDrift,
    [],
    "a one-sided edit here reopens the client-data-leak class on one surface while the other stays fixed",
  );
  for (const p of CONTAINMENT_CORE) {
    assert.ok(audit.shared.includes(p), `${p} must exist in BOTH trees, not just one`);
  }
});

test("every shared path is identical, structural, or a DECLARED fork", () => {
  assert.deepEqual(
    audit.undeclared.map((f) => f.path),
    [],
    "add the pair to FORKS in scripts/maintenance/mirror-check.mjs with a reason, or sync it",
  );
});

test("every declared reason is in the closed vocabulary", () => {
  assert.deepEqual(audit.badReason.map((f) => f.path), []);
  for (const reason of Object.values(FORKS)) assert.ok(reason in REASONS, `unknown reason "${reason}"`);
});

test("the registry cannot rot — a declared fork that is no longer forked must be removed", () => {
  assert.deepEqual(audit.staleDeclarations, []);
});

test("the mirror has not silently shrunk", () => {
  // Not a transcribed count of anything derived — a floor. Files may be added to either tree; a
  // shared path DISAPPEARING means one side was deleted, which is exactly the fork-by-omission the
  // registry cannot see (it only compares paths present in both).
  assert.ok(audit.shared.length >= 92, `shared paths dropped to ${audit.shared.length}`);
  assert.ok(
    audit.identical.length + audit.structural.length >= 39,
    `gated pairs dropped to ${audit.identical.length + audit.structural.length}`,
  );
});

// ---- the classifier ------------------------------------------------------------------------------

test("a path that MUST differ between the trees does not count as content drift", () => {
  const root = "See `plugins/vc-fix/commands/qa-fix.md` and `.claude/knowledge/execution/quality-gates.md`.";
  const plugin = "See `commands/qa-fix.md` and `.claude/rules/quality-gates.md`.";
  assert.equal(classify(root, plugin), "structural");
});

test("the routing data's relocation into the skill is structural, not drift", () => {
  assert.equal(
    classify("routed by `ci/lib/repo-router.ts` from `ci/config/fix-repos.json`",
             "routed by `skills/qa-fix-routing/repo-router.ts` from `skills/qa-fix-routing/fix-repos.json`"),
    "structural",
  );
});

test("a link into rules/ normalises across depth AND tree shape", () => {
  assert.equal(classify("[x](../../rules/reports.md)", "[x](../../.claude/rules/reports.md)"), "structural");
});

test("a real word change is still a fork, even on a line full of paths", () => {
  assert.equal(
    classify("`plugins/vc-fix/x.md` — always REJECT", "`x.md` — always APPROVE"),
    "forked",
    "normalisation must not swallow content",
  );
});

test("CRLF alone is not a fork", () => {
  assert.equal(classify("a\r\nb\r\n", "a\nb\n"), "structural");
});

test("identical text classifies as identical, not structural", () => {
  assert.equal(classify("same\n", "same\n"), "identical");
});

test("driftSize counts lines on each side, ignoring blank lines", () => {
  const d = driftSize("keep\nonly-root\n\n", "keep\nonly-plugin\nalso-plugin\n");
  assert.deepEqual(d, { rootOnly: 1, pluginOnly: 2 });
});

test("canonicalise is idempotent", () => {
  const once = canonicalise("see `plugins/vc-fix/knowledge/x.md` and `../../rules/reports.md`");
  assert.equal(canonicalise(once), once);
});

// ---- the burn-down ---------------------------------------------------------------------------------

test('"undecided" is a burn-down list, not a resting place', () => {
  // A ratchet, not a target: the count may fall, never rise. Each entry is a pair where nobody has
  // decided which side wins. Adjudicating one means replacing "undecided" with a real reason.
  assert.ok(
    audit.undecided.length <= 10,
    `undecided forks rose to ${audit.undecided.length}; declare a real reason instead of adding one`,
  );
});

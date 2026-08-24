// Tests for the design-spec classifiers in `scripts/lib/verify-design-spec.ts`.
//
// The boundaries pinned here are the ones where a wrong call is INVISIBLE in a report:
//
//   UNSPEC must never be a failure — a design project is rarely exhaustive, and treating
//   "the spec doesn't mention this" as a defect turns the whole axis into noise that gets
//   ignored, which is worse than not running it.
//
//   An empty expectation set must never be a PASS — "we checked and it matched" and "there
//   was nothing to check" are different outcomes, and silence reads as the former.
//
//   SKIPPED must never be a PASS — the design axis cannot run without an authorized
//   DesignSync source (no /design-login in web sessions or CI). Same discipline as
//   `tokens:check` exiting 2 on an unreachable source rather than passing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDesignToken,
  classifyIconParity,
  classifyComponentGeometry,
  designAxisSkipped,
  summarizeDesignFindings,
  type IconAuditResult,
  type GeometryAuditResult,
} from "../lib/verify-design-spec.ts";

// --- tokens ----------------------------------------------------------------

test("token axis: notation-only difference is CONFIRMED, real difference is DRIFT", () => {
  const confirmed = classifyDesignToken({
    evaluated: 1,
    items: [{ name: "--color-primary-500", expected: "#e52121", live: "rgb(229, 33, 33)" }],
  });
  assert.equal(confirmed.verdict, "CONFIRMED");
  assert.equal(confirmed.severity, "PASS");

  const drift = classifyDesignToken({
    evaluated: 1,
    items: [{ name: "--color-primary-500", expected: "#e52121", live: "#c41212" }],
  });
  assert.equal(drift.verdict, "DRIFT");
  assert.equal(drift.severity, "FAIL");
  assert.match(drift.message, /--color-primary-500/);
});

test("token axis: a spec'd token absent from the live page is MISSING, not silently clean", () => {
  const finding = classifyDesignToken({
    evaluated: 1,
    items: [{ name: "--spacing-md", expected: "16px", live: "" }],
  });
  assert.equal(finding.verdict, "MISSING");
  assert.equal(finding.severity, "FAIL");
});

test("token axis: unresolved spec entries downgrade a clean result to WARN", () => {
  // All measured tokens matched, but part of the artboard could not be read. Reporting PASS
  // would overstate coverage.
  const finding = classifyDesignToken(
    { evaluated: 1, items: [{ name: "--spacing-md", expected: "16px", live: "16px" }] },
    { unresolved: 2 },
  );
  assert.equal(finding.verdict, "CONFIRMED");
  assert.equal(finding.severity, "WARN");
  assert.match(finding.message, /2 spec entries unresolved/);
});

// --- icons -----------------------------------------------------------------

function icon(over: Partial<IconAuditResult["items"][0]>): IconAuditResult["items"][0] {
  return {
    requested: "cart",
    rendered: "shopping-cart",
    hasSvg: true,
    drawable: 3,
    width: 24,
    height: 24,
    strokeWidth: 1.5,
    spec: { to: "shopping-cart", sizePx: 24, strokeWidth: 1.5 },
    ...over,
  };
}

test("icon axis: the mapped glyph rendering at the mapped size is CONFIRMED", () => {
  const finding = classifyIconParity({ evaluated: 1, specCount: 1, items: [icon({})] });
  assert.equal(finding.verdict, "CONFIRMED");
  assert.equal(finding.severity, "PASS");
});

test("icon axis: a different glyph than the mapping declares is DRIFT", () => {
  const finding = classifyIconParity({
    evaluated: 1,
    specCount: 1,
    items: [icon({ rendered: "shopping-bag" })],
  });
  assert.equal(finding.verdict, "DRIFT");
  assert.equal(finding.severity, "FAIL");
  assert.match(finding.message, /shopping-cart.*shopping-bag/);
});

test("icon axis: a mapped icon that renders nothing drawable is MISSING (the blank-glyph bug)", () => {
  // This is the regression a screenshot review misses: the element exists and occupies space,
  // so layout looks right, but no glyph is painted.
  const blank = classifyIconParity({
    evaluated: 1,
    specCount: 1,
    items: [icon({ drawable: 0 })],
  });
  assert.equal(blank.verdict, "MISSING");
  assert.equal(blank.severity, "FAIL");

  const noSvg = classifyIconParity({
    evaluated: 1,
    specCount: 1,
    items: [icon({ hasSvg: false, drawable: 0 })],
  });
  assert.equal(noSvg.verdict, "MISSING");
});

test("icon axis: an icon the spec never mentions is UNSPEC and NOT a failure", () => {
  const finding = classifyIconParity({
    evaluated: 1,
    specCount: 1,
    items: [icon({ requested: "sparkles", spec: null })],
  });
  assert.equal(finding.verdict, "CONFIRMED");
  assert.equal(finding.severity, "PASS");
  assert.match(finding.message, /not covered by spec/);
});

test("icon axis: size and stroke drift are caught even when the glyph name is right", () => {
  const size = classifyIconParity({
    evaluated: 1,
    specCount: 1,
    items: [icon({ width: 28, height: 28 })],
  });
  assert.equal(size.verdict, "DRIFT");
  assert.match(size.message, /24px, rendered 28×28px/);

  const stroke = classifyIconParity({
    evaluated: 1,
    specCount: 1,
    items: [icon({ strokeWidth: 2 })],
  });
  assert.equal(stroke.verdict, "DRIFT");
  assert.match(stroke.message, /stroke 1\.5, rendered 2/);
});

test("icon axis: sub-pixel size noise inside tolerance stays CONFIRMED", () => {
  const finding = classifyIconParity({
    evaluated: 1,
    specCount: 1,
    items: [icon({ width: 24.4, height: 23.6 })],
  });
  assert.equal(finding.verdict, "CONFIRMED");
});

test("icon axis: when the implementation exposes no rendered glyph name, a drawable glyph is not called drift", () => {
  // `rendered` is only trustworthy where the DOM exposes it. Absent that, claiming a mismatch
  // would invent a finding; claiming a name match would invent a confirmation. We confirm only
  // what was observed — that something drawable rendered at the right size.
  const finding = classifyIconParity({
    evaluated: 1,
    specCount: 1,
    items: [icon({ rendered: "" })],
  });
  assert.equal(finding.verdict, "CONFIRMED");
  assert.equal(finding.severity, "PASS");
});

// --- geometry --------------------------------------------------------------

function geo(over: Partial<GeometryAuditResult["items"][0]>): GeometryAuditResult["items"][0] {
  return {
    tag: "span",
    declared: "md",
    expectedPx: 24,
    expectedRatio: 1,
    width: 24,
    height: 24,
    ...over,
  };
}

test("geometry axis: token equality and ratio are both asserted, not a threshold", () => {
  assert.equal(classifyComponentGeometry({ evaluated: 1, specCount: 1, items: [geo({})] }).verdict, "CONFIRMED");

  const wrongSize = classifyComponentGeometry({
    evaluated: 1,
    specCount: 1,
    items: [geo({ width: 34, height: 28 })],
  });
  assert.equal(wrongSize.verdict, "DRIFT");

  // Right area, wrong shape — the VCST-5413 oval-vs-circle failure mode that every
  // "≥ / no-overflow" gate passes.
  const wrongRatio = classifyComponentGeometry({
    evaluated: 1,
    specCount: 1,
    items: [geo({ width: 24, height: 24, expectedRatio: 2 })],
  });
  assert.equal(wrongRatio.verdict, "DRIFT");
  assert.match(wrongRatio.message, /ratio 2, rendered 1/);
});

test("geometry axis: zero-area control is MISSING; unmatched control is UNSPEC not FAIL", () => {
  const zero = classifyComponentGeometry({
    evaluated: 1,
    specCount: 1,
    items: [geo({ width: 0, height: 0 })],
  });
  assert.equal(zero.verdict, "MISSING");
  assert.equal(zero.severity, "FAIL");

  const unspec = classifyComponentGeometry({
    evaluated: 1,
    specCount: 1,
    items: [geo({ declared: "", expectedPx: null, expectedRatio: null })],
  });
  assert.equal(unspec.severity, "PASS");
  assert.match(unspec.message, /not covered by spec/);
});

// --- empty / skipped: the two "never a PASS" rules -------------------------

test("an empty expectation set is SKIPPED + WARN, never PASS", () => {
  for (const finding of [
    classifyDesignToken({ evaluated: 0, items: [] }),
    classifyIconParity({ evaluated: 0, specCount: 0, items: [] }),
    classifyComponentGeometry({ evaluated: 0, specCount: 0, items: [] }),
  ]) {
    assert.equal(finding.verdict, "SKIPPED", `${finding.axis} must not claim a pass`);
    assert.equal(finding.severity, "WARN");
    assert.match(finding.message, /not exercised, not passed/);
  }
});

test("designAxisSkipped marks every axis SKIPPED + WARN and carries the reason", () => {
  const findings = designAxisSkipped("design source unauthorized (/design-login unavailable)");
  assert.equal(findings.length, 3);
  for (const f of findings) {
    assert.equal(f.verdict, "SKIPPED");
    assert.equal(f.severity, "WARN");
    assert.notEqual(f.severity, "PASS");
    assert.match(f.message, /design-login unavailable/);
  }
});

test("summarizeDesignFindings distinguishes an all-skipped run from a clean run", () => {
  const skipped = summarizeDesignFindings(designAxisSkipped("no authorized design source"));
  assert.equal(skipped.verdict, "SKIPPED");
  assert.equal(skipped.severity, "WARN");
  assert.match(skipped.line, /SKIPPED/);

  const clean = summarizeDesignFindings([
    classifyDesignToken({ evaluated: 1, items: [{ name: "--spacing-md", expected: "16px", live: "16px" }] }),
  ]);
  assert.equal(clean.verdict, "CONFIRMED");
  assert.equal(clean.severity, "PASS");

  const failing = summarizeDesignFindings([
    classifyDesignToken({ evaluated: 1, items: [{ name: "--spacing-md", expected: "16px", live: "13px" }] }),
    ...designAxisSkipped("icons not in scope", ["DESIGN-ICON"]),
  ]);
  assert.equal(failing.severity, "FAIL");
  assert.equal(failing.verdict, "DRIFT");
});

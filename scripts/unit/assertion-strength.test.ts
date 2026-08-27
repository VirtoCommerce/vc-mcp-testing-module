// Unit tests for the T-006 assertion-strength classifier
// (scripts/test-cases/lint-test-cases.ts).
//
// Why this rule exists: measured on this corpus, 1,044 of 1,961 Frontend cases
// (53%) asserted only presence, and a presence check fails only when the element
// is absent entirely — the rarest failure mode. Real bugs render SOMETHING (the
// open bug `non-usd-price-zero-display` renders a literal `£0.00`, so "price is
// visible" passes).
//
// The classifier has to get TWO directions right, and the second is what stops it
// becoming noise: it must flag presence-only cases, and it must NOT flag the
// measurable ones that already exist (048c) or the value-comparing ones
// (CAT-AURL-001). A rule that hits correct cases gets switched off.
// Run: `npx tsx --test scripts/unit/assertion-strength.test.ts` / `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAssertionStrength,
  hasDiscriminatingAssertion,
} from "../test-cases/lint-test-cases.js";

test("measurable UI tags are invariants", () => {
  for (const l of [
    "[SHIFT] before vs after topDelta == 0",
    "[TOUCH] belowAA == 0",
    "[SPACING] offGrid == 0",
    "[CLS] value <= 0.1",
    "[ALIGN] heightDrift <= 1",
    "[OVERFLOW] horizontal == false",
    "[IMGDIMS] missingDims == 0",
  ]) {
    assert.equal(classifyAssertionStrength(l), "INV", l);
  }
});

test("[MATH] counts as an invariant only with a formula", () => {
  assert.equal(classifyAssertionStrength("[MATH] line total = unit price × quantity"), "INV");
  // No formula: T-003 already rejects this shape; strength must not rescue it.
  assert.notEqual(classifyAssertionStrength("[MATH] the total looks right"), "INV");
});

test("relations are recognised by tag and by phrasing", () => {
  assert.equal(classifyAssertionStrength("[REL] PDP price == listing price for the same SKU"), "REL");
  for (const l of [
    "[DOM] cart subtotal after removing the line is unchanged from before",
    "[STATE] the end state is identical to the state before the Back navigation",
    "[DOM] tab B's account name is the same as tab A's",
  ]) {
    assert.equal(classifyAssertionStrength(l), "REL", l);
  }
});

test("a derived comparison is DER, not PRES", () => {
  assert.equal(
    classifyAssertionStrength("[DOM] img src host equals @td(STORE_ASSET_TEST_URL.host)"),
    "DER",
  );
  assert.equal(classifyAssertionStrength("[DOM] title equals {{EXPECTED_TITLE}}"), "DER");
});

test("shape checks are falsifiable without a literal", () => {
  for (const l of [
    "[FORMAT] price matches /^\\$\\d+\\.\\d{2}$/",
    "[DOM] rows sorted ascending by name",
    "[COUNT] exactly 3 facets rendered",
    "[FORMAT] all prices display with exactly 2 decimal places",
  ]) {
    const c = classifyAssertionStrength(l);
    assert.ok(c === "SHAPE" || c === "INV", `${l} → ${c}`);
  }
});

test("presence verbs classify as PRES", () => {
  for (const l of [
    "[DOM] Thumbnail strip visible with multiple images",
    "[DOM] Related products section visible below main product info",
    "[DOM] success notification is shown",
    "[STATE] the compare bar appears",
    "[DOM] 'Add to Cart' button disabled before any option selected",
  ]) {
    assert.equal(classifyAssertionStrength(l), "PRES", l);
  }
});

test("a numeric delta on a [DOM] line is an invariant, not presence", () => {
  // The corpus's own good example — it must not be mistaken for PRES just
  // because the line starts with [DOM].
  assert.equal(classifyAssertionStrength("[DOM] cart badge increments by exactly 1"), "INV");
});

test("hasDiscriminatingAssertion: one strong line rescues a presence guard", () => {
  assert.equal(
    hasDiscriminatingAssertion(["[DOM] price is visible", "[DOM] title is displayed"]),
    false,
  );
  assert.equal(
    hasDiscriminatingAssertion([
      "[DOM] price is visible",
      "[REL] PDP price == listing price for the same SKU, both non-zero",
    ]),
    true,
  );
});

test("an empty set is not treated as discriminating", () => {
  assert.equal(hasDiscriminatingAssertion([]), false);
  assert.equal(classifyAssertionStrength("   "), "UNKNOWN");
});

// Regression guards against the two ways this rule could become noise.
test("the real 048c measurable cases all pass the gate", () => {
  const real = [
    ["[VIEWPORT] 1280x900", "[SHIFT] before vs after topDelta == 0", "[SHIFT] before vs after leftDelta == 0"],
    ["[TOUCH] belowAA == 0", "[TOUCH] belowAAA == 0", "[TOUCH] tooClose == 0"],
    ["[ALIGN] heightDrift <= 1"],
  ];
  for (const lines of real) assert.ok(hasDiscriminatingAssertion(lines), lines.join(" | "));
});

test("a presence guard plus a measured invariant passes (the intended authoring shape)", () => {
  assert.ok(
    hasDiscriminatingAssertion([
      "[DOM] the review-form star picker is visible",
      "[MATH] document scrollWidth = document clientWidth at 375px width",
    ]),
  );
});

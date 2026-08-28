/**
 * Unit tests for scripts/seed-data/loyalty/missions-e2e-specs.mjs — the suite-083d fixture set.
 * Pure logic only: no network, no env, no fs.
 *
 * The tests are written against the ways this set can go VACUOUS, not the ways it can go missing.
 * Suite 083d ran on 2026-08-28 with every fixture present, correct and resolvable — and 6 of 8 cases
 * BLOCKED, because the fixtures had been consumed. So most of what follows perturbs a spec or an
 * overlay into a state that still LOOKS seeded and asserts the guard notices.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEED_PREFIX, NAME_PREFIX, PRODUCT_PREFIX, RUN_ID_PATTERN, RUNTIME_FIELDS_BY_KIND,
  MISSIONS, MISSION_BY_ALIAS, PRODUCTS, PRODUCT_BY_SLOT, UNIT_PRODUCT, PTS_PRODUCT, PERSKU_PRODUCTS,
  REWARD_USER, DISCOUNT_RATE, DEFAULT_SWEEP_MAX_AGE_HOURS,
  PRE_COMPLETION_STATUSES, MAX_SEED_PROGRESS_PERCENT,
  newRunId, missionName, isE2EMissionName, runIdFromName, runIdAgeHours,
  buildE2EMissionBody, buildGoalItems, needsGoalItems, missionSlots,
  isPreCompletion, balanceIsLegible,
  unitsToComplete, unitsJustBelow, discountBand,
  validateSpecShape, validateSeededState,
  CASE_MISSIONS, CASE_MISSION_BY_ALIAS, CASE_ACCOUNTS, CASE_ACCOUNT_BY_ALIAS, CASE_ACCOUNT_PREFIX,
  ALL_MISSIONS, TARGET_RULES, MIN_TARGET_SEPARATION, COMPLETE_ALL_FRACTION, isCaseMission,
  measuredMoney, moneyIncoherence, deriveCaseTarget, attributionProblems,
  shippingHeadroom, taxRateOf, minReading, readingsFor,
  TARGETING_MISSIONS, TARGETING_MISSION_BY_ALIAS, TARGETING_GROUP, TARGETING_CASE_ID,
  TARGETING_MEMBER_ALIAS, TARGETING_OUTSIDER_ALIAS, isTargetingMission,
  boundAccounts, ACCOUNT_BOUND_MISSIONS, declaredAliases,
  unreachableTarget, visibilityPolicy, formatVisibility, parseVisibility,
} from '../seed-data/loyalty/missions-e2e-specs.mjs';

/* ── Run identity ───────────────────────────────────────────────────────────── */

test('newRunId produces a parsable, sweepable handle', () => {
  const id = newRunId(new Date('2026-08-28T11:54:00Z'), 0.5);
  assert.match(id, RUN_ID_PATTERN);
  assert.ok(id.startsWith('20260828115400'));
});

test('a mission name round-trips its run handle, and only E2E names are recognised', () => {
  const runId = newRunId(new Date('2026-08-28T11:54:00Z'), 0.25);
  const name = missionName(runId, 'ORDERVALUE');
  assert.equal(runIdFromName(name), runId);
  assert.ok(isE2EMissionName(name));
  // The stable fixture set MUST NOT match — teardown here would otherwise delete 083c's missions.
  assert.equal(isE2EMissionName('AGENT-TEST-MSN-ORDERVALUE'), false);
  assert.equal(isE2EMissionName('AGENT-TEST-MSN-ORDERCOUNT'), false);
  assert.equal(isE2EMissionName('Some Merchant Mission'), false);
  // A name that merely starts with the prefix but carries no handle is not ours either.
  assert.equal(isE2EMissionName(`${NAME_PREFIX}-ORDERVALUE`), false);
});

test('runIdAgeHours ages a handle and refuses an unparsable one', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  assert.equal(runIdAgeHours('20260828100000-abcd', now), 2);
  assert.equal(runIdAgeHours('not-a-handle', now), null);
  assert.equal(runIdAgeHours(null, now), null);
});

/* ── The committed spec set ─────────────────────────────────────────────────── */

test('the committed spec set is clean', () => {
  assert.deepEqual(validateSpecShape(), []);
});

test('every fixture carries the teardown prefix', () => {
  assert.ok(NAME_PREFIX.startsWith(SEED_PREFIX));
  assert.ok(PRODUCT_PREFIX.startsWith(SEED_PREFIX));
  for (const p of PRODUCTS) assert.ok(p.sku.startsWith(SEED_PREFIX), `${p.aliasName} sku`);
});

test('every LOOP mission is reachable by the customer — Published, public, open window, untargeted', () => {
  for (const m of MISSIONS) {
    assert.equal(m.status, 'Published', m.aliasName);
    assert.equal(m.public, true, m.aliasName);
    assert.equal(m.window, 'active', m.aliasName);
    assert.equal(m.condition?.type, 'AnyUserGroupCondition', m.aliasName);
    assert.ok(Number(m.reward) > 0, m.aliasName);
  }
});

/* ── The vacuity rules, each perturbed ──────────────────────────────────────── */

test('a group-targeted mission is rejected — the per-run reward account belongs to no group', () => {
  const spec = MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE;
  const original = spec.condition;
  spec.condition = { type: 'UserGroupIsCondition', groups: ['VIP'] };
  try {
    const problems = validateSpecShape();
    assert.ok(problems.some((p) => /invisible to exactly the account that drives it/.test(p)), problems.join('\n'));
  } finally { spec.condition = original; }
});

test('a zero reward is rejected — "the reward landed" becomes unfalsifiable', () => {
  const spec = MISSION_BY_ALIAS.MSN_E2E_ORDERCOUNT;
  const original = spec.reward;
  spec.reward = 0;
  try {
    assert.ok(validateSpecShape().some((p) => /reward=0/.test(p)));
  } finally { spec.reward = original; }
});

test('an OrderCount target of 1 is rejected — counting and firing become the same observation', () => {
  const spec = MISSION_BY_ALIAS.MSN_E2E_ORDERCOUNT;
  const original = spec.goal.count;
  spec.goal.count = 1;
  try {
    assert.ok(validateSpecShape().some((p) => /same observation/.test(p)));
  } finally { spec.goal.count = original; }
});

test('an OrderValue target that no whole unit count lands on is rejected', () => {
  const spec = MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE;
  const original = spec.goal.value;
  spec.goal.value = UNIT_PRODUCT.listPrice * 3 + 1;   // never an exact multiple
  try {
    assert.ok(validateSpecShape().some((p) => /not a whole multiple/.test(p)));
  } finally { spec.goal.value = original; }
});

test('an OrderValue target too large to drive through a stepper is rejected', () => {
  const spec = MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE;
  const original = spec.goal.value;
  spec.goal.value = UNIT_PRODUCT.listPrice * 40;
  try {
    assert.ok(validateSpecShape().some((p) => /too many for a storefront stepper/.test(p)));
  } finally { spec.goal.value = original; }
});

test('MSN_E2E_PERSKU with a single target is rejected — all=true stops meaning anything', () => {
  const spec = MISSION_BY_ALIAS.MSN_E2E_PERSKU;
  const original = spec.slots;
  spec.slots = ['A'];
  try {
    assert.ok(validateSpecShape().some((p) => /the same mission and the modal has one row/.test(p)));
  } finally { spec.slots = original; }
});

test('MSN_E2E_PERSKU_PTS losing its PTS target is rejected — the case would ask nothing about currency', () => {
  const spec = MISSION_BY_ALIAS.MSN_E2E_PERSKU_PTS;
  const original = spec.slots;
  spec.slots = ['A'];
  try {
    assert.ok(validateSpecShape().some((p) => /does not target the PTS-priced product/.test(p)));
  } finally { spec.slots = original; }
});

test('the PTS target sharing the denomination product currency is rejected', () => {
  const original = PTS_PRODUCT.currencyIntent;
  PTS_PRODUCT.currencyIntent = UNIT_PRODUCT.currencyIntent;
  try {
    assert.ok(validateSpecShape().some((p) => /cannot ask it in the default currency/.test(p)));
  } finally { PTS_PRODUCT.currencyIntent = original; }
});

test('a pack size above 1 is rejected — the stepper could not reach exactly 1 (gap 3)', () => {
  const p = PERSKU_PRODUCTS[0];
  const original = p.packSize;
  p.packSize = 2;
  try {
    const problems = validateSpecShape();
    assert.ok(problems.some((m) => /packSize=2/.test(m)), problems.join('\n'));
  } finally { p.packSize = original; }
});

/* ── Derived arithmetic ─────────────────────────────────────────────────────── */

test('the order composition numbers are derived from the target and the unit price', () => {
  const ov = MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE;
  assert.equal(unitsToComplete(ov, UNIT_PRODUCT), Math.ceil(ov.goal.value / UNIT_PRODUCT.listPrice));
  assert.equal(unitsJustBelow(ov, UNIT_PRODUCT), unitsToComplete(ov, UNIT_PRODUCT) - 1);
  assert.ok(unitsJustBelow(ov, UNIT_PRODUCT) * UNIT_PRODUCT.listPrice < ov.goal.value);
  assert.ok(unitsToComplete(ov, UNIT_PRODUCT) * UNIT_PRODUCT.listPrice >= ov.goal.value);
});

test('the discount band leaves real shipping headroom below the target', () => {
  const band = discountBand();
  assert.ok(band.preDiscount >= band.target, 'the completing order must clear the target');
  assert.ok(band.postDiscount < band.target, 'the discounted order must fall back below it');
  assert.equal(band.shippingHeadroom, Number((band.target - band.postDiscount).toFixed(2)));
  assert.ok(band.shippingHeadroom >= UNIT_PRODUCT.listPrice, 'headroom below one unit means any shipping charge kills the case');
});

test('a discount rate too small to move the order below the target is caught', () => {
  const band = discountBand(MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE, UNIT_PRODUCT, 0.01);
  assert.ok(band.shippingHeadroom <= 0 || band.postDiscount >= band.target * 0.98);
});

/* ── Goal items ─────────────────────────────────────────────────────────────── */

test('goal items are built per declared slot, at the product-declared quantity', () => {
  const spec = MISSION_BY_ALIAS.MSN_E2E_PERSKU;
  const resolved = { A: { id: 'pa' }, B: { id: 'pb' }, P: { id: 'pp' } };
  const items = buildGoalItems(spec, 'm1', resolved);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.productId).sort(), ['pa', 'pb']);
  for (const i of items) {
    assert.equal(i.missionId, 'm1');
    assert.equal(i.quantity, 1);
    assert.equal(i.quantity % PRODUCT_BY_SLOT.A.packSize, 0);
  }
});

test('a non-PerSku mission produces no goal items, and an unresolved slot throws', () => {
  assert.deepEqual(buildGoalItems(MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE, 'm', {}), []);
  assert.equal(needsGoalItems(MISSION_BY_ALIAS.MSN_E2E_ORDERCOUNT), false);
  assert.throws(() => buildGoalItems(MISSION_BY_ALIAS.MSN_E2E_PERSKU, 'm', { A: { id: 'pa' } }), /slot B/);
});

/* ── Mission body ───────────────────────────────────────────────────────────── */

const TEMPLATE = {
  id: null,
  dynamicExpression: {
    id: 'LoyaltyMissionConditionAndRewardTree',
    children: [
      { id: 'BlockLoyaltyMissionCondition', availableChildren: [{ id: 'AnyUserGroupCondition' }, { id: 'UserGroupIsCondition', groups: [] }], children: [] },
      { id: 'BlockLoyaltyMissionGoals', availableChildren: [{ id: 'OrderValueGoal', value: 0, currencyCode: null }, { id: 'OrderCountGoal', count: 0 }, { id: 'PerSkuGoal', all: false }], children: [] },
      { id: 'BlockLoyaltyReward', availableChildren: [{ id: 'FixedAmountReward', amount: 0 }], children: [] },
    ],
  },
};

test('the body carries the run-scoped name and the resolved goal currency', () => {
  const runId = newRunId(new Date('2026-08-28T11:54:00Z'), 0.75);
  const body = buildE2EMissionBody(MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE, runId, {
    template: TEMPLATE, storeId: 'B2B-store', currencies: { 'store-default': 'USD' },
  });
  assert.equal(body.name, missionName(runId, 'ORDERVALUE'));
  assert.equal(body.storeId, 'B2B-store');
  assert.equal(body.status, 'Published');
  assert.equal(body.public, true);
  assert.equal(body.id, null);
  const goal = body.dynamicExpression.children.find((b) => b.id === 'BlockLoyaltyMissionGoals').children[0];
  assert.equal(goal.id, 'OrderValueGoal');
  assert.equal(goal.value, MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE.goal.value);
  assert.equal(goal.currencyCode, 'USD');
  const reward = body.dynamicExpression.children.find((b) => b.id === 'BlockLoyaltyReward').children[0];
  assert.equal(reward.amount, MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE.reward);
});

test('a PerSku body carries the all flag, and the body refuses an invalid run handle', () => {
  const runId = newRunId(new Date('2026-08-28T11:54:00Z'), 0.1);
  const any = buildE2EMissionBody(MISSION_BY_ALIAS.MSN_E2E_PERSKU_PTS, runId, { template: TEMPLATE, storeId: 'S' });
  const goal = any.dynamicExpression.children.find((b) => b.id === 'BlockLoyaltyMissionGoals').children[0];
  assert.equal(goal.id, 'PerSkuGoal');
  assert.equal(goal.all, false);
  assert.throws(() => buildE2EMissionBody(MISSION_BY_ALIAS.MSN_E2E_PERSKU, 'nope', { template: TEMPLATE, storeId: 'S' }), /invalid run id/);
});

/* ── Pre-completion + legibility ────────────────────────────────────────────── */

test('isPreCompletion accepts only a not-yet-finished, zero-progress state', () => {
  for (const status of PRE_COMPLETION_STATUSES) assert.ok(isPreCompletion({ status, percent: MAX_SEED_PROGRESS_PERCENT }));
  assert.equal(isPreCompletion({ status: 'Completed', percent: 100 }), false);
  assert.equal(isPreCompletion({ status: 'InProgress', percent: 50 }), false, 'a partially advanced mission is not a clean starting point');
  assert.equal(isPreCompletion({ status: 'Expired', percent: 0 }), false);
});

test('balanceIsLegible requires the reward to at least double the balance', () => {
  assert.ok(balanceIsLegible(0, 500));
  assert.ok(balanceIsLegible(499, 500));
  assert.equal(balanceIsLegible(500, 500), false);
  // The observed LOYALTY_VIP_USER balance on 2026-08-28 — the whole reason MSN-E2E-004 was undemonstrable.
  assert.equal(balanceIsLegible(964189233, 500), false);
});

/* ── The overlay vacuity guard ──────────────────────────────────────────────── */

const RUN = '20260828115400-abcd';
const cleanOverlay = () => {
  const o = {
    MSN_E2E_RUN: { run_id: RUN, seeded_at: '2026-08-28T11:54:00Z', store_id: 'B2B-store' },
    [REWARD_USER.aliasName]: { email: 'AGENT-TEST-loyzero-x@test-agent.com', user_id: 'u1', balance_at_seed: '0' },
  };
  for (const m of ALL_MISSIONS) {
    o[m.aliasName] = {
      id: `id-${m.key}`, name: missionName(RUN, m.key), run_id: RUN,
      progress_status_at_seed: 'NotStarted', progress_percent_at_seed: '0',
    };
  }
  for (const p of PRODUCTS) {
    const slug = `seed-loyalty-missions-e2e/${p.sku.toLowerCase()}`;
    o[p.aliasName] = { productId: `p-${p.slot}`, catalogId: 'c1', currency: p.currencyIntent === 'loyalty' ? 'PTS' : 'USD', slug, url: `/${slug}` };
  }
  // The per-case split, with the numbers MEASURED on vcst-qa 2026-08-28 (20% tax, zero shipping).
  for (const [alias, m] of Object.entries(MEASURED)) {
    const spec = CASE_MISSION_BY_ALIAS[alias];
    const d = deriveCaseTarget(spec, m);
    o[alias] = {
      ...o[alias],
      goal_target: String(d.target),
      order_shipping_max: 'unbounded',
      available_shipping: 'BuyOnlinePickupInStore/Pickup=0; FixedRate/Ground=150',
      measured_subtotal: String(m.base.grossMerchandise),
      measured_discount: String(m.base.discountTotal),
      measured_tax: String(m.base.taxTotal),
      measured_shipping: String(m.base.shippingTotal),
      measured_total: String(m.base.orderTotal),
      measured_total_undiscounted: m.undiscounted ? String(m.undiscounted.orderTotal) : '',
      reading_values: '',
      separates_below: String(d.below),
      separates_above: String(d.above),
      separation_margin: String(d.margin),
      co_completing_missions: spec.caseId === 'MSN-E2E-008' ? 'none' : '',
      reward_expected_total: spec.caseId === 'MSN-E2E-008' ? String(spec.reward) : '',
    };
  }
  // The JOURNEY (MSN-E2E-001): an authored count target, a MEASURED cart, and a co-grant set recorded
  // per order because the two orders produce different deltas.
  const journey = ALL_MISSIONS.find((m) => m.journeyOrders != null);
  if (journey) {
    const money = cart(15, 0, 3, 18);
    Object.assign(o[journey.aliasName], {
      order_shipping_max: 'unbounded',
      available_shipping: 'BuyOnlinePickupInStore/Pickup=0',
      measured_subtotal: String(money.grossMerchandise),
      measured_discount: String(money.discountTotal),
      measured_tax: String(money.taxTotal),
      measured_shipping: String(money.shippingTotal),
      measured_total: String(money.orderTotal),
      reading_values: '',
      order1_co_missions: 'AGENT-TEST-MSN-ZEROTARGET=200',
      order1_expected_delta: '200',
      co_completing_missions: 'AGENT-TEST-MSN-LOCALIZED=250',
      reward_expected_total: String(250 + Number(journey.reward)),
    });
  }
  // The targeting star: an unreachable target and a reading for each of its two accounts.
  for (const m of TARGETING_MISSIONS) {
    Object.assign(o[m.aliasName], {
      goal_target: String(unreachableTarget()),
      observed_visibility: formatVisibility(Object.fromEntries(boundAccounts(m).map((x) => [x, true]))),
    });
  }
  for (const a of CASE_ACCOUNTS) {
    o[a.aliasName] = {
      email: `${CASE_ACCOUNT_PREFIX}20260828115400-${a.aliasName.slice(-6)}@test-agent.com`,
      user_id: `u-${a.aliasName}`, member_id: `m-${a.aliasName}`, handle: 'h', balance_at_seed: '0',
      groups_at_seed: (a.groups || []).join('; '),
    };
  }
  return o;
};

/**
 * The measured carts, exactly as the platform returned them on vcst-qa / B2B-store 2026-08-28 through
 * the same xAPI the storefront uses. These are OBSERVATIONS, not a model — the point of the whole
 * per-case redesign is that `units x listPrice` does not predict them (there is a 20% tax).
 */
const cart = (sub, disc, tax, total) => measuredMoney({
  subTotal: { amount: sub }, discountTotal: { amount: disc },
  shippingTotal: { amount: 0 }, taxTotal: { amount: tax }, total: { amount: total },
});
const MEASURED = {
  MSN_E2E_ORDERVALUE_003: { base: cart(45, 0, 9, 54) },
  MSN_E2E_ORDERVALUE_005: { base: cart(50, 10, 8, 48), undiscounted: cart(50, 0, 10, 60) },
  MSN_E2E_ORDERVALUE_006: { base: cart(60, 0, 12, 72) },
  MSN_E2E_ORDERVALUE_008: { base: cart(20, 0, 4, 24) },
};
const measuredTotals = () => Object.fromEntries(Object.entries(MEASURED).map(([k, v]) => [k, v.base.orderTotal]));
const derivedTargets = () => {
  const out = {};
  for (const [k, v] of Object.entries(MEASURED)) out[k] = deriveCaseTarget(CASE_MISSION_BY_ALIAS[k], v);
  for (const s of ALL_MISSIONS) if (!out[s.aliasName] && s.goal?.type === 'OrderValueGoal') out[s.aliasName] = { target: Number(s.goal.value) };
  return out;
};

test('a fully seeded overlay is clean', () => {
  assert.deepEqual(validateSeededState(cleanOverlay(), { now: new Date('2026-08-28T12:00:00Z') }), []);
});

test('an unseeded env is reported as unseeded, never as clean', () => {
  const problems = validateSeededState({}, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /never been seeded/);
});

test('THE MISSING CHECK — a mission already Completed at seed time fails the guard', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERVALUE.progress_status_at_seed = 'Completed';
  o.MSN_E2E_ORDERVALUE.progress_percent_at_seed = '100';
  const problems = validateSeededState(o, { now: new Date('2026-08-28T12:00:00Z') });
  assert.ok(problems.some((p) => /already at Completed 100%/.test(p)), problems.join('\n'));
  // MSN_E2E_ORDERVALUE serves MSN-E2E-004 alone since the per-case split; 003/005/006/008 moved to
  // their own missions AND their own accounts. The failure must still name whoever it blocks.
  assert.ok(problems.some((p) => /MSN-E2E-004/.test(p)), 'the failure must name the cases it blocks');
});

test('a mission with progress but not yet complete also fails — 083d needs a zero start', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERCOUNT.progress_status_at_seed = 'InProgress';
  o.MSN_E2E_ORDERCOUNT.progress_percent_at_seed = '50';
  assert.ok(validateSeededState(o, {}).some((p) => /already at InProgress 50%/.test(p)));
});

test('an unrecorded seed-time state fails — silence is never a pass', () => {
  const o = cleanOverlay();
  o.MSN_E2E_PERSKU.progress_status_at_seed = '';
  assert.ok(validateSeededState(o, {}).some((p) => /did not verify the fixture was usable/.test(p)));
});

test('a mission name from an older run fails — per-run minting silently stopped', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERVALUE.name = missionName('20260101000000-0000', 'ORDERVALUE');
  assert.ok(validateSeededState(o, {}).some((p) => /a mix of two runs/.test(p)));
});

test('a non-run-scoped mission name fails — the fixture reverted to a shared mission', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERVALUE.name = 'AGENT-TEST-MSN-ORDERVALUE';
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((p) => /not a run-scoped E2E mission name/.test(p)), problems.join('\n'));
});

test('a stale run is flagged when an age limit is supplied', () => {
  const problems = validateSeededState(cleanOverlay(), { now: new Date('2026-08-30T12:00:00Z'), maxAgeHours: 6 });
  assert.ok(problems.some((p) => /already consumed/.test(p)));
});

test('a balance that has climbed past the reward fails — MSN-E2E-004 stops demonstrating its thesis', () => {
  const o = cleanOverlay();
  o[REWARD_USER.aliasName].balance_at_seed = '1044';   // the observed LOYALTY_NOBAL_USER drift
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((p) => /at least double the balance/.test(p)), problems.join('\n'));
});

test('a missing reward account fails rather than silently running on whatever balance exists', () => {
  const o = cleanOverlay();
  delete o[REWARD_USER.aliasName];
  assert.ok(validateSeededState(o, {}).some((p) => /no low-balance account/.test(p)));
});

test('the PTS target collapsing onto the default currency fails', () => {
  const o = cleanOverlay();
  o[PTS_PRODUCT.aliasName].currency = o[UNIT_PRODUCT.aliasName].currency;
  assert.ok(validateSeededState(o, {}).some((p) => /asks nothing/.test(p)));
});

test('a missing mission id or product id fails', () => {
  const o = cleanOverlay();
  o.MSN_E2E_PERSKU.id = '';
  o[UNIT_PRODUCT.aliasName].productId = '';
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((p) => /MSN_E2E_PERSKU\.id is empty/.test(p)));
  assert.ok(problems.some((p) => /productId is empty/.test(p)));
});

/* ── Contract with the committed alias file ─────────────────────────────────── */

test('every runtime field kind is declared, and mission names are runtime', () => {
  for (const kind of ['run', 'mission', 'product', 'rewardUser']) {
    assert.ok(Array.isArray(RUNTIME_FIELDS_BY_KIND[kind]), kind);
  }
  // `name` MUST be runtime on a mission here — it carries the run handle. This is the one field whose
  // classification differs from the stable fixture set, and getting it wrong would pin the suite to a
  // single historical run forever.
  assert.ok(RUNTIME_FIELDS_BY_KIND.mission.includes('name'));
  assert.ok(RUNTIME_FIELDS_BY_KIND.mission.includes('id'));
  assert.ok(!RUNTIME_FIELDS_BY_KIND.product.includes('sku'), 'a product sku is authored, not runtime');
});

test('the sweep age floor is a positive number of hours', () => {
  assert.ok(Number.isFinite(DEFAULT_SWEEP_MAX_AGE_HOURS) && DEFAULT_SWEEP_MAX_AGE_HOURS > 0);
});

test('the discount rate is a real fraction', () => {
  assert.ok(DISCOUNT_RATE > 0 && DISCOUNT_RATE < 1);
});

test('a composed PDP url that disagrees with the resolved slug fails — soft-404 protection', () => {
  const o = cleanOverlay();
  for (const p of PRODUCTS) { o[p.aliasName].slug = `seed-loyalty-missions-e2e/${p.sku.toLowerCase()}`; o[p.aliasName].url = `/${p.sku.toLowerCase()}`; }
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /does not match its resolved slug/.test(m)), problems.join('\n'));
});

test('a resolved nested slug with a matching url is clean', () => {
  const o = cleanOverlay();
  for (const p of PRODUCTS) {
    const slug = `seed-loyalty-missions-e2e/${p.sku.toLowerCase()}`;
    o[p.aliasName].slug = slug;
    o[p.aliasName].url = `/${slug}`;
  }
  assert.deepEqual(validateSeededState(o, { now: new Date('2026-08-28T12:00:00Z') }), []);
});

test('a missing slug or url fails — the case would have to invent a storefront route', () => {
  const o = cleanOverlay();
  o[UNIT_PRODUCT.aliasName].slug = '';
  o[UNIT_PRODUCT.aliasName].url = '';
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /slug is empty/.test(m)));
  assert.ok(problems.some((m) => /url is empty/.test(m)));
});

/* ── The per-case split ──────────────────────────────────────────────────────
 *
 * These tests are written against the ways the SPLIT can silently stop working, not against its
 * presence. The failure this whole change exists to remove — four cases sharing one account, so any
 * one case's order advanced all four missions — left every fixture present, resolvable and green.
 */

const readingValuesOf = (money) => ({
  netMerchandise: money.netMerchandise,
  grossMerchandise: money.grossMerchandise,
  orderTotal: money.orderTotal,
  totalPlusPoints: money.totalPlusPoints,
});

test('the measured split is four missions on four DISTINCT accounts, one per contended case', () => {
  assert.equal(CASE_MISSIONS.length, 4);
  assert.deepEqual(CASE_MISSIONS.map((m) => m.caseId).sort(), ['MSN-E2E-003', 'MSN-E2E-005', 'MSN-E2E-006', 'MSN-E2E-008']);
  // The account is the axis that isolates: one order advances EVERY mission applicable to its user,
  // so two cases on one login contend however many missions they own.
  assert.equal(new Set(CASE_MISSIONS.map((m) => m.accountAlias)).size, 4);
  for (const m of CASE_MISSIONS) assert.ok(CASE_ACCOUNT_BY_ALIAS[m.accountAlias], m.aliasName);
});

test('EVERY account-bound mission has its own account, and no two share one', () => {
  // The set is no longer just the four measured cases: the journey (MSN-E2E-001) asserts the whole
  // chain and the targeting star reads through a pair, so both had to leave the shared reward account.
  const owners = new Map();
  for (const m of ACCOUNT_BOUND_MISSIONS) {
    for (const alias of boundAccounts(m)) {
      assert.ok(CASE_ACCOUNT_BY_ALIAS[alias], `${m.aliasName} -> ${alias}`);
      if (!owners.has(alias)) owners.set(alias, []);
      owners.get(alias).push(m.aliasName);
    }
  }
  // Only the targeting pair may carry more than one mission, because for it the pair IS the comparison.
  for (const [alias, missions] of owners) {
    if (missions.length > 1) {
      assert.ok([TARGETING_MEMBER_ALIAS, TARGETING_OUTSIDER_ALIAS].includes(alias), `${alias} carries ${missions.join(', ')}`);
    }
  }
  assert.equal(CASE_ACCOUNTS.length, owners.size);
});

test('the journey owns an account and places enough orders to show an intermediate state', () => {
  const journey = ALL_MISSIONS.find((m) => m.journeyOrders != null);
  assert.ok(journey, 'no journey mission declared');
  assert.equal(journey.goal.type, 'OrderCountGoal');
  assert.equal(Number(journey.journeyOrders), Number(journey.goal.count));
  assert.ok(Number(journey.journeyOrders) >= 2, 'one order collapses "advanced" and "completed"');
  assert.ok(boundAccounts(journey).length === 1, 'the journey must not share an account');
  assert.ok(Number(journey.order.units) > 0, 'its cart must be measurable');
});

test('a journey on the shared reward account is rejected — its chain stops being attributable', () => {
  const journey = ALL_MISSIONS.find((m) => m.journeyOrders != null);
  const original = journey.accountAlias;
  delete journey.accountAlias;
  try {
    assert.ok(validateSpecShape().some((p) => /a journey mission MUST own its account/.test(p)));
  } finally { journey.accountAlias = original; }
});

test('a journey whose order count no longer matches its goal is rejected', () => {
  const journey = ALL_MISSIONS.find((m) => m.journeyOrders != null);
  const original = journey.journeyOrders;
  journey.journeyOrders = 3;
  try {
    assert.ok(validateSpecShape().some((p) => /journeyOrders=3 but the goal counts 2/.test(p)));
  } finally { journey.journeyOrders = original; }
});

test('MSN_E2E_ORDERVALUE is now MSN-E2E-004 only — the case that was never contended', () => {
  assert.deepEqual(MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE.cases, ['MSN-E2E-004']);
  assert.equal(isCaseMission(MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE), false);
  for (const m of CASE_MISSIONS) assert.ok(isCaseMission(m), m.aliasName);
});

test('the per-case accounts do NOT share a sweep namespace with the ephemeral-user seeder', () => {
  // AGENT-TEST-loyzero-* is swept by `npm run seed:loyalty:zero-user:teardown`. If these accounts fell
  // inside it, that teardown would delete them underneath a running 083d.
  assert.ok(CASE_ACCOUNT_PREFIX.startsWith(SEED_PREFIX));
  assert.equal(CASE_ACCOUNT_PREFIX.startsWith('AGENT-TEST-loyzero-'), false);
});

test('every GRANTING mission reward is distinct — a shared reward makes a grant unattributable', () => {
  const seen = new Set();
  for (const m of ALL_MISSIONS) {
    // The targeting star deliberately shares one reward: its three cells must be identical but for the
    // single input each isolates, and they can never grant, so no delta has to attribute them.
    if (isTargetingMission(m)) continue;
    assert.equal(seen.has(m.reward), false, `${m.aliasName} reuses reward ${m.reward}`);
    seen.add(m.reward);
  }
  // ...and the star's shared reward must still not collide with a mission that CAN grant.
  const starReward = TARGETING_MISSIONS[0].reward;
  assert.equal(seen.has(starReward), false, 'a star cell shares a reward with a mission that can grant');
  assert.equal(new Set(TARGETING_MISSIONS.map((m) => m.reward)).size, 1, 'the star cells must share one reward');
});

test('a star cell colliding with a GRANTING mission is still rejected', () => {
  const cell = TARGETING_MISSIONS[0];
  const original = cell.reward;
  cell.reward = MISSION_BY_ALIAS.MSN_E2E_PERSKU.reward;
  try {
    assert.ok(validateSpecShape().some((p) => /indistinguishable in a balance delta/.test(p)), 'the exemption must be from the star ITSELF, never from the rest of the set');
  } finally { cell.reward = original; }
});

test('a colliding reward is rejected — the divergence clause of the SECOND RULE', () => {
  const spec = CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_005;
  const original = spec.reward;
  spec.reward = CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_003.reward;
  try {
    assert.ok(validateSpecShape().some((p) => /indistinguishable in a balance delta/.test(p)));
  } finally { spec.reward = original; }
});

test('an AUTHORED per-case target is rejected — it must be measured', () => {
  const spec = CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_003;
  const original = spec.goal.value;
  spec.goal.value = 50;
  try {
    assert.ok(validateSpecShape().some((p) => /goal\.value is authored/.test(p)));
  } finally { spec.goal.value = original; }
});

test('two cases sharing an account alias is rejected — that IS the contention', () => {
  const spec = CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_006;
  const original = spec.accountAlias;
  spec.accountAlias = CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_003.accountAlias;
  try {
    assert.ok(validateSpecShape().some((p) => /shares account alias/.test(p)));
  } finally { spec.accountAlias = original; }
});

test('MSN-E2E-008 must order the smallest cart, or its reward stops being attributable', () => {
  const spec = CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_008;
  const original = spec.order.units;
  spec.order.units = 99;
  try {
    assert.ok(validateSpecShape().some((p) => /Give it the smallest cart in the set/.test(p)));
  } finally { spec.order.units = original; }
});

test('a fixture that does not state its LIMITS is rejected', () => {
  const spec = CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_006;
  const original = spec.limits;
  spec.limits = '';
  try {
    assert.ok(validateSpecShape().some((p) => /declares no .limits./.test(p)));
  } finally { spec.limits = original; }
});

test('a coupon on a rule that does not use one is rejected, and a missing one on the rule that does', () => {
  const withCoupon = CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_005;
  const without = CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_006;
  const a = withCoupon.order.coupon; const b = without.order.coupon;
  withCoupon.order.coupon = null;
  without.order.coupon = 'COUPON_20PCT';
  try {
    const problems = validateSpecShape();
    assert.ok(problems.some((p) => /needs order\.coupon/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /does not use one/.test(p)), problems.join('\n'));
  } finally { withCoupon.order.coupon = a; without.order.coupon = b; }
});

/* ── Measured money ─────────────────────────────────────────────────────────── */

test('measuredMoney transcribes the cart and derives only netMerchandise', () => {
  const m = cart(50, 10, 8, 48);
  assert.equal(m.grossMerchandise, 50);
  assert.equal(m.discountTotal, 10);
  assert.equal(m.netMerchandise, 40);
  assert.equal(m.taxTotal, 8);
  assert.equal(m.orderTotal, 48);
  assert.equal(m.totalPlusPoints, 48);
  assert.equal(moneyIncoherence(m), null);
});

test('a total the composition does not explain is refused, not tolerated', () => {
  const bad = cart(50, 10, 8, 99);
  assert.match(String(moneyIncoherence(bad)), /carries a term this module does not model/);
});

test('the store tax rate is DERIVED from a measured cart, never declared', () => {
  // 20% on vcst-qa. The point is that the number comes out of the cart, so a store that changes it
  // moves every dependent figure instead of leaving a stale constant behind.
  assert.equal(Number(taxRateOf(cart(45, 0, 9, 54)).toFixed(4)), 0.2);
  assert.equal(taxRateOf(cart(0, 0, 0, 0)), 0);
});

/* ── Target derivation, against the real measurements ───────────────────────── */

test('003 puts its target between merchandise value and order total', () => {
  const d = deriveCaseTarget(CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_003, MEASURED.MSN_E2E_ORDERVALUE_003);
  assert.equal(d.below, 45);
  assert.equal(d.above, 54);
  assert.equal(d.target, 49.5);
  assert.ok(d.below < d.target && d.target <= d.above);
  assert.ok(d.margin >= MIN_TARGET_SEPARATION);
});

test('005 puts its target between the discounted and undiscounted totals of the SAME cart', () => {
  const d = deriveCaseTarget(CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_005, MEASURED.MSN_E2E_ORDERVALUE_005);
  assert.equal(d.below, 48);
  assert.equal(d.above, 60);
  assert.equal(d.target, 54);
  // The counterfactual the case claims: the same order without the coupon WOULD have completed.
  assert.ok(MEASURED.MSN_E2E_ORDERVALUE_005.undiscounted.orderTotal >= d.target);
  assert.ok(MEASURED.MSN_E2E_ORDERVALUE_005.base.orderTotal < d.target);
});

test('006 and 008 complete under EVERY candidate reading — their questions are not about the value', () => {
  for (const alias of ['MSN_E2E_ORDERVALUE_006', 'MSN_E2E_ORDERVALUE_008']) {
    const m = MEASURED[alias];
    const d = deriveCaseTarget(CASE_MISSION_BY_ALIAS[alias], m);
    assert.equal(d.target, Number((minReading(m.base) * COMPLETE_ALL_FRACTION).toFixed(2)), alias);
    for (const reading of Object.values(readingValuesOf(m.base))) {
      assert.ok(reading >= d.target, `${alias}: reading ${reading} does not reach target ${d.target}`);
    }
  }
});

test('a cart with NO tax and no shipping leaves 003 no band at all, and the seed fails', () => {
  // This is the original defect in its purest form: merchandise value and order total are the same
  // number, so both readings predict the same observation and the case decides nothing.
  const flat = { base: cart(45, 0, 0, 45) };
  assert.throws(
    () => deriveCaseTarget(CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_003, flat),
    /no band to place a target in/,
  );
});

test('a band narrower than the floor is refused rather than published', () => {
  const thin = { base: cart(45, 0, 1, 46) };   // 1.00 apart -> 0.5 either side
  assert.throws(() => deriveCaseTarget(CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_003, thin), /indistinguishable from a rounding rule/);
});

test('a coupon that did not apply fails the seed instead of sizing against two identical carts', () => {
  const noDiscount = { base: cart(50, 0, 10, 60), undiscounted: cart(50, 0, 10, 60) };
  assert.throws(
    () => deriveCaseTarget(CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_005, noDiscount),
    /it did not apply/,
  );
});

/* ── Attribution ────────────────────────────────────────────────────────────── */

test('the measured order totals leave MSN-E2E-008 the only completer of its own order', () => {
  assert.deepEqual(attributionProblems(derivedTargets(), measuredTotals()), []);
});

test('an 008 order big enough to reach a sibling target is flagged — the delta would name nothing', () => {
  const totals = { ...measuredTotals(), MSN_E2E_ORDERVALUE_008: 100 };
  const problems = attributionProblems(derivedTargets(), totals);
  assert.ok(problems.some((p) => /no longer/.test(p)), problems.join('\n'));
});

test('an 008 order too small to complete its own mission is flagged too', () => {
  const totals = { ...measuredTotals(), MSN_E2E_ORDERVALUE_008: 1 };
  assert.ok(attributionProblems(derivedTargets(), totals).some((p) => /does not reach its target/.test(p)));
});

/* ── Shipping headroom ──────────────────────────────────────────────────────── */

test('shipping headroom is unbounded where shipping only helps, and bounded where it closes the band', () => {
  const d = derivedTargets();
  // 003: shipping raises the total, which is already the completing side.
  assert.equal(shippingHeadroom(CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_003, { money: MEASURED.MSN_E2E_ORDERVALUE_003.base, target: d.MSN_E2E_ORDERVALUE_003.target }), null);
  // 005: shipping lifts the discounted total toward the target and eats the band from below. The
  // charge is itself taxed, hence margin / (1 + rate) = 6 / 1.2 = 5.
  assert.equal(shippingHeadroom(CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_005, { money: MEASURED.MSN_E2E_ORDERVALUE_005.base, target: d.MSN_E2E_ORDERVALUE_005.target }), 5);
  // 008: shipping lifts its order total toward the nearest sibling target (36), at which point a
  // second mission grants on the same order.
  assert.equal(shippingHeadroom(CASE_MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE_008, { money: MEASURED.MSN_E2E_ORDERVALUE_008.base, target: d.MSN_E2E_ORDERVALUE_008.target, nearestSiblingTarget: 36 }), 10);
});

/* ── The overlay guard, per-case ────────────────────────────────────────────── */

test('a fully seeded per-case overlay is clean', () => {
  assert.deepEqual(validateSeededState(cleanOverlay(), { now: new Date('2026-08-28T12:00:00Z') }), []);
});

test('an empty goal_target fails — the probe cart never ran', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERVALUE_003.goal_target = '';
  assert.ok(validateSeededState(o, {}).some((p) => /the measurement never happened/.test(p)));
});

test('THE DISCRIMINATION CHECK — a target that no longer sits inside its band fails', () => {
  const o = cleanOverlay();
  // Both separated quantities now fall on the same side of the target: the case reports the same
  // result whichever reading the platform implements.
  o.MSN_E2E_ORDERVALUE_003.goal_target = '40';
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((p) => /fall on the SAME side of it/.test(p)), problems.join('\n'));
});

test('a band that has collapsed to under the floor fails', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERVALUE_005.separation_margin = '0.4';
  assert.ok(validateSeededState(o, {}).some((p) => /under the .* floor/.test(p)));
});

test('a measured cart whose parts do not add up to its total fails', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERVALUE_006.measured_total = '999';
  assert.ok(validateSeededState(o, {}).some((p) => /carries a term this module does not model/.test(p)));
});

test('an unrecorded measurement fails — a case would compose its order from guesses', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERVALUE_006.measured_subtotal = '';
  assert.ok(validateSeededState(o, {}).some((p) => /would be a guess/.test(p)));
});

test('THE CONTENTION CHECK — two cases resolving to one account fails', () => {
  const o = cleanOverlay();
  o.MSN_E2E_USER_006.email = o.MSN_E2E_USER_003.email;
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((p) => /resolve to the SAME account/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /consume each other/.test(p)));
});

test('a per-case account outside the sweep namespace fails', () => {
  const o = cleanOverlay();
  o.MSN_E2E_USER_005.email = 'someone-real@example.com';
  assert.ok(validateSeededState(o, {}).some((p) => /outside the .* sweep namespace/.test(p)));
});

test('a missing per-case account fails, naming what it would fall back to', () => {
  const o = cleanOverlay();
  delete o.MSN_E2E_USER_008;
  assert.ok(validateSeededState(o, {}).some((p) => /no dedicated account/.test(p)));
});

test('a coupon mission whose probe cart was never discounted fails', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERVALUE_005.measured_discount = '0';
  o.MSN_E2E_ORDERVALUE_005.measured_total = '60';
  o.MSN_E2E_ORDERVALUE_005.measured_tax = '10';
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((p) => /coupon did not apply/.test(p)), problems.join('\n'));
});

test('an unmeasured counterfactual fails — 005 cannot claim what nobody measured', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERVALUE_005.measured_total_undiscounted = '';
  assert.ok(validateSeededState(o, {}).some((p) => /counterfactual .* was never measured/.test(p)));
});

test('a per-case mission already Completed at seed time still fails, exactly as before', () => {
  const o = cleanOverlay();
  o.MSN_E2E_ORDERVALUE_008.progress_status_at_seed = 'Completed';
  o.MSN_E2E_ORDERVALUE_008.progress_percent_at_seed = '100';
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((p) => /already at Completed 100%/.test(p)));
  assert.ok(problems.some((p) => /MSN-E2E-008/.test(p)));
});

test('the observed spent amount identifies the reading on 005 cart — the three values are distinct', () => {
  const m = MEASURED.MSN_E2E_ORDERVALUE_005.base;
  assert.deepEqual(readingsFor(40, m), ['netMerchandise']);
  assert.deepEqual(readingsFor(50, m), ['grossMerchandise']);
  assert.deepEqual(readingsFor(48, m), ['orderTotal', 'totalPlusPoints']);
  // Nothing the platform could report matches every reading — the fixture is not vacuous.
  assert.equal(readingsFor(999, m).length, 0);
});

/* ── The targeting star ──────────────────────────────────────────────────────
 *
 * Written against the ways the star can go VACUOUS, which is the only way it can go wrong quietly:
 * every one of these perturbations still seeds, still resolves, still renders a card, and leaves a
 * scenario that reports the same thing whatever the server does.
 */

test('the star is a control plus one arm per question, each arm differing on exactly one input', () => {
  assert.equal(TARGETING_MISSIONS.length, 3);
  assert.deepEqual(TARGETING_MISSIONS.map((m) => m.targetingRole).sort(), ['control', 'groupTargeted', 'notPublic']);
  const control = TARGETING_MISSION_BY_ALIAS.MSN_E2E_TGT_CONTROL;
  const group = TARGETING_MISSION_BY_ALIAS.MSN_E2E_TGT_GROUP;
  const priv = TARGETING_MISSION_BY_ALIAS.MSN_E2E_TGT_PRIVATE;
  // The control is the instrument: untargeted, public, and the ONE cell whose visibility is asserted.
  assert.equal(control.public, true);
  assert.equal(control.condition.type, 'AnyUserGroupCondition');
  assert.equal(visibilityPolicy(control), 'required');
  // The arms are measurements, never assertions — a fixture that asserted its answer would prove it.
  assert.equal(visibilityPolicy(group), 'observed');
  assert.equal(visibilityPolicy(priv), 'observed');
  assert.equal(group.condition.type, 'UserGroupIsCondition');
  assert.deepEqual(group.condition.groups, [TARGETING_GROUP]);
  assert.equal(priv.public, false);
  assert.equal(priv.condition.type, 'AnyUserGroupCondition');
  // Every cell is read through BOTH accounts — a cell read through one is not a comparison.
  for (const m of TARGETING_MISSIONS) {
    assert.deepEqual(boundAccounts(m).sort(), [TARGETING_MEMBER_ALIAS, TARGETING_OUTSIDER_ALIAS].sort(), m.aliasName);
  }
});

test('an arm that drifts onto a SECOND variable is rejected', () => {
  // The whole value of the star is that a differing reading names one input. Two differences and it
  // names neither — which is precisely how the 2026-08-27 targeting bug came to be filed and retracted.
  const priv = TARGETING_MISSION_BY_ALIAS.MSN_E2E_TGT_PRIVATE;
  const original = priv.window;
  priv.window = 'openEnded';
  try {
    assert.ok(validateSpecShape().some((p) => /must differ on "public" and nothing else/.test(p)), 'a second differing field must be rejected');
  } finally { priv.window = original; }
});

test('the control losing its neutrality or its public flag is rejected — the instrument must not be gated', () => {
  const control = TARGETING_MISSION_BY_ALIAS.MSN_E2E_TGT_CONTROL;
  const originalPublic = control.public;
  control.public = false;
  try {
    const problems = validateSpecShape();
    assert.ok(problems.some((p) => /the control and must be public=true/.test(p)), problems.join('\n'));
  } finally { control.public = originalPublic; }

  const originalCondition = control.condition;
  control.condition = { type: 'UserGroupIsCondition', groups: [TARGETING_GROUP] };
  try {
    const problems = validateSpecShape();
    assert.ok(problems.some((p) => /must carry AnyUserGroupCondition/.test(p)), problems.join('\n'));
  } finally { control.condition = originalCondition; }
});

test('a star arm that ASSERTS its own visibility is rejected — it would prove the answer by construction', () => {
  const group = TARGETING_MISSION_BY_ALIAS.MSN_E2E_TGT_GROUP;
  const original = group.visibility;
  group.visibility = 'required';
  try {
    assert.ok(validateSpecShape().some((p) => /IS the finding/.test(p)));
  } finally { group.visibility = original; }
});

test('a REACHABLE star target is rejected — it would grant on every other case\'s first order', () => {
  const cell = TARGETING_MISSION_BY_ALIAS.MSN_E2E_TGT_PRIVATE;
  const original = cell.targetRule;
  cell.targetRule = TARGET_RULES.everyReading;
  try {
    assert.ok(validateSpecShape().some((p) => /must be UNREACHABLE/.test(p)));
  } finally { cell.targetRule = original; }
});

test('the unreachable ceiling is DERIVED from the largest cart the set can order, never authored', () => {
  const declaredMax = Math.max(...ALL_MISSIONS.map((m) => Number(m.order?.units) || 0)) * UNIT_PRODUCT.listPrice;
  assert.equal(unreachableTarget(), declaredMax * 100);
  // A cart measured larger than anything declared raises the ceiling with it, instead of leaving a
  // stale constant behind that the fixture would silently grow past.
  assert.ok(unreachableTarget([999]) > unreachableTarget());
  // And it stays clear of the largest whole JOURNEY, not merely of one order.
  const biggestJourney = Math.max(...ALL_MISSIONS.map((m) => (Number(m.order?.units) || 0) * UNIT_PRODUCT.listPrice * (Number(m.journeyOrders) || 1)));
  assert.ok(unreachableTarget() > biggestJourney * 2);
});

test('the targeting PAIR differs in group membership and in nothing else', () => {
  const member = CASE_ACCOUNT_BY_ALIAS[TARGETING_MEMBER_ALIAS];
  const outsider = CASE_ACCOUNT_BY_ALIAS[TARGETING_OUTSIDER_ALIAS];
  assert.deepEqual(member.groups, [TARGETING_GROUP]);
  assert.deepEqual(outsider.groups, []);
  assert.equal(member.caseId, outsider.caseId);
  assert.equal(member.caseId, TARGETING_CASE_ID);
  // Same missions, so the two readings come out of the same three cells.
  assert.deepEqual(member.missionAliases.sort(), outsider.missionAliases.sort());
});

test('an outsider who has joined the audience is rejected — the pair could only ever agree', () => {
  const outsider = CASE_ACCOUNT_BY_ALIAS[TARGETING_OUTSIDER_ALIAS];
  const original = outsider.groups;
  outsider.groups = [TARGETING_GROUP];
  try {
    assert.ok(validateSpecShape().some((p) => /INSIDE the audience/.test(p)));
  } finally { outsider.groups = original; }
});

test('a member outside its own audience is rejected — the same failure from the other side', () => {
  const member = CASE_ACCOUNT_BY_ALIAS[TARGETING_MEMBER_ALIAS];
  const original = member.groups;
  member.groups = [];
  try {
    assert.ok(validateSpecShape().some((p) => /outside its own audience/.test(p)));
  } finally { member.groups = original; }
});

test('a PADDED group is rejected — the server does not trim, so it would target nobody', () => {
  const member = CASE_ACCOUNT_BY_ALIAS[TARGETING_MEMBER_ALIAS];
  const original = member.groups;
  member.groups = [` ${TARGETING_GROUP}`];
  try {
    assert.ok(validateSpecShape().some((p) => /is padded/.test(p)));
  } finally { member.groups = original; }
});

/* ── The star's OVERLAY reading ─────────────────────────────────────────────── */

test('a star cell with no recorded reading fails — an unrecorded absence is not an absence', () => {
  const o = cleanOverlay();
  o.MSN_E2E_TGT_GROUP.observed_visibility = '';
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /no observed_visibility was recorded/.test(m)), problems.join('\n'));
});

test('a cell read through only ONE account fails — one reading is not a comparison', () => {
  const o = cleanOverlay();
  o.MSN_E2E_TGT_GROUP.observed_visibility = formatVisibility({ [TARGETING_MEMBER_ALIAS]: true });
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /carries no reading for MSN_E2E_USER_TGTOUTSIDER/.test(m)), problems.join('\n'));
});

test('THE INSTRUMENT CHECK — a control invisible to an account fails, and is not read as a finding', () => {
  const o = cleanOverlay();
  o.MSN_E2E_TGT_CONTROL.observed_visibility = formatVisibility({
    [TARGETING_MEMBER_ALIAS]: true, [TARGETING_OUTSIDER_ALIAS]: false,
  });
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /broken instrument, not a finding/.test(m)), problems.join('\n'));
});

test('an ARM invisible to the outsider is CLEAN — that reading is the whole point', () => {
  // The one thing the guard must NOT do is treat the finding as a defect. A group-targeted mission the
  // outsider cannot see is the answer scenario 5 exists to obtain, and it was the live reading on
  // vcst-qa 2026-08-28.
  const o = cleanOverlay();
  o.MSN_E2E_TGT_GROUP.observed_visibility = formatVisibility({
    [TARGETING_MEMBER_ALIAS]: true, [TARGETING_OUTSIDER_ALIAS]: false,
  });
  assert.deepEqual(validateSeededState(o, { now: new Date('2026-08-28T12:00:00Z') }), []);
});

test('the OPPOSITE arm reading is equally clean — either answer must be observable', () => {
  const o = cleanOverlay();
  o.MSN_E2E_TGT_PRIVATE.observed_visibility = formatVisibility({
    [TARGETING_MEMBER_ALIAS]: false, [TARGETING_OUTSIDER_ALIAS]: false,
  });
  assert.deepEqual(validateSeededState(o, { now: new Date('2026-08-28T12:00:00Z') }), []);
});

test('a star cell whose target has dropped into reach fails', () => {
  const o = cleanOverlay();
  o.MSN_E2E_TGT_PRIVATE.goal_target = '30';
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /has become completable/.test(m)), problems.join('\n'));
});

test('a visibility reading round-trips through its recorded form', () => {
  const reading = { [TARGETING_MEMBER_ALIAS]: true, [TARGETING_OUTSIDER_ALIAS]: false };
  assert.deepEqual(parseVisibility(formatVisibility(reading)), reading);
  assert.deepEqual(parseVisibility(''), {});
});

/* ── The journey's OVERLAY reading ──────────────────────────────────────────── */

test('a journey with no measured cart fails — its completion delta would be a guess', () => {
  const o = cleanOverlay();
  const journey = ALL_MISSIONS.find((m) => m.journeyOrders != null);
  o[journey.aliasName].measured_total = '';
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /recorded no measured cart/.test(m)), problems.join('\n'));
});

test('a journey with no per-order co-grant set fails — the delta is not the reward on this env', () => {
  const o = cleanOverlay();
  const journey = ALL_MISSIONS.find((m) => m.journeyOrders != null);
  o[journey.aliasName].order1_co_missions = '';
  o[journey.aliasName].co_completing_missions = '';
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /order1_co_missions is empty/.test(m)), problems.join('\n'));
  assert.ok(problems.some((m) => /co_completing_missions is empty/.test(m)));
});

test('THE COLLISION THAT WAS MEASURED — a co-granting mission with the SAME reward fails', () => {
  // vcst-qa 2026-08-28: the journey's completing order also completed the shared 083c
  // AGENT-TEST-MSN-ORDERCOUNT, an OrderCountGoal of 2 that ALSO rewarded 300. Two identical grants on
  // one order are indistinguishable in a balance delta and in a points-history amount. The in-set
  // divergence rule cannot see it, because the colliding mission belongs to another suite.
  const o = cleanOverlay();
  const journey = ALL_MISSIONS.find((m) => m.journeyOrders != null);
  o[journey.aliasName].co_completing_missions = `AGENT-TEST-MSN-ORDERCOUNT=${journey.reward}`;
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /Two identical grants settling together/.test(m)), problems.join('\n'));
});

test('a co-granting mission with a DIFFERENT reward is clean — the grant stays identifiable', () => {
  const o = cleanOverlay();
  const journey = ALL_MISSIONS.find((m) => m.journeyOrders != null);
  o[journey.aliasName].co_completing_missions = `AGENT-TEST-MSN-ORDERCOUNT=${Number(journey.reward) + 1}`;
  o[journey.aliasName].reward_expected_total = String(Number(journey.reward) * 2 + 1);
  assert.deepEqual(validateSeededState(o, { now: new Date('2026-08-28T12:00:00Z') }), []);
});

/* ── Accounts ───────────────────────────────────────────────────────────────── */

test('an unrecorded groups_at_seed fails — nothing verified which side of the audience an account is on', () => {
  const o = cleanOverlay();
  delete o[TARGETING_MEMBER_ALIAS].groups_at_seed;
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /no groups_at_seed was recorded/.test(m)), problems.join('\n'));
});

test('a member the platform reports with no group fails, and an outsider it reports IN the group fails', () => {
  const a = cleanOverlay();
  a[TARGETING_MEMBER_ALIAS].groups_at_seed = '';
  assert.ok(validateSeededState(a, {}).some((m) => /outside its own audience/.test(m)));

  const b = cleanOverlay();
  b[TARGETING_OUTSIDER_ALIAS].groups_at_seed = TARGETING_GROUP;
  assert.ok(validateSeededState(b, {}).some((m) => /INSIDE the audience/.test(m)));
});

test('group membership is matched the way the SERVER matches it — case-insensitively', () => {
  const o = cleanOverlay();
  o[TARGETING_MEMBER_ALIAS].groups_at_seed = TARGETING_GROUP.toLowerCase();
  assert.deepEqual(validateSeededState(o, { now: new Date('2026-08-28T12:00:00Z') }), []);
});

test('the journey and targeting accounts are covered by the distinctness check, not only the four', () => {
  const o = cleanOverlay();
  o[TARGETING_MEMBER_ALIAS].email = o[TARGETING_OUTSIDER_ALIAS].email;
  const problems = validateSeededState(o, {});
  assert.ok(problems.some((m) => /resolve to the SAME account/.test(m)), problems.join('\n'));
});

test('every declared alias has a kind, and the runtime fields of each kind are declared', () => {
  for (const { aliasName, kind } of declaredAliases()) {
    assert.ok(RUNTIME_FIELDS_BY_KIND[kind], `${aliasName}: kind "${kind}" has no runtime field list`);
  }
  // A run-scoped mission NAME is runtime on every mission kind — committing one would pin the suite to
  // a single historical run forever.
  for (const kind of ['mission', 'caseMission', 'journeyMission', 'targetingMission']) {
    assert.ok(RUNTIME_FIELDS_BY_KIND[kind].includes('name'), kind);
  }
  // The star's reading and the pair's observed membership are runtime, never committed: a committed
  // value would assert the very thing the fixtures exist to make falsifiable.
  assert.ok(RUNTIME_FIELDS_BY_KIND.targetingMission.includes('observed_visibility'));
  assert.ok(RUNTIME_FIELDS_BY_KIND.caseUser.includes('groups_at_seed'));
});

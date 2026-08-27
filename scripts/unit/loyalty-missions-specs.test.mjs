/**
 * Unit tests for scripts/seed-data/loyalty/missions-specs.mjs — the VCST-5319 Loyalty Missions
 * fixture set. Pure logic only: no network, no env, no fs.
 *
 * The tests are written against the ways this fixture set can go VACUOUS rather than the ways it can
 * go missing. Every mission here is defined by a value that reads as arbitrary — public=false, a
 * target of 0, a reward of 0, a null currency, an `all` flag that must disagree with its twin — and
 * each of those survives any "does the fixture exist?" check after being edited to something more
 * plausible. So most of what follows perturbs the spec set and asserts the guard NOTICES.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEED_PREFIX, NAME_PREFIX, RUNTIME_FIELDS_BY_KIND, STORE_SETTING, TARGETING, PROCESSED_PERIODICITY,
  STATUSES, ALLOWED_TRANSITION, WINDOWS, PERSKU_PRODUCTS, CURRENCY_INTENTS,
  MISSIONS, MISSION_BY_ALIAS, BLOCK,
  missionName, isSeededMissionName, needsGoalItems, windowDates, resolveCurrencies,
  buildGoalNode, buildConditionNode, buildRewardNode, buildMissionBody, blockOf,
  missionSignature, signaturesMatch, windowIsOpen, windowExpectsOpen,
  BANNERS, BANNER_FOLDER, bannerKeyFor, bannerSourceRel, bannerAssetRel, resolveBannerUrl,
  resolveLocales, localizedString, localizedValues, buildLocalizedFields, LOCALE_INTENTS, MIN_LOCALES,
  buildGoalItems, reconcileGoalItems, validateSpecShape,
} from '../seed-data/loyalty/missions-specs.mjs';

/* ── A faithful stand-in for GET /api/loyalty-missions/new ───────────────────
 * Transcribed from the live response on vcst-qa @ VirtoCommerce.Loyalty 3.1006.0-pr-14-1be7. Kept
 * verbatim (including the empty availableChildren/children on leaves) so a builder that quietly
 * depends on the real shape fails here rather than at seed time.
 */
const template = () => ({
  status: 'Draft', name: null, localizedName: null, description: null, bannerUrl: null,
  storeId: null, startDate: null, endDate: null, public: false, periodicity: 'None',
  dynamicExpression: {
    all: true, not: false, id: 'LoyaltyMissionConditionAndRewardTree',
    availableChildren: [],
    children: [
      {
        all: false, not: false, id: 'BlockLoyaltyMissionCondition',
        availableChildren: [
          { groups: null, id: 'UserGroupIsCondition', availableChildren: [], children: [] },
          { id: 'AnyUserGroupCondition', availableChildren: [], children: [] },
        ],
        children: [],
      },
      {
        all: false, not: false, id: 'BlockLoyaltyMissionGoals',
        availableChildren: [
          { value: 0, currencyCode: null, missionType: 'OrderValue', id: 'OrderValueGoal', availableChildren: [], children: [] },
          { count: 0, missionType: 'OrderCount', id: 'OrderCountGoal', availableChildren: [], children: [] },
          { all: true, missionType: 'PerSku', id: 'PerSkuGoal', availableChildren: [], children: [] },
        ],
        children: [],
      },
      {
        id: 'BlockLoyaltyReward',
        availableChildren: [{ amount: 0, id: 'FixedAmountReward', availableChildren: [], children: [] }],
        children: [],
      },
    ],
  },
  createdDate: '0001-01-01T00:00:00Z', modifiedDate: null, createdBy: null, modifiedBy: null, id: null,
});

const NOW = new Date('2026-08-27T12:00:00.000Z');
/** The B2B-store currency set as it stands on vcst-qa, resolved through the same pure helper. */
const STORE_CURRENCIES = { defaultCurrency: 'USD', currencies: ['GHS', 'CZK', 'CNY', 'PTS', 'AUD', 'EUR', 'XPT', 'GBP', 'USD'] };
const CURRENCIES = resolveCurrencies(STORE_CURRENCIES);
/** The B2B-store language set as it stands on vcst-qa, resolved through the same pure helper. */
const STORE_LANGUAGES = {
  defaultLanguage: 'en-US',
  languages: ['pl-PL', 'sv-SE', 'de-DE', 'fr-FR', 'en-US', 'ja-JP'],
};
const LOCALES = resolveLocales(STORE_LANGUAGES);
/** Everything a full create body needs, so a whole-set loop cannot forget one and skip a fixture. */
/** Stand-in for what the platform asset store hands back — absolute and host-bearing, as it really is. */
const BANNER_URLS = Object.fromEntries(Object.keys(BANNERS).map((k) => [k, 'https://env.test/cms-content/assets/' + bannerAssetRel(k)]));
const RESOLVED = { currencies: CURRENCIES, locales: LOCALES, bannerUrls: BANNER_URLS };
const spec = (alias) => MISSION_BY_ALIAS[alias];
/** A deep, mutable copy of the whole spec set, for perturbation tests. */
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ── The committed set ──────────────────────────────────────────────────────── */

test('the committed spec set is clean as authored', () => {
  assert.deepEqual(validateSpecShape(), []);
});

test('every mission name is prefixed so teardown can sweep exactly these', () => {
  for (const m of MISSIONS) {
    assert.ok(missionName(m).startsWith(`${NAME_PREFIX}-`), `${m.aliasName} is not swept by the prefix`);
    assert.ok(missionName(m).startsWith(SEED_PREFIX), `${m.aliasName} is outside the ${SEED_PREFIX} family`);
    assert.equal(isSeededMissionName(missionName(m)), true);
  }
});

test('isSeededMissionName does not claim missions someone else created', () => {
  assert.equal(isSeededMissionName('Summer Points Drive'), false);
  assert.equal(isSeededMissionName('AGENT-TEST-Loyalty-Program'), false, 'a sibling AGENT-TEST entity is not a mission');
  assert.equal(isSeededMissionName(''), false);
  assert.equal(isSeededMissionName(null), false);
});

test('mission alias names and business keys are unique', () => {
  assert.equal(new Set(MISSIONS.map((m) => m.aliasName)).size, MISSIONS.length);
  assert.equal(new Set(MISSIONS.map((m) => missionName(m))).size, MISSIONS.length);
});

test('the fixture set covers all three goal types and both PerSku modes', () => {
  const goals = new Set(MISSIONS.map((m) => m.goal.type));
  assert.deepEqual([...goals].sort(), ['OrderCountGoal', 'OrderValueGoal', 'PerSkuGoal']);
  assert.equal(spec('MSN_PERSKU_ALL').goal.all, true);
  assert.equal(spec('MSN_PERSKU_ANY').goal.all, false);
});

test('every mission uses the only periodicity the module actually processes', () => {
  for (const m of MISSIONS) {
    const body = buildMissionBody(m, { template: template(), storeId: 'S', now: NOW, ...RESOLVED });
    assert.equal(body.periodicity, PROCESSED_PERIODICITY, `${m.aliasName} would exercise unprocessed periodicity surface`);
  }
});

/* ── The vacuity guards: perturb, then assert the guard notices ─────────────── */

/**
 * validateSpecShape reads the module-level constants, so perturbing them in place is the only way to
 * exercise it. Each test mutates one field, asserts the guard fires with a recognisable reason, and
 * restores — so a guard that has been quietly weakened to always-return-[] fails here.
 */
function withMutation(target, key, value, assertFn) {
  const original = target[key];
  target[key] = value;
  try { assertFn(); } finally { target[key] = original; }
}

test('guard catches MSN_PUBLISHED_PRIVATE being flipped public (C17 goes vacuous)', () => {
  withMutation(spec('MSN_PUBLISHED_PRIVATE'), 'public', true, () => {
    const p = validateSpecShape();
    assert.ok(p.some((x) => /MSN_PUBLISHED_PRIVATE/.test(x)), `expected a MSN_PUBLISHED_PRIVATE problem, got ${JSON.stringify(p)}`);
  });
});

test('guard catches MSN_PUBLISHED_PRIVATE being demoted to Draft', () => {
  withMutation(spec('MSN_PUBLISHED_PRIVATE'), 'status', 'Draft', () => {
    assert.ok(validateSpecShape().some((x) => /MSN_PUBLISHED_PRIVATE/.test(x)));
  });
});

test('guard catches the PerSku pair collapsing to the same all-flag', () => {
  withMutation(spec('MSN_PERSKU_ANY'), 'goal', { type: 'PerSkuGoal', all: true }, () => {
    const p = validateSpecShape();
    assert.ok(p.some((x) => /unfalsifiable/.test(x)), `expected the ALL/ANY divergence problem, got ${JSON.stringify(p)}`);
  });
});

test('guard catches MSN_ZEROTARGET losing its zero', () => {
  withMutation(spec('MSN_ZEROTARGET'), 'goal', { type: 'OrderCountGoal', count: 1 }, () => {
    assert.ok(validateSpecShape().some((x) => /MSN_ZEROTARGET/.test(x)));
  });
});

test('guard catches MSN_ZEROREWARD losing its zero', () => {
  withMutation(spec('MSN_ZEROREWARD'), 'reward', 50, () => {
    assert.ok(validateSpecShape().some((x) => /MSN_ZEROREWARD/.test(x)));
  });
});

test('guard catches a LITERAL currency code being committed instead of an intent', () => {
  // A currency is per-env store config (store.defaultCurrency / store.currencies), so a committed
  // "USD" is the same class of mistake as a committed GUID.
  withMutation(spec('MSN_ORDERVALUE'), 'goal', { type: 'OrderValueGoal', value: 250, currencyCode: 'USD' }, () => {
    assert.ok(validateSpecShape().some((x) => /MSN_ORDERVALUE/.test(x) && /literal currencyCode|one of store-default/.test(x)));
  });
});

test('guard catches the currency pair collapsing onto one currency', () => {
  withMutation(spec('MSN_ORDERVALUE_ALTCURRENCY'), 'goal', { type: 'OrderValueGoal', value: 250, currency: 'store-default' }, () => {
    assert.ok(validateSpecShape().some((x) => /SAME currency intent/.test(x)));
  });
});

test('guard catches the currency pair drifting on a second variable', () => {
  // The pair is a controlled experiment. If the thresholds or rewards diverge too, a failure can no
  // longer be attributed to the currency.
  withMutation(spec('MSN_ORDERVALUE_ALTCURRENCY'), 'goal', { type: 'OrderValueGoal', value: 999, currency: 'store-alternate' }, () => {
    assert.ok(validateSpecShape().some((x) => /only variable/.test(x)));
  });
  withMutation(spec('MSN_ORDERVALUE_ALTCURRENCY'), 'reward', 1, () => {
    assert.ok(validateSpecShape().some((x) => /only variable/.test(x)));
  });
});

test('guard catches a null-currency order-value goal, which the server rejects outright', () => {
  withMutation(spec('MSN_ORDERVALUE'), 'goal', { type: 'OrderValueGoal', value: 250, currency: null }, () => {
    assert.ok(validateSpecShape().some((x) => /MSN_ORDERVALUE/.test(x) && /store-default/.test(x)));
  });
});

test('resolveCurrencies picks a deterministic, genuinely different alternate', () => {
  const r = resolveCurrencies(STORE_CURRENCIES);
  assert.equal(r['store-default'], 'USD');
  assert.notEqual(r['store-alternate'], r['store-default']);
  assert.equal(r['store-alternate'], 'AUD', 'first non-default in sorted order, so a re-seed does not churn the overlay');
  assert.deepEqual(resolveCurrencies(STORE_CURRENCIES), r, 'must be stable across calls');
});

test('resolveCurrencies refuses a single-currency store rather than collapsing the pair', () => {
  // Two "different-currency" fixtures sharing a currency test nothing, so this fails loudly at seed
  // time instead of quietly seeding a degenerate pair.
  assert.throws(() => resolveCurrencies({ defaultCurrency: 'USD', currencies: ['USD'] }), /needs a second one/);
  assert.throws(() => resolveCurrencies({ defaultCurrency: 'USD', currencies: ['usd', 'USD'] }), /needs a second one/, 'case-insensitive: usd is not a different currency from USD');
  assert.throws(() => resolveCurrencies({ currencies: ['USD', 'EUR'] }), /no defaultCurrency/);
});

test('buildGoalNode resolves the currency intent and refuses an unresolvable one', () => {
  const goals = blockOf(template().dynamicExpression, BLOCK.goals);
  assert.equal(buildGoalNode(spec('MSN_ORDERVALUE'), goals, { currencies: CURRENCIES }).currencyCode, 'USD');
  assert.equal(buildGoalNode(spec('MSN_ORDERVALUE_ALTCURRENCY'), goals, { currencies: CURRENCIES }).currencyCode, 'AUD');
  // No currencies supplied: must throw rather than emit currencyCode:null, which the server rejects
  // with a message that says nothing about the real cause.
  assert.throws(() => buildGoalNode(spec('MSN_ORDERVALUE'), goals, {}), /did not resolve/);
  assert.throws(() => buildGoalNode(spec('MSN_ORDERVALUE'), goals, { currencies: {} }), /REQUIRED at save/);
});

test('buildGoalNode never emits a currencyCode on a goal type that has none', () => {
  const goals = blockOf(template().dynamicExpression, BLOCK.goals);
  const count = buildGoalNode(spec('MSN_ORDERCOUNT'), goals, { currencies: CURRENCIES });
  assert.equal(count.currencyCode, undefined);
  const perSku = buildGoalNode(spec('MSN_PERSKU_ALL'), goals, { currencies: CURRENCIES });
  assert.equal(perSku.currencyCode, undefined);
  assert.equal('currency' in perSku, false, 'the symbolic intent must never reach the wire');
});

test('the currency intent itself never reaches the API body', () => {
  const goal = blockOf(
    buildMissionBody(spec('MSN_ORDERVALUE'), { template: template(), storeId: 'S', now: NOW, ...RESOLVED }).dynamicExpression,
    BLOCK.goals,
  ).children[0];
  assert.equal('currency' in goal, false, 'currency is our vocabulary, not the module\'s');
  assert.equal(goal.currencyCode, 'USD');
});

test('a signature separates the currency pair', () => {
  const t = () => template();
  const usd = missionSignature(buildMissionBody(spec('MSN_ORDERVALUE'), { template: t(), storeId: 'S', now: NOW, ...RESOLVED }));
  const alt = missionSignature(buildMissionBody(spec('MSN_ORDERVALUE_ALTCURRENCY'), { template: t(), storeId: 'S', now: NOW, ...RESOLVED }));
  assert.equal(usd.goalCurrency, 'USD');
  assert.equal(alt.goalCurrency, 'AUD');
  assert.equal(signaturesMatch(usd, alt), false, 'a currency-only difference must count as drift, or the seeder cannot heal a wrong-currency fixture');
});

test('currency intents are a closed vocabulary', () => {
  assert.deepEqual([...CURRENCY_INTENTS].sort(), ['store-alternate', 'store-default']);
  for (const m of MISSIONS) {
    if (!m.goal.currency) continue;
    assert.ok(CURRENCY_INTENTS.includes(m.goal.currency), `${m.aliasName} uses an unknown currency intent`);
  }
});

test('guard catches MSN_DRAFT losing recreateAlways — the one-shot mutation fixture', () => {
  withMutation(spec('MSN_DRAFT'), 'recreateAlways', false, () => {
    assert.ok(validateSpecShape().some((x) => /MSN_DRAFT/.test(x) && /recreate/i.test(x)));
  });
});

test('guard catches a mission with no condition (the API rejects it at 400)', () => {
  withMutation(spec('MSN_ORDERCOUNT'), 'condition', undefined, () => {
    assert.ok(validateSpecShape().some((x) => /no condition/.test(x)));
  });
});

test('guard catches a reward silently turned into a string', () => {
  withMutation(spec('MSN_ORDERCOUNT'), 'reward', '300', () => {
    assert.ok(validateSpecShape().some((x) => /reward must be a number/.test(x)));
  });
});

test('guard catches a status outside the module vocabulary', () => {
  // The API itself accepts ANY status string (verified live — no vocabulary validation server-side),
  // so this guard is the only thing standing between a typo and a fixture nothing will ever match.
  withMutation(spec('MSN_ORDERCOUNT'), 'status', 'Activated', () => {
    assert.ok(validateSpecShape().some((x) => /not one of/.test(x)));
  });
});

/* ── Body building ──────────────────────────────────────────────────────────── */

test('buildMissionBody produces exactly one condition, one goal and one reward', () => {
  // These are the module's own server-side validators: "at least one condition", "exactly one goal",
  // "at least one reward". A body violating any of them is a 400 at seed time.
  for (const m of MISSIONS) {
    const tree = buildMissionBody(m, { template: template(), storeId: 'B2B-store', now: NOW, ...RESOLVED }).dynamicExpression;
    assert.equal(blockOf(tree, BLOCK.condition).children.length, 1, `${m.aliasName} condition count`);
    assert.equal(blockOf(tree, BLOCK.goals).children.length, 1, `${m.aliasName} goal count`);
    assert.equal(blockOf(tree, BLOCK.reward).children.length, 1, `${m.aliasName} reward count`);
  }
});

test('buildMissionBody carries name, store, status and public through', () => {
  const m = spec('MSN_PUBLISHED_PRIVATE');
  const body = buildMissionBody(m, { template: template(), storeId: 'B2B-store', now: NOW, ...RESOLVED });
  assert.equal(body.name, 'AGENT-TEST-MSN-PUBLISHED-PRIVATE');
  assert.equal(body.storeId, 'B2B-store');
  assert.equal(body.status, 'Published');
  assert.equal(body.public, false);
  assert.equal(body.id, null, 'a create body must not carry an id');
});

test('buildGoalNode overlays the spec onto the live prototype rather than writing a literal', () => {
  const goals = blockOf(template().dynamicExpression, BLOCK.goals);
  const node = buildGoalNode(spec('MSN_ORDERVALUE'), goals, { currencies: CURRENCIES });
  assert.equal(node.id, 'OrderValueGoal');
  assert.equal(node.value, 250);
  // The currency INTENT is resolved against the store, never left null: verified live on vcst-qa
  // 2026-08-27 that the server rejects null, "" and an omitted currencyCode alike with HTTP 400
  // "Currency code is required for the order value goal".
  assert.equal(node.currencyCode, CURRENCIES['store-default']);
  // missionType comes from the server prototype — proof the node is derived, not hand-written.
  assert.equal(node.missionType, 'OrderValue');
  assert.deepEqual(node.children, []);
  assert.deepEqual(node.availableChildren, []);
});

test('buildGoalNode refuses a goal type this build does not offer', () => {
  const goals = blockOf(template().dynamicExpression, BLOCK.goals);
  assert.throws(
    () => buildGoalNode({ goal: { type: 'OrderWeightGoal' } }, goals),
    /not offered by this build/,
    'an unsupported goal must fail loudly at build time, not silently seed a mission with no goal',
  );
});

test('buildConditionNode defaults to the neutral condition and honours group targeting', () => {
  const conds = blockOf(template().dynamicExpression, BLOCK.condition);
  assert.equal(buildConditionNode({ condition: undefined }, conds).id, 'AnyUserGroupCondition');
  const grouped = buildConditionNode({ condition: { type: 'UserGroupIsCondition', groups: ['VIP'] } }, conds);
  assert.equal(grouped.id, 'UserGroupIsCondition');
  assert.deepEqual(grouped.groups, ['VIP']);
});

test('buildRewardNode carries a zero amount through instead of falling back to a default', () => {
  const rewards = blockOf(template().dynamicExpression, BLOCK.reward);
  assert.equal(buildRewardNode({ reward: 0 }, rewards).amount, 0, 'a zero reward must survive — it IS the MSN_ZEROREWARD fixture');
  assert.equal(buildRewardNode({ reward: 500 }, rewards).amount, 500);
});

/* ── Windows ────────────────────────────────────────────────────────────────── */

test('windowDates puts an active window around now', () => {
  const { startDate, endDate } = windowDates('active', NOW);
  assert.ok(Date.parse(startDate) < NOW.getTime(), 'start must already have passed');
  assert.ok(Date.parse(endDate) > NOW.getTime(), 'end must still be ahead');
});

test('windowDates refuses an unknown intent instead of silently producing null dates', () => {
  assert.throws(() => windowDates('whenever', NOW), /unknown window intent/);
});

test('windowIsOpen distinguishes expired and not-yet-started from open', () => {
  const iso = (d) => new Date(NOW.getTime() + d * 86400000).toISOString();
  assert.equal(windowIsOpen({ startDate: iso(-1), endDate: iso(1) }, NOW), true);
  assert.equal(windowIsOpen({ startDate: iso(-30), endDate: iso(-1) }, NOW), false, 'an expired fixture must not read as healthy');
  assert.equal(windowIsOpen({ startDate: iso(1), endDate: iso(30) }, NOW), false);
  assert.equal(windowIsOpen({ startDate: null, endDate: null }, NOW), true, 'an unbounded window is open');
});

/* ── Banners ─────────────────────────────────────────────────────────────────
 * The storefront card (VCST-5346) renders `bannerUrl` at 150px, full width, object-fit: cover. An
 * empty or unreachable one renders a blank card, which is indistinguishable from a broken one — so
 * the failure mode here is invisible rather than loud, and these tests pin the four things that keep
 * it visible: every mission resolves a banner, the artwork matches the goal type, the URL is runtime
 * (never authored), and the file name is FIXED so the URL cannot churn.
 */

test('every mission resolves a banner, and it matches its goal type', () => {
  const byGoal = { OrderValueGoal: 'order-value', OrderCountGoal: 'order-count', PerSkuGoal: 'per-sku' };
  for (const m of MISSIONS) {
    assert.equal(bannerKeyFor(m), byGoal[m.goal.type], `${m.aliasName} carries the wrong artwork for a ${m.goal.type}`);
  }
});

test('bannerKeyFor refuses an unknown goal instead of defaulting to the money artwork', () => {
  assert.throws(() => bannerKeyFor({ aliasName: 'X', goal: { type: 'OrderWeightGoal' } }), /no banner declared/);
});

test('the three banners are three distinct files, one per goal type', () => {
  const files = Object.values(BANNERS).map((b) => b.file);
  assert.equal(new Set(files).size, 3, 'two mission types sharing artwork stop being distinguishable at a glance');
  assert.deepEqual(Object.values(BANNERS).flatMap((b) => b.goals).sort(), ['OrderCountGoal', 'OrderValueGoal', 'PerSkuGoal']);
});

test('banner file names are FIXED, not generated', () => {
  // The asset URL derives from the file name and bannerUrl is part of missionSignature: a timestamped
  // name would change the URL every run, and every mission would be deleted and recreated forever.
  for (const [key, b] of Object.entries(BANNERS)) {
    assert.match(b.file, /^msn-banner-[a-z-]+\.(svg|png|jpe?g|gif|webp)$/, `${key} has a non-fixed file name`);
    assert.equal(bannerSourceRel(key), `test-data/uploads/${b.file}`);
    assert.equal(bannerAssetRel(key), `${BANNER_FOLDER}/${b.file}`);
  }
});

test('buildMissionBody carries the RESOLVED banner url, never an authored one', () => {
  const body = buildMissionBody(spec('MSN_ORDERCOUNT'), {
    template: template(), storeId: 'S', now: NOW, ...RESOLVED,
  });
  assert.equal(body.bannerUrl, BANNER_URLS['order-count']);
  assert.ok(/^https?:\/\//.test(body.bannerUrl), 'the platform hands back an absolute, host-bearing URL');
});

test('buildMissionBody refuses to create a mission whose banner did not resolve', () => {
  // A Published mission is immutable, so a missing banner at create time can never be added later —
  // failing loudly here is the only moment the mistake is cheap.
  assert.throws(
    () => buildMissionBody(spec('MSN_ORDERCOUNT'), { template: template(), storeId: 'S', now: NOW, currencies: CURRENCIES, locales: LOCALES, bannerUrls: {} }),
    /banner "order-count" did not resolve/,
  );
  assert.throws(() => resolveBannerUrl(spec('MSN_PERSKU_ALL'), { 'order-value': 'x' }), /banner "per-sku" did not resolve/);
});

test('the banner url is part of the signature, so a moved asset is detected as drift', () => {
  const a = buildMissionBody(spec('MSN_ORDERCOUNT'), { template: template(), storeId: 'S', now: NOW, ...RESOLVED });
  const b = buildMissionBody(spec('MSN_ORDERCOUNT'), {
    template: template(), storeId: 'S', now: NOW, ...RESOLVED,
    bannerUrls: { ...BANNER_URLS, 'order-count': 'https://example.test/other.svg' },
  });
  assert.ok(!signaturesMatch(missionSignature(a), missionSignature(b)));
});

test('the same banner url produces the same signature, so a re-seed reuses the mission', () => {
  const a = buildMissionBody(spec('MSN_PERSKU_ANY'), { template: template(), storeId: 'S', now: NOW, ...RESOLVED });
  const b = buildMissionBody(spec('MSN_PERSKU_ANY'), {
    template: template(), storeId: 'S', now: new Date(NOW.getTime() + 9 * 86400000), ...RESOLVED,
  });
  assert.ok(signaturesMatch(missionSignature(a), missionSignature(b)));
});

test('the banner url is declared RUNTIME, and the artwork key is not', () => {
  assert.ok(RUNTIME_FIELDS_BY_KIND.mission.includes('banner_url'), 'an absolute asset URL is per-env, exactly like a GUID');
  assert.ok(!RUNTIME_FIELDS_BY_KIND.mission.includes('banner_key'), 'which artwork a mission carries is authored and env-invariant');
});

test('guard catches a literal bannerUrl being authored back into a spec', () => {
  withMutation(spec('MSN_LOCALIZED'), 'bannerUrl', '/assets/agent-test/whatever.png', () => {
    const p = validateSpecShape();
    assert.ok(p.some((x) => /MSN_LOCALIZED.*bannerUrl/.test(x)), `expected a literal-bannerUrl problem, got ${JSON.stringify(p)}`);
  });
});

test('guard catches a banner losing its goal type, or a goal type losing its banner', () => {
  withMutation(BANNERS['per-sku'], 'goals', [], () => {
    assert.ok(validateSpecShape().some((x) => /PerSkuGoal|per-sku/.test(x)));
  });
  withMutation(BANNERS['order-value'], 'file', 'msn-banner-order-count.svg', () => {
    assert.ok(validateSpecShape().some((x) => /share one image file/.test(x)));
  });
});

test('guard catches a generated banner file name', () => {
  withMutation(BANNERS['order-count'], 'file', 'msn-banner-order-count-20260827.svg', () => {
    assert.ok(validateSpecShape().some((x) => /generated-looking file name/.test(x)));
  });
});

/* ── MSN_EXPIRED: the one fixture that is SUPPOSED to be outside its window ───
 * Its whole value is a closed window on an otherwise ordinary mission. Every edit that destroys it —
 * moving it back onto `active`, demoting it to Draft, making it private, zeroing its reward — leaves a
 * fixture that still seeds and still resolves, and turns MSN-008 into an assertion about an absence
 * that has a second, unrelated explanation. So each of those is perturbed here.
 */

test('windowDates puts the expired window ENTIRELY in the past', () => {
  const { startDate, endDate } = windowDates('expired', NOW);
  assert.ok(Date.parse(startDate) < NOW.getTime(), 'start must already have passed');
  assert.ok(Date.parse(endDate) < NOW.getTime(), 'end must ALSO have passed — that is the whole fixture');
  assert.equal(windowIsOpen({ startDate, endDate }, NOW), false);
});

test('the expired window stays expired as the fixture ages', () => {
  // Offsets, not literals: a committed date is expired only until someone refreshes it, and a window
  // seeded near "now" could read as open under clock skew.
  const { startDate, endDate } = windowDates('expired', NOW);
  const later = new Date(NOW.getTime() + 400 * 86400000);
  assert.equal(windowIsOpen({ startDate, endDate }, later), false);
  assert.ok(NOW.getTime() - Date.parse(endDate) > 7 * 86400000, 'the expiry must clear "now" by more than a rounding error');
});

test('windowExpectsOpen states the INTENT, so a closed window is not read as drift', () => {
  assert.equal(windowExpectsOpen('active'), true);
  assert.equal(windowExpectsOpen('expired'), false);
  assert.throws(() => windowExpectsOpen('whenever'), /unknown window intent/);
});

test('the seeder reuses the expired fixture instead of recreating it every run', () => {
  // This mirrors the seeder's own reuse predicate. With a plain `!windowIsOpen` check MSN_EXPIRED is
  // recreated on EVERY seed, churning the GUID that @td(MSN_EXPIRED.id) resolves to.
  const recreate = (m, at) => {
    const body = buildMissionBody(m, { template: template(), storeId: 'S', now: NOW, ...RESOLVED });
    return windowIsOpen(body, at) !== windowExpectsOpen(m.window);
  };
  const soon = new Date(NOW.getTime() + 30 * 86400000);
  assert.equal(recreate(spec('MSN_EXPIRED'), soon), false, 'a closed window IS the expired fixture working');
  assert.equal(recreate(spec('MSN_ORDERCOUNT'), soon), false, 'an active fixture inside its window is reused');
  // ...and the check still catches a genuinely stale active fixture.
  const wayLater = new Date(NOW.getTime() + 400 * 86400000);
  assert.equal(recreate(spec('MSN_ORDERCOUNT'), wayLater), true, 'an active fixture that has expired must be rebuilt');
});

test('MSN_EXPIRED is the ONLY fixture outside its window', () => {
  const closed = MISSIONS.filter((m) => !windowExpectsOpen(m.window));
  assert.deepEqual(closed.map((m) => m.aliasName), ['MSN_EXPIRED']);
});

test('MSN_EXPIRED is otherwise ordinary, so only the window can explain its absence', () => {
  const m = spec('MSN_EXPIRED');
  assert.equal(m.status, 'Published');
  assert.equal(m.public, true);
  assert.ok(m.reward > 0, 'a zero reward would give the mission a second reason to be filtered out');
});

test('guard catches MSN_EXPIRED being moved back onto an open window', () => {
  withMutation(spec('MSN_EXPIRED'), 'window', 'active', () => {
    const p = validateSpecShape();
    assert.ok(p.some((x) => /MSN_EXPIRED/.test(x)), `expected an MSN_EXPIRED problem, got ${JSON.stringify(p)}`);
  });
});

test('guard catches MSN_EXPIRED being demoted to Draft or made private', () => {
  withMutation(spec('MSN_EXPIRED'), 'status', 'Draft', () => {
    assert.ok(validateSpecShape().some((x) => /MSN_EXPIRED/.test(x)));
  });
  withMutation(spec('MSN_EXPIRED'), 'public', false, () => {
    assert.ok(validateSpecShape().some((x) => /MSN_EXPIRED/.test(x)));
  });
});

test('guard catches MSN_EXPIRED losing its payable reward', () => {
  withMutation(spec('MSN_EXPIRED'), 'reward', 0, () => {
    assert.ok(validateSpecShape().some((x) => /MSN_EXPIRED/.test(x)));
  });
});

test('guard catches an ACTIVE fixture being parked on the expired window', () => {
  // The reverse failure: a completion fixture that silently sits outside its window turns every
  // completion case into a false negative that reads as a product bug.
  withMutation(spec('MSN_ORDERCOUNT'), 'window', 'expired', () => {
    const p = validateSpecShape();
    assert.ok(p.some((x) => /MSN_ORDERCOUNT/.test(x)), `expected an MSN_ORDERCOUNT problem, got ${JSON.stringify(p)}`);
  });
});

test('guard catches the expired window being quietly reopened', () => {
  withMutation(WINDOWS.expired, 'endOffsetDays', 90, () => {
    assert.ok(validateSpecShape().some((x) => /MSN_EXPIRED/.test(x)));
  });
  withMutation(WINDOWS.expired, 'expectOpen', true, () => {
    assert.ok(validateSpecShape().some((x) => /MSN_EXPIRED|expectOpen/.test(x)));
  });
});

test('guard catches a window intent that never says whether it is meant to be open', () => {
  withMutation(WINDOWS.active, 'expectOpen', undefined, () => {
    assert.ok(validateSpecShape().some((x) => /expectOpen/.test(x)));
  });
});

/* ── Signature / drift detection ────────────────────────────────────────────── */

test('a signature ignores dates, so a re-seed does not recreate everything forever', () => {
  const m = spec('MSN_ORDERCOUNT');
  const a = buildMissionBody(m, { template: template(), storeId: 'S', now: NOW, ...RESOLVED });
  const b = buildMissionBody(m, { template: template(), storeId: 'S', now: new Date(NOW.getTime() + 5 * 86400000), ...RESOLVED });
  assert.notEqual(a.startDate, b.startDate, 'the fixture really did move in time');
  assert.ok(signaturesMatch(missionSignature(a), missionSignature(b)), 'yet the signature must call it the same fixture');
});

test('a signature notices every field that defines the fixture', () => {
  const base = buildMissionBody(spec('MSN_ORDERCOUNT'), { template: template(), storeId: 'S', now: NOW, ...RESOLVED });
  const sig = missionSignature(base);

  const perturbations = {
    status: (b) => { b.status = 'Draft'; },
    public: (b) => { b.public = false; },
    storeId: (b) => { b.storeId = 'other-store'; },
    name: (b) => { b.name = 'AGENT-TEST-MSN-SOMETHING-ELSE'; },
    reward: (b) => { blockOf(b.dynamicExpression, BLOCK.reward).children[0].amount = 999; },
    goalCount: (b) => { blockOf(b.dynamicExpression, BLOCK.goals).children[0].count = 7; },
    condition: (b) => { blockOf(b.dynamicExpression, BLOCK.condition).children[0] = { id: 'UserGroupIsCondition', groups: ['VIP'] }; },
  };
  for (const [label, mutate] of Object.entries(perturbations)) {
    const c = clone(base);
    mutate(c);
    assert.equal(signaturesMatch(missionSignature(c), sig), false, `signature failed to notice a change to ${label}`);
  }
});

test('a signature reads a live record and a spec-built body identically', () => {
  // The seeder compares a body it built against a record it fetched. If those two ever produced
  // different signatures for the same fixture, every seed would delete and recreate the whole set.
  const body = buildMissionBody(spec('MSN_PERSKU_ALL'), { template: template(), storeId: 'S', now: NOW, ...RESOLVED });
  const asFetched = { ...clone(body), id: 'server-assigned-guid', createdBy: 'admin', modifiedDate: '2026-08-27T00:00:00Z' };
  assert.ok(signaturesMatch(missionSignature(body), missionSignature(asFetched)));
});

test('a signature separates the PerSku pair', () => {
  const t = template();
  const all = missionSignature(buildMissionBody(spec('MSN_PERSKU_ALL'), { template: t, storeId: 'S', now: NOW, ...RESOLVED }));
  const any = missionSignature(buildMissionBody(spec('MSN_PERSKU_ANY'), { template: template(), storeId: 'S', now: NOW, ...RESOLVED }));
  assert.equal(all.goalAll, true);
  assert.equal(any.goalAll, false);
  assert.equal(signaturesMatch(all, any), false);
});

test('missionSignature survives a malformed / empty tree without throwing', () => {
  assert.doesNotThrow(() => missionSignature({}));
  assert.doesNotThrow(() => missionSignature({ dynamicExpression: { children: [] } }));
  assert.equal(missionSignature({}).goal, null);
});

/* ── PerSku goal items ──────────────────────────────────────────────────────── */

test('only PerSku missions need separate goal items', () => {
  assert.equal(needsGoalItems(spec('MSN_PERSKU_ALL')), true);
  assert.equal(needsGoalItems(spec('MSN_PERSKU_ANY')), true);
  assert.equal(needsGoalItems(spec('MSN_ORDERCOUNT')), false);
  assert.equal(needsGoalItems(spec('MSN_ORDERVALUE')), false);
});

test('buildGoalItems produces one row per slot, keyed to the mission', () => {
  const products = { A: { id: 'prod-a' }, B: { id: 'prod-b' } };
  const rows = buildGoalItems(spec('MSN_PERSKU_ALL'), 'mission-1', products);
  assert.equal(rows.length, PERSKU_PRODUCTS.length);
  assert.deepEqual(rows.map((r) => r.missionId), rows.map(() => 'mission-1'));
  assert.deepEqual(rows.map((r) => r.productId).sort(), ['prod-a', 'prod-b']);
  assert.deepEqual(rows.map((r) => r.quantity), PERSKU_PRODUCTS.map((p) => p.quantity));
});

test('buildGoalItems refuses to build a PerSku mission with an unresolved product', () => {
  // The failure this prevents: a PerSku mission with zero (or partial) targets is structurally valid,
  // permanently uncompletable, and passes every "does the mission exist" check.
  assert.throws(() => buildGoalItems(spec('MSN_PERSKU_ALL'), 'm1', { A: { id: 'a' } }), /slot B has no resolved product/);
  assert.throws(() => buildGoalItems(spec('MSN_PERSKU_ALL'), 'm1', {}), /no resolved product/);
});

test('buildGoalItems returns nothing for a non-PerSku mission', () => {
  assert.deepEqual(buildGoalItems(spec('MSN_ORDERCOUNT'), 'm1', { A: { id: 'a' }, B: { id: 'b' } }), []);
});

test('reconcileGoalItems creates what is missing', () => {
  const desired = [{ missionId: 'm', productId: 'a', quantity: 2 }, { missionId: 'm', productId: 'b', quantity: 1 }];
  const r = reconcileGoalItems(desired, []);
  assert.equal(r.create.length, 2);
  assert.equal(r.update.length, 0);
  assert.equal(r.remove.length, 0);
});

test('reconcileGoalItems is a no-op when the live set already matches', () => {
  // This is what keeps a re-seed off the (MissionId, ProductId) unique index, whose violation
  // surfaces as a raw HTTP 500 SQL error rather than a 409.
  const desired = [{ missionId: 'm', productId: 'a', quantity: 2 }];
  const existing = [{ id: 'gi1', missionId: 'm', productId: 'a', quantity: 2 }];
  const r = reconcileGoalItems(desired, existing);
  assert.deepEqual([r.create.length, r.update.length, r.remove.length], [0, 0, 0]);
});

test('reconcileGoalItems updates a drifted quantity in place, keeping the row id', () => {
  const desired = [{ missionId: 'm', productId: 'a', quantity: 5 }];
  const existing = [{ id: 'gi1', missionId: 'm', productId: 'a', quantity: 2 }];
  const r = reconcileGoalItems(desired, existing);
  assert.equal(r.create.length, 0);
  assert.equal(r.remove.length, 0);
  assert.deepEqual(r.update, [{ id: 'gi1', missionId: 'm', productId: 'a', quantity: 5 }]);
});

test('reconcileGoalItems removes a target that is no longer wanted', () => {
  const desired = [{ missionId: 'm', productId: 'a', quantity: 2 }];
  const existing = [
    { id: 'gi1', missionId: 'm', productId: 'a', quantity: 2 },
    { id: 'gi2', missionId: 'm', productId: 'stale', quantity: 9 },
  ];
  const r = reconcileGoalItems(desired, existing);
  assert.deepEqual(r.remove.map((x) => x.id), ['gi2']);
});

test('reconcileGoalItems compares quantity numerically, not by identity', () => {
  // The API returns quantity as a number, but a fixture edited through a CSV-shaped path could hand
  // over a string. Treating "2" as different from 2 would rewrite every row on every seed.
  const r = reconcileGoalItems([{ productId: 'a', quantity: 2 }], [{ id: 'gi1', productId: 'a', quantity: '2' }]);
  assert.equal(r.update.length, 0);
});

test('reconcileGoalItems tolerates null inputs', () => {
  const r = reconcileGoalItems(null, null);
  assert.deepEqual([r.create.length, r.update.length, r.remove.length], [0, 0, 0]);
});

/* ── Recorded API facts ─────────────────────────────────────────────────────── */

test('the store-settings fixture names the real setting and its independence verdict', () => {
  assert.equal(STORE_SETTING.missionsSetting, 'Loyalty.Missions.Enable');
  assert.equal(STORE_SETTING.missionsGroup, 'Loyalty|Missions');
  assert.equal(STORE_SETTING.baseSetting, 'Loyalty.Enable');
  assert.equal(STORE_SETTING.platformDefault, false, 'the feature is OFF unless a store opts in');
  assert.equal(STORE_SETTING.gatingVerdict, 'independent');
});

test('targeting is group-only — no customer-id condition exists in this module', () => {
  // Recorded so a test author reads the real surface instead of assuming a CustomerIds field. Verified
  // both live (GET /new offers only these two) and in source (LoyaltyMissionConditionAndRewardTreePrototype).
  assert.equal(TARGETING.customerIdCondition, null);
  assert.equal(TARGETING.groupCondition.id, 'UserGroupIsCondition');
  assert.equal(TARGETING.groupCondition.field, 'groups');
  assert.equal(TARGETING.neutralCondition.id, 'AnyUserGroupCondition');
});

test('the immutability rule is recorded as the single allowed transition', () => {
  assert.deepEqual(ALLOWED_TRANSITION, { from: 'Published', to: 'Archived' });
  assert.deepEqual(STATUSES, ['Draft', 'Published', 'Archived']);
});

test('runtime fields are declared per alias kind, and none of them is that kind\'s business key', () => {
  const { mission, perSkuProduct, storeSetting } = RUNTIME_FIELDS_BY_KIND;

  // A mission's id is server-assigned; its NAME is the business key the seeder looks it up by.
  // banner_url joins it for the same reason: the platform hands back an absolute, host-bearing URL.
  assert.deepEqual(mission, ['id', 'banner_url']);
  assert.ok(!mission.includes('banner_key'), 'WHICH artwork a mission carries is authored and env-invariant');
  assert.ok(!mission.includes('name'), 'a mission name is authored, not runtime');
  for (const f of ['status', 'reward', 'public']) {
    assert.ok(!mission.includes(f), `${f} is authored, not runtime`);
  }

  // A PerSku target is merely FOUND on the env, so nothing about it is invariant — its name and SKU
  // are runtime too. This is the exact asymmetry a single flattened list destroys: `name` means
  // opposite things on these two kinds.
  for (const f of ['productId', 'sku', 'name', 'catalogId']) {
    assert.ok(perSkuProduct.includes(f), `${f} must be runtime on a discovered product`);
  }
  assert.ok(!perSkuProduct.includes('quantity'), 'the target quantity is authored by the fixture, not discovered');

  // The gate's setting NAME is invariant; only the observed values and the store are per-env.
  assert.ok(!storeSetting.includes('setting_name'), 'the setting name is the same on every env');
  for (const f of ['store_id', 'missions_enabled', 'base_loyalty_enabled']) {
    assert.ok(storeSetting.includes(f), `${f} is per-env`);
  }
});

test('window intents are declared, not inlined as literal dates', () => {
  // A committed literal date expires silently: the fixture still exists, still resolves, and every
  // completion case becomes a false negative that reads as a product bug.
  for (const [name, w] of Object.entries(WINDOWS)) {
    assert.equal(typeof w.startOffsetDays, 'number', `${name} start must be an offset`);
    assert.equal(typeof w.endOffsetDays, 'number', `${name} end must be an offset`);
    assert.ok(w.endOffsetDays > w.startOffsetDays, `${name} must not be inverted`);
  }
});

/* ── C11: localization + banner ──────────────────────────────────────────────
 * These pin the ONE fact that makes the fixture non-vacuous: a LocalizedString has to be posted as
 * { values: { <locale>: <text> } }. The flat dict is accepted with HTTP 201 and no error, and comes
 * back as {"values":{}} — so nothing except an explicit assertion catches it.
 */
test('resolveLocales picks the store default and a stable, distinct alternate', () => {
  assert.equal(LOCALES['store-default'], 'en-US');
  assert.equal(LOCALES['store-alternate'], 'de-DE', 'first non-default in sorted order — stable across re-seeds');
  assert.notEqual(LOCALES['store-default'], LOCALES['store-alternate']);
});

test('resolveLocales refuses a single-language store rather than collapsing both intents', () => {
  assert.throws(
    () => resolveLocales({ defaultLanguage: 'en-US', languages: ['en-US'] }),
    /only one language/,
    'two translations in the same language demonstrate nothing',
  );
});

test('localizedString wraps in the values envelope the API actually persists', () => {
  assert.deepEqual(localizedString({ 'en-US': 'a' }), { values: { 'en-US': 'a' } });
  assert.notDeepEqual(localizedString({ 'en-US': 'a' }), { 'en-US': 'a' },
    'a flat dict is silently dropped by the server (201 + {"values":{}}), so it must never be produced');
});

test('buildLocalizedFields resolves intents to real store locales in the values envelope', () => {
  const m = spec('MSN_LOCALIZED');
  const f = buildLocalizedFields(m, LOCALES);
  assert.deepEqual(Object.keys(f).sort(), ['description', 'localizedName']);
  assert.deepEqual(Object.keys(f.localizedName.values).sort(), ['de-DE', 'en-US']);
  assert.equal(f.localizedName.values['en-US'], m.l10n.name['store-default']);
  assert.equal(f.localizedName.values['de-DE'], m.l10n.name['store-alternate']);
  assert.equal(f.description.values['de-DE'], m.l10n.description['store-alternate']);
});

test('buildLocalizedFields throws on an unresolved intent instead of dropping that locale', () => {
  assert.throws(
    () => buildLocalizedFields(spec('MSN_LOCALIZED'), { 'store-default': 'en-US' }),
    /did not resolve/,
    'a half-localized fixture is indistinguishable from the bug a C11 case hunts',
  );
});

test('buildLocalizedFields is a no-op for a spec with no translations', () => {
  assert.deepEqual(buildLocalizedFields(spec('MSN_ORDERCOUNT'), LOCALES), {});
});

test('buildMissionBody carries the localized fields and banner through', () => {
  const m = spec('MSN_LOCALIZED');
  const body = buildMissionBody(m, { template: template(), storeId: 'B2B-store', now: NOW, ...RESOLVED });
  assert.equal(body.name, 'AGENT-TEST-MSN-LOCALIZED', 'the business key stays ASCII — the seeder looks missions up by it');
  assert.equal(body.bannerUrl, BANNER_URLS[bannerKeyFor(m)], 'the banner is resolved from the upload, not authored on the spec');
  assert.equal(body.localizedName.values['de-DE'], m.l10n.name['store-alternate']);
  assert.equal(body.description.values['en-US'], m.l10n.description['store-default']);
});

test('missionSignature includes the translations and banner, so an edited string is drift', () => {
  const m = spec('MSN_LOCALIZED');
  const base = buildMissionBody(m, { template: template(), storeId: 'B2B-store', now: NOW, ...RESOLVED });
  const edited = { ...base, localizedName: { values: { ...base.localizedName.values, 'de-DE': 'Etwas anderes' } } };
  assert.ok(!signaturesMatch(missionSignature(base), missionSignature(edited)),
    'without this the live mission keeps the old translation forever while the spec says otherwise');
  const rebanner = { ...base, bannerUrl: '/assets/other.png' };
  assert.ok(!signaturesMatch(missionSignature(base), missionSignature(rebanner)));
});

test('missionSignature is order-insensitive across locales', () => {
  const a = { localizedName: { values: { 'en-US': 'x', 'de-DE': 'y' } } };
  const b = { localizedName: { values: { 'de-DE': 'y', 'en-US': 'x' } } };
  assert.deepEqual(missionSignature(a).localizedName, missionSignature(b).localizedName,
    'key order must never read as drift, or every re-seed recreates the fixture');
});

test('localizedValues tolerates the null a non-localized record carries', () => {
  assert.deepEqual(localizedValues(null), {});
  assert.deepEqual(localizedValues(undefined), {});
  assert.deepEqual(localizedValues({ values: { 'en-US': 'a' } }), { 'en-US': 'a' });
});

test('the guard catches every way MSN_LOCALIZED can go vacuous', () => {
  const m = spec('MSN_LOCALIZED');
  const orig = { l10n: m.l10n };
  // Restoring has to DELETE a key the perturbation added (the spec carries no bannerUrl of its own any
  // more), not just overwrite the ones it had — otherwise the leftover leaks into the next assertion.
  const perturb = (patch) => {
    Object.assign(m, patch);
    const p = validateSpecShape();
    for (const k of Object.keys(patch)) if (!(k in orig)) delete m[k];
    Object.assign(m, orig);
    return p;
  };

  assert.ok(perturb({ l10n: { name: { 'store-default': 'only one' }, description: { 'store-default': 'only one' } } })
    .some((p) => /at least 2/.test(p)), 'one locale cannot demonstrate localization');

  assert.ok(perturb({ l10n: { ...m.l10n, name: { 'en-US': 'literal', 'de-DE': 'literal2' } } })
    .some((p) => /not one of store-default/.test(p)), 'a literal locale code is per-env config');

  assert.ok(perturb({ l10n: { name: m.l10n.name, description: { 'store-default': 'a', 'store-alternate': 'a' } } })
    .some((p) => /repeats the SAME text/.test(p)), 'identical text hides a fallback');

  assert.ok(perturb({ l10n: { name: m.l10n.name, description: { 'store-default': 'a', 'store-alternate': '  ' } } })
    .some((p) => /empty translation/.test(p)));

  // The banner is no longer authored on the spec at all — the guard's job there is to REFUSE one, so
  // that the per-env asset URL cannot be committed back into the source of truth.
  assert.ok(perturb({ bannerUrl: 'https://cdn.example.com/b.png' }).some((p) => /literal bannerUrl/.test(p)));

  assert.deepEqual(validateSpecShape().filter((p) => /MSN_LOCALIZED/.test(p)), [], 'and the committed spec is clean');
});

test('MSN_LOCALIZED is the only fixture carrying translations — but NOT the only one with a banner', () => {
  const withL10n = MISSIONS.filter((m) => m.l10n).map((m) => m.aliasName);
  assert.deepEqual(withL10n, ['MSN_LOCALIZED'], 'two localization fixtures make the C11 assertions ambiguous');
  // Exclusivity used to cover the banner too. It must not any more: every mission carries one, so the
  // C11 banner assertion is "MSN_LOCALIZED's banner serves like everyone else's", not "only it has one".
  for (const m of MISSIONS) assert.ok(bannerKeyFor(m), `${m.aliasName} has no banner`);
});

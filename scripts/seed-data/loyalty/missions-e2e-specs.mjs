/**
 * scripts/seed-data/loyalty/missions-e2e-specs.mjs
 *
 * SINGLE SOURCE OF TRUTH for the suite-083d ("loyalty missions E2E") fixture set. Side-effect-free —
 * no env load, no network, no fs, no main() — so the seeder (seed-missions-e2e.mjs), the drift guard
 * (validate-missions-e2e-data.mjs) and the unit tests all import the SAME rules.
 *
 * WHY THIS EXISTS SEPARATELY FROM missions-specs.mjs
 * --------------------------------------------------
 * `missions-specs.mjs` provisions STABLE, long-lived missions for suites 075d / 083c: a fixture is
 * looked up by a fixed name, reused when its structural signature matches, and deliberately NOT
 * recreated. That is exactly right for a suite that asserts a mission's DEFINITION.
 *
 * 083d asserts the mission LOOP — progress advances, the mission completes, the reward lands. Loop
 * assertions consume the fixture: mission progress is per-(user, mission), cumulative, monotonic and
 * FROZEN once the mission completes, and vc-module-loyalty exposes no reset of any kind
 * (`/api/loyalty-mission-progress` has `POST /search` and `GET /{id}` and nothing else; the sole
 * writer is `LoyaltyMissionLogicService.ProcessOrderAsync` off an order INSERT). So the second run of
 * 083d against a stable mission asserts against a Completed row and can never watch progress move.
 * Measured on vcst-qa 2026-08-28 (run REG-2026-08-28-1154): MSN_ORDERCOUNT sat at 2 of 2 Completed
 * and MSN_ORDERVALUE at $5,842,446 / 100%, and a Completed mission was proven to stop accruing
 * entirely by a control pair inside one order — MSN_ZEROTARGET went 24 -> 25 while MSN_ORDERCOUNT
 * stayed frozen at 2. Six of the suite's eight cases were BLOCKED.
 *
 * THE ONE SHAPE THAT IS REPEATABLE
 * --------------------------------
 * Because progress cannot be reset, repeatability cannot come from resetting anything. It comes from
 * asking a DIFFERENT question each run: a mission minted THIS run has no progress row for anybody, so
 * it starts every account at 0% regardless of that account's entire history. Run identity is carried
 * in the mission NAME (`AGENT-TEST-MSN-E2E-<runId>-<KEY>`), so:
 *   - the CSV binds to a stable alias name while the underlying mission id changes every run;
 *   - two runs never share a mission, so 083d is safe to run concurrently with 075d / 083c and with
 *     itself (see feedback_concurrent_runners_distinct_org_users_taskstop);
 *   - teardown is a PREFIX SWEEP with an age floor, not an inline delete, so a crashed run's missions
 *     are still reclaimed by the next one.
 *
 * WHAT IS RUN-SCOPED AND WHAT IS NOT — the split is load-bearing
 * -------------------------------------------------------------
 * MISSIONS are run-scoped, because progress accumulates ON them. PRODUCTS are NOT: a product carries
 * no per-user state, so minting four products per run would add churn, index lag and catalog litter
 * while buying nothing. The products are stable, find-or-create, `trackInventory: false` (so they are
 * infinitely re-purchasable and no case can ever be blocked by stock), and are the only part of this
 * fixture set a teardown of the run does not touch.
 *
 * THE FOUR THINGS THIS SET FIXES, EACH OF WHICH FAILS SILENTLY
 * -----------------------------------------------------------
 * 1. VACUITY. A mission that is already Completed at seed time still exists, still resolves, still
 *    renders a card — and the case asserting "progress advances" reads a frozen number as a product
 *    bug (or, worse, asserts a Completed state it was handed). The seeder records the OBSERVED
 *    seed-time progress into the overlay and the guard FAILS on anything that is not pre-completion.
 *    That check is the one that was missing, and its absence is the direct cause of this episode.
 * 2. LEGIBILITY. MSN-E2E-004's thesis is that the points spent were EARNED FROM A MISSION.
 *    LOYALTY_VIP_USER holds ~964,189,233 PTS, so a 500-PTS reward is ~0.00005% of the balance and no
 *    arithmetic can demonstrate the thesis. The reward account is therefore bound to the per-run
 *    ephemeral LOYALTY_ZERO_USER, and the guard asserts the recorded seed-time balance is BELOW the
 *    reward — i.e. the grant at least doubles it. Note the balance CLIMBS on every completion, which
 *    is why this is an invariant re-checked each run and not a one-off provisioning step.
 * 3. PTS-PRICED PERSKU TARGET. MSN-E2E-007 needs a product that is simultaneously a PerSkuGoal target
 *    and priced in the loyalty currency, and none existed. The accrual path
 *    (`LoyaltyMissionLogicService.cs:~416`) increments `CurrentQuantity` from `order.Items` with NO
 *    currency filter while its sibling `LoyaltyProgramHandler.cs:199` filters
 *    `!x.Currency.EqualsIgnoreCase(loyaltyCurrency)` — so whether a points-currency line counts
 *    toward a quantity target is genuinely open, and unaskable without this fixture.
 * 4. PACK SIZE. MSN_PERSKU_PRODUCT_B (55557702) has pack size 2 and steps 0 -> 2 -> 0, so a case step
 *    saying "raise the stepper to exactly 1" is unachievable. Every product here is CREATED with
 *    packSize 1, `pack_size` is an authored alias field so no case has to assume, and the guard
 *    asserts each goal quantity is a whole multiple of its product's pack size.
 *
 * API SHAPES are inherited wholesale from `missions-specs.mjs` rather than restated — this module
 * imports its node builders, window model and block map, so a change to the mission body shape is
 * made in exactly one place. The only thing overridden here is the NAME (run-scoped) and the fixture
 * set itself.
 *
 * NAMING: `AGENT-TEST-MSN-E2E-<runId>-<KEY>` for missions, `AGENT-TEST-MSN-E2E-<KEY>` for products —
 * both under the `AGENT-TEST-` prefix `/qa-seed-data teardown` sweeps.
 * RUNTIME IDS: mission GUIDs, product ids, catalog ids, the resolved currency, the reward account's
 * identity and every observed seed-time state live ONLY in aliases.<env>.json — never in a committed
 * file.
 */
import {
  WINDOWS, windowDates, PROCESSED_PERIODICITY, BLOCK, blockOf,
  buildGoalNode, buildConditionNode, buildRewardNode,
  READING_ORDER, readingValues, readingsConsistentWith,
} from './missions-specs.mjs';

/** Everything disposable this seeder creates carries this prefix. */
export const SEED_PREFIX = 'AGENT-TEST';

/** Mission names are `${NAME_PREFIX}-${runId}-${key}`. */
export const NAME_PREFIX = 'AGENT-TEST-MSN-E2E';

/** Product codes are `${PRODUCT_PREFIX}-${key}` — stable, NOT run-scoped (see the header). */
export const PRODUCT_PREFIX = 'AGENT-TEST-MSN-E2E';

/**
 * A run handle: `<YYYYMMDDHHmmss>-<rand4>`. Deliberately the SAME shape as
 * seed-loyalty-ephemeral-user.mjs's account handle, because both are swept by age and a second
 * timestamp format would mean a second parser that can silently disagree with the first.
 */
export const RUN_ID_PATTERN = /^(\d{14})-([0-9a-f]{4})$/;

/** Mint a run handle. The ONE impure-looking export — it reads the clock and Math.random, nothing else. */
export function newRunId(now = new Date(), rand = Math.random()) {
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${ts}-${Math.floor(rand * 65536).toString(16).padStart(4, '0')}`;
}

/** Compose a run-scoped mission name. Pure. */
export const missionName = (runId, key) => `${NAME_PREFIX}-${runId}-${key}`;

/** Is this a mission THIS seeder owns? The hard teardown guard — nothing else is ever deleted. */
export const isE2EMissionName = (name) => new RegExp(`^${NAME_PREFIX}-\\d{14}-[0-9a-f]{4}-`).test(String(name || ''));

/** Pull the run handle back out of a mission name, or null. Pure. */
export function runIdFromName(name) {
  const m = new RegExp(`^${NAME_PREFIX}-(\\d{14}-[0-9a-f]{4})-`).exec(String(name || ''));
  return m ? m[1] : null;
}

/**
 * Age of a run handle in hours, or null when it does not parse. Used by teardown's `--max-age-hours`
 * floor so a sweep cannot delete the missions of a run that is still executing beside it.
 */
export function runIdAgeHours(runId, now = new Date()) {
  const m = RUN_ID_PATTERN.exec(String(runId || ''));
  if (!m) return null;
  const s = m[1];
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / 3600000 : null;
}

/** Default age floor for a teardown sweep: younger runs are spared. */
export const DEFAULT_SWEEP_MAX_AGE_HOURS = 6;

/**
 * Fields that are server- or env-determined, keyed by ALIAS KIND. They MUST be empty in the committed
 * `test-data/aliases.json` and are written per-env into `aliases.<env>.json`.
 *
 * Keyed by kind rather than flattened for the same reason missions-specs.mjs does it: `name` is
 * RUNTIME on a mission here (it carries the run handle, so it cannot be committed) and AUTHORED on a
 * product (we create it by that code). A single union list would demand that the products' own
 * identifiers be blanked.
 */
export const RUNTIME_FIELDS_BY_KIND = {
  // `catalog_id` / `category_id` are the PIN that stops ensureCategoryPath minting a duplicate
  // category every run (its lookup is index-backed and this env does not index categories).
  run: ['run_id', 'seeded_at', 'store_id', 'catalog_id', 'category_id'],
  // `name` is runtime BECAUSE it is run-scoped — this is the difference from the stable fixture set.
  mission: ['id', 'name', 'run_id', 'goal_currency', 'progress_status_at_seed', 'progress_percent_at_seed'],
  product: ['productId', 'catalogId', 'currency', 'url', 'slug'],
  rewardUser: ['email', 'user_id', 'member_id', 'balance_at_seed'],
  // A per-case mission adds MEASURED fields. `goal_target` is runtime here and authored on a plain
  // `mission`: the target is derived from a live probe cart on the case's own account, because the
  // quantity it has to separate (merchandise vs order total) is composed by the platform — a 20% tax
  // this repo never declared is what actually makes them differ on vcst-qa. Transcribing a target
  // would re-introduce exactly the undecidable fixture `.claude/rules/test-data.md` SECOND RULE
  // describes.
  caseMission: [
    'id', 'name', 'run_id', 'goal_currency', 'goal_target',
    'progress_status_at_seed', 'progress_percent_at_seed',
    'order_shipping_max', 'available_shipping',
    'measured_subtotal', 'measured_discount', 'measured_tax', 'measured_shipping', 'measured_total',
    'measured_total_undiscounted', 'reading_values', 'separates_above', 'separates_below',
    'separation_margin', 'co_completing_missions', 'reward_expected_total',
  ],
  caseUser: ['email', 'user_id', 'member_id', 'handle', 'balance_at_seed'],
};

/* ── Products ────────────────────────────────────────────────────────────────
 *
 * All four are Physical, isBuyable, `trackInventory: false`, packSize 1, and live in the store's
 * virtual catalog. Non-tracked inventory is not a shortcut: 083d places REAL orders on every run
 * forever, so a tracked fixture would drain and start failing cases for a reason that has nothing to
 * do with missions — the same class of silent decay this whole module exists to remove.
 */

/**
 * The denomination product. Priced at ONE unit of the store default currency, so an order of quantity
 * N has a subtotal of exactly N and any order value in 083d is composable without fixture gymnastics.
 * Same trick, and the same justification, as LOY_SKU_PTS_UNIT's 1-PTS divisor price.
 */
export const UNIT_PRODUCT = {
  aliasName: 'MSN_E2E_PRODUCT_UNIT',
  kind: 'product',
  slot: 'U',
  key: 'UNIT',
  sku: `${PRODUCT_PREFIX}-UNIT`,
  productName: 'AGENT-TEST Missions E2E Unit',
  listPrice: 5,
  currencyIntent: 'store-default',
  packSize: 1,
  purpose:
    'Denomination product for every OrderValueGoal case. At 5 units of the store default currency a '
    + 'cart of quantity N has subtotal 5N, so the order values MSN-E2E-003/005 need (just below the '
    + 'target; exactly at it) are composable by quantity alone.',
};

/** The two PerSku targets. Two, not one, because `all=true` over a single target is indistinguishable
 *  from `all=false` — the ALL semantics need a second row to mean anything. */
export const PERSKU_PRODUCTS = [
  {
    aliasName: 'MSN_E2E_PRODUCT_A',
    kind: 'product',
    slot: 'A',
    key: 'PERSKU-A',
    sku: `${PRODUCT_PREFIX}-PERSKU-A`,
    productName: 'AGENT-TEST Missions E2E PerSku Target A',
    listPrice: 10,
    currencyIntent: 'store-default',
    packSize: 1,
    goalQuantity: 1,
    purpose: 'PerSku target A. packSize 1 so "raise the stepper to exactly 1" is achievable.',
  },
  {
    aliasName: 'MSN_E2E_PRODUCT_B',
    kind: 'product',
    slot: 'B',
    key: 'PERSKU-B',
    sku: `${PRODUCT_PREFIX}-PERSKU-B`,
    productName: 'AGENT-TEST Missions E2E PerSku Target B',
    listPrice: 10,
    currencyIntent: 'store-default',
    packSize: 1,
    goalQuantity: 1,
    purpose: 'PerSku target B — the second row that makes `all=true` mean something.',
  },
];

/**
 * The PTS-priced PerSku target (MSN-E2E-007). Priced ONLY in the loyalty currency, deliberately: a
 * product carrying both a PTS and a default-currency price would let the line settle in either one,
 * and the case could not attribute what it observed. With a single PTS price the line item's currency
 * is not in question, so "does a points-currency line count toward a quantity target?" has an
 * answerable form.
 */
export const PTS_PRODUCT = {
  aliasName: 'MSN_E2E_PRODUCT_PTS',
  kind: 'product',
  slot: 'P',
  key: 'PERSKU-PTS',
  sku: `${PRODUCT_PREFIX}-PERSKU-PTS`,
  productName: 'AGENT-TEST Missions E2E PerSku PTS Target',
  listPrice: 1,
  /** Resolved from LOYALTY_SETTINGS.currency_code at seed time — never assumed to be the literal 'PTS'. */
  currencyIntent: 'loyalty',
  packSize: 1,
  goalQuantity: 1,
  purpose:
    'The unambiguous instance of the no-currency-filter finding: a PerSkuGoal target priced in the '
    + 'LOYALTY currency, so a line item bought with points either does or does not increment '
    + 'CurrentQuantity. LoyaltyMissionLogicService.cs:~416 applies no currency filter while the '
    + 'sibling LoyaltyProgramHandler.cs:199 does — this fixture is what makes the discrepancy '
    + 'observable from the storefront.',
};

export const PRODUCTS = [UNIT_PRODUCT, ...PERSKU_PRODUCTS, PTS_PRODUCT];
export const PRODUCT_BY_SLOT = Object.fromEntries(PRODUCTS.map((p) => [p.slot, p]));
export const PRODUCT_BY_ALIAS = Object.fromEntries(PRODUCTS.map((p) => [p.aliasName, p]));

/* ── Missions ────────────────────────────────────────────────────────────── */

/**
 * The coupon 083d's discount case applies. Declared here — not because this module owns the coupon,
 * but because the OrderValueGoal target must leave a band in which a pre-discount order clears the
 * target and its post-discount total does not. Without the rate written down, that band is an
 * accident and `discountBand()` cannot check it.
 */
export const DISCOUNT_ALIAS = 'COUPON_20PCT';
export const DISCOUNT_RATE = 0.2;

export const MISSIONS = [
  {
    aliasName: 'MSN_E2E_ORDERVALUE',
    key: 'ORDERVALUE',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderValueGoal', value: 50, currency: 'store-default' },
    reward: 500,
    cases: ['MSN-E2E-004'],
    purpose:
      'MSN-E2E-004 ONLY, since the per-case split. 004 asks whether the points it spends were EARNED '
      + 'FROM A MISSION — a question about the reward, not about how the goal is measured — so a plain '
      + 'authored target that the case order comfortably clears is the right shape, and its account '
      + '(the per-run LOYALTY_ZERO_USER) was never contended: progress is per-(user, mission), and 004 '
      + 'is the only case on that account. 003/005/006/008 shared LOYALTY_VIP_USER and therefore shared '
      + 'every OrderValueGoal row on it; they now have their own missions AND their own accounts (see '
      + 'CASE_MISSIONS).',
  },
  {
    aliasName: 'MSN_E2E_ORDERCOUNT',
    key: 'ORDERCOUNT',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderCountGoal', count: 2 },
    reward: 300,
    cases: ['MSN-E2E-001'],
    purpose:
      'Order-count goal, target 2. Two and not one: at count=1 "counts orders" and "fires on any '
      + 'order" are the same observation, so the first order would prove nothing about counting. Two '
      + 'also gives MSN-E2E-001 an intermediate state to assert — 1 of 2, InProgress, not Completed — '
      + 'between the two orders it places.',
  },
  {
    aliasName: 'MSN_E2E_PERSKU',
    key: 'PERSKU',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'PerSkuGoal', all: true },
    reward: 750,
    slots: ['A', 'B'],
    cases: ['MSN-E2E-002'],
    purpose:
      'The featured-SKU modal subject. `all=true` over TWO targets at quantity 1 each: adding to cart '
      + 'from the modal must leave both rows at 0, and completing the purchase must advance them. Both '
      + 'targets are packSize-1 products, so the "set the stepper to exactly 1" step in MSN-E2E-002 is '
      + 'achievable — it is not against MSN_PERSKU_PRODUCT_B, which steps 0 -> 2 -> 0.',
  },
  {
    aliasName: 'MSN_E2E_PERSKU_PTS',
    key: 'PERSKU-PTS',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'PerSkuGoal', all: false },
    reward: 150,
    slots: ['P'],
    cases: ['MSN-E2E-007'],
    purpose:
      'The currency-filter subject. ONE target, the PTS-priced product, `all=false` so a single '
      + 'points-currency line is the whole goal and the observation is not diluted by a second row '
      + 'bought in the default currency. Whether it completes IS the finding.',
  },
];

/* ── Per-case OrderValue missions + per-case accounts ────────────────────────
 *
 * THE CONTENTION, AND WHICH AXIS ACTUALLY FIXES IT
 * ------------------------------------------------
 * MSN_E2E_ORDERVALUE used to serve five cases. Four of them — 003/005/006/008 — also shared ONE
 * account (LOYALTY_VIP_USER), and that is the axis that actually broke them.
 *
 * `LoyaltyMissionLogicService.ProcessOrderAsync` runs once per order INSERT and advances EVERY
 * mission applicable to that order's user. So a single account carrying four OrderValueGoal missions
 * has all four rows moved by any one case's order: 003's 9-unit order would leave 005, 006 and 008
 * each part-consumed before they started. Minting four missions on one account therefore fixes
 * NOTHING — it multiplies the rows one order touches.
 *
 * Progress is keyed per-(user, mission). MSN-E2E-004 already proved the correct axis: it shares the
 * mission DEFINITION with the other four and is not contended, because it runs on its own account.
 * So the fix is per-case ACCOUNTS. Evidence that one order moves many missions, from the same
 * environment: run REG-2026-08-28-1154 granted 750+450+550+400 mission rewards from the single order
 * CO260828-00001, and its control pair showed MSN_ZEROTARGET advancing 24 -> 25 in that same order.
 *
 * PER-CASE MISSIONS ARE STILL REQUIRED — FOR SIZING, NOT FOR ISOLATION
 * --------------------------------------------------------------------
 * Accounts remove the contention; they do not let one target answer four different questions. Under
 * `.claude/rules/test-data.md` SECOND RULE each mission's target has to be placed so that the wrong
 * implementation of ITS link produces a different observation, and those placements conflict:
 *   - 003 needs the target strictly BETWEEN merchandise value and order total;
 *   - 005 needs it strictly BETWEEN the same cart's discounted and undiscounted totals;
 *   - 006 needs it BELOW every candidate reading, so a failure to reach 100% can only mean the
 *     settlement window misbehaved and never "the goal measures something smaller";
 *   - 008 needs it below every reading AND low enough that its own order completes NO other mission
 *     in this set, or the reward it asserts on is not attributable.
 * One number cannot be all four. Minting is cheap (POST /api/loyalty-missions, already proven), so
 * each case gets its own.
 *
 * EVERY TARGET IS MEASURED, NOT MODELLED — this is the correction the SECOND RULE forced
 * ---------------------------------------------------------------------------------------
 * The previous fixture derived its numbers from `units x listPrice`, i.e. from a model of the cart.
 * That model is wrong on this environment. Measured on vcst-qa / B2B-store, 2026-08-28, through the
 * same xAPI the storefront uses:
 *
 *     9 x UNIT @ 5   ->  subTotal 45  tax  9  shipping 0  TOTAL 54
 *    10 x UNIT @ 5   ->  subTotal 50  tax 10  shipping 0  TOTAL 60
 *    10 x UNIT + 20% ->  subTotal 50  tax  8  discount 10  TOTAL 48
 *
 * There is a 20% tax nothing in this repo had declared, applied to (subTotal - discount + shipping).
 * It is the whole reason merchandise value and order total differ at all when shipping is 0 — and
 * therefore the whole reason 003 is decidable. A modelled `postDiscount = 40` (what the old
 * `discountBand()` predicts) is 8.00 away from the platform's actual 48, which is four times the
 * band 005 was supposed to discriminate inside. So the seeder builds a real probe cart per case, on
 * that case's own account, and derives the target from what the platform returned.
 *
 * The reading vocabulary is NOT re-invented here: `ORDER_VALUE_READINGS` / `READING_ORDER` /
 * `readingValues` / `readingsConsistentWith` are imported from `missions-specs.mjs`, which already
 * models "what could an OrderValueGoal be measuring". This module only supplies a money shape read
 * off a live cart instead of composed from an authored order.
 */

/** Sweep namespace for the per-case accounts. The ONLY accounts this seeder will ever delete. */
export const CASE_ACCOUNT_PREFIX = 'AGENT-TEST-msne2e-';

/**
 * How a case mission's target is placed. Each rule names the DISTINCTION the mission exists to make
 * decidable; the seeder feeds it measured money and gets a number.
 */
export const TARGET_RULES = {
  /** Between the merchandise readings and the order-total readings. */
  totalVsMerchandise: 'totalVsMerchandise',
  /** Between the same cart's discounted and undiscounted order totals. */
  discountedVsUndiscounted: 'discountedVsUndiscounted',
  /** Below EVERY candidate reading — the mission's question is not about the measured value. */
  everyReading: 'everyReading',
};

/**
 * Where a `everyReading` target sits, as a fraction of the weakest reading the case's own order
 * produces. 0.6 leaves 40% headroom, so the mission still completes if the platform turns out to
 * measure the smallest of the four candidates.
 */
export const COMPLETE_ALL_FRACTION = 0.6;

/**
 * The smallest gap, in store currency, between a derived target and either quantity it separates.
 *
 * Below this the fixture has stopped discriminating in practice even though the arithmetic still
 * "works": a one-cent band is indistinguishable from a rounding rule. Both separated quantities are
 * exact platform output, so this is a design floor rather than a tolerance.
 */
export const MIN_TARGET_SEPARATION = 1;

/**
 * The four contended cases, one mission and one account each.
 *
 * `reward` is DISTINCT per mission and mnemonic (503 for MSN-E2E-003, and so on). That is the
 * SECOND RULE's divergence clause applied to attribution: four missions sharing a 500-PTS reward
 * would be indistinguishable in a balance delta or a points-history row, so "the grant came from THIS
 * mission" would be unfalsifiable. None of these values collides with an existing loyalty fixture
 * reward (500/300/750/400/275/200/100/250/150/325/450/550/350).
 *
 * `order.units` is AUTHORED intent (how big a cart the case drives); every money figure that follows
 * from it is MEASURED. The units are chosen so the four orders' totals stay ordered
 * 008 < 003 < 006 < 005, which is what makes 008's reward attributable — see ATTRIBUTION below.
 */
export const CASE_MISSIONS = [
  {
    aliasName: 'MSN_E2E_ORDERVALUE_003',
    key: 'ORDERVALUE-003',
    caseId: 'MSN-E2E-003',
    cases: ['MSN-E2E-003'],
    accountAlias: 'MSN_E2E_USER_003',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    /** `value` is DERIVED at seed time from the probe cart — never authored. */
    goal: { type: 'OrderValueGoal', value: null, currency: 'store-default' },
    reward: 503,
    order: { units: 9, coupon: null },
    targetRule: TARGET_RULES.totalVsMerchandise,
    decides:
      'Does an OrderValueGoal accrue the order TOTAL (merchandise less discounts, plus shipping and '
      + 'tax) or merchandise value alone? The two diverge by the tax the platform adds: 9 units give '
      + 'subTotal 45 and TOTAL 54 on vcst-qa. The target lands between them, so a merchandise reading '
      + 'leaves the card short and a total reading completes it. The old flat fixture could not ask '
      + 'this — both readings predicted the same number, which is the worked example in '
      + '.claude/rules/test-data.md SECOND RULE.',
    limits:
      'It separates {netMerchandise, grossMerchandise} from {orderTotal, totalPlusPoints} as GROUPS. '
      + 'Without a discount net and gross are the same number, and without a points line orderTotal '
      + 'and totalPlusPoints are the same number, so this mission cannot tell the members of either '
      + 'pair apart. Distinguishing net from gross is MSN_E2E_ORDERVALUE_005\'s job.',
  },
  {
    aliasName: 'MSN_E2E_ORDERVALUE_005',
    key: 'ORDERVALUE-005',
    caseId: 'MSN-E2E-005',
    cases: ['MSN-E2E-005'],
    accountAlias: 'MSN_E2E_USER_005',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderValueGoal', value: null, currency: 'store-default' },
    reward: 505,
    order: { units: 10, coupon: DISCOUNT_ALIAS },
    targetRule: TARGET_RULES.discountedVsUndiscounted,
    decides:
      'Is a checkout discount reflected in what the goal accrues? The seeder measures the SAME cart '
      + 'twice on the same account — with the coupon and without it (48 and 60 on vcst-qa) — and puts '
      + 'the target between the two. The case places the discounted order; the fixture has already '
      + 'measured that the identical undiscounted order would have completed the mission, so '
      + '"it would have crossed pre-discount and fell back post-discount" is a measured counterfactual '
      + 'rather than an assumption.',
    limits:
      'Non-completion ALONE does not prove discount-sensitivity: a discount-BLIND grossMerchandise '
      + 'reading (50) also falls under the target (54). What identifies the reading is the amount the '
      + 'card reports as spent — 40 (net) / 50 (gross) / 48 (total) are three distinct values on this '
      + 'environment — so the case must record the spent amount and match it against `reading_values`, '
      + 'not merely observe that no Completed chip appeared.',
  },
  {
    aliasName: 'MSN_E2E_ORDERVALUE_006',
    key: 'ORDERVALUE-006',
    caseId: 'MSN-E2E-006',
    cases: ['MSN-E2E-006'],
    accountAlias: 'MSN_E2E_USER_006',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderValueGoal', value: null, currency: 'store-default' },
    reward: 506,
    order: { units: 12, coupon: null },
    targetRule: TARGET_RULES.everyReading,
    decides:
      'Does the missions page degrade cleanly between order confirmation and Hangfire settlement, and '
      + 'converge to 100% inside the budget? The question is about the WINDOW, so the target is placed '
      + 'below every candidate reading. That is deliberate and is the whole reason this mission is '
      + 'separate: if the target sat where only some readings complete, a card stuck below 100% would '
      + 'be ambiguous between "settlement regressed" (the finding) and "the goal measures something '
      + 'smaller than we assumed" (a different finding entirely), and the case could not tell which.',
    limits:
      'It says nothing about WHAT the goal measures — by construction. It also cannot distinguish a '
      + 'slow settlement from a fast one beyond the poll budget the case applies.',
  },
  {
    aliasName: 'MSN_E2E_ORDERVALUE_008',
    key: 'ORDERVALUE-008',
    caseId: 'MSN-E2E-008',
    cases: ['MSN-E2E-008'],
    accountAlias: 'MSN_E2E_USER_008',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderValueGoal', value: null, currency: 'store-default' },
    reward: 508,
    order: { units: 4, coupon: null },
    targetRule: TARGET_RULES.everyReading,
    decides:
      'Is a mission reward clawed back when its order is cancelled? Like 006 the target is below every '
      + 'reading, because the question is about the grant and not about the measurement. What is '
      + 'special here is ATTRIBUTION: the case asserts on a balance delta, so its order must complete '
      + 'this mission and no other mission in this set. Four units keep its order total (24) below '
      + 'every other per-case target, and the reward 508 is unique, so the grant is identifiable by '
      + 'amount as well as by mission name.',
    limits:
      'Attribution is exact only WITHIN this fixture set. Other store-wide missions still grant on a '
      + 'fresh account\'s first order — MSN_ZEROTARGET (OrderCountGoal 0, reward 200), MSN_LOCALIZED '
      + 'and the other count-1 fixtures all fire — so a raw balance delta is NOT equal to this '
      + 'mission\'s reward. The seeder measures that co-grant set live and records it as '
      + '`co_completing_missions` / `reward_expected_total`; a case asserting on the delta must use '
      + 'those, or assert on the attributable points-history row instead.',
  },
];

export const CASE_MISSION_BY_ALIAS = Object.fromEntries(CASE_MISSIONS.map((m) => [m.aliasName, m]));

/** Every mission this seeder mints — the authored-target set plus the measured per-case set. */
export const ALL_MISSIONS = [...MISSIONS, ...CASE_MISSIONS];

export const MISSION_BY_ALIAS = Object.fromEntries(ALL_MISSIONS.map((m) => [m.aliasName, m]));

/** Does this spec carry a measured, seed-time-derived target? Pure. */
export const isCaseMission = (spec) => CASE_MISSION_BY_ALIAS[spec?.aliasName] != null;

/** The per-case accounts, declared from the missions so the two can never disagree. */
export const CASE_ACCOUNTS = CASE_MISSIONS.map((m) => ({
  aliasName: m.accountAlias,
  kind: 'caseUser',
  caseId: m.caseId,
  missionAlias: m.aliasName,
  purpose:
    `Per-run, zero-balance account for ${m.caseId}. Its own account is what isolates ${m.aliasName}: `
    + 'one order advances every applicable mission for its user, so a shared account cannot be fixed '
    + 'by minting more missions. Created WITH org membership because the org supplies the shipping '
    + 'ADDRESSES checkout needs — a brand-new contact has none and the cart never reaches a decisive '
    + 'place-order state.',
}));

export const CASE_ACCOUNT_BY_ALIAS = Object.fromEntries(CASE_ACCOUNTS.map((a) => [a.aliasName, a]));

const round2 = (n) => Number(Number(n).toFixed(2));
const num = (v) => (v == null ? 0 : Number(v?.amount ?? v) || 0);

/**
 * Turn a LIVE cart reading into the money shape `missions-specs.mjs` already models readings over.
 *
 * Deliberately a straight transcription of what the platform returned plus ONE derived field
 * (`netMerchandise`), so nothing here can quietly disagree with the cart. `pointsLineValue` is 0
 * because these probe carts contain only the default-currency denomination product; the PTS fixture
 * belongs to MSN-E2E-007, which is a PerSku case and not an OrderValueGoal at all.
 */
export function measuredMoney(cart) {
  const grossMerchandise = round2(num(cart?.subTotal));
  const discountTotal = round2(num(cart?.discountTotal));
  const shippingTotal = round2(num(cart?.shippingTotal));
  const taxTotal = round2(num(cart?.taxTotal));
  const orderTotal = round2(num(cart?.total));
  const netMerchandise = round2(grossMerchandise - discountTotal);
  return {
    grossMerchandise, discountTotal, netMerchandise, shippingTotal, taxTotal,
    orderTotal, pointsLineValue: 0, totalPlusPoints: orderTotal,
  };
}

/**
 * Does the platform compose this cart the way the reading model assumes
 * (`net + shipping + tax === total`)? Returns null when it does, or a description when it does not.
 *
 * A mismatch is NOT tolerated by widening a tolerance: it would mean the composition has a term this
 * module does not model, and every derived target would be placed against an incomplete picture.
 */
export function moneyIncoherence(money, tolerance = 0.01) {
  const expect = round2(money.netMerchandise + money.shippingTotal + money.taxTotal);
  if (Math.abs(expect - money.orderTotal) <= tolerance) return null;
  return (
    `the platform reports total ${money.orderTotal} but net ${money.netMerchandise} + shipping `
    + `${money.shippingTotal} + tax ${money.taxTotal} = ${expect}. The order total carries a term this `
    + 'module does not model, so every target derived from this cart would be placed against an '
    + 'incomplete picture of what the goal could be measuring.'
  );
}

/** The smallest value any candidate reading predicts for this money shape. Pure. */
export const minReading = (money) => Math.min(...READING_ORDER.map((k) => Number(readingValues(money)[k])));

/** The largest value any candidate reading predicts. Pure. */
export const maxReading = (money) => Math.max(...READING_ORDER.map((k) => Number(readingValues(money)[k])));

/**
 * Place a case mission's target from measured money. Pure.
 *
 * `measurements` is `{ base, undiscounted? }` — `base` is the cart the CASE will actually place
 * (coupon applied where the spec declares one) and `undiscounted` is the same cart measured without
 * the coupon, which only the `discountedVsUndiscounted` rule needs.
 *
 * Returns `{ target, above, below, aboveLabel, belowLabel, margin }`, or throws when the measurement
 * leaves no band at all — a fixture that cannot discriminate must fail the SEED, never the suite.
 */
export function deriveCaseTarget(spec, measurements) {
  const base = measurements?.base;
  if (!base) throw new Error(`${spec.aliasName}: no measured cart to derive a target from`);
  const bad = moneyIncoherence(base);
  if (bad) throw new Error(`${spec.aliasName}: ${bad}`);

  const band = (below, above, belowLabel, aboveLabel) => {
    if (!(above > below)) {
      throw new Error(
        `${spec.aliasName}: ${aboveLabel} (${above}) is not above ${belowLabel} (${below}), so there is `
        + 'no band to place a target in and the mission would answer the same way whichever reading is '
        + 'right. Change the order composition rather than the target.',
      );
    }
    const target = round2((above + below) / 2);
    const margin = round2(Math.min(target - below, above - target));
    if (margin < MIN_TARGET_SEPARATION) {
      throw new Error(
        `${spec.aliasName}: the band between ${belowLabel} (${below}) and ${aboveLabel} (${above}) leaves `
        + `only ${margin} either side of target ${target}, under the ${MIN_TARGET_SEPARATION} floor — a `
        + 'gap that narrow is indistinguishable from a rounding rule. Raise the order quantity.',
      );
    }
    return { target, below, above, belowLabel, aboveLabel, margin };
  };

  switch (spec.targetRule) {
    case TARGET_RULES.totalVsMerchandise:
      return band(base.grossMerchandise, base.orderTotal, 'grossMerchandise', 'orderTotal');

    case TARGET_RULES.discountedVsUndiscounted: {
      const undiscounted = measurements?.undiscounted;
      if (!undiscounted) throw new Error(`${spec.aliasName}: the discountedVsUndiscounted rule needs the same cart measured without its coupon`);
      if (!(base.discountTotal > 0)) {
        throw new Error(
          `${spec.aliasName}: the coupon reduced the probe cart by ${base.discountTotal} — it did not apply, `
          + 'so the case would place an undiscounted order and assert a discount effect that never happened.',
        );
      }
      return band(base.orderTotal, undiscounted.orderTotal, 'orderTotal (discounted)', 'orderTotal (undiscounted)');
    }

    case TARGET_RULES.everyReading: {
      const weakest = minReading(base);
      const target = round2(weakest * COMPLETE_ALL_FRACTION);
      const margin = round2(weakest - target);
      if (margin < MIN_TARGET_SEPARATION) {
        throw new Error(
          `${spec.aliasName}: the weakest reading of the probe cart is ${weakest}, which leaves only ${margin} `
          + `above target ${target} — this mission must complete under EVERY reading or a card short of 100% is `
          + 'ambiguous between its own question and a measurement question. Raise the order quantity.',
        );
      }
      return { target, below: 0, above: weakest, belowLabel: 'zero', aboveLabel: 'weakest reading', margin };
    }

    default:
      throw new Error(`${spec.aliasName}: unknown target rule "${spec.targetRule}"`);
  }
}

/**
 * The store's effective tax rate, DERIVED from a measured cart rather than declared.
 *
 * vcst-qa applies 20% to (subTotal - discount + shipping); nothing in this repo had written that down,
 * and it is the term that makes merchandise value and order total differ at all when shipping is 0.
 * Reading it off the cart means a store that changes its rate — or has none — moves every dependent
 * number with it instead of leaving a stale one behind. Returns 0 when there is nothing to divide by.
 */
export function taxRateOf(money) {
  const base = Number(money.netMerchandise) + Number(money.shippingTotal);
  if (!(base > 0)) return 0;
  return Number(money.taxTotal) / base;
}

/**
 * How much SHIPPING this case's order can carry before its fixture stops discriminating — the number
 * the case needs in order to choose a delivery method, and which it currently has to guess at.
 *
 * `null` means unbounded. The two bounded rules are bounded for different reasons:
 *   - `discountedVsUndiscounted`: shipping raises the discounted AND undiscounted totals together, so
 *     it eats the band from below. Headroom is `margin / (1 + taxRate)` because the shipping charge is
 *     itself taxed.
 *   - MSN-E2E-008: shipping raises its order total toward the nearest SIBLING target, and the moment
 *     it reaches one, a second mission grants on the same order and the balance delta the case asserts
 *     on stops naming anything.
 * `totalVsMerchandise` and the plain `everyReading` case are unbounded: shipping only ever moves the
 * total UP, which is the side that already completes.
 */
export function shippingHeadroom(spec, { money, target, nearestSiblingTarget = null } = {}) {
  const t = taxRateOf(money);
  const grow = (gap) => (gap == null ? null : Math.max(0, Number((gap / (1 + t)).toFixed(2))));
  if (spec.targetRule === TARGET_RULES.discountedVsUndiscounted) {
    return grow(Number(target) - Number(money.orderTotal));
  }
  if (spec.caseId === 'MSN-E2E-008' && nearestSiblingTarget != null) {
    return grow(Number(nearestSiblingTarget) - Number(money.orderTotal));
  }
  return null;
}

/**
 * ATTRIBUTION. MSN-E2E-008 asserts on a balance delta, so its own order must complete its own mission
 * and NO other mission in this set. Given each case's derived target and the order total its account
 * will place, return the problems ([] = clean). Pure.
 */
export function attributionProblems(derivedByAlias, orderTotalByAlias, margin = MIN_TARGET_SEPARATION) {
  const problems = [];
  const attributed = CASE_MISSIONS.filter((m) => m.caseId === 'MSN-E2E-008');
  for (const owner of attributed) {
    const ownTotal = Number(orderTotalByAlias?.[owner.aliasName]);
    if (!Number.isFinite(ownTotal)) { problems.push(`${owner.aliasName}: no measured order total, so attribution cannot be checked`); continue; }
    const ownTarget = Number(derivedByAlias?.[owner.aliasName]?.target);
    if (!(ownTarget <= ownTotal)) problems.push(`${owner.aliasName}: its own order (${ownTotal}) does not reach its target (${ownTarget}) — the reward it asserts on would never be granted`);
    for (const other of ALL_MISSIONS) {
      if (other.aliasName === owner.aliasName) continue;
      if (other.goal?.type !== 'OrderValueGoal') continue;
      const otherTarget = Number(derivedByAlias?.[other.aliasName]?.target ?? other.goal?.value);
      if (!Number.isFinite(otherTarget)) continue;
      if (ownTotal + margin > otherTarget) {
        problems.push(
          `${owner.aliasName}: its order total ${ownTotal} reaches ${other.aliasName}'s target ${otherTarget}, so that `
          + `mission grants on the same order and the ${owner.reward}-PTS delta ${owner.caseId} asserts on is no longer `
          + 'attributable. Lower this order\'s quantity or raise the other target.',
        );
      }
    }
  }
  return problems;
}

/**
 * Which readings a live-observed "spent" amount is consistent with — the falsifiability check run
 * against observation rather than intent. Re-exported through this module so a consumer of the E2E
 * fixture set has one import, and so the pass-through is unit-tested here too.
 */
export const readingsFor = (observed, money, tolerance = 0.01) => readingsConsistentWith(observed, money, tolerance);

/** The PerSku slots a spec targets, and the goal quantity per slot. Pure. */
export const missionSlots = (spec) => (spec?.slots ? [...spec.slots] : []);
export const needsGoalItems = (spec) => spec?.goal?.type === 'PerSkuGoal';

/** The goal-item rows this mission needs, once the products are resolved. Pure. */
export function buildGoalItems(spec, missionId, resolvedBySlot) {
  if (!needsGoalItems(spec)) return [];
  return missionSlots(spec).map((slot) => {
    const product = resolvedBySlot?.[slot];
    if (!product?.id) throw new Error(`PerSku slot ${slot} has no resolved product`);
    const declared = PRODUCT_BY_SLOT[slot];
    if (!declared) throw new Error(`slot ${slot} is not declared in PRODUCTS`);
    return { missionId, productId: product.id, quantity: declared.goalQuantity };
  });
}

/* ── Derived arithmetic — the numbers the cases compose orders from ─────────
 *
 * Every one of these is DERIVED, never a second literal. A case that wants "the quantity that just
 * fails" reads it from the alias; if the target or the unit price ever moves, the number moves with
 * it instead of going quietly stale (.claude/rules/test-data.md GOLDEN RULE).
 */

/** Units of UNIT_PRODUCT whose subtotal first reaches the OrderValue target. */
export const unitsToComplete = (spec = MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE, product = UNIT_PRODUCT) =>
  Math.ceil(Number(spec.goal.value) / Number(product.listPrice));

/** The largest unit count that still falls SHORT of the target. */
export const unitsJustBelow = (spec = MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE, product = UNIT_PRODUCT) =>
  unitsToComplete(spec, product) - 1;

/**
 * MSN-E2E-005's band. An order of exactly `unitsToComplete` clears the target; the same order after
 * the coupon is worth `postDiscount`, and `shippingHeadroom` is how much shipping may be added on top
 * before the discounted TOTAL creeps back over the target and the case stops discriminating.
 */
export function discountBand(spec = MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE, product = UNIT_PRODUCT, rate = DISCOUNT_RATE) {
  const target = Number(spec.goal.value);
  const preDiscount = unitsToComplete(spec, product) * Number(product.listPrice);
  const postDiscount = Number((preDiscount * (1 - rate)).toFixed(2));
  return { target, preDiscount, postDiscount, shippingHeadroom: Number((target - postDiscount).toFixed(2)) };
}

/* ── The reward account ─────────────────────────────────────────────────────
 *
 * NOT provisioned here. It is the per-run ephemeral account seed-loyalty-ephemeral-user.mjs already
 * mints (LOYALTY_ZERO_USER), and this module only declares the BINDING and the invariant that makes
 * it usable. Building a second ephemeral-account provisioner would be a second implementation of a
 * solved problem, and the two would drift.
 */
export const REWARD_USER = {
  aliasName: 'MSN_E2E_REWARD_USER',
  kind: 'rewardUser',
  /** The alias whose per-run account this one borrows. */
  sourceAlias: 'LOYALTY_ZERO_USER',
  /** The mission whose reward must be legible against the balance. */
  rewardAlias: 'MSN_E2E_ORDERVALUE',
  purpose:
    'MSN-E2E-004 asserts that the points it spends were EARNED FROM A MISSION. That is a claim about '
    + 'the RATIO, not the amount: on LOYALTY_VIP_USER (964,189,233 PTS) a 500-PTS grant is 0.00005% of '
    + 'the balance and no arithmetic recovers the thesis. Bound to the per-run zero-balance account so '
    + 'the grant is the balance. Re-checked every run, not provisioned once, because the balance '
    + 'CLIMBS on every completion and there is no write API to bring it back down.',
};

/**
 * Is a mission reward legible against a balance? The reward must at least DOUBLE the balance, i.e.
 * the balance before the grant must be strictly below the reward. Anything weaker and "the balance
 * went up by the reward" stops being distinguishable from ordinary accrual noise.
 */
export const balanceIsLegible = (balance, reward) => Number(balance) < Number(reward);

/* ── Pre-completion: the vacuity invariant ──────────────────────────────────
 *
 * A mission is USABLE by 083d only if the bound account has not already finished it. These are the
 * only progress states that qualify, and the seeder records what it OBSERVED rather than what it
 * intended — a recorded intention would assert itself.
 */
export const PRE_COMPLETION_STATUSES = ['NotStarted', 'InProgress'];
export const MAX_SEED_PROGRESS_PERCENT = 0;

/**
 * Is this observed state a legitimate starting point? `percent` above zero is rejected as well as a
 * Completed status: a mission minted this run that already reports progress means the run handle
 * collided or the seeder silently reused an older mission, and either way the suite is asserting
 * against somebody else's state.
 */
export function isPreCompletion({ status, percent } = {}) {
  if (status != null && !PRE_COMPLETION_STATUSES.includes(String(status))) return false;
  if (percent != null && Number(percent) > MAX_SEED_PROGRESS_PERCENT) return false;
  return true;
}

/* ── Mission body ───────────────────────────────────────────────────────────── */

/**
 * Compose the `POST /api/loyalty-missions` body for a run-scoped spec. Delegates every node to
 * missions-specs.mjs's builders so the body SHAPE has exactly one definition in the repo; the only
 * thing this adds is the run-scoped name. Pure.
 */
export function buildE2EMissionBody(spec, runId, { template, storeId, now = new Date(), currencies } = {}) {
  if (!template) throw new Error('buildE2EMissionBody needs the GET /api/loyalty-missions/new template');
  if (!storeId) throw new Error('buildE2EMissionBody needs a storeId');
  if (!RUN_ID_PATTERN.test(String(runId || ''))) throw new Error(`invalid run id: ${runId}`);
  const tree = template.dynamicExpression;
  const { startDate, endDate } = windowDates(spec.window, now);
  return {
    ...template,
    id: null,
    name: missionName(runId, spec.key),
    storeId,
    status: spec.status,
    public: spec.public,
    periodicity: PROCESSED_PERIODICITY,
    startDate,
    endDate,
    dynamicExpression: {
      ...tree,
      children: [
        { ...blockOf(tree, BLOCK.condition), children: [buildConditionNode(spec, blockOf(tree, BLOCK.condition))] },
        { ...blockOf(tree, BLOCK.goals), children: [buildGoalNode(spec, blockOf(tree, BLOCK.goals), { currencies })] },
        { ...blockOf(tree, BLOCK.reward), children: [buildRewardNode(spec, blockOf(tree, BLOCK.reward))] },
      ],
    },
  };
}

/* ── Shape validation (the drift guard's deterministic core) ─────────────────── */

/**
 * Assert the committed spec set is internally coherent and still DISCRIMINATING. Returns an array of
 * problem strings ([] = clean). Every rule exists because breaking it leaves a fixture that still
 * seeds, still resolves and still passes — while testing nothing.
 */
export function validateSpecShape() {
  const problems = [];
  const push = (m) => problems.push(m);

  // --- identity ---------------------------------------------------------------
  if (!NAME_PREFIX.startsWith(SEED_PREFIX)) push(`NAME_PREFIX "${NAME_PREFIX}" does not start with ${SEED_PREFIX} — teardown would not sweep it`);
  if (!PRODUCT_PREFIX.startsWith(SEED_PREFIX)) push(`PRODUCT_PREFIX "${PRODUCT_PREFIX}" does not start with ${SEED_PREFIX}`);
  const sample = missionName(newRunId(new Date(0), 0), 'X');
  if (!isE2EMissionName(sample)) push(`missionName() produces "${sample}", which isE2EMissionName() does not recognise — teardown would never match this run's own missions`);

  // --- missions ---------------------------------------------------------------
  if (!MISSIONS.length) push('MISSIONS is empty');
  const aliases = new Set();
  const keys = new Set();
  for (const m of ALL_MISSIONS) {
    if (aliases.has(m.aliasName)) push(`duplicate mission alias ${m.aliasName}`);
    aliases.add(m.aliasName);
    if (keys.has(m.key)) push(`duplicate mission key ${m.key}`);
    keys.add(m.key);
    if (!WINDOWS[m.window]) push(`${m.aliasName}: unknown window intent "${m.window}"`);
    // Every E2E mission must be REACHABLE by the customer: a Draft or non-public mission never
    // reaches loyaltyMissionProgress, so a loop case would assert against a card that is not there.
    if (m.status !== 'Published') push(`${m.aliasName}: status "${m.status}" — an E2E loop fixture must be Published or the storefront never sees it`);
    if (m.public !== true) push(`${m.aliasName}: public=${m.public} — a non-public mission is filtered out of the customer-facing query, so the loop is unobservable`);
    if (WINDOWS[m.window]?.expectOpen !== true) push(`${m.aliasName}: window "${m.window}" is not expected to be open — a closed mission cannot accrue`);
    // Targeting must be NEUTRAL. The reward account is a freshly minted ephemeral user with no group
    // membership at all, so any UserGroupIsCondition would make the mission invisible to exactly the
    // account MSN-E2E-004 needs — and invisibly so: the case would report "no such mission".
    if ((m.condition?.type || 'AnyUserGroupCondition') !== 'AnyUserGroupCondition') {
      push(`${m.aliasName}: condition "${m.condition?.type}" — the per-run reward account belongs to no group, so a targeted mission would be invisible to it`);
    }
    // A zero reward makes "the reward landed" unfalsifiable.
    if (!(Number(m.reward) > 0)) push(`${m.aliasName}: reward=${m.reward} — a loop case asserts that points LAND, which a zero reward cannot show`);
    if (!Array.isArray(m.cases) || !m.cases.length) push(`${m.aliasName}: declares no cases[] — a fixture nothing consumes is dead weight nobody will notice`);
  }

  // --- goal shapes ------------------------------------------------------------
  const ov = MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE;
  if (!ov) push('MSN_E2E_ORDERVALUE is missing — five of the eight cases bind to it');
  else {
    if (ov.goal.type !== 'OrderValueGoal') push(`MSN_E2E_ORDERVALUE goal is ${ov.goal.type}, expected OrderValueGoal`);
    if (!(Number(ov.goal.value) > 0)) push(`MSN_E2E_ORDERVALUE target is ${ov.goal.value} — a zero target auto-completes and there is no loop to watch`);
    if (!ov.goal.currency) push('MSN_E2E_ORDERVALUE declares no currency intent — OrderValueGoal.currencyCode is rejected as null/"" at save');
    // COMPOSABILITY: the target must be reachable by whole units of the denomination product, and
    // reachable CHEAPLY. A target that needs 40 stepper presses is a case nobody re-runs.
    const target = Number(ov.goal.value);
    const unit = Number(UNIT_PRODUCT.listPrice);
    if (target % unit !== 0) {
      push(`MSN_E2E_ORDERVALUE target ${target} is not a whole multiple of the ${unit} unit price — no quantity lands exactly on the target, so "just below" and "exactly at" collapse into one observation`);
    }
    const units = unitsToComplete(ov, UNIT_PRODUCT);
    if (units < 2) push(`MSN_E2E_ORDERVALUE completes in ${units} unit(s) — at one unit there is no quantity that falls SHORT, so MSN-E2E-003 has no below-target order to place`);
    if (units > 20) push(`MSN_E2E_ORDERVALUE needs ${units} units to complete — too many for a storefront stepper to drive reliably; lower the target or raise the unit price`);
    // DISCOUNT BAND: MSN-E2E-005 only discriminates while the discounted total stays below the target.
    const band = discountBand(ov, UNIT_PRODUCT);
    if (!(band.shippingHeadroom > 0)) {
      push(`MSN-E2E-005 has no discount band: a ${DISCOUNT_RATE * 100}% coupon takes the completing order to ${band.postDiscount}, which is not below the ${band.target} target — the case cannot show a fall-back`);
    } else if (band.shippingHeadroom < unit) {
      push(`MSN-E2E-005's shipping headroom is ${band.shippingHeadroom}, below one unit (${unit}) — any shipping charge pushes the discounted total back over the target and the case silently stops discriminating`);
    }
  }

  const oc = MISSION_BY_ALIAS.MSN_E2E_ORDERCOUNT;
  if (!oc) push('MSN_E2E_ORDERCOUNT is missing — MSN-E2E-001 binds to it');
  else if (Number(oc.goal.count) < 2) {
    push(`MSN_E2E_ORDERCOUNT target is ${oc.goal.count} — at 1, "counts orders" and "fires on any order" are the same observation and there is no intermediate state to assert`);
  }

  // --- PerSku pairing ---------------------------------------------------------
  const persku = MISSION_BY_ALIAS.MSN_E2E_PERSKU;
  const perskuPts = MISSION_BY_ALIAS.MSN_E2E_PERSKU_PTS;
  if (!persku) push('MSN_E2E_PERSKU is missing — MSN-E2E-002 binds to it');
  else {
    if (persku.goal.all !== true) push('MSN_E2E_PERSKU must be all=true — it is the ALL-semantics subject');
    if (missionSlots(persku).length < 2) {
      push(`MSN_E2E_PERSKU targets ${missionSlots(persku).length} slot(s) — with fewer than two, all=true and all=false are the same mission and the modal has one row`);
    }
  }
  if (!perskuPts) push('MSN_E2E_PERSKU_PTS is missing — MSN-E2E-007 binds to it');
  else {
    if (missionSlots(perskuPts).length !== 1) push(`MSN_E2E_PERSKU_PTS targets ${missionSlots(perskuPts).length} slots — the currency observation must not be diluted by a second, default-currency row`);
    if (!missionSlots(perskuPts).includes(PTS_PRODUCT.slot)) push(`MSN_E2E_PERSKU_PTS does not target the PTS-priced product (slot ${PTS_PRODUCT.slot}) — without it the case asks nothing about currency`);
    if (perskuPts.goal.all !== false) push('MSN_E2E_PERSKU_PTS must be all=false — with a single target, all=true adds a semantics variable the case is not asking about');
  }

  // --- products ---------------------------------------------------------------
  const slots = new Set();
  const skus = new Set();
  for (const p of PRODUCTS) {
    if (slots.has(p.slot)) push(`duplicate product slot ${p.slot}`);
    slots.add(p.slot);
    if (skus.has(p.sku)) push(`duplicate product sku ${p.sku}`);
    skus.add(p.sku);
    if (!p.sku.startsWith(SEED_PREFIX)) push(`${p.aliasName}: sku "${p.sku}" lacks the ${SEED_PREFIX} prefix — teardown would not sweep it`);
    // GAP 3: pack size is the fixture property that makes a stepper step reachable.
    if (Number(p.packSize) !== 1) {
      push(`${p.aliasName}: packSize=${p.packSize} — a pack size above 1 makes the stepper jump (MSN_PERSKU_PRODUCT_B steps 0 -> 2 -> 0), so "set the quantity to exactly 1" is unachievable`);
    }
    if (!(Number(p.listPrice) > 0)) push(`${p.aliasName}: listPrice=${p.listPrice} — an unpriced product renders as a broken row, which reads as a different defect`);
    if (p.goalQuantity != null && Number(p.goalQuantity) % Number(p.packSize) !== 0) {
      push(`${p.aliasName}: goal quantity ${p.goalQuantity} is not a whole multiple of pack size ${p.packSize} — the target can never be hit exactly`);
    }
  }
  // Every slot a mission targets must exist as a product, and every PerSku product must be targeted.
  const targeted = new Set(MISSIONS.flatMap(missionSlots));
  for (const slot of targeted) if (!PRODUCT_BY_SLOT[slot]) push(`mission slot ${slot} has no declared product`);
  for (const p of [...PERSKU_PRODUCTS, PTS_PRODUCT]) {
    if (!targeted.has(p.slot)) push(`${p.aliasName} (slot ${p.slot}) is targeted by no mission — a goal-item product nothing points at is never bought`);
  }
  // The PTS product's whole point is a currency DIFFERENT from the one the value goal is measured in.
  if (PTS_PRODUCT.currencyIntent === UNIT_PRODUCT.currencyIntent) {
    push(`the PTS target and the denomination product share the currency intent "${PTS_PRODUCT.currencyIntent}" — MSN-E2E-007 asks whether a NON-default-currency line counts, and cannot ask it in the default currency`);
  }

  // --- reward account ---------------------------------------------------------
  if (!MISSION_BY_ALIAS[REWARD_USER.rewardAlias]) push(`REWARD_USER.rewardAlias "${REWARD_USER.rewardAlias}" is not a declared mission`);
  if (!REWARD_USER.sourceAlias) push('REWARD_USER declares no sourceAlias — the account has to come from somewhere');

  // --- per-case missions + accounts -------------------------------------------
  //
  // These rules are the SECOND RULE applied to the split. Each one, broken, leaves a fixture set that
  // still seeds, still resolves and still reports green while the cases on it contend or decide
  // nothing.
  const caseIds = new Set();
  const accountAliases = new Set();
  const rewards = new Map();
  for (const m of ALL_MISSIONS) {
    // DIVERGENT REWARDS. Four missions sharing a reward are indistinguishable in a balance delta or a
    // points-history row, so "the grant came from THIS mission" stops being falsifiable. This is the
    // same divergence requirement as td:validate:variation-stock's "the quantities must differ".
    if (rewards.has(m.reward)) push(`${m.aliasName} and ${rewards.get(m.reward)} both reward ${m.reward} PTS — a grant from either is indistinguishable in a balance delta or a points-history row, so no case on them can attribute what it observed`);
    else rewards.set(m.reward, m.aliasName);
  }
  for (const m of CASE_MISSIONS) {
    if (m.goal?.value != null) {
      push(`${m.aliasName}: goal.value is authored as ${m.goal.value} — a per-case target is DERIVED from a live probe cart at seed time (a modelled target was 8.00 out against the platform's real 20% tax, four times the band it was meant to discriminate inside)`);
    }
    if (m.goal?.type !== 'OrderValueGoal') push(`${m.aliasName}: goal type ${m.goal?.type} — the per-case split exists for OrderValueGoal sizing`);
    if (!m.goal?.currency) push(`${m.aliasName}: declares no currency intent — OrderValueGoal.currencyCode is rejected as null/"" at save`);
    if (!TARGET_RULES[m.targetRule]) push(`${m.aliasName}: unknown targetRule "${m.targetRule}"`);
    if (!(Number(m.order?.units) > 0)) push(`${m.aliasName}: order.units=${m.order?.units} — the seeder has no cart to measure`);
    if (Number(m.order?.units) > 20) push(`${m.aliasName}: order.units=${m.order.units} is more than a storefront quantity control is worth driving`);

    // A coupon is required by exactly one rule and meaningless to the others; a stray one would
    // silently change the measured money the target is placed against.
    const wantsCoupon = m.targetRule === TARGET_RULES.discountedVsUndiscounted;
    if (wantsCoupon && !m.order?.coupon) push(`${m.aliasName}: the discountedVsUndiscounted rule needs order.coupon — without it both measurements are the same cart and the target has no band`);
    if (!wantsCoupon && m.order?.coupon) push(`${m.aliasName}: declares order.coupon "${m.order.coupon}" but its "${m.targetRule}" rule does not use one — the coupon would change the measured money the target is placed against`);

    if (caseIds.has(m.caseId)) push(`two per-case missions claim ${m.caseId}`);
    caseIds.add(m.caseId);
    if (accountAliases.has(m.accountAlias)) push(`${m.aliasName} shares account alias ${m.accountAlias} with another case — a shared account is the contention this split exists to remove, since one order advances EVERY mission applicable to its user`);
    accountAliases.add(m.accountAlias);
    if (!CASE_ACCOUNT_BY_ALIAS[m.accountAlias]) push(`${m.aliasName}: account alias ${m.accountAlias} is not declared in CASE_ACCOUNTS`);

    // STATE THE LIMITS. `.claude/rules/test-data.md` SECOND RULE: a fixture whose limits are not
    // written down lets a green case imply an answer it cannot give.
    if (!String(m.decides || '').trim()) push(`${m.aliasName}: declares no \`decides\` — a fixture that does not say which question its data makes decidable cannot be reviewed for whether it does`);
    if (!String(m.limits || '').trim()) push(`${m.aliasName}: declares no \`limits\` — every one of these missions has a distinction it CANNOT make, and an unstated limit is how a green case comes to imply an answer it never tested`);
  }

  // ATTRIBUTION, at the spec level: MSN-E2E-008's order must be the smallest, or its own order
  // completes a sibling mission and the reward delta it asserts on stops being attributable. The
  // measured form of this check runs in the seeder (attributionProblems); this one catches the
  // authoring mistake before anything is provisioned.
  const attributed = CASE_MISSIONS.find((m) => m.caseId === 'MSN-E2E-008');
  if (attributed) {
    for (const other of CASE_MISSIONS) {
      if (other.aliasName === attributed.aliasName) continue;
      if (Number(attributed.order.units) >= Number(other.order.units)) {
        push(
          `${attributed.aliasName} orders ${attributed.order.units} units, not fewer than ${other.aliasName}'s `
          + `${other.order.units} — MSN-E2E-008 asserts on a balance delta, so its order must complete its own `
          + 'mission and no sibling. Give it the smallest cart in the set.',
        );
      }
    }
  }

  for (const a of CASE_ACCOUNTS) {
    if (!a.aliasName.startsWith('MSN_E2E_USER_')) push(`${a.aliasName}: a per-case account alias should be MSN_E2E_USER_<case>`);
    if (!CASE_MISSION_BY_ALIAS[a.missionAlias]) push(`${a.aliasName}: missionAlias ${a.missionAlias} is not a per-case mission`);
  }
  if (!CASE_ACCOUNT_PREFIX.startsWith(SEED_PREFIX)) push(`CASE_ACCOUNT_PREFIX "${CASE_ACCOUNT_PREFIX}" does not start with ${SEED_PREFIX} — teardown would not sweep the per-case accounts`);
  // The per-case accounts must NOT fall inside the ephemeral-user seeder's own sweep namespace, or
  // `npm run seed:loyalty:zero-user:teardown` would delete them mid-run.
  if (CASE_ACCOUNT_PREFIX.startsWith('AGENT-TEST-loyzero-')) push(`CASE_ACCOUNT_PREFIX collides with seed-loyalty-ephemeral-user.mjs's sweep namespace — that seeder's teardown would delete the per-case accounts underneath a running suite`);

  return problems;
}

/**
 * The OVERLAY vacuity guard, and the check whose absence produced the 6-BLOCKED run. Pure: it judges
 * the state the last seed RECORDED, so it runs offline and still answers "was the data this suite ran
 * against actually usable?".
 *
 * `overlay` is the parsed aliases.<env>.json. Returns problem strings ([] = clean). An overlay with no
 * E2E entries at all is reported as UNSEEDED (one problem), not as clean — silence is never a pass.
 */
export function validateSeededState(overlay, { now = new Date(), maxAgeHours = null } = {}) {
  const problems = [];
  const o = overlay || {};
  const run = o.MSN_E2E_RUN || {};
  const runId = String(run.run_id || '');

  if (!runId) {
    return [
      'MSN_E2E_RUN.run_id is empty in the overlay — suite 083d has never been seeded on this env, so every '
      + 'case would resolve its mission to "" and read as a product failure. Run `npm run seed:missions-e2e`.',
    ];
  }
  if (!RUN_ID_PATTERN.test(runId)) problems.push(`MSN_E2E_RUN.run_id "${runId}" does not parse as a run handle — teardown cannot age it and the sweep floor is inoperative`);

  const age = runIdAgeHours(runId, now);
  if (maxAgeHours != null && age != null && age > maxAgeHours) {
    problems.push(`the seeded run is ${age.toFixed(1)}h old (limit ${maxAgeHours}h) — 083d's missions are minted per run, so a stale run means the suite is about to assert against progress a previous execution already consumed`);
  }

  for (const spec of ALL_MISSIONS) {
    const a = o[spec.aliasName];
    if (!a) { problems.push(`${spec.aliasName}: absent from the overlay — cases ${spec.cases.join(', ')} would resolve to nothing`); continue; }
    if (!a.id) problems.push(`${spec.aliasName}.id is empty — the mission was not created`);
    if (!a.name) problems.push(`${spec.aliasName}.name is empty — the storefront card is matched by name`);
    // RUN-SCOPING. This is the check that catches the seeder silently falling back to a reused
    // mission: the name must carry THIS run's handle, not some earlier one.
    if (a.name && !isE2EMissionName(a.name)) {
      problems.push(`${spec.aliasName}.name "${a.name}" is not a run-scoped E2E mission name — the fixture is not per-run, so its progress carries over between executions`);
    }
    if (a.name && runIdFromName(a.name) !== runId) {
      problems.push(`${spec.aliasName}.name carries run "${runIdFromName(a.name)}" but MSN_E2E_RUN.run_id is "${runId}" — the alias set is a mix of two runs, so some cases would assert against already-consumed progress`);
    }
    // VACUITY. The observed seed-time state must be pre-completion.
    const status = a.progress_status_at_seed;
    const percent = a.progress_percent_at_seed;
    if (status === '' || status == null) {
      problems.push(`${spec.aliasName}: no progress_status_at_seed was recorded — the seeder did not verify the fixture was usable, which is exactly the omission that let run REG-2026-08-28-1154 execute against six already-Completed missions`);
    } else if (!isPreCompletion({ status, percent })) {
      problems.push(
        `${spec.aliasName} was already at ${status} ${percent}% when it was seeded — cases ${spec.cases.join(', ')} `
        + 'cannot watch progress advance on a mission that has already finished, and a Completed mission stops accruing entirely.',
      );
    }
  }

  /* ── The per-case split, checked against what the seed actually recorded ──────
   *
   * Everything here asks whether the split DID ITS JOB, not whether it is present. A per-case mission
   * that seeded fine but sits on the same account as its sibling, or whose target no longer separates
   * anything, still resolves and still renders — and the case on it is back to reporting a coincidence.
   */
  const seenAccounts = new Map();
  const derivedByAlias = {};
  const orderTotalByAlias = {};
  for (const spec of CASE_MISSIONS) {
    const a = o[spec.aliasName] || {};
    const acct = o[spec.accountAlias];

    // [a] A DERIVED, non-empty target. Empty means the probe cart never ran and the mission was minted
    //     against nothing.
    const target = Number(a.goal_target);
    if (a.goal_target === '' || a.goal_target == null) {
      problems.push(`${spec.aliasName}.goal_target is empty — its target is derived from a live probe cart, so an empty one means the measurement never happened and the mission was minted against a number nobody computed`);
    } else if (!(target > 0)) {
      problems.push(`${spec.aliasName}.goal_target = ${a.goal_target} — a zero or negative target auto-completes and ${spec.caseId} has no loop to watch`);
    }
    derivedByAlias[spec.aliasName] = { target };

    // [b] THE BAND IS REAL. The two quantities the target separates must both be recorded and must
    //     straddle it by the declared floor. This is the check that fails when a fixture quietly stops
    //     discriminating — the failure mode `.claude/rules/test-data.md` SECOND RULE is about.
    const above = Number(a.separates_above);
    const below = Number(a.separates_below);
    const margin = Number(a.separation_margin);
    if (a.separates_above === '' || a.separates_above == null || a.separates_below === '' || a.separates_below == null) {
      problems.push(`${spec.aliasName}: the seed recorded no separates_above/separates_below — nothing says what this target was placed BETWEEN, so whether ${spec.caseId} can discriminate at all is unknown`);
    } else if (Number.isFinite(above) && Number.isFinite(below) && Number.isFinite(target)) {
      if (!(below < target && target <= above)) {
        problems.push(
          `${spec.aliasName}: target ${target} does not sit between ${below} and ${above} — the two readings `
          + `${spec.caseId} exists to tell apart now fall on the SAME side of it, so the case reports the same `
          + 'result whichever one the platform implements.',
        );
      }
      if (Number.isFinite(margin) && margin < MIN_TARGET_SEPARATION) {
        problems.push(`${spec.aliasName}: only ${margin} separates target ${target} from the nearer of ${below}/${above}, under the ${MIN_TARGET_SEPARATION} floor — a band that narrow is indistinguishable from a rounding rule`);
      }
    }

    // [c] The measured cart must be COHERENT and must be the cart the case will place.
    //
    // An UNRECORDED field is checked as an empty string, not coerced: `Number('')` is 0, which is
    // perfectly finite, so a missing measurement would otherwise read as a free and coherent zero and
    // sail through every check below it.
    const MEASURED_FIELDS = ['measured_subtotal', 'measured_discount', 'measured_tax', 'measured_shipping', 'measured_total'];
    const unrecorded = MEASURED_FIELDS.filter((f) => a[f] === '' || a[f] == null);
    const money = {
      grossMerchandise: Number(a.measured_subtotal),
      discountTotal: Number(a.measured_discount),
      netMerchandise: Number(a.measured_subtotal) - Number(a.measured_discount),
      shippingTotal: Number(a.measured_shipping),
      taxTotal: Number(a.measured_tax),
      orderTotal: Number(a.measured_total),
      pointsLineValue: 0,
      totalPlusPoints: Number(a.measured_total),
    };
    if (!unrecorded.length && Object.values(money).every((v) => Number.isFinite(v))) {
      const bad = moneyIncoherence(money);
      if (bad) problems.push(`${spec.aliasName}: ${bad}`);
      orderTotalByAlias[spec.aliasName] = money.orderTotal;
    } else {
      const which = unrecorded.length ? unrecorded.join(', ') : 'subtotal/discount/tax/shipping/total';
      problems.push(`${spec.aliasName}: the seed recorded no measured cart (${which}) — every number ${spec.caseId} composes its order from would be a guess`);
    }

    // [d] A coupon-driven mission must have actually been discounted when measured.
    if (spec.order.coupon) {
      if (!(Number(a.measured_discount) > 0)) {
        problems.push(`${spec.aliasName}: measured_discount is ${a.measured_discount} — the ${spec.order.coupon} coupon did not apply on the probe cart, so ${spec.caseId} would place an undiscounted order and assert a discount effect that never happened`);
      }
      const undiscounted = Number(a.measured_total_undiscounted);
      if (!Number.isFinite(undiscounted) || !(undiscounted > Number(a.measured_total))) {
        problems.push(`${spec.aliasName}: measured_total_undiscounted (${a.measured_total_undiscounted}) is not above measured_total (${a.measured_total}) — the counterfactual "the same order without the coupon WOULD have completed" was never measured, so ${spec.caseId} cannot claim it`);
      }
    }

    // [e] PER-CASE ACCOUNT, and it must be genuinely its own. A shared account is the whole defect.
    if (!acct) {
      problems.push(`${spec.accountAlias}: absent from the overlay — ${spec.caseId} has no dedicated account, so its order would advance every sibling mission on whatever account it falls back to (run \`npm run seed:missions-e2e\`)`);
    } else {
      if (!acct.email) problems.push(`${spec.accountAlias}.email is empty — ${spec.caseId} cannot sign in`);
      if (!acct.user_id) problems.push(`${spec.accountAlias}.user_id is empty — progress is keyed on the security-account id, so nothing can verify this case's own row`);
      if (acct.email && !String(acct.email).startsWith(CASE_ACCOUNT_PREFIX)) {
        problems.push(`${spec.accountAlias}.email "${acct.email}" is outside the ${CASE_ACCOUNT_PREFIX} sweep namespace — teardown would leak it, and it may not be a per-run account at all`);
      }
      if (acct.email && seenAccounts.has(acct.email)) {
        problems.push(
          `${spec.accountAlias} and ${seenAccounts.get(acct.email)} resolve to the SAME account (${acct.email}). `
          + 'One order advances every mission applicable to its user, so these two cases would consume each '
          + 'other\'s progress — which is exactly the contention the per-case split exists to remove.',
        );
      } else if (acct.email) seenAccounts.set(acct.email, spec.accountAlias);
    }
  }

  // [f] ATTRIBUTION, against the measured order totals. MSN-E2E-008's own order must complete its own
  //     mission and no sibling, or the balance delta it asserts on names nothing.
  if (Object.keys(orderTotalByAlias).length === CASE_MISSIONS.length) {
    for (const spec of ALL_MISSIONS) {
      if (derivedByAlias[spec.aliasName]) continue;
      if (spec.goal?.type === 'OrderValueGoal') derivedByAlias[spec.aliasName] = { target: Number(spec.goal.value) };
    }
    for (const m of attributionProblems(derivedByAlias, orderTotalByAlias)) problems.push(m);
  }

  for (const p of PRODUCTS) {
    const a = o[p.aliasName];
    if (!a) { problems.push(`${p.aliasName}: absent from the overlay — the product was never resolved`); continue; }
    if (!a.productId) problems.push(`${p.aliasName}.productId is empty — the fixture product does not exist on this env`);
    if (!a.currency) problems.push(`${p.aliasName}.currency is empty — the resolved price currency was never recorded, so no case can tell which currency the line settles in`);
    // The PDP path must come from the storefront's own product resolver, not from string composition.
    // `/product/<sku>` and a flat `/<sku>` both render a client-side 404 behind HTTP 200 on this
    // storefront — a soft-404 no status check can see — so a composed url sends the case to a blank
    // page it will report as a product bug.
    if (!a.slug) problems.push(`${p.aliasName}.slug is empty — the storefront path was never resolved, so any PDP navigation in 083d is a guess`);
    if (!a.url) problems.push(`${p.aliasName}.url is empty — cases navigate {{FRONT_URL}}@td(${p.aliasName}.url)`);
    if (a.slug && a.url && a.url !== `/${String(a.slug).replace(/^\/+/, '')}`) {
      problems.push(`${p.aliasName}.url "${a.url}" does not match its resolved slug "${a.slug}" — one of the two was composed by hand and will 404`);
    }
  }
  const ptsOverlay = o[PTS_PRODUCT.aliasName] || {};
  const unitOverlay = o[UNIT_PRODUCT.aliasName] || {};
  if (ptsOverlay.currency && unitOverlay.currency && ptsOverlay.currency === unitOverlay.currency) {
    problems.push(
      `${PTS_PRODUCT.aliasName} resolved to the same currency as ${UNIT_PRODUCT.aliasName} (${ptsOverlay.currency}) — `
      + 'MSN-E2E-007 asks whether a LOYALTY-currency line counts toward a quantity target, and both products now settle in the same currency, so it asks nothing.',
    );
  }

  // LEGIBILITY. The reward account's balance must stay below the reward it is about to be granted.
  const ru = o[REWARD_USER.aliasName];
  const reward = Number(MISSION_BY_ALIAS[REWARD_USER.rewardAlias]?.reward);
  if (!ru) {
    problems.push(`${REWARD_USER.aliasName}: absent from the overlay — MSN-E2E-004 has no low-balance account and would run against whatever balance the session happens to carry`);
  } else {
    if (!ru.email) problems.push(`${REWARD_USER.aliasName}.email is empty — the per-run zero-balance account was not provisioned (run \`npm run seed:loyalty:zero-user\`)`);
    if (ru.balance_at_seed === '' || ru.balance_at_seed == null) {
      problems.push(`${REWARD_USER.aliasName}: no balance_at_seed was recorded — the legibility of the reward was never checked`);
    } else if (!balanceIsLegible(ru.balance_at_seed, reward)) {
      problems.push(
        `${REWARD_USER.aliasName} held ${ru.balance_at_seed} PTS at seed time against a ${reward} PTS reward — `
        + 'MSN-E2E-004 asserts the points it spends were EARNED FROM THE MISSION, and a grant that does not at '
        + 'least double the balance cannot demonstrate that. The balance climbs on every completion and there is '
        + 'no write API to lower it, so the fix is a fresh ephemeral account: `npm run seed:loyalty:zero-user`.',
      );
    }
  }

  return problems;
}

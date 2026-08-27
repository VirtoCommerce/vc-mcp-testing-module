/**
 * scripts/seed-data/loyalty/missions-specs.mjs
 *
 * SINGLE SOURCE OF TRUTH for the VCST-5319 "Loyalty Missions" fixture set. Side-effect-free — no env
 * load, no network, no fs, no main() — so the seeder (seed-loyalty-missions.mjs), the drift guard
 * (validate-missions-data.mjs) and the unit tests all import the SAME rules.
 *
 * WHAT THIS FIXTURE SET IS FOR
 * ----------------------------
 * `VirtoCommerce.Loyalty` gained a Missions feature: a store-scoped, date-windowed, goal-and-reward
 * entity that grants loyalty points when a customer's orders satisfy its goal. Almost every case in
 * the ticket needs a mission that DIFFERS from the happy path in exactly one respect, and most of
 * those differences are the kind that pass silently when they rot:
 *
 *   - MSN_PUBLISHED_PRIVATE is the ticket's highest-priority condition (C17): a Published mission with
 *     `public=false` must not reach the customer-facing query. If someone "fixes" it to public=true
 *     the case still runs, still passes, and proves nothing — so the guard asserts public===false.
 *   - MSN_PERSKU_ALL / MSN_PERSKU_ANY only mean something AS A PAIR. Equal `all` flags make the
 *     ALL-vs-ANY distinction unfalsifiable, so the guard asserts the two DIVERGE.
 *   - MSN_ZEROTARGET (target 0) and MSN_ZEROREWARD (reward 0) are boundary fixtures whose whole value
 *     is the zero. A well-meaning edit to a "sensible" number destroys them without breaking anything.
 *
 * SHAPES VERIFIED LIVE ON vcst-qa AGAINST BUILD 3.1006.0-pr-14-1be7 (2026-08-27)
 * ------------------------------------------------------------------------------
 * `GET /api/loyalty-missions/new` returns a LoyaltyMission whose `dynamicExpression` is a
 * `LoyaltyMissionConditionAndRewardTree` carrying exactly three blocks in `children[]`:
 *   BlockLoyaltyMissionCondition  availableChildren: UserGroupIsCondition{groups:string[]}, AnyUserGroupCondition
 *   BlockLoyaltyMissionGoals      availableChildren: OrderValueGoal{value,currencyCode}, OrderCountGoal{count}, PerSkuGoal{all}
 *   BlockLoyaltyReward            availableChildren: FixedAmountReward{amount}
 *
 * Server-side validators observed (all HTTP 400 with a FluentValidation body):
 *   "Mission name is required" · "Mission store is required" ·
 *   "Mission must have at least one condition" · "Mission must have exactly one goal" ·
 *   "Mission must have at least one reward"
 * So a mission body MUST carry one condition, exactly one goal and at least one reward. That is why
 * every spec below declares a condition even when the case does not care about targeting — an
 * `AnyUserGroupCondition` is the neutral choice, not an omission.
 *
 * THREE LIVE FINDINGS THAT SHAPE THIS MODULE — read before "simplifying" it
 * ------------------------------------------------------------------------
 * 1. PerSku SKU TARGETS ARE NOT PART OF THE MISSION BODY. `PerSkuGoal` serializes as `{all,
 *    missionType, id, availableChildren, children}` and NOTHING else: an `items`/`goalItems`/
 *    `products` array posted inside it is silently DROPPED (probed with all three names — none
 *    round-tripped). The SKU targets are a separate entity, `LoyaltyMissionGoalItem`
 *    {missionId, productId, quantity}, written through `/api/loyalty-mission-goal-items` and joined
 *    back by `missionId`. A seeder that only POSTs the mission produces a PerSku mission with zero
 *    targets — structurally valid, permanently uncompletable, and green on every "does it exist" check.
 * 2. A PUBLISHED MISSION IS IMMUTABLE AND CANNOT BE UN-PUBLISHED. `EnsureMutableAsync` rejects every
 *    edit to a Published mission except the single transition Published -> Archived (and rejects
 *    everything on an Archived one), so there is no "repair in place" path. Idempotency therefore
 *    compares a STRUCTURAL SIGNATURE and, on any drift, DELETEs and recreates — DELETE is allowed at
 *    every status, which is what makes that safe.
 * 3. A MISSION CAN BE CREATED DIRECTLY AS Published. No Draft->Published PUT dance is needed, which
 *    matters because that PUT would be the only mutable moment and would make the seeder order-dependent.
 *
 * NAMING: every mission is `AGENT-TEST-MSN-<KEY>` so `/qa-seed-data teardown` sweeps exactly these.
 * RUNTIME IDS: mission GUIDs, goal-item GUIDs and the discovered product ids/SKUs are server- or
 * env-determined and live ONLY in aliases.<env>.json — never in a committed file.
 */

/** Everything disposable this seeder creates carries this prefix. */
export const SEED_PREFIX = 'AGENT-TEST';

/** Mission display names are `${NAME_PREFIX}-${key}` — the business key the seeder looks missions up by. */
export const NAME_PREFIX = 'AGENT-TEST-MSN';

/**
 * Fields whose values are server-assigned or per-env. They MUST be empty in the committed
 * `test-data/aliases.json` and are written per-env into `aliases.<env>.json` instead.
 *
 * KEYED BY ALIAS KIND, NOT FLATTENED INTO ONE LIST — and that is not tidiness. `name` is runtime on a
 * PerSku product (we merely FOUND it, so nothing about it is invariant) and is the BUSINESS KEY on a
 * mission (we author it, and the seeder looks the mission up by it). A single union list therefore
 * declares every mission name a policy violation, which is exactly what the first version of the drift
 * guard reported: eight false failures demanding that the fixtures' own identifiers be blanked. The
 * question "is this field runtime?" only has an answer relative to the alias it sits on.
 */
export const RUNTIME_FIELDS_BY_KIND = {
  // `banner_url` is the URL the platform asset store hands back — an ABSOLUTE, host-bearing address
  // (`https://<env-host>/cms-content/assets/…`), so it is per-env in exactly the way a GUID is. The
  // authored half is `banner_key`, which names WHICH artwork the mission carries and is invariant.
  mission: ['id', 'banner_url'],
  perSkuProduct: ['productId', 'sku', 'name', 'catalogId'],
  storeSetting: ['store_id', 'missions_enabled', 'base_loyalty_enabled'],
};

/** The store-settings fixture. The seeder flips ONLY `missionsSetting`; `baseSetting` is read and reported. */
export const STORE_SETTING = {
  aliasName: 'MSN_STORE_SETTINGS',
  /** The gate under test. Boolean, group `Loyalty|Missions`, platform default false, IsPublic=true. */
  missionsSetting: 'Loyalty.Missions.Enable',
  missionsGroup: 'Loyalty|Missions',
  /**
   * The BASE loyalty switch. Deliberately READ-ONLY for this seeder: suites 075/075b/075c depend on
   * it via LOYALTY_SETTINGS, and flipping it here would break them from a mission run. The seeder
   * records its observed value into the overlay so a "base loyalty OFF + missions ON" case knows what
   * it is starting from instead of assuming.
   */
  baseSetting: 'Loyalty.Enable',
  valueType: 'Boolean',
  platformDefault: false,
  /**
   * VERIFIED FROM SOURCE (vc-module-loyalty PR #14, head 1be73b4): the two settings are INDEPENDENT.
   * `MissionsEnable` is read at exactly two sites — `LoyaltyMissionLogicService.ProcessOrderAsync`
   * (accrual) and `.GetUserMissionsAsync` (read) — and NEITHER also checks `General.Enable`; no caller
   * up either chain checks it, and the reward write (`LoyaltyLogicService`) reads no settings at all.
   * `Loyalty.Enable` is read only by `LoyaltyPointsCalculator` and `LoyaltySettingService`, neither on
   * a mission path. So `Loyalty.Enable=false` + `Loyalty.Missions.Enable=true` is a REAL, supported
   * combination in which missions still accrue, still return to the storefront, and still pay out.
   * That makes the "base loyalty OFF + missions ON" case meaningful rather than nonsensical — but it
   * is also NOT the state this seeder leaves behind (it never touches the base setting), so a case
   * that wants it must flip `Loyalty.Enable` itself and restore it.
   */
  gatingVerdict: 'independent',
};

/**
 * Targeting surface, VERIFIED live (`GET /api/loyalty-missions/new`) AND from source
 * (`LoyaltyMissionConditionAndRewardTreePrototype`, which is what that endpoint serves and the only
 * thing `Module.cs` registers types from — so nothing outside it can ever appear in a mission tree).
 *
 * Group targeting EXISTS: `UserGroupIsCondition { groups: string[] }`. Customer-ID targeting is
 * ABSENT — there is no `CustomerIsCondition` / `UserIsCondition` / `CustomerIds` anywhere in the
 * module. A single-customer mission is therefore not expressible; the customer must be put in a group.
 * Recorded here so a test author reads the real surface instead of assuming a field that never existed.
 */
export const TARGETING = {
  groupCondition: { id: 'UserGroupIsCondition', field: 'groups', shape: 'string[]' },
  neutralCondition: { id: 'AnyUserGroupCondition' },
  customerIdCondition: null,
};

/** The only periodicity the module actually processes; anything else is untested product surface. */
export const PROCESSED_PERIODICITY = 'None';

/** Statuses the module recognises, and the ONLY transition it permits once a mission leaves Draft. */
export const STATUSES = ['Draft', 'Published', 'Archived'];
export const ALLOWED_TRANSITION = { from: 'Published', to: 'Archived' };

/**
 * The two live-discovered catalog products the PerSku goals target. Nothing is authored here: the
 * seeder resolves real, buyable products off the target env and writes id/sku/name into the overlay.
 * Declared as specs only so the aliases have a stable NAME and the guard can assert the CSV/base file
 * carries no product id.
 */
export const PERSKU_PRODUCTS = [
  { aliasName: 'MSN_PERSKU_PRODUCT_A', slot: 'A', quantity: 2 },
  { aliasName: 'MSN_PERSKU_PRODUCT_B', slot: 'B', quantity: 1 },
];

/**
 * Date-window intents. Kept symbolic rather than as literal dates because a committed literal date
 * silently expires: an "active" fixture whose endDate has passed still exists, still resolves, and
 * turns every mission-completion case into a false negative that reads as a product bug.
 *
 * `expectOpen` is what the intent MEANS, not a derived convenience. The seeder reuses a live fixture
 * only when its window still matches the intent, and "matches" is not "is open": for `expired` an OPEN
 * window is the drift. Without the flag the seeder's expiry check would delete and recreate the expired
 * fixture on every single run, churning its GUID — and every `@td(MSN_EXPIRED.id)` resolved against it.
 */
export const WINDOWS = {
  active: { startOffsetDays: -7, endOffsetDays: 180, expectOpen: true },
  /**
   * A window that CLOSED BEFORE the seed clock. Both offsets are negative and stay negative as the
   * fixture ages, so it can never drift back into being active — unlike a committed literal date,
   * which is expired only until someone "refreshes" it.
   *
   * It exists for exactly one defect: `GetQualifyingMissionsAsync` leaves `OnlyActive` unset, so a
   * mission whose EndDate has passed keeps coming back from `loyaltyMissionProgress`. Every other
   * fixture in this set is `active`, so nothing else in it can tell a window filter that works from
   * one that was never applied.
   *
   * The 30-day gap between endOffsetDays and today is deliberate slack: a fixture that expired
   * "yesterday" would sit close enough to now that a clock skew or a timezone reading could make the
   * window look open and turn the case into a flake that reads as a product bug.
   */
  expired: { startOffsetDays: -365, endOffsetDays: -30, expectOpen: false },
};

/**
 * Does this window intent mean the fixture should currently be inside its window? Pure. Callers must
 * ask this rather than calling `windowIsOpen` directly on a spec — see `WINDOWS.expectOpen`.
 */
export function windowExpectsOpen(window) {
  const w = WINDOWS[window];
  if (!w) throw new Error(`unknown window intent: ${window}`);
  return w.expectOpen === true;
}

/**
 * BANNER ARTWORK — one image per GOAL TYPE, shared by every mission of that type.
 *
 * The storefront mission card (VCST-5346) renders `bannerUrl` full-width at 150px in the card and
 * 170px in the detail modal, `object-fit: cover`. With the field empty or pointing at a path nothing
 * serves, that card renders blank — and a blank card is indistinguishable from a broken one, so the
 * visual result cannot be judged at all. Every mission therefore carries a real, reachable image.
 *
 * WHY THE KEY IS DERIVED FROM THE GOAL, NOT DECLARED PER MISSION. The banner is a property of what the
 * mission ASKS FOR, and the ticket asks for exactly three: money, repeat orders, featured SKUs. A
 * per-mission `banner:` field would be a second place to keep in step with `goal.type` and would drift
 * — a PerSku mission wearing the order-value artwork is wrong and nothing mechanical would object.
 *
 * WHY SVG. No image library is installed (`sharp`/`canvas`/`pngjs`/`jimp` are all absent), so SVG is
 * the one format authorable as text with zero dependencies and zero raster tooling. Verified live on
 * vcst-qa 2026-08-27: `POST /api/assets` accepts `.svg`, stores it, and serves it back 200 with
 * `content-type: image/svg+xml`.
 *
 * The FILE NAME is fixed rather than timestamped, and that is load-bearing: the asset URL derives from
 * it, `bannerUrl` is part of `missionSignature`, and a URL that changed per run would report drift on
 * every seed and delete-and-recreate every mission forever (the same trap `missionSignature` avoids by
 * excluding dates).
 */
export const BANNER_FOLDER = 'agent-test/loyalty-missions';
export const BANNER_CONTENT_TYPE = 'image/svg+xml';
export const BANNERS = {
  'order-value': {
    file: 'msn-banner-order-value.svg',
    goals: ['OrderValueGoal'],
    subject: 'concentric target + value tokens — hit a spend threshold',
  },
  'order-count': {
    file: 'msn-banner-order-count.svg',
    goals: ['OrderCountGoal'],
    subject: 'a rising run of parcels on a progress rail — place N orders',
  },
  'per-sku': {
    file: 'msn-banner-per-sku.svg',
    goals: ['PerSkuGoal'],
    subject: 'a grid of product tiles with two selected — buy these SKUs',
  },
};

/** Source path of a banner, relative to the repo root. Pure. */
export const bannerSourceRel = (key) => `test-data/uploads/${BANNERS[key].file}`;

/** Where the banner lands in platform asset storage. Pure — the URL is whatever the platform returns. */
export const bannerAssetRel = (key) => `${BANNER_FOLDER}/${BANNERS[key].file}`;

/**
 * Which banner a mission carries, derived from its goal. Throws rather than falling back to a default:
 * a new goal type silently inheriting the money artwork is exactly the mismatch nobody would notice.
 */
export function bannerKeyFor(spec) {
  const type = spec?.goal?.type;
  const key = Object.keys(BANNERS).find((k) => BANNERS[k].goals.includes(type));
  if (!key) throw new Error(`no banner declared for goal type ${type} — add one to BANNERS rather than defaulting`);
  return key;
}

/**
 * Currency intents for an OrderValueGoal — symbolic, resolved against the STORE at seed time.
 *
 * THE ORIGINAL PLAN FOR THIS FIELD WAS WRONG, AND THE API SAID SO.
 * `OrderValueGoal.CurrencyCode` is `nullable` in the DTO and in the published Swagger, so the obvious
 * reading is "omit it and the goal accepts any currency". It does not: a save-time validator rejects
 * BOTH null and "" with *"Currency code is required for the order value goal"* (HTTP 400). Verified
 * live on vcst-qa 2026-08-27 — it is what made the first real seed run fail.
 *
 * The validation is also ASYMMETRIC, which is the part worth designing against: presence is enforced,
 * VALIDITY is not. `"XYZ"` (not a currency at all) and lowercase `"usd"` are both accepted and
 * persisted verbatim. So a currency-mismatch defect cannot be caught at save time and has to be caught
 * at accrual time — which is exactly what the ORDERVALUE pair below exists to make possible.
 *
 * Resolved from the store rather than written as a literal because a currency is per-env store
 * configuration (`store.defaultCurrency` / `store.currencies`), so a committed "USD" is the same class
 * of mistake as a committed GUID.
 */
export const CURRENCY_INTENTS = ['store-default', 'store-alternate'];

/**
 * Resolve the two currency intents against a store. Pure — takes the store's own fields, does no I/O.
 * The alternate is the first NON-default code in sorted order, so a re-seed against an unchanged store
 * picks the same one and the overlay stops churning. Throws rather than silently collapsing the pair
 * onto one currency, because two "different-currency" fixtures sharing a currency test nothing.
 */
export function resolveCurrencies({ defaultCurrency, currencies } = {}) {
  const def = String(defaultCurrency || '').trim();
  if (!def) throw new Error('store has no defaultCurrency — cannot resolve an OrderValueGoal currency');
  const others = [...new Set((currencies || []).map((c) => String(c || '').trim()).filter(Boolean))]
    .filter((c) => c.toUpperCase() !== def.toUpperCase())
    .sort();
  if (!others.length) {
    throw new Error(
      `store declares only one currency (${def}); MSN_ORDERVALUE_ALTCURRENCY needs a second one, `
      + 'or the cross-currency pair degenerates into two identical fixtures',
    );
  }
  return { 'store-default': def, 'store-alternate': others[0] };
}

/* ── Localization (C11) ──────────────────────────────────────────────────────── */

/**
 * THE WIRE SHAPE OF A LocalizedString, AND WHY IT IS DECLARED RATHER THAN ASSUMED.
 *
 * `localizedName` and `description` are `LocalizedString`, which serializes as `{ values: { <locale>:
 * <text> } }` — NOT as a flat `{ <locale>: <text> }` dictionary. The obvious flat shape is the trap:
 * the API accepts it with **HTTP 201 and no error at all**, and the record comes back with
 * `{"values":{}}` — every translation silently discarded. Verified live on vcst-qa 2026-08-27 by
 * posting both shapes and re-reading each: `{values:{…}}` round-tripped intact, the flat dict did not.
 *
 * That is precisely the vacuous-fixture failure this spec set exists to prevent: a localization case
 * pointed at a mission whose translations were dropped at seed time asserts a missing translation
 * against an empty field and "passes" the fallback branch for entirely the wrong reason. So the shape
 * is built by ONE function, asserted by the drift guard, and pinned by a unit test.
 */
export const LOCALIZED_STRING_KEY = 'values';

/** Minimum locales a localization fixture must carry. One locale cannot demonstrate localization. */
export const MIN_LOCALES = 2;

/** Wrap a locale→text map in the LocalizedString envelope the API actually persists. Pure. */
export function localizedString(byLocale) {
  return { [LOCALIZED_STRING_KEY]: { ...byLocale } };
}

/**
 * Locale intents, resolved against the STORE — the same treatment as a currency, for the same reason.
 * A store's language list is per-env configuration (`store.languages` / `store.defaultLanguage`), so a
 * committed "de-DE" is the same class of mistake as a committed GUID: on an env that does not declare
 * it, the translation is authored into a locale the storefront can never request, and the fixture goes
 * quietly untestable.
 */
export const LOCALE_INTENTS = ['store-default', 'store-alternate'];

/**
 * Resolve the two locale intents against a store. Pure. The alternate is the first NON-default code in
 * sorted order so a re-seed against an unchanged store picks the same one and the overlay stops
 * churning. Throws rather than collapsing both intents onto one locale — two "different-language"
 * translations in the same language demonstrate nothing.
 */
export function resolveLocales({ defaultLanguage, languages } = {}) {
  const def = String(defaultLanguage || '').trim();
  if (!def) throw new Error('store has no defaultLanguage — cannot resolve a localization locale');
  const others = [...new Set((languages || []).map((l) => String(l || '').trim()).filter(Boolean))]
    .filter((l) => l.toLowerCase() !== def.toLowerCase())
    .sort();
  if (!others.length) {
    throw new Error(
      `store declares only one language (${def}); MSN_LOCALIZED needs a second one, `
      + 'or the localization fixture degenerates into a single-language string',
    );
  }
  return { 'store-default': def, 'store-alternate': others[0] };
}

/**
 * THE FIXTURE SET.
 *
 * `goal` mirrors the live `availableChildren` shapes exactly:
 *   OrderValueGoal { value:number, currencyCode:string|null }
 *   OrderCountGoal { count:number }
 *   PerSkuGoal     { all:boolean }  + targets sourced from PERSKU_PRODUCTS as separate goal items
 */
export const MISSIONS = [
  {
    aliasName: 'MSN_ORDERVALUE',
    key: 'ORDERVALUE',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderValueGoal', value: 250, currency: 'store-default' },
    reward: 500,
    purpose:
      'Order-value goal in the STORE DEFAULT currency. It was originally specified with currencyCode=null '
      + '("accepts any currency", C19) — but a save-time validator rejects both null and "" with "Currency '
      + 'code is required for the order value goal", so a currency-agnostic order-value mission is not '
      + 'expressible at all. The C19 question therefore moved: it is now answered by running this against '
      + 'MSN_ORDERVALUE_ALTCURRENCY, not by a null field.',
  },
  {
    aliasName: 'MSN_ORDERVALUE_ALTCURRENCY',
    key: 'ORDERVALUE-ALT',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderValueGoal', value: 250, currency: 'store-alternate' },
    reward: 500,
    purpose:
      'The discriminating half of the currency pair: SAME threshold and SAME reward as MSN_ORDERVALUE, '
      + 'differing ONLY in currency. It exists because the server enforces that a currency is PRESENT but '
      + 'never that it is VALID ("XYZ" and lowercase "usd" both persist verbatim), so a wrong-currency '
      + 'defect cannot surface at save time and must be caught at accrual: an order in the default currency '
      + 'must satisfy MSN_ORDERVALUE and must NOT satisfy this one. With a single order-value fixture that '
      + 'comparison has nothing to compare against.',
  },
  {
    aliasName: 'MSN_ORDERCOUNT',
    key: 'ORDERCOUNT',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderCountGoal', count: 2 },
    reward: 300,
    purpose:
      'Order-count goal with a small threshold so a case can cross it in two orders. Count is >1 on '
      + 'purpose: at count=1 "counts orders" and "fires on any order" are indistinguishable.',
  },
  {
    aliasName: 'MSN_PERSKU_ALL',
    key: 'PERSKU-ALL',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'PerSkuGoal', all: true },
    reward: 750,
    purpose:
      'PerSku with all=true → surfaces as PerSkuAll: EVERY target SKU must be bought at its quantity. '
      + 'Paired with MSN_PERSKU_ANY over the SAME two targets, so the only variable is the flag.',
  },
  {
    aliasName: 'MSN_PERSKU_ANY',
    key: 'PERSKU-ANY',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'PerSkuGoal', all: false },
    reward: 400,
    purpose:
      'PerSku with all=false → surfaces as PerSkuAny: ONE target SKU at quantity suffices. The '
      + 'discriminating half of the ALL/ANY pair.',
  },
  {
    aliasName: 'MSN_PUBLISHED_PRIVATE',
    key: 'PUBLISHED-PRIVATE',
    status: 'Published',
    public: false,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderCountGoal', count: 1 },
    reward: 100,
    purpose:
      'C17, the ticket\'s highest-priority condition: Published but public=false must NOT leak into the '
      + 'customer-facing query while REMAINING visible to the admin search. Both halves matter — a '
      + 'mission that is merely absent everywhere would pass the leak check for the wrong reason.',
  },
  {
    aliasName: 'MSN_ZEROTARGET',
    key: 'ZEROTARGET',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderCountGoal', count: 0 },
    reward: 200,
    purpose:
      'Zero-target boundary: a goal of 0 must never report 100% / auto-complete on an empty history. '
      + 'Accepted by the API without complaint (verified live), so the boundary is reachable and real.',
  },
  {
    aliasName: 'MSN_ZEROREWARD',
    key: 'ZEROREWARD',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderCountGoal', count: 1 },
    reward: 0,
    purpose:
      'Zero-reward boundary: the mission still COMPLETES but GetRewardAmount returns <=0, so no points '
      + 'are granted and no transaction should be written. Separates "completed" from "paid".',
  },
  {
    aliasName: 'MSN_EXPIRED',
    key: 'EXPIRED',
    status: 'Published',
    public: true,
    window: 'expired',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderCountGoal', count: 1 },
    reward: 100,
    purpose:
      'The ONLY fixture whose date window has already closed. `GetQualifyingMissionsAsync` leaves '
      + '`OnlyActive` unset, so an expired mission keeps returning from `loyaltyMissionProgress` — and '
      + 'with every other fixture on the `active` window, nothing else in the set can distinguish a '
      + 'window filter that works from one that was never applied. Deliberately Published + public=true '
      + 'and otherwise ordinary (OrderCountGoal count=1, a payable reward): it must be a mission that '
      + 'WOULD be returned if it were still open, so its absence can only be attributed to the window. '
      + 'A Draft, private or zero-reward expired mission would be filtered out for a second reason and '
      + 'the case would pass without the window filter existing at all.',
  },
  {
    aliasName: 'MSN_LOCALIZED',
    key: 'LOCALIZED',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderCountGoal', count: 1 },
    reward: 250,
    /**
     * The only fixture carrying translations and a banner. Text is authored per locale INTENT; the
     * intent resolves to a real store language at seed time (see `resolveLocales`). `name` stays the
     * ASCII business key — the seeder looks missions up by it, and the display string is what gets
     * localized, which is exactly the split the module models.
     */
    l10n: {
      name: {
        'store-default': 'AGENT-TEST Localized Mission',
        'store-alternate': 'AGENT-TEST Lokalisierte Mission',
      },
      description: {
        'store-default': 'Place one order to complete this mission and earn points.',
        'store-alternate': 'Geben Sie eine Bestellung auf, um diese Mission abzuschliessen und Punkte zu verdienen.',
      },
    },
    purpose:
      'C11: localized Name + Description in TWO locales plus a BannerUrl — the presentation surface no '
      + 'other fixture exercises. It is the one fixture that can catch the LocalizedString wire-shape '
      + 'trap: a flat {locale:text} dict is accepted with 201 and silently persisted as {"values":{}}, '
      + 'so translations vanish with no error and a localization case then asserts a missing translation '
      + 'against an empty field and passes the fallback branch for the wrong reason.',
  },
  {
    aliasName: 'MSN_DRAFT',
    key: 'DRAFT',
    status: 'Draft',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'OrderCountGoal', count: 3 },
    reward: 150,
    /**
     * `recreateAlways` is not a convenience. A mutation case publishes this mission, and a Published
     * mission can never return to Draft (finding 2 above), so "reuse if present" would hand the next
     * run a Published fixture wearing a Draft alias — the case would then assert Draft-only editability
     * against an immutable record and fail as a product bug. Deleting and recreating is the only way
     * back to Draft.
     */
    recreateAlways: true,
    purpose:
      'The mutation scratch fixture: edit-while-Draft, Draft->Published, delete-while-Draft. Kept apart '
      + 'from the read fixtures above so a mutation case can never strand one of them mid-transition.',
  },
];

/** Alias name → spec, for the seeder and guard. */
export const MISSION_BY_ALIAS = Object.fromEntries(MISSIONS.map((m) => [m.aliasName, m]));

/** The business key a mission is looked up by. Pure. */
export const missionName = (spec) => `${NAME_PREFIX}-${spec.key}`;

/** True when `name` is one of ours — the teardown sweep predicate. Pure. */
export const isSeededMissionName = (name) => String(name || '').startsWith(`${NAME_PREFIX}-`);

/** True when a goal spec needs separate LoyaltyMissionGoalItem rows. Pure. */
export const needsGoalItems = (spec) => spec?.goal?.type === 'PerSkuGoal';

/**
 * Resolve a window intent to concrete ISO dates. `now` is injected so the unit tests are not
 * time-dependent and so a whole seed run shares one clock.
 */
export function windowDates(window, now = new Date()) {
  const w = WINDOWS[window];
  if (!w) throw new Error(`unknown window intent: ${window}`);
  const at = (days) => new Date(now.getTime() + days * 86400000).toISOString();
  return { startDate: at(w.startOffsetDays), endDate: at(w.endOffsetDays) };
}

/** Deep-ish clone of a template node without its nested availability lists. Pure. */
const bareNode = (node) => ({ ...node, availableChildren: [], children: [] });

/**
 * Build the goal node by OVERLAYING the spec onto the live template's own `availableChildren` entry.
 * Deriving from the template rather than writing a literal means a field the module adds or renames
 * arrives with its server-supplied default instead of silently going missing — the GOLDEN RULE applied
 * to an API body. Pure; `templateGoals` is the BlockLoyaltyMissionGoals block from `GET /new`.
 */
export function buildGoalNode(spec, templateGoals, { currencies } = {}) {
  const proto = (templateGoals?.availableChildren || []).find((c) => c.id === spec.goal.type);
  if (!proto) throw new Error(`goal type ${spec.goal.type} is not offered by this build's mission template`);
  const node = bareNode(proto);
  for (const [k, v] of Object.entries(spec.goal)) {
    if (k === 'type' || k === 'currency') continue;
    node[k] = v;
  }
  if (spec.goal.currency) {
    // Resolved, never literal: a currency is per-env store configuration. And it must land NON-EMPTY —
    // the server rejects null/"" outright, so a silently unresolved intent would fail the whole seed
    // with a validation error that says nothing about the real cause.
    const code = currencies?.[spec.goal.currency];
    if (!code) {
      throw new Error(
        `currency intent "${spec.goal.currency}" did not resolve for ${spec.aliasName}. `
        + 'OrderValueGoal.currencyCode is REQUIRED at save (null and "" are both rejected), so this cannot be omitted.',
      );
    }
    node.currencyCode = code;
  }
  return node;
}

/** Build the condition node the same way. Pure. */
export function buildConditionNode(spec, templateConditions) {
  const type = spec.condition?.type || 'AnyUserGroupCondition';
  const proto = (templateConditions?.availableChildren || []).find((c) => c.id === type);
  if (!proto) throw new Error(`condition type ${type} is not offered by this build's mission template`);
  const node = bareNode(proto);
  if (Array.isArray(spec.condition?.groups)) node.groups = [...spec.condition.groups];
  return node;
}

/** Build the reward node. Pure. */
export function buildRewardNode(spec, templateRewards) {
  const proto = (templateRewards?.availableChildren || []).find((c) => c.id === 'FixedAmountReward');
  if (!proto) throw new Error('FixedAmountReward is not offered by this build\'s mission template');
  return { ...bareNode(proto), amount: spec.reward };
}

/**
 * Build `localizedName` / `description` for a spec that declares `l10n`, resolving each locale INTENT
 * against the store's real languages. Returns `{}` for a spec with no translations, so the template's
 * own nulls stand. Pure.
 *
 * Throws on an unresolved intent rather than dropping that locale: a silently half-localized fixture
 * is indistinguishable from the very bug a localization case is looking for.
 */
export function buildLocalizedFields(spec, locales) {
  if (!spec?.l10n) return {};
  const resolve = (byIntent, field) => {
    const out = {};
    for (const [intent, text] of Object.entries(byIntent || {})) {
      const code = locales?.[intent];
      if (!code) {
        throw new Error(
          `locale intent "${intent}" did not resolve for ${spec.aliasName}.${field}. `
          + 'A missing translation would persist as an empty LocalizedString with no error.',
        );
      }
      out[code] = text;
    }
    return localizedString(out);
  };
  const fields = {};
  if (spec.l10n.name) fields.localizedName = resolve(spec.l10n.name, 'name');
  if (spec.l10n.description) fields.description = resolve(spec.l10n.description, 'description');
  return fields;
}

/** The locale→text map actually persisted on a record, for either localized field. Pure. */
export const localizedValues = (v) => (v && typeof v === 'object' ? (v[LOCALIZED_STRING_KEY] || {}) : {});

/** Pull one of the three blocks out of a mission tree (template or fetched). Pure. */
export const blockOf = (tree, id) => (tree?.children || []).find((b) => b.id === id) || null;

export const BLOCK = {
  condition: 'BlockLoyaltyMissionCondition',
  goals: 'BlockLoyaltyMissionGoals',
  reward: 'BlockLoyaltyReward',
};

/**
 * Resolve a spec's banner to the URL the platform asset store handed back for that artwork. Pure.
 *
 * Throws on a missing entry rather than emitting `null`, for the same reason the currency resolver
 * does: a Published mission is IMMUTABLE, so a banner that goes missing at create time can never be
 * added afterwards — the fixture would have to be deleted and rebuilt, and until someone noticed, the
 * storefront card it exists to exercise would render blank.
 */
export function resolveBannerUrl(spec, bannerUrls) {
  const key = bannerKeyFor(spec);
  const url = bannerUrls?.[key];
  if (!url) {
    throw new Error(
      `banner "${key}" did not resolve for ${spec.aliasName}. The seeder must upload `
      + `${bannerSourceRel(key)} and pass the returned URL in { bannerUrls }.`,
    );
  }
  return url;
}

/**
 * Compose the full `POST /api/loyalty-missions` body for a spec, from the live `GET /new` template.
 * Pure — the caller supplies template, storeId, clock and the resolved banner URLs.
 */
export function buildMissionBody(spec, { template, storeId, now = new Date(), currencies, locales, bannerUrls } = {}) {
  if (!template) throw new Error('buildMissionBody needs the GET /api/loyalty-missions/new template');
  if (!storeId) throw new Error('buildMissionBody needs a storeId');
  const tree = template.dynamicExpression;
  const { startDate, endDate } = windowDates(spec.window, now);
  return {
    ...template,
    id: null,
    name: missionName(spec),
    ...buildLocalizedFields(spec, locales),
    bannerUrl: resolveBannerUrl(spec, bannerUrls),
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

/**
 * STRUCTURAL signature of a mission — the fields that decide whether a live record still IS the
 * fixture. Deliberately excludes startDate/endDate: those are relative to the seed clock, so
 * comparing them would report drift on every single run and recreate every mission forever.
 * The window is checked separately by `windowIsOpen`, which asks the question that actually matters.
 * Pure; works identically on a spec-derived body and on a record fetched from the API.
 */
export function missionSignature(mission) {
  const tree = mission?.dynamicExpression;
  const goal = (blockOf(tree, BLOCK.goals)?.children || [])[0] || null;
  const reward = (blockOf(tree, BLOCK.reward)?.children || [])[0] || null;
  const cond = (blockOf(tree, BLOCK.condition)?.children || [])[0] || null;
  // The localized fields and banner are part of the signature so an EDITED translation is detected as
  // drift and the fixture is rebuilt. Without this, changing the German text in the spec would leave
  // the live mission carrying the old string forever — the fixture and its source silently disagreeing.
  const nameL10n = localizedValues(mission?.localizedName);
  const descL10n = localizedValues(mission?.description);
  return {
    name: mission?.name ?? null,
    localizedName: Object.fromEntries(Object.entries(nameL10n).sort(([a], [b]) => a.localeCompare(b))),
    description: Object.fromEntries(Object.entries(descL10n).sort(([a], [b]) => a.localeCompare(b))),
    bannerUrl: mission?.bannerUrl ?? null,
    status: mission?.status ?? null,
    public: mission?.public === true,
    periodicity: mission?.periodicity ?? null,
    storeId: mission?.storeId ?? null,
    condition: cond?.id ?? null,
    conditionGroups: Array.isArray(cond?.groups) ? [...cond.groups].sort() : null,
    goal: goal?.id ?? null,
    goalValue: goal?.value ?? null,
    goalCount: goal?.count ?? null,
    goalAll: goal?.id === 'PerSkuGoal' ? goal?.all === true : null,
    goalCurrency: goal?.currencyCode ?? null,
    reward: reward?.amount ?? null,
  };
}

/** True when two signatures describe the same fixture. Pure. */
export const signaturesMatch = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Is the live record's date window currently open? A fixture that exists but has expired is the
 * silent-failure case this exists to catch — signature comparison alone would call it healthy.
 */
export function windowIsOpen(mission, now = new Date()) {
  const t = now.getTime();
  const start = mission?.startDate ? Date.parse(mission.startDate) : null;
  const end = mission?.endDate ? Date.parse(mission.endDate) : null;
  if (start != null && Number.isFinite(start) && start > t) return false;
  if (end != null && Number.isFinite(end) && end < t) return false;
  return true;
}

/** The goal-item rows a PerSku mission needs, given the resolved products. Pure. */
export function buildGoalItems(spec, missionId, products) {
  if (!needsGoalItems(spec)) return [];
  return PERSKU_PRODUCTS.map((p) => {
    const resolved = products?.[p.slot];
    if (!resolved?.id) throw new Error(`PerSku slot ${p.slot} has no resolved product`);
    return { missionId, productId: resolved.id, quantity: p.quantity };
  });
}

/**
 * Reconcile desired goal items against what the mission already has. Returns the three actions the
 * seeder must take. Pure — the caller does the HTTP.
 *
 * Why a reconcile rather than "delete all, recreate": `LoyaltyMissionGoalItem` carries a UNIQUE index
 * on (MissionId, ProductId), and a duplicate POST surfaces as a raw HTTP 500 SQL error rather than a
 * 409 — so a blind re-POST on a re-seed does not merely fail, it fails as an unreadable server error.
 */
export function reconcileGoalItems(desired, existing) {
  const byProduct = new Map((existing || []).map((e) => [e.productId, e]));
  const create = [];
  const update = [];
  for (const d of desired || []) {
    const cur = byProduct.get(d.productId);
    if (!cur) create.push(d);
    else if (Number(cur.quantity) !== Number(d.quantity)) update.push({ ...cur, quantity: d.quantity });
    byProduct.delete(d.productId);
  }
  return { create, update, remove: [...byProduct.values()] };
}

/* ── Shape validation (the drift guard's deterministic core) ─────────────────── */

/**
 * Assert the committed spec set is internally coherent and still DISCRIMINATING. Returns an array of
 * problem strings ([] = clean). Every rule below exists because breaking it leaves a fixture that
 * still seeds, still resolves and still passes — while testing nothing.
 */
export function validateSpecShape() {
  const problems = [];
  const seen = new Set();
  const names = new Set();

  for (const m of MISSIONS) {
    if (seen.has(m.aliasName)) problems.push(`duplicate alias name: ${m.aliasName}`);
    seen.add(m.aliasName);

    const name = missionName(m);
    if (names.has(name)) problems.push(`duplicate mission name: ${name}`);
    names.add(name);

    if (!isSeededMissionName(name)) problems.push(`${m.aliasName}: name "${name}" lacks the ${NAME_PREFIX}- prefix, so teardown cannot sweep it`);
    if (!STATUSES.includes(m.status)) problems.push(`${m.aliasName}: status "${m.status}" is not one of ${STATUSES.join('/')}`);
    if (typeof m.public !== 'boolean') problems.push(`${m.aliasName}: public must be a boolean`);
    if (!WINDOWS[m.window]) problems.push(`${m.aliasName}: unknown window intent "${m.window}"`);
    if (!m.condition?.type) problems.push(`${m.aliasName}: no condition — the API rejects a mission with an empty condition block`);
    if (!m.goal?.type) problems.push(`${m.aliasName}: no goal — the API requires exactly one`);
    if (typeof m.reward !== 'number') problems.push(`${m.aliasName}: reward must be a number (0 is legal and meaningful)`);
    if (!m.purpose) problems.push(`${m.aliasName}: no purpose — an undocumented fixture gets "tidied" into uselessness`);

    if (m.goal?.type === 'OrderValueGoal' && typeof m.goal.value !== 'number') problems.push(`${m.aliasName}: OrderValueGoal needs a numeric value`);
    if (m.goal?.type === 'OrderCountGoal' && typeof m.goal.count !== 'number') problems.push(`${m.aliasName}: OrderCountGoal needs a numeric count`);
    if (m.goal?.type === 'PerSkuGoal' && typeof m.goal.all !== 'boolean') problems.push(`${m.aliasName}: PerSkuGoal needs a boolean all`);
  }

  // --- the discriminating properties, each of which can rot silently ---

  // A window intent that does not say whether it is meant to be open is unusable: the seeder cannot
  // tell "the fixture drifted" from "the fixture is doing its job".
  for (const [name, w] of Object.entries(WINDOWS)) {
    if (typeof w.startOffsetDays !== 'number' || typeof w.endOffsetDays !== 'number') {
      problems.push(`window intent "${name}" must be declared as day OFFSETS — a committed literal date expires silently`);
    }
    if (typeof w.expectOpen !== 'boolean') {
      problems.push(`window intent "${name}" declares no expectOpen — the seeder cannot tell a drifted window from an intentionally closed one and would recreate the fixture on every run`);
    }
    if (!(w.endOffsetDays > w.startOffsetDays)) {
      problems.push(`window intent "${name}" is inverted (end <= start)`);
    }
  }

  const priv = MISSION_BY_ALIAS.MSN_PUBLISHED_PRIVATE;
  if (priv && (priv.public !== false || priv.status !== 'Published')) {
    problems.push('MSN_PUBLISHED_PRIVATE must stay Published + public=false — it is the ONLY fixture that can catch a private mission leaking to the customer-facing query (C17)');
  }

  const all = MISSION_BY_ALIAS.MSN_PERSKU_ALL;
  const any = MISSION_BY_ALIAS.MSN_PERSKU_ANY;
  if (all && any) {
    if (all.goal.all === any.goal.all) {
      problems.push('MSN_PERSKU_ALL and MSN_PERSKU_ANY carry the SAME `all` flag — the ALL-vs-ANY distinction becomes unfalsifiable');
    }
    if (all.goal.all !== true) problems.push('MSN_PERSKU_ALL must have all=true (it resolves as PerSkuAll)');
    if (any.goal.all !== false) problems.push('MSN_PERSKU_ANY must have all=false (it resolves as PerSkuAny)');
  }

  // MSN_EXPIRED has exactly one job, and every plausible edit destroys it silently. If it becomes
  // `active` the case asserts an absence that never happens; if it becomes Draft/private/zero-reward it
  // is filtered out for a SECOND reason and the case passes whether or not the window filter exists.
  const exp = MISSION_BY_ALIAS.MSN_EXPIRED;
  if (exp) {
    const w = WINDOWS[exp.window];
    if (!w || w.expectOpen !== false || !(w.endOffsetDays < 0)) {
      problems.push('MSN_EXPIRED no longer declares a CLOSED window (expectOpen=false, endOffsetDays<0) — it is the only fixture that can show OnlyActive is never applied, and an open one asserts an absence that never occurs');
    }
    if (exp.status !== 'Published' || exp.public !== true) {
      problems.push('MSN_EXPIRED must stay Published + public=true — a Draft or private mission is excluded for a second reason, so the case would pass without the window filter existing at all');
    }
    if (!(exp.reward > 0)) {
      problems.push('MSN_EXPIRED must carry a non-zero reward — it has to be a mission that WOULD be returned if its window were open, so nothing but the window explains its absence');
    }
    if (MISSIONS.filter((m) => WINDOWS[m.window]?.expectOpen === false).length !== 1) {
      problems.push('more than one fixture declares a closed window — the expired-mission assertions can no longer name a single unambiguous subject');
    }
  } else if (MISSIONS.some((m) => WINDOWS[m.window]?.expectOpen === false)) {
    problems.push('a fixture declares a closed window but MSN_EXPIRED is gone — the expired-window fixture is the declared one');
  }
  // Every OTHER mission must sit inside an open window: an expired "active" fixture still seeds, still
  // resolves, and turns every completion case into a false negative that reads as a product bug.
  for (const m of MISSIONS) {
    if (m.aliasName === 'MSN_EXPIRED') continue;
    if (WINDOWS[m.window]?.expectOpen !== true) {
      problems.push(`${m.aliasName} declares window "${m.window}", which is not open — only MSN_EXPIRED is meant to be outside its window`);
    }
  }

  const zt = MISSION_BY_ALIAS.MSN_ZEROTARGET;
  if (zt && !(zt.goal.count === 0 || zt.goal.value === 0)) {
    problems.push('MSN_ZEROTARGET no longer has a zero target — the boundary it exists for is gone');
  }

  const zr = MISSION_BY_ALIAS.MSN_ZEROREWARD;
  if (zr && zr.reward !== 0) {
    problems.push('MSN_ZEROREWARD no longer has reward 0 — it can no longer prove "completes but grants nothing"');
  }

  const ov = MISSION_BY_ALIAS.MSN_ORDERVALUE;
  const ovAlt = MISSION_BY_ALIAS.MSN_ORDERVALUE_ALTCURRENCY;
  for (const m of [ov, ovAlt]) {
    if (!m) continue;
    if (!CURRENCY_INTENTS.includes(m.goal.currency)) {
      problems.push(`${m.aliasName}.goal.currency must be one of ${CURRENCY_INTENTS.join('/')} — a LITERAL currency code is per-env store config and must not be committed (and it cannot be null: the server rejects a null/empty currency on an OrderValueGoal)`);
    }
    if ('currencyCode' in m.goal) {
      problems.push(`${m.aliasName}.goal must not carry a literal currencyCode — declare a currency INTENT and let the seeder resolve it against the store`);
    }
  }
  if (ov && ovAlt) {
    if (ov.goal.currency === ovAlt.goal.currency) {
      problems.push('MSN_ORDERVALUE and MSN_ORDERVALUE_ALTCURRENCY resolve to the SAME currency intent — the cross-currency comparison (C19) becomes unfalsifiable');
    }
    // The pair is a controlled experiment: currency must be the ONLY difference, or a failure cannot
    // be attributed to the currency rather than to the threshold or the payout.
    if (ov.goal.value !== ovAlt.goal.value) {
      problems.push('MSN_ORDERVALUE and MSN_ORDERVALUE_ALTCURRENCY have different thresholds — currency is no longer the only variable between them');
    }
    if (ov.reward !== ovAlt.reward) {
      problems.push('MSN_ORDERVALUE and MSN_ORDERVALUE_ALTCURRENCY have different rewards — currency is no longer the only variable between them');
    }
  }

  // MSN_LOCALIZED is the only fixture with translations, and each way it can rot leaves it seeding
  // cleanly while proving nothing: one locale (nothing to compare), a locale intent that never
  // resolves (an empty LocalizedString, which the server accepts silently), name and description
  // translated into DIFFERENT locales (no single culture shows both), or a lost banner.
  const l10n = MISSION_BY_ALIAS.MSN_LOCALIZED;
  if (l10n) {
    const nameIntents = Object.keys(l10n.l10n?.name || {});
    const descIntents = Object.keys(l10n.l10n?.description || {});
    if (nameIntents.length < MIN_LOCALES) {
      problems.push(`MSN_LOCALIZED.l10n.name declares ${nameIntents.length} locale(s); C11 needs at least ${MIN_LOCALES} — one language cannot demonstrate localization`);
    }
    if (descIntents.length < MIN_LOCALES) {
      problems.push(`MSN_LOCALIZED.l10n.description declares ${descIntents.length} locale(s); C11 needs at least ${MIN_LOCALES}`);
    }
    for (const i of [...nameIntents, ...descIntents]) {
      if (!LOCALE_INTENTS.includes(i)) {
        problems.push(`MSN_LOCALIZED declares locale intent "${i}", which is not one of ${LOCALE_INTENTS.join('/')} — a LITERAL locale code is per-env store config and must not be committed`);
      }
    }
    if (nameIntents.sort().join(',') !== descIntents.sort().join(',')) {
      problems.push('MSN_LOCALIZED translates name and description into DIFFERENT locale sets — no single culture then shows both, so a storefront case cannot assert them together');
    }
    for (const [field, byIntent] of Object.entries(l10n.l10n || {})) {
      const texts = Object.values(byIntent || {}).map((t) => String(t || '').trim());
      if (texts.some((t) => !t)) problems.push(`MSN_LOCALIZED.l10n.${field} has an empty translation — it would persist as a blank string and read as a missing translation`);
      if (new Set(texts).size !== texts.length) {
        problems.push(`MSN_LOCALIZED.l10n.${field} repeats the SAME text across locales — a case cannot tell a served translation from a fallback`);
      }
    }
  }
  // A second fixture quietly acquiring translations would make the guard above non-exclusive. The
  // BANNER is deliberately NOT part of this exclusivity any more: every mission carries one now, so
  // C11's banner half is "MSN_LOCALIZED's banner is served like everyone else's", not "only it has one".
  for (const m of MISSIONS) {
    if (m.aliasName === 'MSN_LOCALIZED') continue;
    if (m.l10n) problems.push(`${m.aliasName} carries l10n, but MSN_LOCALIZED is the declared localization fixture — two of them make the C11 assertions ambiguous`);
  }

  // --- banners: the storefront card renders bannerUrl, so an unset one is an invisible failure ---
  for (const m of MISSIONS) {
    if ('bannerUrl' in m) {
      problems.push(`${m.aliasName} declares a literal bannerUrl — the asset URL is per-env runtime data (an absolute host-bearing address), so it belongs in aliases.<env>.json; the artwork is chosen by goal type via bannerKeyFor()`);
    }
    try { bannerKeyFor(m); } catch (e) { problems.push(`${m.aliasName}: ${e.message}`); }
  }
  const goalTypes = new Set(MISSIONS.map((m) => m.goal?.type).filter(Boolean));
  for (const t of goalTypes) {
    if (!Object.values(BANNERS).some((b) => b.goals.includes(t))) {
      problems.push(`goal type ${t} has no banner — its missions would render a blank storefront card, which is indistinguishable from a broken one`);
    }
  }
  const usedBanners = new Set(MISSIONS.map((m) => { try { return bannerKeyFor(m); } catch { return null; } }).filter(Boolean));
  for (const [key, b] of Object.entries(BANNERS)) {
    if (!b.file || !/\.(svg|png|jpe?g|gif|webp)$/i.test(b.file)) {
      problems.push(`banner "${key}" has no usable image file name — the seeder uploads ${b.file}`);
    }
    if (/\$\{|\d{6,}/.test(b.file)) {
      problems.push(`banner "${key}" has a generated-looking file name — the name must be FIXED, or its asset URL changes every run, and bannerUrl is part of missionSignature so every mission would be deleted and recreated forever`);
    }
    if (!b.goals?.length) problems.push(`banner "${key}" claims no goal type — nothing would ever use it`);
    if (!b.subject) problems.push(`banner "${key}" has no subject — an undescribed banner gets "tidied" into a duplicate of another`);
    if (!usedBanners.has(key)) problems.push(`banner "${key}" is uploaded but no mission uses it — dead artwork reads as coverage that does not exist`);
  }
  // Two goal types sharing one artwork would make the three card types indistinguishable at a glance,
  // which is the entire point of having three.
  const goalToBanner = Object.entries(BANNERS).flatMap(([k, b]) => b.goals.map((g) => [g, k]));
  if (new Set(goalToBanner.map(([g]) => g)).size !== goalToBanner.length) {
    problems.push('a goal type is claimed by more than one banner — bannerKeyFor would pick by declaration order, which is not a decision anyone made');
  }
  if (new Set(Object.keys(BANNERS)).size !== new Set(Object.values(BANNERS).map((b) => b.file)).size) {
    problems.push('two banners share one image file — the mission types stop being visually distinguishable');
  }

  const draft = MISSION_BY_ALIAS.MSN_DRAFT;
  if (draft && (draft.status !== 'Draft' || draft.recreateAlways !== true)) {
    problems.push('MSN_DRAFT must be status=Draft with recreateAlways=true — a Published mission can never return to Draft, so without the recreate the mutation fixture is a one-shot');
  }

  // At least one fixture must be able to actually PAY, or nothing can prove a grant happens.
  if (!MISSIONS.some((m) => m.status === 'Published' && m.public === true && m.reward > 0)) {
    problems.push('no Published + public mission with a non-zero reward — nothing in the set can demonstrate points being granted');
  }

  // The PerSku pair needs at least two DISTINCT target slots, or "all" and "any" coincide at runtime.
  const slots = new Set(PERSKU_PRODUCTS.map((p) => p.slot));
  if (slots.size < 2) {
    problems.push('PERSKU_PRODUCTS declares fewer than 2 distinct slots — with one target, PerSkuAll and PerSkuAny are the same mission');
  }
  if (PERSKU_PRODUCTS.some((p) => !(p.quantity > 0))) {
    problems.push('every PERSKU_PRODUCTS slot needs a positive quantity');
  }

  return problems;
}

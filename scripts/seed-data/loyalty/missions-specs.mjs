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
  // The VCST-5346 provisioning order. Its GUID is server-assigned; `user_id` is the target account's
  // per-env SECURITY-ACCOUNT id and `user_email`/`store_id` are per-env identity — all runtime.
  progressOrder: ['id', 'user_id', 'user_email', 'store_id'],
  // The group-targeting control pair. The GROUP NAME is authored and env-invariant (same treatment as
  // USER_GROUP_VIP.name), and so are the two role KEYS — but the accounts those roles resolve to are
  // per-env identity, and their observed group membership is live state read off the target env. The
  // groups are runtime SPECIFICALLY so nothing can commit a claim about who is in the audience: that
  // claim is what the seeder verifies, and a committed one would assert itself.
  groupAudience: [
    'member_email', 'member_user_id', 'member_groups',
    'nonmember_email', 'nonmember_user_id', 'nonmember_groups',
  ],
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

/**
 * TARGETING AND `public` ARE TWO INDEPENDENT VARIABLES, AND CONFLATING THEM COST A RETRACTED BUG.
 *
 * `MSN_PUBLISHED_PRIVATE` is Published with `public=false` and — deliberately — the NEUTRAL
 * `AnyUserGroupCondition`. Its name says "private"; its condition says "every customer is the intended
 * audience". Both are true at once, because the two properties are orthogonal: the condition tree
 * decides WHO a mission is FOR, and `public` decides whether it is advertised. With that one fixture as
 * the only non-public mission in the set, and `TARGETING.groupCondition` declared but used by NO spec,
 * the set could not tell the two apart — so an arbitrary customer earning it read as an audience leak
 * and was drafted as a P1 privacy/revenue defect on 2026-08-27, then retracted once the condition was
 * read. The fixture was not wrong; the SET was under-designed.
 *
 * The two fixtures below close it, giving a 2x2 with one cell deliberately empty:
 *
 *   fixture                  condition   public   isolates
 *   MSN_GROUP_VIP            VIP          true    TARGETING (the positive control)
 *   MSN_GROUP_VIP_PRIVATE    VIP          false   `public` ON TOP OF targeting
 *   MSN_PUBLISHED_PRIVATE    Any          false   `public` ON ITS OWN
 *   (Any + public=true)      Any          true    the ordinary case — ten fixtures already are it
 *
 * `validateSpecShape` defends each cell, because every one of them can be destroyed by an edit that
 * still seeds cleanly: give MSN_PUBLISHED_PRIVATE a group and it merges into the second row; let the
 * VIP pair drift on a second field and neither row attributes anything.
 */
export const TARGET_GROUP = 'VIP';

/**
 * HOW THE SERVER REALLY EVALUATES A GROUP — verified in source 2026-08-27 (vc-module-loyalty PR #14 @
 * 1be73b4, plus vc-module-core and vc-platform at their dev heads). Recorded because every one of these
 * facts changes what a fixture is allowed to claim, and three of them are not guessable from the API.
 *
 * 1. `UserGroupIsCondition` is NOT a loyalty type — it lives in vc-module-core
 *    (`Conditions/UserGroupIsCondition.cs`) and loyalty only lists it as an available child. It reads
 *    `EvaluationContextBase.UserGroups`, and it is FAIL-CLOSED twice over: an empty/null `Groups[]`
 *    returns false, and a null `UserGroups` returns false. That is why an empty `groups[]` is a guarded
 *    problem below rather than a harmless default — it targets NOBODY, not everybody.
 * 2. `UserGroups` comes from the CONTACT/MEMBER entity's `Groups` collection, nowhere else:
 *    `LoyaltyLogicService.GetUserGroups(userId)` -> `IMemberResolver.ResolveMemberByIdAsync(userId)`
 *    (security-user id -> `user.MemberId` -> member) -> `member.Groups.ToArray()`. Not a security-account
 *    claim, not the order, not a store setting. If the resolver returns null the context's `UserGroups`
 *    stays null and EVERY group-targeted mission silently vanishes — a fixture whose audience account has
 *    no member record fails as an absence, which reads as a product bug.
 * 3. The match is `UserGroups.Any(x => Groups.Any(x.EqualsIgnoreCase))` — whole-string, ORDINAL
 *    CASE-INSENSITIVE, and NOT trimmed. So "vip" matches "VIP", "VIP Gold" does not, and a stray space
 *    on either side breaks it with no error. The seeder therefore compares case-insensitively (mirroring
 *    the server) but REFUSES a padded group string, because that one the server would silently drop.
 * 4. `AnyUserGroupCondition.IsSatisfiedBy` is `context is LoyaltyProgramEvaluationContext` — a CONSTANT
 *    TRUE. It is genuinely "no audience restriction", which is what makes MSN_PUBLISHED_PRIVATE the
 *    neutral cell rather than a weakly-targeted one.
 * 5. THE READ PATH APPLIES THE CONDITION, so a non-member does not merely fail to accrue — the mission
 *    is FILTERED OUT of the storefront list entirely (`GetQualifyingMissionsAsync` ->
 *    `Where(x => x.DynamicExpression?.IsSatisfiedBy(context) ?? false)`, and accrual uses the identical
 *    predicate). MSN_GROUP_VIP is therefore observable as presence/absence on `loyaltyMissionProgress`,
 *    not only as a payout difference.
 * 6. `public` IS READ BY NOTHING ON EITHER PATH. `LoyaltyMissionSearchCriteria.Public` exists and
 *    `LoyaltyMissionSearchService` will filter on it — but NO caller in the module ever sets it: the
 *    storefront read sets `StoreIds`/`Status`/`Take`, accrual sets `StoreIds`/`OnlyActive`/`Take`, and
 *    the xAPI project contains zero occurrences of the field. So on this build a Published, in-store,
 *    condition-satisfying mission reaches the storefront REGARDLESS of `public`.
 *    THIS IS A FINDING THE FIXTURES EXIST TO MAKE JUDGEABLE, NOT AN ASSERTION THEY MAY BAKE IN. The
 *    predicted outcome — MSN_GROUP_VIP and MSN_GROUP_VIP_PRIVATE behaving IDENTICALLY, and
 *    MSN_PUBLISHED_PRIVATE visible to everyone — is exactly what the triple is for, and a fixture that
 *    encoded the expectation would prove it by construction. Nothing here declares an expected
 *    visibility; the cells declare only the INPUTS.
 *
 * ONE MORE TRAP, GUARDED BY CONSTRUCTION. `BlockLoyaltyMissionCondition` is persisted with its own
 * `all` flag (JSON round-trip; the stored value wins over the ctor). This build's template ships
 * `all: false` = OR. With ONE condition child that is immaterial, and `buildMissionBody` emits exactly
 * one — but a mission carrying BOTH `UserGroupIsCondition` and `AnyUserGroupCondition` would OR a real
 * predicate with a constant true, and the targeting would be a silent no-op. That is the likeliest
 * explanation for any "targeted mission shown to everyone" report, so the set must never author it.
 */

/**
 * The two accounts that make group targeting FALSIFIABLE, named by user-roles.mjs key rather than by
 * email — an email is per-env identity (`.env.<env>`), so a literal here is the same class of mistake
 * as a literal GUID.
 *
 * WHY A NON-MEMBER IS MANDATORY AND NOT A NICETY. "The VIP user sees the VIP mission" is true of a
 * mission with no targeting at all — it is exactly the observation that made the retracted bug look
 * real. The claim only becomes falsifiable next to an account that is verifiably OUTSIDE the group and
 * does NOT see it. So the seeder resolves both accounts live, asserts the membership in each direction,
 * and records the OBSERVED groups in the overlay; a run whose control account has quietly joined the
 * audience aborts instead of seeding a pair that can only ever agree.
 *
 * `nonMemberRole` is LOYALTY_WHOLESALE_USER because it is the only declared loyalty customer that is
 * not in VIP: LOYALTY_NOBAL_USER is ALSO `groups:["VIP"]` (verified live on vcst-qa 2026-08-27), so
 * picking it would have made the negative control a second positive one.
 */
export const GROUP_AUDIENCE = {
  aliasName: 'MSN_GROUP_AUDIENCE',
  group: TARGET_GROUP,
  memberRole: 'LOYALTY_VIP_USER',
  nonMemberRole: 'LOYALTY_WHOLESALE_USER',
};

/**
 * Fields a controlled PAIR is allowed to differ on. Everything else must be identical, and the check is
 * written as "compare every key EXCEPT these" rather than "compare this list" on purpose: a field added
 * to the spec shape later is then compared automatically instead of silently escaping the control.
 */
export const GROUP_PAIR_EXEMPT_FIELDS = ['aliasName', 'key', 'public', 'purpose'];

/**
 * Which fields two specs differ on, exempt fields removed. `[]` means the pair is a clean controlled
 * comparison. Pure — exported so the guard and the unit tests share one definition of "differ".
 */
export function specDifferences(a, b, exempt = GROUP_PAIR_EXEMPT_FIELDS) {
  if (!a || !b) return null;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !exempt.includes(k)));
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

/** The groups a spec targets, sorted; `null` for a spec that carries no group condition. Pure. */
export function targetedGroups(spec) {
  if (spec?.condition?.type !== TARGETING.groupCondition.id) return null;
  return [...(spec.condition.groups || [])].sort();
}

/** True when the spec aims at a specific audience rather than at everyone. Pure. */
export const isGroupTargeted = (spec) => targetedGroups(spec) != null;

/**
 * A MIRROR of the server's own comparison — `string.Equals(a, b, OrdinalIgnoreCase)` — so the seeder's
 * live membership assertion agrees with the predicate that will actually decide visibility. Whole
 * string, never a substring: "VIP Gold" is not "VIP". Pure.
 */
export const groupMatches = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** Would the server consider an observed group list a member of `target`? Pure. */
export const groupsInclude = (groups, target) => (groups || []).some((g) => groupMatches(g, target));

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
  /**
   * A window that is OPEN but CLOSES SOON, so the storefront's date badge takes its DANGER branch
   * (VCST-5346). This is the ONLY window intent that exists to make a COLOUR reachable rather than a
   * filter, and it is the cheapest of the three progress-era fixtures because it needs no order at all.
   *
   * WHY A NEW INTENT AT ALL. `daysRemaining` is not stored anywhere — it is computed in the xAPI
   * resolver, per request, off the MISSION's end date (LoyaltyUserMissionType; verified in source and
   * live on vcst-qa):
   *     days = ceil((mission.EndDate - DateTime.UtcNow).TotalDays), then clamped to >= 0
   * The seeder writes `endDate = seedClock + endOffsetDays`, so the value STARTS at `endOffsetDays`
   * and only ever decreases: its reachable range is exactly [0, endOffsetDays]. `WINDOWS.active` sets
   * 180, so every fixture on it reports `daysRemaining: 180` (observed) and the danger branch — which
   * needs `< DANGER_THRESHOLD_DAYS` — was unreachable BY CONSTRUCTION, not by accident of data.
   *
   * WHY 5, AND WHY THE NUMBER IS ARGUED IN BOTH DIRECTIONS. `WINDOWS.expired` argues its 30-day gap
   * one way (far enough below "now" that a clock reading cannot make it look open). This fixture has
   * a boundary on EACH side and can be destroyed by either:
   *   - too close to DANGER_THRESHOLD_DAYS: a clock/timezone reading pushes `daysRemaining` to 10 and
   *     the badge silently renders the WARNING colour — the fixture then asserts the default state;
   *   - too close to 0: the window closes between one seed and the next, and once it does,
   *     `GetUserMissionsAsync` drops the mission entirely (out of window + no progress row), so the
   *     case asserts a badge colour on a card that is not on the page.
   * The worst clock error this has to survive is ~26 h (a 14 h timezone offset plus a DST shift,
   * rounded up) — see WINDOW_CLOCK_SLACK_DAYS. 5 is the midpoint of [0, DANGER_THRESHOLD_DAYS]: it
   * buys 5 days of margin below the boundary AND 5 days of fixture life, each ~4.6x the worst error.
   * Nothing between 2 and 8 is wrong; the midpoint is chosen because there is no reason to favour one
   * failure mode over the other, and `validateSpecShape` enforces only the slack-derived range so the
   * value can be moved without re-deriving the argument.
   *
   * THE SHORT LIFE IS AFFORDABLE BECAUSE THE SEEDER SELF-HEALS. For an `expectOpen: true` intent a
   * closed window is DRIFT, so `windowIsOpen(...) !== windowExpectsOpen(...)` deletes and recreates
   * the fixture with a fresh 5-day window on the next seed. That is the same mechanism that stops
   * `expired` from churning, read in the other direction.
   */
  endingSoon: { startOffsetDays: -7, endOffsetDays: 5, expectOpen: true },
};

/**
 * The storefront's own boundary: a mission whose `daysRemaining` is BELOW this renders its date badge
 * in the danger colour; at or above it, the warning colour (VCST-5346, vc-frontend PR #2396). Declared
 * here because `WINDOWS.endingSoon` is meaningless without the number it is chosen relative to — and
 * because if the frontend ever moves the threshold, this is the one place the fixture follows it.
 */
export const DANGER_THRESHOLD_DAYS = 10;

/**
 * How much room a date-window fixture must keep between itself and any boundary it is judged against.
 * The worst clock disagreement between the seeder and the resolver is a timezone offset (<= 14 h) plus
 * a DST shift (1 h) — call it 26 h — so 2 days is ~2x the worst case. Used to bound `endingSoon` from
 * BOTH sides; it is a minimum, not the chosen value.
 */
export const WINDOW_CLOCK_SLACK_DAYS = 2;

/**
 * Does this window intent mean the fixture should currently be inside its window? Pure. Callers must
 * ask this rather than calling `windowIsOpen` directly on a spec — see `WINDOWS.expectOpen`.
 */
export function windowExpectsOpen(window) {
  const w = WINDOWS[window];
  if (!w) throw new Error(`unknown window intent: ${window}`);
  return w.expectOpen === true;
}

/* ── Progress: the VCST-5346 storefront states ───────────────────────────────
 *
 * WHAT THE STOREFRONT ACTUALLY RENDERS, AND WHY THE MISSION DEFINITIONS ABOVE CANNOT DRIVE IT.
 * `/account/missions` (vc-frontend PR #2396) draws each card from `loyaltyMissionProgress`, and every
 * visual state on it is a function of PROGRESS, not of the mission: the bar width and `percentage`,
 * the "{current} of {target}" label, the green "Completed" chip + success bar, the date badge colour,
 * and — in the SKU modal — the per-row "target met" styling plus the whole modal going READ-ONLY when
 * the backend status is `Completed`. Every fixture above is a DEFINITION. Definitions alone yield a
 * page of identical 0% / warning / not-completed cards, so three acceptance criteria could not be
 * judged at all.
 *
 * HOW PROGRESS IS PROVISIONED — the answer is "an order", and it is the only answer.
 * Verified from source (vc-module-loyalty PR #14, head 1be73b4) and confirmed live on vcst-qa:
 *   - `/api/loyalty-mission-progress` exposes `POST /search` and `GET /{id}` and NOTHING else. There
 *     is no create/update/delete, no recalculate, no reprocess, no enrol, no seed-progress endpoint,
 *     and nothing anywhere in the module publishes the event that would drive one.
 *   - The single writer is `LoyaltyMissionLogicService.ProcessOrderAsync`, reached only from
 *     `LoyaltyMissionHandler : IEventHandler<OrderChangedEvent>` filtered to `EntryState.Added` — i.e.
 *     the INSERT of a CustomerOrder row, dispatched to Hangfire.
 *   - There is NO order-status gate: the mission advances on the insert whatever status the order
 *     carries, so `POST /api/order/customerOrders` provisions progress with no cart, no checkout, no
 *     payment and no browser. (Observed: progress appeared within 5 s of the POST.)
 * So the cheapest honest path is ONE Swagger-shaped order, and everything below exists to make that
 * one order produce three DIFFERENT, deterministic, re-derivable states.
 *
 * WHY THE GOALS ARE COUNTS AND SKUs AND NEVER MONEY. An `OrderValueGoal` contributes `order.Total`,
 * and the platform RECOMPUTES that from line items, tax and shipping — a fixture authored with
 * `total: 249.98` was stored as `251.99` (observed on vcst-qa). A percentage derived from an authored
 * total would therefore be a guess that no static check could catch. Order COUNT and PerSku LINE
 * QUANTITIES are carried through verbatim, so the outcome of the seed order is predictable in closed
 * form — which is what `predictProgress` below computes and `validateSpecShape` enforces.
 */

/**
 * WHOSE progress. Resolved through `scripts/lib/user-roles.mjs` at seed time, never as a literal:
 * `USER` is the repo's canonical "primary storefront shopper" role, so this fixture set follows
 * whatever account the storefront suites actually sign in as on the target env.
 */
export const PROGRESS_USER_ROLE = 'USER';

/**
 * The ONE order that provisions every progress state. Business keys only — no ids, no totals.
 *
 * `slot` refers to `PERSKU_PRODUCTS`, so the line items point at the same two live-discovered products
 * the PerSku goals target; their real ids are resolved at seed time. `unitPrice` exists only because
 * an order line needs one — nothing asserts against it, and nothing may, per the total-recompute note
 * above.
 *
 * THE LINE QUANTITIES ARE THE DESIGN. A×2 + B×1 is the smallest single order that simultaneously
 * OVER-satisfies one slot, EXACTLY satisfies another, and leaves a third target UNDER-satisfied
 * depending on the goal's own quantities — which is what lets one order drive a partial fixture and a
 * completed fixture at once instead of needing two orders (and a second order cannot be had cheaply:
 * `TransactionExistsAsync(missionId, orderId, userId)` plus a unique index mean one order contributes
 * to a given mission exactly once).
 */
export const PROGRESS_ORDER = {
  key: 'ORDER',
  status: 'New',
  unitPrice: 10,
  lines: [
    { slot: 'A', quantity: 2 },
    { slot: 'B', quantity: 1 },
  ],
};

/** The provisioning order's business key — deterministic, so the seeder finds and reuses it. Pure. */
export const progressOrderNumber = () => `${NAME_PREFIX}-${PROGRESS_ORDER.key}`;

/** Alias that carries the provisioning order's runtime ids. */
export const PROGRESS_ORDER_ALIAS = 'MSN_PROGRESS_ORDER';

/** How many orders the seed places. `OrderCountGoal` contributions are exactly this. Pure. */
export const PROGRESS_ORDER_COUNT = 1;

/**
 * The per-slot target quantities a PerSku mission's goal items carry. Defaults to `PERSKU_PRODUCTS`
 * (the shared ALL/ANY pair) and lets a spec override per slot. Pure.
 *
 * The override exists because the progress fixtures need targets the seed order lands ABOVE for one
 * and BELOW for another over the SAME two products — that is the only way to get a card showing one
 * "target met" row next to one that is not. A second pair of discovered products would not do it: the
 * distinction being tested is per-row, within one mission.
 */
export function goalItemQuantities(spec) {
  const base = Object.fromEntries(PERSKU_PRODUCTS.map((p) => [p.slot, p.quantity]));
  return { ...base, ...(spec?.goalItemQuantities || {}) };
}

/** What the seed order buys, per slot. Pure. */
export const progressOrderQuantities = () => Object.fromEntries(
  PROGRESS_ORDER.lines.map((l) => [l.slot, l.quantity]),
);

/**
 * Predict, in closed form, what the single seed order does to a fixture's progress.
 *
 * This is a deliberate MIRROR of `LoyaltyMissionLogicService.UpdateMissionProgressMetrics` +
 * `IsCompleted`, and mirroring server logic is normally exactly what `.claude/rules/test-data.md`
 * §GOLDEN RULE forbids. It is justified here, narrowly, because it is not used as an ORACLE: nothing
 * asserts the product against it. It is used to prove that a COMMITTED FIXTURE SET can still produce
 * the three distinct states it claims to — statically, before anyone spends a seed run finding out
 * that an edited quantity turned the partial fixture into a completed one. The live values remain the
 * only proof that the data landed, and the seeder asserts those separately against the real query.
 * If the module's arithmetic changes, this drifts and the SEEDER fails loudly on the live comparison
 * — which is the failure mode we want, rather than a fixture that silently stops discriminating.
 *
 * Returns `null` for a goal whose outcome is NOT predictable (see the money note above). Pure.
 */
export function predictProgress(spec) {
  const goal = spec?.goal;
  if (!goal) return null;

  if (goal.type === 'PerSkuGoal') {
    const targets = goalItemQuantities(spec);
    const bought = progressOrderQuantities();
    const rows = PERSKU_PRODUCTS.map((p) => ({
      slot: p.slot,
      target: targets[p.slot],
      current: bought[p.slot] || 0,
    }));
    const targetValue = rows.reduce((s, r) => s + r.target, 0);
    // The module clamps EACH row before summing (`Sum(Math.Min(current, target))`), so buying ten of
    // one SKU cannot compensate for buying none of another.
    const currentValue = rows.reduce((s, r) => s + Math.min(r.current, r.target), 0);
    const met = rows.filter((r) => r.current >= r.target);
    const completed = goal.all
      ? rows.length > 0 && met.length === rows.length
      : met.length > 0;
    // PerSkuAny's percentage is BINARY server-side (0 or 100) — it has no partial state at all, which
    // is why the partial fixture must be a PerSkuAll.
    const percentage = goal.all
      ? (targetValue > 0 ? Math.min(100, (currentValue / targetValue) * 100) : 0)
      : (completed ? 100 : 0);
    return {
      currentValue, targetValue, percentage,
      status: completed ? 'Completed' : 'InProgress',
      rows, rowsMet: met.length, rowsUnmet: rows.length - met.length,
    };
  }

  if (goal.type === 'OrderCountGoal') {
    const targetValue = goal.count;
    const currentValue = PROGRESS_ORDER_COUNT;
    // The `targetValue > 0` guard is the module's own, and it is why a zero-target mission reports 0%
    // rather than dividing by zero or auto-completing (MSN_ZEROTARGET's whole point).
    const percentage = targetValue > 0 ? Math.min(100, (currentValue / targetValue) * 100) : 0;
    const completed = targetValue > 0 && currentValue >= targetValue;
    return {
      currentValue, targetValue, percentage,
      status: completed ? 'Completed' : 'InProgress',
      rows: [], rowsMet: 0, rowsUnmet: 0,
    };
  }

  // OrderValueGoal: the contribution is the SERVER-RECOMPUTED order.Total. Not predictable.
  return null;
}

/** Percentages are decimals off the wire; compare with a tolerance rather than by identity. Pure. */
export const percentagesMatch = (a, b, tolerance = 0.01) => (
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance
);

/** Every fixture that declares an expected progress state. Pure. */
export const progressFixtures = () => MISSIONS.filter((m) => m.progress);

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
      'C17 — the `public` FLAG IN ISOLATION, under a deliberately NEUTRAL condition. Read the name as '
      + '"not advertised", NEVER as "audience-restricted": its AnyUserGroupCondition means every '
      + 'customer IS its intended audience, so an arbitrary shopper (or an anonymous checkout) earning '
      + 'it is CORRECT BEHAVIOUR and not a leak. Getting that backwards cost a retracted P1 on '
      + '2026-08-27. This is the third cell of the targeting x public matrix — it answers "does `public` '
      + 'do anything ON ITS OWN?" and nothing else; audience targeting is MSN_GROUP_VIP / '
      + 'MSN_GROUP_VIP_PRIVATE. Both halves of C17 still matter — Published + public=false must stay out '
      + 'of the customer-facing query while REMAINING visible to the admin search, because a mission '
      + 'that is merely absent everywhere would pass the leak check for the wrong reason.',
  },
  {
    aliasName: 'MSN_GROUP_VIP',
    key: 'GROUP-VIP',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'UserGroupIsCondition', groups: [TARGET_GROUP] },
    goal: { type: 'OrderCountGoal', count: 1 },
    reward: 275,
    purpose:
      'The POSITIVE CONTROL for group targeting, and the first fixture in the set to use '
      + 'TARGETING.groupCondition at all (it was declared and used by nothing, so MSN-011 had to build a '
      + 'group-scoped mission inline inside the case). Targeted at @td(MSN_GROUP_AUDIENCE.group) with '
      + '`public` held at its PERMISSIVE value, so targeting is the only variable: '
      + '@td(MSN_GROUP_AUDIENCE.member_email) must see and earn it, '
      + '@td(MSN_GROUP_AUDIENCE.nonmember_email) must not. Both halves are required — "the VIP user sees '
      + 'the VIP mission" is equally true of a mission with NO targeting, which is precisely the '
      + 'observation that made the retracted bug look real. public=true is load-bearing: flip it and '
      + 'this stops being the targeting cell and duplicates MSN_GROUP_VIP_PRIVATE.',
  },
  {
    aliasName: 'MSN_GROUP_VIP_PRIVATE',
    key: 'GROUP-VIP-PRIVATE',
    status: 'Published',
    public: false,
    window: 'active',
    condition: { type: 'UserGroupIsCondition', groups: [TARGET_GROUP] },
    goal: { type: 'OrderCountGoal', count: 1 },
    reward: 275,
    purpose:
      'The cell that isolates the FLAG with TARGETING HELD CONSTANT: identical to MSN_GROUP_VIP in every '
      + 'respect except public=false. It answers the one question neither of the other two cells can — '
      + 'does `public` add ANYTHING on top of an audience condition that already restricts the mission? '
      + 'Run as a triple: if the member sees MSN_GROUP_VIP but not this, `public` is a second, '
      + 'independent gate; if the member sees both, `public` is inert once a condition is present; if '
      + 'the member sees neither, the two gates are redundant. The guard asserts the pair differs on '
      + 'NOTHING but `public`, because a second variable makes every one of those three readings '
      + 'unattributable — the exact failure that produced the retracted bug.',
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

  /* ── VCST-5346 storefront progress states ─────────────────────────────────
   * The three fixtures below are the PROGRESS axis. Everything above them varies the mission
   * DEFINITION and is judged by the admin API; these vary what the customer's card LOOKS LIKE and are
   * judged by `loyaltyMissionProgress`. They overlap the definitions above by design — the same
   * single order also moves MSN_ORDERCOUNT to 50% and completes MSN_PERSKU_ALL — but those fixtures
   * declare nothing about progress and no guard defends their percentages, so an edit to
   * MSN_ORDERCOUNT's count would silently take the storefront's only partial state with it. These
   * three declare the state, and `validateSpecShape` re-derives it from the seed order.
   */
  {
    aliasName: 'MSN_ENDING_SOON',
    key: 'ENDING-SOON',
    status: 'Published',
    public: true,
    window: 'endingSoon',
    condition: { type: 'AnyUserGroupCondition' },
    // count=4 against a ONE-order seed: comfortably un-completable, and 25% exactly (no repeating
    // decimal to compare against). See the purpose note for why un-completable is load-bearing.
    goal: { type: 'OrderCountGoal', count: 4 },
    reward: 350,
    progress: { status: 'InProgress', percentage: 25 },
    purpose:
      'The DANGER date badge (VCST-5346). The storefront colours the badge success when the mission is '
      + 'completed, DANGER when daysRemaining < DANGER_THRESHOLD_DAYS, and warning otherwise — and '
      + 'daysRemaining maxes out at the window intent\'s endOffsetDays, which is 180 for every other '
      + 'fixture, so the danger branch was unreachable BY CONSTRUCTION rather than for want of data. '
      + 'It is the only fixture on the endingSoon window. Two properties keep it honest and both are '
      + 'guarded: the window must stay inside (0, DANGER_THRESHOLD_DAYS) with clock slack on BOTH '
      + 'sides, and the mission must NOT be completable by the seed order — a completed mission takes '
      + 'the success branch, which overrides danger entirely, so a fixture that quietly became '
      + 'completable would render the one colour it exists to exclude while still looking seeded.',
  },
  {
    aliasName: 'MSN_PROGRESS_PARTIAL',
    key: 'PROGRESS-PARTIAL',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'PerSkuGoal', all: true },
    // Against the seed order (A x2, B x1): A is exactly met (2/2), B is left short (1/2).
    // currentValue = min(2,2) + min(1,2) = 3 of 4 => 75%, InProgress.
    goalItemQuantities: { A: 2, B: 2 },
    reward: 450,
    progress: { status: 'InProgress', percentage: 75, rowsMet: 1, rowsUnmet: 1 },
    purpose:
      'PARTIAL progress — a bar strictly between empty and full, a non-trivial "{current} of {target} '
      + 'SKUs" label, and the only fixture in the set where the SKU modal shows a target-MET row next '
      + 'to a target-UNMET one, so the per-row styling has both of its states on screen at once. '
      + 'PerSkuALL is mandatory here and not a preference: the module computes PerSkuAny\'s percentage '
      + 'as a BINARY 0-or-100, so an Any goal has no partial state to render at all. The two target '
      + 'quantities must also DIVERGE relative to the seed order (one at or below what it buys, one '
      + 'above) — equalise them and the fixture snaps to 0% or 100% and stops being partial while '
      + 'still seeding cleanly.',
  },
  {
    aliasName: 'MSN_PROGRESS_COMPLETED',
    key: 'PROGRESS-COMPLETED',
    status: 'Published',
    public: true,
    window: 'active',
    condition: { type: 'AnyUserGroupCondition' },
    goal: { type: 'PerSkuGoal', all: true },
    // Against the seed order (A x2, B x1): both targets met.
    // currentValue = min(2,1) + min(1,1) = 2 of 2 => 100%, Completed.
    goalItemQuantities: { A: 1, B: 1 },
    reward: 550,
    progress: { status: 'Completed', percentage: 100, rowsMet: 2, rowsUnmet: 0 },
    purpose:
      'COMPLETED progress — the green chip, the success-coloured bar, the "Mission completed" label, '
      + 'the success date badge, and the READ-ONLY SKU modal (steppers and Add-to-cart hidden once the '
      + 'backend status is Completed). It is a PerSku mission on purpose: the read-only branch exists '
      + 'ONLY on the SKU modal, so an OrderCount mission at 100% reaches four of those five surfaces '
      + 'and silently leaves the fifth untested. Its targets sit at or below what the seed order buys '
      + 'so completion is a closed-form consequence of the fixture rather than of order history.',
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
  // Per-spec quantities, defaulting to the shared PERSKU_PRODUCTS pair. A progress fixture overrides
  // them so one order can land above one target and below another — see `goalItemQuantities`.
  const quantities = goalItemQuantities(spec);
  return PERSKU_PRODUCTS.map((p) => {
    const resolved = products?.[p.slot];
    if (!resolved?.id) throw new Error(`PerSku slot ${p.slot} has no resolved product`);
    return { missionId, productId: resolved.id, quantity: quantities[p.slot] };
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

  /* ── Targeting x public: the three declared cells ──────────────────────────
   * Targeting (the condition tree) and `public` (the advertise flag) are INDEPENDENT variables, and a
   * set that varies both at once cannot attribute a behaviour to either. Every rule below names a way
   * one of the three cells collapses into another while every fixture still seeds and still resolves.
   */

  if (!String(TARGET_GROUP || '').trim()) {
    problems.push('TARGET_GROUP is empty — a UserGroupIsCondition with no group targets nobody, and the whole targeting axis becomes unobservable');
  }
  if (GROUP_AUDIENCE.group !== TARGET_GROUP) {
    problems.push(`GROUP_AUDIENCE.group (${JSON.stringify(GROUP_AUDIENCE.group)}) disagrees with TARGET_GROUP (${JSON.stringify(TARGET_GROUP)}) — the fixtures would target one group while the audience assertions name another`);
  }
  if (GROUP_AUDIENCE.memberRole === GROUP_AUDIENCE.nonMemberRole) {
    problems.push('GROUP_AUDIENCE names the SAME role as member and non-member — "in the group" and "not in the group" would be asserted against one account, so neither can fail');
  }

  // Condition shapes. An empty `groups[]` is the silent one: the API stores it, the mission seeds, and
  // it aims at an audience nobody chose. A `groups` field on the NEUTRAL condition is the mirror image
  // — `buildConditionNode` copies it onto a node the module never reads, so the spec READS as targeted
  // while behaving as untargeted, which is the shape of the misreading this whole block exists for.
  for (const m of MISSIONS) {
    const c = m.condition || {};
    if (c.type === TARGETING.groupCondition.id) {
      const groups = c.groups;
      if (!Array.isArray(groups) || !groups.length || groups.some((g) => !String(g || '').trim())) {
        problems.push(`${m.aliasName}: ${TARGETING.groupCondition.id} with ${JSON.stringify(groups)} for ${TARGETING.groupCondition.field} — a missing or blank group still seeds and still resolves, and targets nothing anyone chose (the server's own check is fail-closed: an empty Groups[] returns false)`);
      }
      // The server compares with EqualsIgnoreCase and does NOT trim, so a padded group never matches
      // anything and never errors — the mission simply disappears for every customer.
      for (const g of Array.isArray(groups) ? groups : []) {
        if (typeof g === 'string' && g !== g.trim()) {
          problems.push(`${m.aliasName} targets ${JSON.stringify(g)}, which has leading/trailing whitespace — the server matches whole strings with EqualsIgnoreCase and never trims, so this silently matches nobody`);
        }
      }
    } else if (c.type === TARGETING.neutralCondition.id) {
      if ('groups' in c) {
        problems.push(`${m.aliasName}: ${TARGETING.neutralCondition.id} carries a groups field — buildConditionNode copies it onto a node the module never reads, so the fixture reads as audience-targeted while behaving as untargeted`);
      }
    } else if (c.type) {
      problems.push(`${m.aliasName}: condition type "${c.type}" is neither ${TARGETING.groupCondition.id} nor ${TARGETING.neutralCondition.id} — this build's template offers nothing else, so the create would be rejected`);
    }
  }

  // MSN_PUBLISHED_PRIVATE is the `public`-alone cell, and it is that ONLY while its condition stays
  // neutral. Give it a group and it becomes a second MSN_GROUP_VIP_PRIVATE: two fixtures varying both
  // variables together, and nothing left that can separate them. That conflation is exactly what made
  // the original set read as a privacy defect — "private" was in the name only.
  if (priv && priv.condition?.type !== TARGETING.neutralCondition.id) {
    problems.push(`MSN_PUBLISHED_PRIVATE must stay on the NEUTRAL ${TARGETING.neutralCondition.id} — it is the cell that isolates the \`public\` flag with targeting held constant, and a group on it merges it into the MSN_GROUP_VIP_PRIVATE cell`);
  }

  const vipPub = MISSION_BY_ALIAS.MSN_GROUP_VIP;
  const vipPriv = MISSION_BY_ALIAS.MSN_GROUP_VIP_PRIVATE;
  for (const [alias, m, wantPublic, why] of [
    ['MSN_GROUP_VIP', vipPub, true, 'it is the cell that isolates TARGETING, so the flag has to be held at its permissive value; flipped, it duplicates MSN_GROUP_VIP_PRIVATE and the targeting control disappears'],
    ['MSN_GROUP_VIP_PRIVATE', vipPriv, false, 'it is the cell that isolates the flag with targeting held constant; flipped, it duplicates MSN_GROUP_VIP'],
  ]) {
    if (!m) continue;
    if (m.public !== wantPublic) problems.push(`${alias} must be public=${wantPublic} — ${why}`);
    if (m.status !== 'Published') problems.push(`${alias} must stay Published — a Draft mission is filtered out for a second reason, so neither the targeting nor the flag explains its absence`);
    const groups = targetedGroups(m);
    if (!groups) {
      problems.push(`${alias} no longer carries a ${TARGETING.groupCondition.id} — on the neutral condition it is just another ordinary mission, and the targeting axis loses the cell it exists to fill`);
    } else if (groups.length !== 1 || groups[0] !== TARGET_GROUP) {
      problems.push(`${alias} targets ${JSON.stringify(groups)} but TARGET_GROUP is ${JSON.stringify(TARGET_GROUP)} — it must be the group the member account really carries, or "the member sees it" is asserted against an audience nobody is in`);
    }
  }
  if (vipPub && vipPriv) {
    if (vipPub.public === vipPriv.public) {
      problems.push('MSN_GROUP_VIP and MSN_GROUP_VIP_PRIVATE no longer differ on `public` — the pair collapses into one duplicated fixture and the flag stops being isolated at all');
    }
    const diff = specDifferences(vipPub, vipPriv);
    if (diff.length) {
      problems.push(`MSN_GROUP_VIP and MSN_GROUP_VIP_PRIVATE differ on ${diff.join(', ')} as well as \`public\` — with a second variable in play, a difference in behaviour can no longer be attributed to the flag, which is the whole reason the pair exists`);
    }
  }

  // Losing a cell is not a per-fixture error — every survivor is individually valid — so it has to be
  // asked of the SET. A set missing a cell still seeds, still resolves, and quietly answers two of the
  // three questions.
  const publishedCell = (targeted, isPublic) => MISSIONS.filter(
    (m) => m.status === 'Published' && isGroupTargeted(m) === targeted && m.public === isPublic,
  );
  const MATRIX = [
    ['targeted + public', true, true, 'does group targeting filter at all? (the positive control)'],
    ['targeted + private', true, false, 'does `public` add anything ON TOP of targeting?'],
    ['neutral + private', false, false, 'does `public` do anything ON ITS OWN?'],
  ];
  for (const [cell, targeted, isPublic, question] of MATRIX) {
    if (!publishedCell(targeted, isPublic).length) {
      problems.push(`the targeting x public matrix has no Published fixture in the "${cell}" cell — "${question}" becomes unanswerable, and every remaining fixture still looks correctly seeded`);
    }
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

  /* ── VCST-5346 progress fixtures ───────────────────────────────────────────
   * Each rule below names a way a progress fixture keeps seeding, keeps resolving through @td(), and
   * stops rendering the state it was built for. The percentages are re-DERIVED from the seed order
   * rather than trusted, so an edited goal quantity cannot leave a stale declaration behind.
   */

  // The seed order is what every prediction is relative to; a malformed one invalidates all three.
  const orderSlots = PROGRESS_ORDER.lines.map((l) => l.slot);
  if (new Set(orderSlots).size !== orderSlots.length) {
    problems.push('PROGRESS_ORDER repeats a slot — two lines on one product would double its quantity in a way no fixture accounts for');
  }
  for (const l of PROGRESS_ORDER.lines) {
    if (!PERSKU_PRODUCTS.some((p) => p.slot === l.slot)) problems.push(`PROGRESS_ORDER line references slot "${l.slot}", which PERSKU_PRODUCTS does not declare — the seeder has no product to resolve it to`);
    if (!(l.quantity > 0)) problems.push(`PROGRESS_ORDER line ${l.slot} needs a positive quantity`);
  }
  if (PROGRESS_ORDER_COUNT !== 1) {
    problems.push('PROGRESS_ORDER_COUNT is not 1, but the seeder places exactly one order — every OrderCount prediction would be wrong by construction');
  }
  if (!isSeededMissionName(progressOrderNumber())) {
    problems.push(`the provisioning order is named "${progressOrderNumber()}", which lacks the ${NAME_PREFIX}- prefix — teardown sweeps by that prefix and would leave it behind`);
  }

  const withProgress = progressFixtures();
  if (!withProgress.length) {
    problems.push('no fixture declares a `progress` expectation — the storefront card renders from loyaltyMissionProgress, so with none the whole VCST-5346 state axis is untestable');
  }
  for (const m of withProgress) {
    if (m.status !== 'Published' || m.public !== true) {
      problems.push(`${m.aliasName} declares a progress expectation but is not Published + public — the customer-facing query would never return it, so the state could not be observed at all`);
    }
    if (WINDOWS[m.window]?.expectOpen !== true) {
      problems.push(`${m.aliasName} declares a progress expectation on a CLOSED window — ProcessOrderAsync filters on OnlyActive, so the seed order would never contribute to it`);
    }
    const predicted = predictProgress(m);
    if (!predicted) {
      problems.push(
        `${m.aliasName} declares a progress expectation but its ${m.goal?.type} is not predictable from the seed order. `
        + 'An OrderValueGoal contributes order.Total, which the platform RECOMPUTES from line items, tax and shipping '
        + '(an authored 249.98 came back as 251.99 on vcst-qa), so any percentage declared here would be a guess no static check could catch.',
      );
      continue;
    }
    if (predicted.status !== m.progress.status) {
      problems.push(`${m.aliasName} declares status ${JSON.stringify(m.progress.status)} but the seed order yields ${JSON.stringify(predicted.status)} — the declaration and the fixture disagree, so one of them is testing something nobody chose`);
    }
    if (!percentagesMatch(predicted.percentage, m.progress.percentage)) {
      problems.push(`${m.aliasName} declares percentage ${m.progress.percentage} but the seed order yields ${predicted.percentage} — re-derive it or fix the goal quantities`);
    }
    for (const k of ['rowsMet', 'rowsUnmet']) {
      if (m.progress[k] != null && m.progress[k] !== predicted[k]) {
        problems.push(`${m.aliasName} declares ${k}=${m.progress[k]} but the seed order yields ${predicted[k]} — the per-row "target met" styling would be asserted against the wrong row count`);
      }
    }
  }

  const soon = MISSION_BY_ALIAS.MSN_ENDING_SOON;
  if (soon) {
    const w = WINDOWS[soon.window];
    if (!w) {
      problems.push(`MSN_ENDING_SOON declares unknown window intent "${soon.window}"`);
    } else {
      // daysRemaining = ceil(endDate - now) clamped at 0, and endDate = seedClock + endOffsetDays, so
      // the value never exceeds endOffsetDays and never goes below 0. Both bounds have to hold with
      // clock slack, or the fixture renders warning (too high) or vanishes from the page (too low).
      if (!(w.endOffsetDays < DANGER_THRESHOLD_DAYS)) {
        problems.push(`MSN_ENDING_SOON's window ends in ${w.endOffsetDays} days, so daysRemaining starts at ${w.endOffsetDays} — the storefront's danger branch needs < ${DANGER_THRESHOLD_DAYS} and the badge would render WARNING, the default state the fixture exists to escape`);
      }
      if (w.endOffsetDays > DANGER_THRESHOLD_DAYS - WINDOW_CLOCK_SLACK_DAYS) {
        problems.push(`MSN_ENDING_SOON's window ends in ${w.endOffsetDays} days, within ${WINDOW_CLOCK_SLACK_DAYS} of the ${DANGER_THRESHOLD_DAYS}-day boundary — a timezone or DST reading could push daysRemaining over it and flip the badge to warning intermittently, which reads as a product bug`);
      }
      if (w.endOffsetDays < WINDOW_CLOCK_SLACK_DAYS) {
        problems.push(`MSN_ENDING_SOON's window ends in ${w.endOffsetDays} days, leaving less than ${WINDOW_CLOCK_SLACK_DAYS} days of life — once it closes GetUserMissionsAsync drops the mission entirely and the case asserts a badge colour on a card that is not on the page`);
      }
      if (w.expectOpen !== true) {
        problems.push('MSN_ENDING_SOON must sit on an OPEN window (expectOpen=true) — an expired mission has no badge to colour');
      }
    }
    if (MISSIONS.filter((m) => m.window === 'endingSoon').length !== 1) {
      problems.push('more than one fixture sits on the endingSoon window — the danger-badge assertions can no longer name a single unambiguous subject');
    }
    if (predictProgress(soon)?.status === 'Completed') {
      problems.push('MSN_ENDING_SOON is COMPLETED by the seed order — the storefront colours a completed mission SUCCESS, which overrides the danger branch, so the fixture would render exactly the state it exists to exclude while still looking correctly seeded');
    }
    if (!(soon.goal?.count > PROGRESS_ORDER_COUNT)) {
      problems.push(`MSN_ENDING_SOON's target (${soon.goal?.count}) is not above the ${PROGRESS_ORDER_COUNT} order the seed places — it would complete, and a completed mission takes the success branch instead of the danger one`);
    }
  } else if (MISSIONS.some((m) => m.window === 'endingSoon')) {
    problems.push('a fixture sits on the endingSoon window but MSN_ENDING_SOON is gone — the danger-badge fixture is the declared one');
  }

  const partial = MISSION_BY_ALIAS.MSN_PROGRESS_PARTIAL;
  if (partial) {
    const p = predictProgress(partial);
    if (partial.goal?.type !== 'PerSkuGoal' || partial.goal?.all !== true) {
      problems.push('MSN_PROGRESS_PARTIAL must be a PerSkuGoal with all=true — the module computes PerSkuAny\'s percentage as a BINARY 0 or 100, so an Any goal has no partial state, and an OrderValue goal\'s percentage is not statically derivable');
    }
    if (!p || !(p.percentage > 0 && p.percentage < 100)) {
      problems.push(`MSN_PROGRESS_PARTIAL yields percentage ${p ? p.percentage : 'nothing'} — a partial fixture must be STRICTLY between 0 and 100 or the progress bar shows an end state and the "{current} of {target}" label is trivial`);
    }
    if (p?.status === 'Completed') {
      problems.push('MSN_PROGRESS_PARTIAL is completed by the seed order — it would render the Completed chip and the success bar, i.e. the other fixture\'s state');
    }
    if (!p || !(p.rowsMet >= 1 && p.rowsUnmet >= 1)) {
      problems.push('MSN_PROGRESS_PARTIAL no longer has one target-MET row and one target-UNMET row — the per-row "target met" styling then only ever shows one of its two states, and the modal cannot distinguish styling that works from styling that is never applied');
    }
  }

  const done = MISSION_BY_ALIAS.MSN_PROGRESS_COMPLETED;
  if (done) {
    const p = predictProgress(done);
    if (done.goal?.type !== 'PerSkuGoal') {
      problems.push('MSN_PROGRESS_COMPLETED must be a PerSku mission — the READ-ONLY modal branch (steppers and Add-to-cart hidden at Completed) exists only on the SKU modal, so a completed OrderCount mission leaves it untested');
    }
    if (!p || p.status !== 'Completed') {
      problems.push('MSN_PROGRESS_COMPLETED is NOT completed by the seed order — the Completed chip, the success bar and the read-only modal are all unreachable, and the case would assert them against an in-progress card');
    }
    if (!p || !percentagesMatch(p.percentage, 100)) {
      problems.push(`MSN_PROGRESS_COMPLETED yields percentage ${p ? p.percentage : 'nothing'} rather than 100 — a "completed" card with a part-filled bar is a contradiction the fixture must not manufacture`);
    }
    if (p && p.rowsUnmet !== 0) {
      problems.push(`MSN_PROGRESS_COMPLETED leaves ${p.rowsUnmet} SKU row(s) below target — every row must be met, or the modal shows unmet rows on a completed mission`);
    }
  }

  // The three states must be DISTINCT. Collapse two of them and the set still seeds, still resolves,
  // and quietly covers two states instead of three.
  const states = withProgress.map((m) => `${m.progress.status}:${m.progress.percentage}`);
  if (new Set(states).size !== states.length) {
    problems.push(`two progress fixtures declare the SAME state (${states.join(', ')}) — one of them is redundant and the state it was meant to cover is now uncovered`);
  }

  // A per-slot override that names a slot nobody declares is silently ignored by buildGoalItems.
  for (const m of MISSIONS) {
    if (!m.goalItemQuantities) continue;
    if (!needsGoalItems(m)) {
      problems.push(`${m.aliasName} declares goalItemQuantities but its ${m.goal?.type} has no SKU targets — a dead override reads as coverage that does not exist`);
    }
    for (const [slot, qty] of Object.entries(m.goalItemQuantities)) {
      if (!PERSKU_PRODUCTS.some((p) => p.slot === slot)) problems.push(`${m.aliasName}.goalItemQuantities names slot "${slot}", which PERSKU_PRODUCTS does not declare — buildGoalItems ignores it silently`);
      if (!(qty > 0)) problems.push(`${m.aliasName}.goalItemQuantities.${slot} must be positive — the module treats 0 >= 0 as satisfied WITHOUT the SKU being bought, so a zero target completes the mission on any order at all`);
    }
  }

  return problems;
}

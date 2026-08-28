/**
 * seed-missions-e2e.mjs — the per-run test-data foundation for suite 083d (loyalty missions E2E).
 *
 * WHAT IT PROVISIONS, AND THE ONE SENTENCE THAT EXPLAINS THE SHAPE
 * ---------------------------------------------------------------
 * Mission progress is per-(user, mission), cumulative, monotonic, FROZEN once the mission completes,
 * and there is no reset path anywhere in vc-module-loyalty. So the only fixture that starts at 0%
 * every single run is a mission that did not exist before the run started. This seeder mints four,
 * names them with a run handle, and writes the runtime ids to aliases.<env>.json.
 *
 * Rationale, the fixture inventory, and every vacuity rule live in `missions-e2e-specs.mjs` (imported,
 * never restated). This file is the I/O half: resolve -> sweep -> mint -> verify -> write back.
 *
 * ORDER OF OPERATIONS, and why it is this order
 *   1. Guards: ENV_RISK, auth, and the store's `Loyalty.Missions.Enable` READ (never written here —
 *      seed-loyalty-missions.mjs owns that setting and two owners would fight over it).
 *   2. Products: stable, find-or-create, non-tracked, packSize 1, priced, linked, INDEXED. Before the
 *      missions, because a PerSku goal item needs a productId.
 *   3. Sweep: delete E2E missions older than the age floor. Before minting, so a long-lived env does
 *      not accumulate; after the products, so a failure here does not leave a half-built catalog.
 *   4. Mint: four missions carrying this run's handle, plus their goal items.
 *   5. VERIFY, and this is the step whose absence caused the 6-BLOCKED run REG-2026-08-28-1154:
 *      probe live progress for the bound accounts and REFUSE to write an alias for a mission that is
 *      not in a pre-completion state. A fixture that is not usable must fail the seed, not the suite.
 *   6. Reward account: bind to the per-run ephemeral LOYALTY_ZERO_USER, read its live balance, and
 *      assert the reward is legible against it.
 *   7. Write back: every runtime id + every OBSERVED seed-time state into aliases.<env>.json.
 *
 * Usage:
 *   npm run seed:missions-e2e                     # zero-user + this seeder (the normal entry point)
 *   node scripts/seed-data/loyalty/seed-missions-e2e.mjs [--dry-run] [--verbose]
 *   node scripts/seed-data/loyalty/seed-missions-e2e.mjs --teardown [--max-age-hours N] [--all]
 *   ... --keep-products                           # teardown the run's missions, keep the catalog fixtures
 *
 * TEARDOWN is a PREFIX SWEEP with an age floor, not an inline delete of "this run's" ids, because a
 * crashed run leaks its missions and nothing would ever reclaim them. `--max-age-hours` (default 6)
 * spares younger runs so a concurrent 083d execution is never torn down underneath itself; `--all`
 * removes every E2E mission regardless of age and is the deliberate, explicit form.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, STORE_ID, BACK_URL, DRY_RUN, TEARDOWN, VERBOSE,
  log, verbose, assertSafeTarget, auth, api,
  ensureVirtualCatalog, ensureCategoryPath, ensureCurrencies, buildStoreSeo, SEED_FAMILY,
  writeEnvAliasOverride, verifyRemoved, idsParam, loadAliases, loadCsv,
} from '../../lib/seed-common.mjs';
import { STORE_SETTING, resolveCurrencies, readingValues } from './missions-specs.mjs';
import {
  createEphemeralAccount, sweepEphemeralAccounts, findEphemeralAccounts, storefrontToken, password,
} from '../../lib/loyalty-ephemeral-account.mjs';
import {
  SEED_PREFIX, PRODUCTS, UNIT_PRODUCT, RUNTIME_FIELDS_BY_KIND,
  MISSIONS, ALL_MISSIONS, MISSION_BY_ALIAS, REWARD_USER, DEFAULT_SWEEP_MAX_AGE_HOURS,
  CASE_MISSIONS, CASE_ACCOUNTS, CASE_ACCOUNT_PREFIX, isCaseMission,
  measuredMoney, deriveCaseTarget, attributionProblems, shippingHeadroom, taxRateOf,
  newRunId, missionName, isE2EMissionName, runIdFromName, runIdAgeHours,
  buildE2EMissionBody, buildGoalItems, needsGoalItems, missionSlots,
  isPreCompletion, balanceIsLegible, validateSpecShape,
  unitsToComplete, unitsJustBelow, discountBand,
} from './missions-e2e-specs.mjs';

const argv = process.argv.slice(2);
const SWEEP_ALL = argv.includes('--all');
const KEEP_PRODUCTS = argv.includes('--keep-products');
const MAX_AGE_HOURS = argv.includes('--max-age-hours')
  ? Number(argv[argv.indexOf('--max-age-hours') + 1])
  : DEFAULT_SWEEP_MAX_AGE_HOURS;

const CATEGORY_PATH = 'Loyalty Missions E2E';
const PRICELIST_NAME = (currency) => `AGENT-TEST-MSN-E2E-${currency}`;
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

let VIRTUAL_CATALOG_ID = null;

/* ── Overlay reads (direct, not through the resolver) ────────────────────────
 *
 * Read raw rather than through `@td()` so the seeder has no dependency on the resolver's own alias
 * contract, and so an absent overlay is an ordinary first-seed state rather than a throw.
 */
function overlay() {
  const env = process.env.TEST_ENV || 'vcst';
  const p = join(ROOT, `test-data/aliases.${env}.json`);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) || {}; } catch { return {}; }
}

/* ── Currencies ──────────────────────────────────────────────────────────────── */

/**
 * Resolve every currency intent this fixture set uses. `store-default` comes from the live store;
 * `loyalty` comes from the committed LOYALTY_SETTINGS alias, which is the repo's declared source of
 * truth for the points currency — never the literal 'PTS', which is per-deployment configuration.
 */
function resolveIntents(store) {
  const base = resolveCurrencies(store);
  const loyalty = String(loadAliases()?.LOYALTY_SETTINGS?.currency_code || '').trim();
  if (!loyalty) {
    throw new Error(
      'LOYALTY_SETTINGS.currency_code is empty in test-data/aliases.json — the PTS-priced PerSku target '
      + '(MSN-E2E-007) has no currency to be priced in, and pricing it in the store default would make the '
      + 'case ask nothing.',
    );
  }
  if (loyalty.toUpperCase() === String(base['store-default']).toUpperCase()) {
    throw new Error(
      `the loyalty currency (${loyalty}) is the store default on this env — MSN-E2E-007 asks whether a `
      + 'NON-default-currency line counts toward a PerSku quantity target, and it cannot ask that here.',
    );
  }
  return { ...base, loyalty };
}

/**
 * Resolve the fixture category, OVERLAY-FIRST.
 *
 * `ensureCategoryPath` finds an existing category through `POST /api/catalog/listentries`, which is
 * INDEX-backed — and category documents on this env are not in that index (a keyword search for a
 * category created minutes earlier returns nothing, measured on vcst-qa 2026-08-28). So the helper
 * believes the category is absent and creates a SECOND one with the same code: run 1 produced
 * 69bfb80d…, run 2 produced 7ab4155a…, and run 2 then re-linked the products under the duplicate
 * while their `categoryId` still pointed at the original. On a seeder that runs on EVERY execution
 * that is one orphaned category per run, quietly.
 *
 * The fix is the same "overlay id first, index second" order `seed-loyalty-missions.mjs` already uses
 * for its zero-stock product: `GET /api/catalog/categories/{id}` is DATABASE-backed and authoritative,
 * so a pinned id resolves whatever the index thinks. `ensureCategoryPath` remains the fallback for a
 * first seed or a cleared overlay — this deliberately does not change the shared helper, whose
 * behaviour every other seeder depends on.
 */
/** The code `ensureCategoryPath` gives this fixture category — derived by its own rule, not transcribed. */
const FIXTURE_CATEGORY_CODE = `${SEED_FAMILY}-${slugify(CATEGORY_PATH)}`;

/**
 * Every category in `catalogId` carrying this fixture's code — usually one, more only when a previous
 * run died between creating it and writing its pin.
 *
 * BROWSE-backed, not keyword-backed, and that difference is the whole point. The shared
 * `findCategoryByCode` searches `listentries` with `keyword: <code>`, which on this env returns
 * nothing for a category however recently it was created — the index gap that made every run mint a
 * duplicate. Dropping the keyword and listing the catalog's categories DOES return them (measured
 * 2026-08-28: 17 categories, including three same-code orphans invisible to the keyword search). The
 * shared helper is deliberately left alone — every other seeder depends on its behaviour.
 */
async function listFixtureCategories(catalogId) {
  if (!catalogId) return [];
  const r = await api('POST', '/api/catalog/listentries', { catalogId, take: 500, objectTypes: ['Category'] }, { expectStatus: [200, 201, 400, 404] }).catch(() => null);
  return (r?.listEntries || r?.results || [])
    .filter((c) => String(c.type).toLowerCase() === 'category' && c.code === FIXTURE_CATEGORY_CODE);
}

async function ensureLocation() {
  const pinned = overlay().MSN_E2E_RUN || {};
  if (pinned.category_id && pinned.catalog_id) {
    const cat = await api('GET', `/api/catalog/categories/${pinned.category_id}`, null, { expectStatus: [200, 404] }).catch(() => null);
    if (cat?.id && cat.catalogId === pinned.catalog_id) {
      log(`  ↻ category (pinned): ${cat.name} (${cat.id})`);
      return { catalogId: cat.catalogId, categoryId: cat.id, name: cat.name, pinned: true };
    }
    verbose(`pinned category ${pinned.category_id} no longer resolves`);
  }
  // SECOND CHANCE before creating anything: a run that died before write-back left a category with no
  // pin, and `ensureCategoryPath` cannot see it. Reuse the oldest match rather than minting another —
  // that is what turns "one orphan per crashed run, forever" into "at most one".
  if (pinned.catalog_id) {
    const existing = await listFixtureCategories(pinned.catalog_id);
    if (existing.length) {
      const reuse = existing[0];
      if (existing.length > 1) log(`  ⚠ ${existing.length} categories share the code ${FIXTURE_CATEGORY_CODE} (orphans from runs that died before write-back) — reusing ${reuse.id}; teardown sweeps them all`);
      log(`  ↻ category (by code): ${reuse.name} (${reuse.id})`);
      return { catalogId: pinned.catalog_id, categoryId: reuse.id, name: reuse.name, pinned: false };
    }
  }
  const loc = await ensureCategoryPath(api, CATEGORY_PATH);
  if (!loc) throw new Error(`could not resolve category path "${CATEGORY_PATH}"`);
  return { ...loc, pinned: false };
}

/* ── Pricelists ──────────────────────────────────────────────────────────────── */

/**
 * One pricelist per currency, assigned to the VIRTUAL catalog — that is the catalog the storefront
 * resolves prices through (a pricelist assigned only to the physical catalog is invisible to it, which
 * renders as an unpriced product and reads as a different defect entirely).
 */
async function ensurePricelist(currency) {
  const name = PRICELIST_NAME(currency);
  const search = await api('GET', `/api/pricing/pricelists?keyword=${encodeURIComponent(name)}`, null, { expectStatus: [200, 404] });
  let pl = (search?.results || []).find((p) => p?.name === name);
  if (pl) { verbose(`pricelist ${name} → ${pl.id}`); return pl; }
  if (DRY_RUN) { log(`  [DRY] would create pricelist ${name} (${currency})`); return { id: `dry-pl-${currency}` }; }
  pl = await api('POST', '/api/pricing/pricelists', {
    name, currency, description: 'suite 083d loyalty-missions E2E fixtures',
  }, { expectStatus: [200, 201] });
  try {
    await api('POST', '/api/pricing/assignments', {
      name: `${name} → ${STORE_ID}`, pricelistId: pl.id, catalogId: VIRTUAL_CATALOG_ID, priority: 100,
    }, { expectStatus: [200, 201] });
  } catch (e) { log(`  ⚠ pricelist ${name} created but its catalog assignment failed: ${String(e.message).slice(0, 140)}`); }
  log(`  ✓ pricelist ${name} (${currency}) → ${pl.id}`);
  return pl;
}

/* ── Products ────────────────────────────────────────────────────────────────── */

async function findProductByCode(code) {
  // Deliberately catalog-BLIND: these codes are AGENT-TEST-MSN-E2E- prefixed and therefore globally
  // unique, and a catalog-scoped lookup was measured to miss products the unscoped one finds — which
  // sends a find-or-create straight into a duplicate-key HTTP 500.
  const r = await api('POST', '/api/catalog/listentries', { keyword: code, take: 10 }, { expectStatus: [200, 201, 400, 404] });
  const hit = (r?.listEntries || r?.results || []).find((p) => p.code === code && p.type === 'product');
  return hit ? { id: hit.id, code, name: hit.name, catalogId: hit.catalogId } : null;
}

/**
 * Find-or-create one fixture product, then bring its price, pack size and catalog link to spec.
 *
 * `trackInventory: false` is load-bearing rather than lazy: 083d places real orders on every run
 * forever, so a stock-tracked fixture drains and starts blocking cases for a reason that has nothing
 * to do with missions.
 */
async function ensureProduct(spec, location, pricelistByCurrency, currencies) {
  const currency = currencies[spec.currencyIntent];
  if (!currency) throw new Error(`${spec.aliasName}: currency intent "${spec.currencyIntent}" did not resolve`);
  const pricelist = pricelistByCurrency[currency];
  if (!pricelist?.id) throw new Error(`${spec.aliasName}: no pricelist for ${currency}`);

  let product = await findProductByCode(spec.sku);
  const slug = slugify(spec.sku);
  if (!product) {
    if (DRY_RUN) { log(`  [DRY] would create ${spec.sku} (${spec.productName})`); return { ...spec, id: `dry-${spec.slot}`, catalogId: location.catalogId, currency, slug, url: `/${slug}` }; }
    const created = await api('POST', '/api/catalog/products', {
      catalogId: location.catalogId,
      categoryId: location.categoryId,
      code: spec.sku,
      name: spec.productName,
      productType: 'Physical',
      vendor: 'QA',
      isActive: true,
      isBuyable: true,
      trackInventory: false,
      packSize: spec.packSize,
      minQuantity: 1,
      // A STORE-SCOPED SEO record: `/product/<sku>` does NOT resolve on this storefront (a client-side
      // 404 behind HTTP 200), so without a slug every PDP link in the mission modal is broken and a
      // case cannot tell a broken link from the state it is actually asserting.
      seoInfos: [buildStoreSeo({ semanticUrl: slug, pageTitle: spec.productName })],
    }, { expectStatus: [200, 201] });
    product = { id: created.id, code: spec.sku, name: spec.productName, catalogId: location.catalogId };
    log(`  ✓ created ${spec.sku} → ${product.id}`);
  } else {
    verbose(`${spec.sku} exists → ${product.id}`);
  }

  if (DRY_RUN) return { ...spec, id: product.id, catalogId: product.catalogId, currency, slug, url: `/${slug}` };

  // PACK SIZE, re-asserted every run. This is gap 3: a product whose pack size drifts above 1 makes
  // the stepper jump (0 -> 2 -> 0) and every "set the quantity to exactly 1" step unachievable — and
  // it drifts silently, because the product still exists and still adds to cart.
  const full = await api('GET', `/api/catalog/products/${product.id}`);
  const livePack = Number(full?.packSize ?? 1) || 1;
  if (livePack !== spec.packSize) {
    await api('PUT', '/api/catalog/products', { ...full, packSize: spec.packSize, minQuantity: 1 }, { expectStatus: [200, 204] });
    log(`  ✓ ${spec.sku}: packSize ${livePack} → ${spec.packSize}`);
  }

  await api('PUT', '/api/products/prices', [{
    productId: product.id,
    prices: [{ pricelistId: pricelist.id, productId: product.id, list: spec.listPrice, currency, minQuantity: 1 }],
  }], { expectStatus: [200, 204] });

  // Link under the virtual catalog's category (drop a stale root link first — a product linked at the
  // root and under a category renders twice).
  await api('POST', '/api/catalog/listentrylinks/delete', [{ listEntryId: product.id, listEntryType: 'product', catalogId: VIRTUAL_CATALOG_ID }], { expectStatus: [200, 204, 404] }).catch(() => {});
  await api('POST', '/api/catalog/listentrylinks', [{ listEntryId: product.id, listEntryType: 'product', catalogId: VIRTUAL_CATALOG_ID, categoryId: location.categoryId }], { expectStatus: [200, 204] });

  const seo = (full?.seoInfos || []).find((s) => s.semanticUrl);
  return {
    ...spec,
    id: product.id,
    catalogId: product.catalogId || location.catalogId,
    currency,
    slug: seo?.semanticUrl || slug,
    url: `/${seo?.semanticUrl || slug}`,
  };
}

/**
 * The storefront resolves products through the SEARCH INDEX, so a product that exists in the database
 * and is not indexed is invisible in the mission modal — created, aliased, guarded, and testing
 * nothing. Incremental (`rebuild: false`), never a full rebuild: on a shared QA env that is somebody
 * else's outage.
 */
async function ensureIndexed(products) {
  if (DRY_RUN) return;
  const codes = products.map((p) => p.sku);
  const findAll = async () => {
    const missing = [];
    for (const code of codes) if (!(await findProductByCode(code))) missing.push(code);
    return missing;
  };
  let missing = await findAll();
  if (!missing.length) { verbose('all fixture products already indexed'); return; }
  const reindex = () => api('POST', '/api/search/indexes/index', [{ documentType: 'CatalogProduct', rebuild: false }], { expectStatus: [200, 201, 202, 204] })
    .catch((e) => verbose(`reindex trigger: ${String(e.message).slice(0, 120)}`));
  await reindex();
  for (let i = 0; i < 12 && missing.length; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    missing = await findAll();
    if (missing.length && i === 5) await reindex();
  }
  if (missing.length) {
    throw new Error(
      `${missing.join(', ')} exist but are NOT in the CatalogProduct search index after ~2 min. The storefront `
      + 'resolves mission-modal products through that index, so those rows would simply not render and the '
      + 'fixture would look seeded while testing nothing.',
    );
  }
  log(`  ✓ all ${codes.length} fixture products indexed`);
}

/* ── Missions ────────────────────────────────────────────────────────────────── */

async function allE2EMissions() {
  const r = await api('POST', '/api/loyalty-missions/search', { take: 500 }, { expectStatus: [200, 201] });
  return (r?.results || []).filter((m) => isE2EMissionName(m.name));
}

async function deleteMissions(ids) {
  if (!ids.length) return;
  await api('DELETE', `/api/loyalty-missions?${idsParam(ids)}`, null, { expectStatus: [200, 204] });
}

/**
 * Remove E2E missions from previous runs. Age-floored so a 083d execution running beside this one is
 * never torn down underneath itself — the same guard, for the same reason, as the ephemeral loyalty
 * user's `--max-age-hours`.
 */
async function sweepStaleMissions({ all = false, maxAgeHours = MAX_AGE_HOURS, exceptRunId = null, now = new Date() } = {}) {
  const live = await allE2EMissions();
  const doomed = [];
  const spared = [];
  for (const m of live) {
    const rid = runIdFromName(m.name);
    if (rid && rid === exceptRunId) continue;
    const age = runIdAgeHours(rid, now);
    // An UNPARSABLE handle is swept only under --all. It cannot be aged, so sweeping it by default
    // would risk deleting a mission a concurrent run just created under a naming change.
    if (all || (age != null && age > maxAgeHours)) doomed.push(m);
    else spared.push({ name: m.name, ageHours: age });
  }
  if (spared.length) log(`  – sparing ${spared.length} mission(s) younger than ${maxAgeHours}h: ${spared.map((s) => s.name).join(', ')}`);
  if (!doomed.length) { log('  – no stale E2E missions to sweep'); return 0; }
  if (DRY_RUN) { log(`  [DRY] would delete ${doomed.length} stale mission(s): ${doomed.map((m) => m.name).join(', ')}`); return doomed.length; }
  await deleteMissions(doomed.map((m) => m.id));
  log(`  ✗ swept ${doomed.length} stale E2E mission(s)`);
  return doomed.length;
}

async function syncGoalItems(spec, missionId, resolvedBySlot) {
  const desired = buildGoalItems(spec, missionId, resolvedBySlot);
  if (!desired.length) return;
  if (DRY_RUN) { log(`  [DRY] would create ${desired.length} goal item(s) for ${spec.aliasName}`); return; }
  // A freshly minted mission has no goal items, so this is a straight create — no reconcile is needed
  // here (unlike the stable seeder, which reuses missions). The UNIQUE (MissionId, ProductId) index
  // therefore cannot be hit.
  for (const row of desired) await api('POST', '/api/loyalty-mission-goal-items', row, { expectStatus: [200, 201] });
  log(`  ✓ ${spec.aliasName}: ${desired.length} goal item(s) → ${missionSlots(spec).join(', ')}`);
}

/* ── Progress + balance verification ─────────────────────────────────────────── */

async function progressByMission(missionIds, userId) {
  if (!missionIds.length || !userId) return new Map();
  const r = await api('POST', '/api/loyalty-mission-progress/search', { missionIds, userId, take: 200 }, { expectStatus: [200, 201] });
  return new Map((r?.results || []).map((p) => [p.missionId, p]));
}

/**
 * The state the STOREFRONT sees, which is a different question from what the admin progress table
 * holds and is the one 083d actually asserts against.
 *
 * Two failures are only visible here. (a) REACHABILITY: a mission can be minted, Published and public
 * and still not come back from `loyaltyMissionProgress` — and a mission the customer-facing query
 * omits blocks every case in the suite while every admin-side check stays green. (b) The customer
 * query reports a mission with NO progress row as `InProgress 0% isStarted=false`, whereas the admin
 * search simply has no row; recording the storefront's own vocabulary means the overlay says what the
 * suite will see rather than what the seeder inferred.
 *
 * Run as admin with an explicit `userId` (the authorization handler allows admin-or-self), so the
 * seeder never needs the customer's password. `cultureName` is required — without it the description
 * resolver throws ARGUMENT_NULL for every item.
 */
/** `/graphql` needs its own bearer; seed-common keeps its admin token private. */
async function gql(query, variables) {
  const res = await fetch(`${BACK_URL}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password', username: process.env.ADMIN, password: process.env.ADMIN_PASSWORD, scope: 'offline_access',
    }),
  });
  if (!res.ok) throw new Error(`graphql token failed: ${res.status}`);
  const token = (await res.json()).access_token;
  const r = await fetch(`${BACK_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json();
  if (json.errors) throw new Error(`graphql failed: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

async function customerVisibleMissions(userId, culture = 'en-US') {
  const query = `query($s:String!,$u:String,$c:String){ loyaltyMissionProgress(storeId:$s userId:$u first:200 cultureName:$c){ items {
    missionId name status percentage currentValue targetValue isStarted missionType items { productId currentQuantity targetQuantity } } } }`;
  const data = await gql(query, { s: STORE_ID, u: userId, c: culture });
  return new Map((data?.loyaltyMissionProgress?.items || []).map((i) => [i.missionId, i]));
}

/**
 * Read each fixture product's REAL storefront facts off the xAPI the storefront itself reads — slug,
 * buyability, stock, resolved price — and fail if any of them would block a case.
 *
 * The slug in particular is DERIVED, never composed. The seeder writes a flat `semanticUrl` when it
 * creates the product, but the storefront serves a NESTED path (`<category-slug>/<product-slug>`,
 * measured on vcst-qa 2026-08-28: `seed-loyalty-missions-e2e/agent-test-msn-e2e-unit`). A case
 * navigating a composed `{{FRONT_URL}}/agent-test-msn-e2e-unit` gets a client-side 404 behind HTTP
 * 200 — an SPA soft-404 that a status check cannot detect — so the path has to come from the product
 * resolver rather than from string concatenation (.claude/rules/test-data.md GOLDEN RULE, and the
 * `feedback_never_invent_storefront_routes` rule).
 */
async function resolveStorefrontFacts(products) {
  const query = `query($s:String!,$c:String!,$cu:String!,$id:String!){ product(storeId:$s cultureName:$c currencyCode:$cu id:$id){
    code slug availabilityData{ isBuyable isInStock isActive } price{ list{ amount currency{ code } } } } }`;
  const problems = [];
  const out = [];
  for (const p of products) {
    const data = await gql(query, { s: STORE_ID, c: 'en-US', cu: p.currency, id: p.id });
    const live = data?.product;
    if (!live) { problems.push(`${p.sku}: the storefront product resolver returns nothing for ${p.currency} — no case can add it to a cart`); out.push(p); continue; }
    if (live.availabilityData?.isBuyable !== true) problems.push(`${p.sku}: isBuyable=false — every case that adds it to a cart is blocked`);
    if (live.availabilityData?.isInStock !== true) problems.push(`${p.sku}: isInStock=false despite trackInventory=false — the add-to-cart control renders disabled`);
    const amount = Number(live.price?.list?.amount);
    const code = live.price?.list?.currency?.code;
    if (!(amount > 0)) problems.push(`${p.sku}: the storefront resolves no ${p.currency} price (got ${live.price?.list?.amount}) — the line would render unpriced, which reads as a different defect`);
    else if (amount !== Number(p.listPrice) || String(code) !== String(p.currency)) {
      problems.push(`${p.sku}: the storefront resolves ${amount} ${code} but the fixture declares ${p.listPrice} ${p.currency} — every order-value calculation in 083d is composed from the declared price`);
    }
    if (!live.slug) problems.push(`${p.sku}: the storefront resolves no slug — the PDP link in the mission modal would be broken`);
    out.push({ ...p, slug: live.slug || p.slug, url: `/${String(live.slug || p.slug).replace(/^\/+/, '')}` });
  }
  if (problems.length) throw new Error(`fixture products are not usable from the storefront:\n    ${problems.join('\n    ')}`);
  log(`  ✓ ${out.length} product(s) buyable, priced and slug-resolved on the storefront`);
  return out;
}

/** Live balance via the admin op-log endpoint. Keyed on the SECURITY-ACCOUNT id, not the member id. */
async function readBalance(userId) {
  const r = await api('GET', `/api/loyalty-program-operation-log/balance/${encodeURIComponent(userId)}`, null, { expectStatus: [200, 404] });
  if (typeof r === 'number') return r;
  return Number(r?.balance ?? r?.points ?? r?.amount ?? 0) || 0;
}

/**
 * The per-run zero-balance account, as `seed-loyalty-ephemeral-user.mjs` last left it. NOT provisioned
 * here — a second ephemeral-account provisioner would be a second implementation of a solved problem
 * and the two would drift. `npm run seed:missions-e2e` runs that seeder first.
 */
function rewardAccountFromOverlay() {
  const src = overlay()[REWARD_USER.sourceAlias] || {};
  return {
    email: src.email || '',
    userId: src.securityAccountId || '',
    memberId: src.memberId || '',
  };
}

/* ── Per-case accounts + probe carts ─────────────────────────────────────────
 *
 * WHY THE ACCOUNTS EXIST. `LoyaltyMissionLogicService.ProcessOrderAsync` runs once per order INSERT
 * and advances EVERY mission applicable to that order's user. Progress is keyed per-(user, mission),
 * so four missions on one account are all moved by any one case's order — minting more missions on a
 * shared account multiplies the rows an order touches instead of isolating anything. The account is
 * the axis that isolates, and MSN-E2E-004 already demonstrated it: same mission definition, own
 * account, never contended.
 *
 * WHY THE PROBE CARTS EXIST. Every per-case target has to be placed against quantities the PLATFORM
 * composes, not against `units x listPrice`. vcst-qa applies a 20% tax nothing in this repo had
 * declared, so the modelled `postDiscount` the old fixture published was 8.00 away from the real
 * total — four times the band it was meant to discriminate inside. The seeder therefore builds the
 * case's cart on the case's own account, reads what came back, and derives the target from that.
 */

/** A customer-scoped GraphQL call. Separate from `gql()`, which is the admin one. */
async function customerGql(token, query, variables) {
  const r = await fetch(`${BACK_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json();
  if (json.errors) throw new Error(`customer graphql failed: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

const PROBE_CART_NAME = 'agent-test-msn-e2e-probe';

/**
 * Resolve a CSV-backed coupon ALIAS to the code the storefront actually accepts.
 *
 * The spec module names the alias (`COUPON_20PCT`), never the literal `SUPER` — a coupon code is
 * fixture data that moves, and `.claude/rules/test-data.md` forbids transcribing it. The `@td()`
 * resolver itself is TypeScript and this seeder runs under plain `node`, so the two-field lookup is
 * done here against the same alias definition the resolver reads.
 */
function resolveCouponCode(aliasName) {
  const def = loadAliases()?.[aliasName];
  if (!def) throw new Error(`coupon alias ${aliasName} is not in test-data/aliases.json`);
  if (def.code) return String(def.code);                        // inline form
  // An alias's `file` is resolver-relative and extension-less (`promotions/coupons`); `loadCsv` takes
  // a repo-relative path. Getting this wrong exits(2) inside the helper with a message that names the
  // wrong thing, so the mapping is done explicitly here.
  const rows = loadCsv(`test-data/${def.file}.csv`);
  const [filterCol, filterVal] = Object.entries(def.filter || {})[0] || [];
  const col = def.fields?.code || 'code';
  const row = rows.find((r) => String(r[filterCol]) === String(filterVal));
  if (!row?.[col]) {
    throw new Error(
      `coupon alias ${aliasName} does not resolve to a code (${def.file} where ${filterCol}=${filterVal}). `
      + 'MSN-E2E-005 is sized on the gap between a discounted and an undiscounted cart, so without a real '
      + 'coupon the fixture would be measured against two identical carts and decide nothing.',
    );
  }
  return String(row[col]);
}

const CART_FIELDS = `
  itemsCount
  subTotal{amount} shippingTotal{amount} taxTotal{amount} discountTotal{amount} total{amount}
  coupons{ code isAppliedSuccessfully }
  availableShippingMethods{ code optionName price{amount} }`;

/**
 * Build the exact cart the case will place, read what the platform made of it, then empty it again.
 *
 * The cart is named, not the default one, so a probe can never leave anything in the cart the case
 * itself opens. It is cleared before AND after: before, because a crashed earlier run may have left
 * lines in it; after, because a case that signs in to a non-empty cart is a case debugging someone
 * else's state.
 */
async function measureCart(token, userId, currency, productId, { units, coupon = null }) {
  const ctx = { storeId: STORE_ID, userId, cartName: PROBE_CART_NAME, currencyCode: currency, cultureName: 'en-US', cartType: null };
  const clear = () => customerGql(token, 'mutation($c:InputClearCartType!){ clearCart(command:$c){ id } }', { c: ctx });
  await clear();
  await customerGql(token, 'mutation($c:InputAddItemType!){ addItem(command:$c){ id } }', { c: { ...ctx, productId, quantity: units } });
  if (coupon) {
    await customerGql(token, 'mutation($c:InputAddCouponType!){ addCoupon(command:$c){ id } }', { c: { ...ctx, couponCode: coupon } });
  }
  const q = `query($s:String!,$u:String!,$n:String!,$cu:String!,$c:String!){ cart(storeId:$s userId:$u cartName:$n currencyCode:$cu cultureName:$c){${CART_FIELDS}} }`;
  const cart = (await customerGql(token, q, { s: STORE_ID, u: userId, n: PROBE_CART_NAME, cu: currency, c: 'en-US' })).cart;
  if (!cart || Number(cart.itemsCount) < 1) throw new Error(`probe cart for ${units} unit(s) came back empty — the fixture product is not addable on this account`);
  if (coupon) {
    const applied = (cart.coupons || []).find((c) => String(c.code).toUpperCase() === String(coupon).toUpperCase());
    if (!applied?.isAppliedSuccessfully) {
      throw new Error(
        `coupon ${coupon} did not apply on the probe cart (${JSON.stringify(cart.coupons)}). MSN-E2E-005's `
        + 'whole band is the gap between the discounted and undiscounted totals, so without the discount the '
        + 'fixture would be sized against two identical carts and the case would decide nothing.',
      );
    }
  }
  await clear();
  return cart;
}

/** Mint the per-case accounts, after sweeping stale ones. Age-floored, same reason as the missions. */
async function ensureCaseAccounts({ maxAgeHours = MAX_AGE_HOURS, all = false } = {}) {
  const { removed, spared } = await sweepEphemeralAccounts(api, {
    prefix: CASE_ACCOUNT_PREFIX, maxAgeHours: all ? null : maxAgeHours, dryRun: DRY_RUN, log, verbose,
  });
  if (removed || spared) log(`  – per-case accounts: swept ${removed}, spared ${spared} younger than ${maxAgeHours}h`);

  const accounts = {};
  for (const a of CASE_ACCOUNTS) {
    // withOrg is required: the org supplies the shipping ADDRESSES checkout needs, and a brand-new
    // contact has none — the cart never reaches a decisive place-order state without them.
    const user = await createEphemeralAccount(api, {
      prefix: CASE_ACCOUNT_PREFIX, storeId: STORE_ID, withOrg: true,
      lastName: a.caseId.replace(/[^A-Za-z0-9]/g, ''), dryRun: DRY_RUN, log, verbose,
    });
    accounts[a.aliasName] = { ...user, caseId: a.caseId, missionAlias: a.missionAlias };
  }
  return accounts;
}

/**
 * Measure every per-case cart and derive every per-case target.
 *
 * Returns `{ [missionAlias]: { money, undiscounted, derived, headroom, shipping, readings } }`.
 * Throws rather than degrading: a target that cannot be placed in a real band means the fixture
 * cannot discriminate, and that must fail the SEED, not the suite.
 */
async function measureCaseCarts(accounts, currency, unitProductId) {
  const out = {};
  for (const spec of CASE_MISSIONS) {
    const acct = accounts[spec.accountAlias];
    const token = await storefrontToken(BACK_URL, STORE_ID, acct.email, password());
    if (!token) {
      throw new Error(
        `could not obtain a storefront token for ${acct.email} (${spec.caseId}). The account was just created, `
        + 'so this is the status/emailConfirmed/resetpassword sequence failing rather than a credential problem '
        + '— see scripts/lib/loyalty-ephemeral-account.mjs.',
      );
    }
    // The spec names the coupon ALIAS; the cart needs the code it resolves to.
    const couponCode = spec.order.coupon ? resolveCouponCode(spec.order.coupon) : null;
    const base = await measureCart(token, acct.userId, currency, unitProductId, { ...spec.order, coupon: couponCode });
    const money = measuredMoney(base);
    let undiscounted = null;
    if (spec.order.coupon) {
      const plain = await measureCart(token, acct.userId, currency, unitProductId, { units: spec.order.units, coupon: null });
      undiscounted = measuredMoney(plain);
    }
    const derived = deriveCaseTarget(spec, { base: money, undiscounted });
    out[spec.aliasName] = {
      money, undiscounted, derived, token,
      shipping: (base.availableShippingMethods || []).map((s) => ({ code: s.code, option: s.optionName, price: Number(s.price?.amount ?? 0) })),
      readings: readingValues(money),
    };
    log(
      `  ✓ ${spec.caseId} cart ${spec.order.units}u${spec.order.coupon ? ` + ${spec.order.coupon}` : ''}: `
      + `sub ${money.grossMerchandise} disc ${money.discountTotal} tax ${money.taxTotal} ship ${money.shippingTotal} `
      + `TOTAL ${money.orderTotal} → target ${derived.target} (between ${derived.below} and ${derived.above}, margin ${derived.margin})`,
    );
  }

  // ATTRIBUTION, on the measured numbers rather than the authored intent.
  const derivedByAlias = {};
  const orderTotalByAlias = {};
  for (const spec of CASE_MISSIONS) {
    derivedByAlias[spec.aliasName] = out[spec.aliasName].derived;
    orderTotalByAlias[spec.aliasName] = out[spec.aliasName].money.orderTotal;
  }
  for (const spec of MISSIONS) {
    if (spec.goal?.type === 'OrderValueGoal') derivedByAlias[spec.aliasName] = { target: Number(spec.goal.value) };
  }
  const attribution = attributionProblems(derivedByAlias, orderTotalByAlias);
  if (attribution.length) {
    throw new Error(
      `the measured order totals break MSN-E2E-008's reward attribution:\n    ${attribution.join('\n    ')}\n  `
      + 'That case asserts on a balance delta, so a sibling mission granting on the same order makes the delta '
      + 'name nothing. Adjust the per-case order quantities in missions-e2e-specs.mjs.',
    );
  }

  // Shipping headroom, which is what a case needs in order to pick a delivery method.
  const siblingTargets = CASE_MISSIONS
    .filter((s) => s.caseId !== 'MSN-E2E-008')
    .map((s) => out[s.aliasName].derived.target)
    .concat(MISSIONS.filter((s) => s.goal?.type === 'OrderValueGoal').map((s) => Number(s.goal.value)));
  for (const spec of CASE_MISSIONS) {
    const o = out[spec.aliasName];
    const nearest = spec.caseId === 'MSN-E2E-008'
      ? Math.min(...siblingTargets.filter((t) => t > o.money.orderTotal))
      : null;
    o.headroom = shippingHeadroom(spec, { money: o.money, target: o.derived.target, nearestSiblingTarget: Number.isFinite(nearest) ? nearest : null });
  }
  log(`  Store tax rate (derived from the probe carts): ${(taxRateOf(out[CASE_MISSIONS[0].aliasName].money) * 100).toFixed(1)}%`);
  return out;
}

/**
 * Which OTHER missions will also grant on this account's planned order — the honest form of
 * MSN-E2E-008's balance arithmetic.
 *
 * A fresh account has consumed none of the store's one-shot missions, so its FIRST order completes
 * MSN_ZEROTARGET (OrderCountGoal 0), every count-1 fixture, and anything else whose target it clears.
 * `BAL_1 - BAL_0 = reward` is therefore false on this environment for any account, and pretending
 * otherwise is how the previous run ended up recording an unattributable 3,110-PTS delta. This
 * computes the set rather than guessing it, and records it so a case can assert against something
 * true.
 */
async function coCompletingMissions(userId, orderTotal, ownMissionId, rewardById) {
  const visible = await customerVisibleMissions(userId);
  const co = [];
  for (const [missionId, card] of visible) {
    if (missionId === ownMissionId) continue;
    if (String(card.status) === 'Completed') continue;       // already consumed — grants nothing again
    const reward = rewardById.get(missionId);
    if (reward == null) continue;
    const target = Number(card.targetValue);
    const type = String(card.missionType || '');
    let willComplete = false;
    if (/OrderCount/i.test(type)) willComplete = target <= 1;               // this order is the account's first
    else if (/OrderValue/i.test(type)) willComplete = target <= orderTotal;
    // PerSku goals need their own target products, which none of these carts contain.
    if (willComplete) co.push({ name: card.name, reward });
  }
  return co;
}

/* ── Seed ────────────────────────────────────────────────────────────────────── */

async function seed() {
  const shape = validateSpecShape();
  if (shape.length) throw new Error(`the committed spec set is incoherent — fix missions-e2e-specs.mjs first:\n    ${shape.join('\n    ')}`);

  const runId = newRunId();
  const now = new Date();
  log(`Run handle: ${runId}`);

  // --- 1. store, gate, currencies -------------------------------------------
  const store = await api('GET', `/api/stores/${encodeURIComponent(STORE_ID)}`);
  const missionsSetting = (store.settings || []).find((s) => s.name === STORE_SETTING.missionsSetting) || null;
  const missionsEnabled = missionsSetting == null ? null : (missionsSetting.value == null ? missionsSetting.defaultValue === true : missionsSetting.value === true);
  if (missionsEnabled !== true) {
    // Deliberately NOT flipped here. `seed-loyalty-missions.mjs` owns this setting; a second writer
    // would race it, and a store PUT that loses a required default takes the storefront down
    // (reference_store_required_defaults_null_breaks_frontend).
    throw new Error(
      `${STORE_SETTING.missionsSetting} is ${missionsEnabled} on store ${STORE_ID} — every 083d case reads the `
      + 'missions page and would find nothing. Enable it with `npm run seed:loyalty-missions -- --missions on` '
      + '(that seeder owns the setting; this one deliberately does not write it).',
    );
  }
  const currencies = resolveIntents(store);
  log(`  Currencies: default=${currencies['store-default']}  loyalty=${currencies.loyalty}`);

  // --- 2. catalog + products -------------------------------------------------
  VIRTUAL_CATALOG_ID = await ensureVirtualCatalog(api);
  await ensureCurrencies(api, [...new Set([currencies['store-default'], currencies.loyalty])]);
  const location = await ensureLocation();

  const pricelistByCurrency = {};
  for (const c of new Set(PRODUCTS.map((p) => currencies[p.currencyIntent]))) {
    pricelistByCurrency[c] = await ensurePricelist(c);
  }
  let resolvedProducts = [];
  for (const p of PRODUCTS) resolvedProducts.push(await ensureProduct(p, location, pricelistByCurrency, currencies));
  await ensureIndexed(resolvedProducts);
  // Derive the storefront-facing facts (slug, buyability, resolved price) from the resolver the
  // storefront itself uses — never compose them. See resolveStorefrontFacts.
  if (!DRY_RUN) resolvedProducts = await resolveStorefrontFacts(resolvedProducts);
  const bySlot = Object.fromEntries(resolvedProducts.map((p) => [p.slot, p]));

  // --- 3. sweep --------------------------------------------------------------
  await sweepStaleMissions({ all: SWEEP_ALL, exceptRunId: runId, now });

  // --- 3b. per-case accounts -------------------------------------------------
  // Minted BEFORE the missions because the probe carts that size the per-case targets have to be
  // built on the accounts that will actually place those orders — a cart measured as somebody else
  // could resolve different prices, a different tax and a different coupon eligibility.
  const caseAccounts = await ensureCaseAccounts({ all: SWEEP_ALL });

  // --- 3c. measure the per-case carts and DERIVE their targets ---------------
  let measurements = {};
  if (!DRY_RUN) {
    measurements = await measureCaseCarts(caseAccounts, currencies['store-default'], bySlot[UNIT_PRODUCT.slot].id);
  }

  // --- 4. mint ---------------------------------------------------------------
  const template = await api('GET', '/api/loyalty-missions/new', null, { expectStatus: [200] });
  const minted = {};
  for (const spec of ALL_MISSIONS) {
    // A per-case mission's target is the MEASURED one. The spec deliberately carries `value: null` so
    // that a target can never be published without a measurement behind it.
    const derivedTarget = measurements[spec.aliasName]?.derived?.target;
    const effective = isCaseMission(spec)
      ? { ...spec, goal: { ...spec.goal, value: DRY_RUN ? 1 : derivedTarget } }
      : spec;
    if (isCaseMission(spec) && !DRY_RUN && !(Number(derivedTarget) > 0)) {
      throw new Error(`${spec.aliasName}: no measured target — refusing to mint a per-case mission against a number nobody computed`);
    }
    const body = buildE2EMissionBody(effective, runId, { template, storeId: STORE_ID, now, currencies });
    if (DRY_RUN) { log(`  [DRY] would create ${body.name} (${spec.goal.type}, reward ${spec.reward})`); minted[spec.aliasName] = { id: `dry-${spec.key}`, name: body.name }; continue; }
    const created = await api('POST', '/api/loyalty-missions', body, { expectStatus: [200, 201] });
    if (!created?.id) throw new Error(`${spec.aliasName}: POST /api/loyalty-missions returned no id`);
    minted[spec.aliasName] = { id: created.id, name: created.name, goalCurrency: spec.goal.currency ? currencies[spec.goal.currency] : '', target: effective.goal.value };
    log(`  ✓ ${spec.aliasName.padEnd(24)} ${created.name}  (${spec.goal.type}${effective.goal.value != null ? ` target ${effective.goal.value}` : ''}, reward ${spec.reward})`);
    if (needsGoalItems(spec)) await syncGoalItems(spec, created.id, bySlot);
  }

  // --- 5. reward account -----------------------------------------------------
  const reward = rewardAccountFromOverlay();
  let balance = null;
  if (!reward.email || !reward.userId) {
    throw new Error(
      `${REWARD_USER.sourceAlias} is not provisioned on this env (email="${reward.email}", account="${reward.userId}"). `
      + 'MSN-E2E-004 asserts the points it spends were EARNED FROM THE MISSION, which needs a balance the reward '
      + 'can visibly dominate. Run `npm run seed:loyalty:zero-user` (or `npm run seed:missions-e2e`, which does both).',
    );
  }
  if (!DRY_RUN) {
    balance = await readBalance(reward.userId);
    const rewardPoints = Number(MISSION_BY_ALIAS[REWARD_USER.rewardAlias].reward);
    if (!balanceIsLegible(balance, rewardPoints)) {
      throw new Error(
        `${REWARD_USER.sourceAlias} (${reward.email}) holds ${balance} PTS against a ${rewardPoints} PTS mission reward. `
        + 'A grant that does not at least double the balance cannot demonstrate that the points spent came FROM the '
        + 'mission — which is the whole thesis of MSN-E2E-004. The balance only ever climbs (no write API exists), so '
        + 'the fix is a fresh account: `npm run seed:loyalty:zero-user`.',
      );
    }
    log(`  ✓ reward account ${reward.email} → ${balance} PTS (reward ${rewardPoints} PTS is legible)`);
  }

  // --- 6. VERIFY pre-completion ---------------------------------------------
  // The step whose absence let run REG-2026-08-28-1154 execute against six Completed missions.
  //
  // Each mission is probed AS THE ACCOUNT THAT WILL DRIVE IT, not as one shared identity. That
  // distinction is the whole point of the per-case split: progress is per-(user, mission), so
  // "MSN_E2E_ORDERVALUE_005 is at 0%" is only a claim about the account 005 signs in as. Probing one
  // account for all of them would re-introduce exactly the assumption this change removes.
  const observed = {};
  const coGrants = {};
  if (!DRY_RUN) {
    // Reward amounts by mission id, for the co-grant computation below. Read from the admin API
    // rather than assumed, because the store carries missions this repo did not create.
    const allLive = await api('POST', '/api/loyalty-missions/search', { take: 500 }, { expectStatus: [200, 201] });
    const rewardById = new Map();
    for (const m of (allLive?.results || [])) {
      const blocks = m?.dynamicExpression?.children || [];
      const rewardBlock = blocks.find((b) => String(b.id).includes('Reward'));
      const amount = rewardBlock?.children?.[0]?.amount;
      if (amount != null) rewardById.set(m.id, Number(amount));
    }

    for (const spec of ALL_MISSIONS) {
      // Which identity is this mission's? A per-case mission has its own; the rest keep the per-run
      // reward account, which is still the freshest identity available to them.
      const acct = isCaseMission(spec)
        ? { email: caseAccounts[spec.accountAlias].email, userId: caseAccounts[spec.accountAlias].userId }
        : { email: reward.email, userId: reward.userId };
      const id = minted[spec.aliasName].id;
      const admin = await progressByMission([id], acct.userId);
      const seen = await customerVisibleMissions(acct.userId);
      const bad = [];
      const invisible = [];
      const card = seen.get(id);
      // REACHABILITY first. A mission the customer-facing query omits blocks every case that binds to
      // it, and does so while every admin-side check stays green — so it is a hard failure of the
      // seed, not a warning.
      if (!card) { invisible.push(`${spec.aliasName} (${missionName(runId, spec.key)}) for ${acct.email}`); }
      else {
        // Prefer the STOREFRONT's own reading. The admin table has no row at all for a mission nobody
        // has ordered against, while the customer query reports that same state as `InProgress 0%
        // isStarted=false` — recording the latter means the overlay says what the suite will see.
        const state = { status: String(card.status), percent: Number(card.percentage) };
        observed[spec.aliasName] = state;
        if (!isPreCompletion(state)) bad.push(`${spec.aliasName} (${card.name}) is already ${state.status} ${state.percent}% for ${acct.email}`);
        // A progress row on a mission minted seconds ago is not merely surprising, it is proof the run
        // handle did not isolate this run.
        if (admin.get(id)) bad.push(`${spec.aliasName} already has a progress row in the admin table — the mission is not new`);
        if (card.isStarted === true) bad.push(`${spec.aliasName} reports isStarted=true on a freshly minted mission`);
      }
      if (invisible.length) {
        throw new Error(
          `minted but INVISIBLE to the customer-facing query: ${invisible.join(', ')}.\n  `
          + 'It exists in the admin API, so every "does the fixture exist?" check passes, but /account/missions '
          + 'would not render a card for it and the 083d case bound to it would report a missing mission as a '
          + 'product failure. Check the store\'s Loyalty.Missions.Enable gate and the mission window.',
        );
      }
      if (bad.length) {
        throw new Error(
          `a freshly minted mission is NOT in a clean pre-completion state:\n    ${bad.join('\n    ')}\n  `
          + 'That should be impossible for a mission created seconds ago against a brand-new account — it means the '
          + 'run handle collided or an older mission was reused, and 083d would assert against progress a previous '
          + 'execution already consumed.',
        );
      }

      // The account's balance is READ, never assumed to be zero. It should be zero on an account
      // created seconds ago, and that is exactly why a non-zero reading is worth surfacing rather
      // than papering over — the same discipline as recording the OBSERVED progress state above.
      if (isCaseMission(spec)) {
        const bal = await readBalance(acct.userId);
        caseAccounts[spec.accountAlias].balance = bal;
        if (bal !== 0) {
          log(`  ⚠ ${spec.accountAlias} (${acct.email}) reports ${bal} PTS on a freshly minted account — recorded as observed, not corrected`);
        }
      }

      // CO-GRANT SET, for the one case that asserts on a balance delta. Computed rather than assumed:
      // a fresh account has consumed none of the store's one-shot missions, so its first order grants
      // more than this mission's own reward and `BAL_1 - BAL_0 = reward` is simply false.
      if (isCaseMission(spec) && spec.caseId === 'MSN-E2E-008') {
        const total = measurements[spec.aliasName].money.orderTotal;
        const co = await coCompletingMissions(acct.userId, total, id, rewardById);
        coGrants[spec.aliasName] = co;
        const sum = co.reduce((n, c) => n + Number(c.reward), 0) + Number(spec.reward);
        log(`  ℹ ${spec.caseId}: ${co.length} other mission(s) also grant on its order (${co.map((c) => `${c.name} +${c.reward}`).join(', ') || 'none'}) → expected total delta ${sum} PTS, of which ${spec.reward} is this mission's`);
      }
    }
    const perCase = CASE_MISSIONS.map((s) => `${s.caseId} ${observed[s.aliasName].status} ${observed[s.aliasName].percent}%`).join(', ');
    log(`  ✓ all ${ALL_MISSIONS.length} missions visible and pre-completion — per-case: ${perCase}`);
  } else {
    for (const spec of ALL_MISSIONS) observed[spec.aliasName] = { status: 'NotStarted', percent: 0 };
  }

  // --- 7. write back ---------------------------------------------------------
  const ov = MISSION_BY_ALIAS.MSN_E2E_ORDERVALUE;
  const band = discountBand(ov, UNIT_PRODUCT);
  const updates = {
    // The category id is PINNED here so the NEXT run resolves it from the database instead of an
    // index that cannot see it. Without the pin, ensureCategoryPath mints a duplicate category on
    // every single run and silently re-parents the virtual-catalog links onto the newest one.
    MSN_E2E_RUN: {
      run_id: runId, seeded_at: now.toISOString(), store_id: STORE_ID,
      catalog_id: location.catalogId, category_id: location.categoryId,
    },
    [REWARD_USER.aliasName]: {
      email: reward.email, user_id: reward.userId, member_id: reward.memberId,
      balance_at_seed: balance == null ? '' : String(balance),
    },
  };
  for (const spec of MISSIONS) {
    updates[spec.aliasName] = {
      id: minted[spec.aliasName].id,
      name: minted[spec.aliasName].name,
      run_id: runId,
      goal_currency: minted[spec.aliasName].goalCurrency || '',
      progress_status_at_seed: observed[spec.aliasName].status,
      progress_percent_at_seed: String(observed[spec.aliasName].percent),
    };
  }

  // Per-case missions carry, on top of the identity fields, everything the case needs in order to
  // COMPOSE its order from measured facts instead of from a model: the derived target, the two
  // quantities that target separates, the measured cart, what each candidate reading predicts, and
  // how much shipping the order can absorb before the band closes. Every one of these is a number the
  // case currently has to re-derive or guess at.
  for (const spec of CASE_MISSIONS) {
    const m = measurements[spec.aliasName];
    const acct = caseAccounts[spec.accountAlias];
    const co = coGrants[spec.aliasName] || null;
    updates[spec.aliasName] = {
      id: minted[spec.aliasName].id,
      name: minted[spec.aliasName].name,
      run_id: runId,
      goal_currency: minted[spec.aliasName].goalCurrency || '',
      goal_target: m ? String(m.derived.target) : '',
      progress_status_at_seed: observed[spec.aliasName].status,
      progress_percent_at_seed: String(observed[spec.aliasName].percent),
      order_shipping_max: m ? (m.headroom == null ? 'unbounded' : String(m.headroom)) : '',
      available_shipping: m ? m.shipping.map((s) => `${s.code}/${s.option}=${s.price}`).join('; ') : '',
      measured_subtotal: m ? String(m.money.grossMerchandise) : '',
      measured_discount: m ? String(m.money.discountTotal) : '',
      measured_tax: m ? String(m.money.taxTotal) : '',
      measured_shipping: m ? String(m.money.shippingTotal) : '',
      measured_total: m ? String(m.money.orderTotal) : '',
      measured_total_undiscounted: m?.undiscounted ? String(m.undiscounted.orderTotal) : '',
      // The observed "spent" amount on the card names the reading. Recording what each candidate
      // predicts is what lets a case identify it instead of merely noticing a chip did not appear.
      reading_values: m ? Object.entries(m.readings).map(([k, v]) => `${k}=${v}`).join('; ') : '',
      separates_below: m ? String(m.derived.below) : '',
      separates_above: m ? String(m.derived.above) : '',
      separation_margin: m ? String(m.derived.margin) : '',
      co_completing_missions: co ? (co.map((c) => `${c.name}=${c.reward}`).join('; ') || 'none') : '',
      reward_expected_total: co ? String(co.reduce((n, c) => n + Number(c.reward), 0) + Number(spec.reward)) : '',
    };
    updates[spec.accountAlias] = {
      email: acct.email, user_id: acct.userId, member_id: acct.memberId, handle: acct.handle,
      balance_at_seed: acct.balance == null ? '' : String(acct.balance),
    };
  }

  for (const p of resolvedProducts) {
    updates[p.aliasName] = {
      productId: p.id, catalogId: p.catalogId, currency: p.currency, slug: p.slug, url: p.url,
    };
  }
  if (DRY_RUN) { log(`  [DRY] would write ${Object.keys(updates).length} alias overrides`); }
  else {
    writeEnvAliasOverride(updates);
    log(`  ✓ aliases.${process.env.TEST_ENV || 'vcst'}.json: ${Object.keys(updates).length} entries`);
  }

  log('');
  log(`Composition arithmetic for 083d (derived, not literals):`);
  log(`  OrderValue target ${ov.goal.value} ${currencies['store-default']} = ${unitsToComplete(ov, UNIT_PRODUCT)} × ${UNIT_PRODUCT.sku} @ ${UNIT_PRODUCT.listPrice}`);
  log(`  just below target : ${unitsJustBelow(ov, UNIT_PRODUCT)} units (${unitsJustBelow(ov, UNIT_PRODUCT) * UNIT_PRODUCT.listPrice})`);
  log(`  discount band     : pre ${band.preDiscount} → post ${band.postDiscount}; shipping headroom ${band.shippingHeadroom}`);
  log(`  storefront        : ${BACK_URL ? '' : ''}/account/missions`);
  log('Done: 083d fixtures provisioned.');
}

/* ── Teardown ────────────────────────────────────────────────────────────────── */

async function deleteProducts() {
  let removed = 0;
  for (const spec of PRODUCTS) {
    const p = await findProductByCode(spec.sku);
    if (!p?.id) { verbose(`${spec.sku} not present`); continue; }
    if (!String(p.code).startsWith(SEED_PREFIX)) { log(`  ⚠ skip ${p.code}: lacks the ${SEED_PREFIX} guard prefix`); continue; }
    if (DRY_RUN) { log(`  [DRY] would delete product ${spec.sku}`); continue; }
    await api('POST', '/api/catalog/listentries/delete', { objectIds: [p.id], objectType: 'CatalogProduct' }, { expectStatus: [200, 204, 404] })
      .catch((e) => log(`  ⚠ delete ${spec.sku}: ${String(e.message).slice(0, 120)}`));
    removed += 1;
  }
  if (removed) log(`  ✗ deleted ${removed} fixture product(s)`);
  const residual = await verifyRemoved(async () => {
    const left = [];
    for (const spec of PRODUCTS) { const p = await findProductByCode(spec.sku); if (p?.id) left.push(p.id); }
    return left;
  });
  log(residual === 0 ? '  ✓ product teardown verified — zero residue' : `  ⚠ product teardown incomplete — ${residual} still present`);
}

/**
 * Remove the two pricelists and the fixture category this seeder creates. Both are guarded by an
 * EXACT name/code match, and both are uniquely ours — no other seeder uses this category path or
 * these pricelist names.
 *
 * The category matters more than it looks. `ensureCategoryPath` cannot find it again (its lookup is
 * index-backed and categories are not indexed on this env), so leaving it behind while blanking the
 * overlay pin means the NEXT seed mints a duplicate — `td:reconcile` [6] is currently reporting
 * exactly that residue for the older `AGENT-TEST-SEED-loyalty-fixtures` fixture, which is the same
 * bug in another seeder. Deleting it is what makes teardown -> seed idempotent rather than
 * accumulating.
 */
async function deleteCatalogScaffolding() {
  for (const currency of ['USD', 'PTS', ...new Set(PRODUCTS.map((p) => p.currencyIntent))]) {
    const name = PRICELIST_NAME(currency);
    const search = await api('GET', `/api/pricing/pricelists?keyword=${encodeURIComponent(name)}`, null, { expectStatus: [200, 404] }).catch(() => null);
    const pl = (search?.results || []).find((p) => p?.name === name);
    if (!pl?.id) continue;
    if (DRY_RUN) { log(`  [DRY] would delete pricelist ${name}`); continue; }
    await api('DELETE', `/api/pricing/pricelists?${idsParam([pl.id])}`, null, { expectStatus: [200, 204, 404] })
      .catch((e) => log(`  ⚠ pricelist ${name}: ${String(e.message).slice(0, 120)}`));
    log(`  ✗ deleted pricelist ${name}`);
  }

  // Categories are swept BY CODE, not just by the pin. The pin only ever names the category of the
  // last SUCCESSFUL run; a run that died between creating one and writing its pin leaves an orphan
  // that neither the pin nor the keyword-backed lookup can see, so deleting only the pinned one made
  // the residue permanent and monotonically growing (three had accumulated by 2026-08-28).
  const pin = overlay().MSN_E2E_RUN || {};
  const catalogId = pin.catalog_id;
  const targets = new Map();
  for (const c of await listFixtureCategories(catalogId)) targets.set(c.id, c.code);
  if (pin.category_id && !targets.has(pin.category_id)) {
    const cat = await api('GET', `/api/catalog/categories/${pin.category_id}`, null, { expectStatus: [200, 404] }).catch(() => null);
    if (cat?.id) targets.set(cat.id, cat.code);
  }
  if (!targets.size) { verbose('no fixture category to remove'); return; }

  for (const [id, code] of targets) {
    // The prefix guard stands whatever the enumeration returned — this is the only thing standing
    // between a code typo and deleting somebody else's category.
    if (!String(code || '').startsWith(`${SEED_FAMILY}-`)) { log(`  ⚠ skip category ${code}: lacks the ${SEED_FAMILY}- guard prefix — refusing to delete`); continue; }
    if (DRY_RUN) { log(`  [DRY] would delete category ${code} (${id})`); continue; }
    await api('POST', '/api/catalog/listentries/delete', { objectIds: [id], objectType: 'Category' }, { expectStatus: [200, 204, 404] })
      .catch((e) => log(`  ⚠ category ${code}: ${String(e.message).slice(0, 120)}`));
    const back = await api('GET', `/api/catalog/categories/${id}`, null, { expectStatus: [200, 404] }).catch(() => null);
    log(back?.id ? `  ⚠ category ${code} (${id}) still present` : `  ✗ deleted category ${code} (${id})`);
  }
}

async function teardown() {
  log(`Teardown: E2E missions ${SWEEP_ALL ? '(ALL)' : `older than ${MAX_AGE_HOURS}h`}${KEEP_PRODUCTS ? ', products kept' : ' + products'}`);
  await sweepStaleMissions({ all: SWEEP_ALL, maxAgeHours: MAX_AGE_HOURS });

  // The per-case accounts are swept on the SAME age floor as the missions they isolate, because they
  // are two halves of one fixture: an account without its mission cannot start a case at 0%, and a
  // mission without its account is contended again the moment two cases fall back to a shared login.
  // Sweeping one and sparing the other would leave a set that still resolves and no longer works.
  const acct = await sweepEphemeralAccounts(api, {
    prefix: CASE_ACCOUNT_PREFIX, maxAgeHours: SWEEP_ALL ? null : MAX_AGE_HOURS, dryRun: DRY_RUN, log, verbose,
  });
  log(`  ✗ per-case accounts: swept ${acct.removed}${acct.spared ? `, spared ${acct.spared} younger than ${MAX_AGE_HOURS}h` : ''}`);
  const acctResidual = await verifyRemoved(async () => {
    const left = await findEphemeralAccounts(api, CASE_ACCOUNT_PREFIX);
    return SWEEP_ALL ? left.map((u) => u.id || u.userName) : [];
  });
  log(acctResidual === 0 ? '  ✓ per-case account teardown verified — zero residue' : `  ⚠ per-case account teardown incomplete — ${acctResidual} still present`);
  const residual = await verifyRemoved(async () => {
    const live = await allE2EMissions();
    return SWEEP_ALL ? live.map((m) => m.id) : live.filter((m) => (runIdAgeHours(runIdFromName(m.name)) ?? 0) > MAX_AGE_HOURS).map((m) => m.id);
  });
  log(residual === 0 ? '  ✓ mission teardown verified — zero residue' : `  ⚠ mission teardown incomplete — ${residual} still present`);

  if (!KEEP_PRODUCTS) { await deleteProducts(); await deleteCatalogScaffolding(); }

  // Blank the overlay. A dead identity left behind is worse than an empty one: `@td(MSN_E2E_*.id)`
  // would keep resolving to a mission that no longer exists, and the case reads the miss as a product
  // failure rather than as unseeded data.
  if (DRY_RUN) { log('  [DRY] would blank the MSN_E2E_* overlay entries'); return; }
  // The catalog/category pin survives a mission-only teardown: it is the thing that stops the next
  // seed minting a duplicate category, so it is cleared only when the products go with it.
  const blanks = { MSN_E2E_RUN: { run_id: '', seeded_at: '', store_id: '' } };
  if (!KEEP_PRODUCTS) Object.assign(blanks.MSN_E2E_RUN, { catalog_id: '', category_id: '' });
  for (const spec of MISSIONS) {
    blanks[spec.aliasName] = { id: '', name: '', run_id: '', goal_currency: '', progress_status_at_seed: '', progress_percent_at_seed: '' };
  }
  // Every runtime field the spec module declares, blanked from the declaration itself rather than
  // re-listed here — a hand-kept second list is how a new field comes to survive a teardown and leave
  // the next run resolving one stale measurement among fresh ones.
  for (const spec of CASE_MISSIONS) {
    blanks[spec.aliasName] = Object.fromEntries(RUNTIME_FIELDS_BY_KIND.caseMission.map((f) => [f, '']));
  }
  for (const a of CASE_ACCOUNTS) {
    blanks[a.aliasName] = Object.fromEntries(RUNTIME_FIELDS_BY_KIND.caseUser.map((f) => [f, '']));
  }
  blanks[REWARD_USER.aliasName] = { email: '', user_id: '', member_id: '', balance_at_seed: '' };
  if (!KEEP_PRODUCTS) {
    for (const p of PRODUCTS) blanks[p.aliasName] = { productId: '', catalogId: '', currency: '', slug: '', url: '' };
  }
  writeEnvAliasOverride(blanks);
  log(`  ✓ aliases.${process.env.TEST_ENV || 'vcst'}.json: MSN_E2E_* entries blanked`);
}

(async () => {
  console.log(`🎯 Seed Loyalty Missions E2E (083d)${DRY_RUN ? ' [DRY RUN]' : ''}${TEARDOWN ? ' [TEARDOWN]' : ''}`);
  assertSafeTarget();
  await auth();
  if (TEARDOWN) await teardown(); else await seed();
})().catch((e) => { console.error('FAILED:', e.message); if (VERBOSE) console.error(e.stack); process.exit(1); });

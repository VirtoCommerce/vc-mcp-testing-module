/**
 * seed-loyalty-missions.mjs — VCST-5319 Loyalty Missions fixture seeder.
 *
 * Provisions the mission fixtures declared in `missions-specs.mjs` (the single source of truth),
 * their PerSku SKU targets, and the `Loyalty.Missions.Enable` store setting that gates the whole
 * feature. Runtime GUIDs land in `test-data/aliases.<env>.json`; nothing server-assigned is ever
 * written to a committed file.
 *
 * API (VirtoCommerce.Loyalty 3.1006.0-pr-14 — /docs/VirtoCommerce.Loyalty/swagger.json):
 *   GET    /api/loyalty-missions/new                 → a valid empty LoyaltyMission (the template)
 *   POST   /api/loyalty-missions/search              → { totalCount, results }
 *   POST   /api/loyalty-missions                     → create (accepts status Published directly)
 *   GET    /api/loyalty-missions/{id}                → one mission (200 + null body when absent)
 *   DELETE /api/loyalty-missions?ids=…               → allowed at EVERY status, incl. Published
 *   POST   /api/loyalty-mission-goal-items/search    → PerSku targets by missionId
 *   POST   /api/loyalty-mission-goal-items           → create one target
 *   PUT    /api/loyalty-mission-goal-items           → update one target
 *   DELETE /api/loyalty-mission-goal-items?ids=…     → remove targets
 *   GET/PUT /api/stores/{id}                         → store settings live on the store body
 *   POST   /api/assets?folderUrl=…                   → multipart banner upload (SVG accepted)
 *   GET    /api/assets?folderUrl=…                   → folder listing; the source of the asset URL
 *   DELETE /api/assets?urls=…                        → remove an asset by its RELATIVE url
 *
 * IDEMPOTENCY — why it deletes rather than repairs.
 * A Published mission is IMMUTABLE: `EnsureMutableAsync` rejects every edit except the single
 * transition Published -> Archived, and rejects everything on an Archived one. So there is no
 * repair-in-place path for any Published fixture. The seeder instead compares a STRUCTURAL
 * SIGNATURE (`missionSignature`, deliberately date-free) plus a live window check, and on any drift
 * DELETEs and recreates. DELETE works at every status, which is what makes that safe. A mission whose
 * signature matches and whose window is open is reused untouched, so its GUID — and therefore every
 * `@td(MSN_*.id)` already resolved against it — stays stable across re-seeds.
 *
 * Usage:
 *   node scripts/seed-data/loyalty/seed-loyalty-missions.mjs
 *   node scripts/seed-data/loyalty/seed-loyalty-missions.mjs --only MSN_PERSKU_ALL
 *   node scripts/seed-data/loyalty/seed-loyalty-missions.mjs --dry-run --verbose
 *   node scripts/seed-data/loyalty/seed-loyalty-missions.mjs --teardown
 *   node scripts/seed-data/loyalty/seed-loyalty-missions.mjs --missions off   # toggle-test helper
 *   node scripts/seed-data/loyalty/seed-loyalty-missions.mjs --missions on
 *   node scripts/seed-data/loyalty/seed-loyalty-missions.mjs --reupload-banners  # artwork edited
 *
 * BANNERS. Each mission carries the artwork for its GOAL TYPE (money / repeat orders / featured SKUs),
 * uploaded from `test-data/uploads/msn-banner-*.svg` under a FIXED file name so the asset URL is stable
 * across runs — it is part of `missionSignature`, and a churning URL would recreate every mission on
 * every seed. The URL is per-env and goes to the overlay; `bannerUrl` is set at CREATE time because a
 * Published mission can never gain one afterwards, and each URL is asserted to serve 2xx + image/*.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STORE_ID, DRY_RUN, TEARDOWN, ONLY, ROOT,
  log, verbose, assertSafeTarget, auth, api,
  uploadAsset, assetUrlOk,
  writeEnvAliasOverride, verifyRemoved, discoverCatalogProducts,
} from '../../lib/seed-common.mjs';
import {
  MISSIONS, MISSION_BY_ALIAS, STORE_SETTING, PERSKU_PRODUCTS, TARGETING,
  BANNERS, BANNER_FOLDER, BANNER_CONTENT_TYPE, bannerSourceRel, bannerAssetRel, bannerKeyFor,
  missionName, isSeededMissionName, needsGoalItems, resolveCurrencies, resolveLocales,
  buildMissionBody, buildGoalItems, reconcileGoalItems, localizedValues,
  missionSignature, signaturesMatch, windowIsOpen, windowExpectsOpen, validateSpecShape,
} from './missions-specs.mjs';

const argv = process.argv.slice(2);
const missionsFlagIdx = argv.indexOf('--missions');
/** `--missions on|off` sets ONLY the gate and exits — the toggle-test helper. */
const MISSIONS_TOGGLE = missionsFlagIdx >= 0 ? String(argv[missionsFlagIdx + 1] || '').toLowerCase() : null;
/** Push the banner BYTES back up even though the URL already serves — for when the artwork changed. */
const REUPLOAD_BANNERS = argv.includes('--reupload-banners');

/* ── Store settings ─────────────────────────────────────────────────────────── */

/**
 * Read both loyalty switches off the store. The base switch is REPORTED, never written — suites
 * 075/075b/075c read it through LOYALTY_SETTINGS and a mission seed has no business moving it.
 */
async function readLoyaltySettings() {
  const store = await api('GET', `/api/stores/${encodeURIComponent(STORE_ID)}`);
  const find = (name) => (store.settings || []).find((s) => s.name === name) || null;
  const missions = find(STORE_SETTING.missionsSetting);
  const base = find(STORE_SETTING.baseSetting);
  const effective = (s) => (s == null ? null : (s.value == null ? s.defaultValue === true : s.value === true));
  return { store, missions, base, missionsEnabled: effective(missions), baseEnabled: effective(base) };
}

/**
 * Set `Loyalty.Missions.Enable` on the store. Idempotent (a no-op when already at `desired`) and
 * surgical: it rewrites exactly that one entry of `store.settings` and PUTs the store back, so no
 * other store setting — loyalty or otherwise — is disturbed.
 */
async function setMissionsEnabled(desired) {
  const { store, missions, missionsEnabled, baseEnabled } = await readLoyaltySettings();
  if (missions == null) {
    throw new Error(
      `${STORE_SETTING.missionsSetting} is not registered on store ${STORE_ID}. `
      + 'The Loyalty module build that declares it is probably not deployed on this env.',
    );
  }
  if (missionsEnabled === desired) {
    log(`✓ ${STORE_SETTING.missionsSetting} already ${desired} (${STORE_SETTING.baseSetting}=${baseEnabled})`);
    return { changed: false, missionsEnabled: desired, baseEnabled };
  }
  const next = {
    ...store,
    settings: (store.settings || []).map((s) => (
      s.name === STORE_SETTING.missionsSetting ? { ...s, value: desired } : s
    )),
  };
  await api('PUT', '/api/stores', next, { expectStatus: [200, 204] });
  log(`✓ ${STORE_SETTING.missionsSetting}: ${missionsEnabled} → ${desired} (${STORE_SETTING.baseSetting}=${baseEnabled}, untouched)`);
  return { changed: true, missionsEnabled: desired, baseEnabled };
}

/* ── Missions ───────────────────────────────────────────────────────────────── */

async function searchMissions() {
  const r = await api('POST', '/api/loyalty-missions/search', { take: 200 }, { expectStatus: [200, 201] });
  return r?.results || [];
}

/** Every mission this seeder owns, keyed by name. */
async function ourMissionsByName() {
  const all = await searchMissions();
  const map = new Map();
  for (const m of all) if (isSeededMissionName(m.name)) map.set(m.name, m);
  return map;
}

async function deleteMissions(ids) {
  if (!ids.length) return;
  const qs = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
  await api('DELETE', `/api/loyalty-missions?${qs}`, null, { expectStatus: [200, 204] });
}

/* ── PerSku goal items ──────────────────────────────────────────────────────── */

async function goalItemsFor(missionId) {
  const r = await api('POST', '/api/loyalty-mission-goal-items/search', { missionId, take: 200 }, { expectStatus: [200, 201] });
  return r?.results || [];
}

/**
 * Bring a PerSku mission's SKU targets to exactly the desired set.
 *
 * The reconcile (rather than a wipe-and-recreate) is forced by the schema: `LoyaltyMissionGoalItem`
 * has a UNIQUE index on (MissionId, ProductId) and a duplicate insert surfaces as a raw HTTP 500 SQL
 * error, not a 409 — so a blind re-POST on a re-seed does not fail gracefully, it fails illegibly.
 * The bulk `PUT /items` route is NOT an upsert either (it hits the same index), so each row is
 * created / updated / removed individually.
 */
async function syncGoalItems(spec, missionId, products) {
  const desired = buildGoalItems(spec, missionId, products);
  const existing = DRY_RUN ? [] : await goalItemsFor(missionId);
  const { create, update, remove } = reconcileGoalItems(desired, existing);

  for (const row of create) await api('POST', '/api/loyalty-mission-goal-items', row, { expectStatus: [200, 201] });
  for (const row of update) await api('PUT', '/api/loyalty-mission-goal-items', row, { expectStatus: [200, 204] });
  if (remove.length) {
    const qs = remove.map((r) => `ids=${encodeURIComponent(r.id)}`).join('&');
    await api('DELETE', `/api/loyalty-mission-goal-items?${qs}`, null, { expectStatus: [200, 204] });
  }
  verbose(`goal items for ${missionName(spec)}: +${create.length} ~${update.length} -${remove.length}`);

  if (DRY_RUN) return desired.length;
  // A PerSku mission with zero targets is structurally valid and permanently uncompletable — the
  // exact silent failure this seeder exists to prevent. Assert, do not assume.
  const after = await goalItemsFor(missionId);
  if (after.length !== desired.length) {
    throw new Error(`${missionName(spec)}: expected ${desired.length} goal items, found ${after.length}`);
  }
  return after.length;
}

/* ── Banner artwork ─────────────────────────────────────────────────────────── */

/**
 * Upload the three banner SVGs (one per goal type) and return `{ key: url }`.
 *
 * Idempotent by FIXED FILE NAME, not by timestamp: an already-serving asset is reused untouched, so
 * the URL is the same on every run. That matters twice over — `bannerUrl` is part of
 * `missionSignature`, so a churning URL would delete and recreate every mission on every seed; and a
 * Published mission is immutable, so a URL that moves cannot be corrected in place afterwards.
 *
 * `--reupload-banners` forces the bytes back up when the artwork itself has been edited (the URL is
 * unchanged, so no mission is recreated — the same address simply serves the new image).
 */
async function uploadBanners() {
  const urls = {};
  for (const [key, b] of Object.entries(BANNERS)) {
    const existing = REUPLOAD_BANNERS ? null : await servingBannerUrl(key);
    if (existing) { urls[key] = existing; verbose(`banner ${key}: already serving — reused (${existing})`); continue; }
    const bytes = readFileSync(join(ROOT, bannerSourceRel(key)));
    const info = await uploadAsset(BANNER_FOLDER, b.file, bytes, BANNER_CONTENT_TYPE);
    urls[key] = info.url;
    verbose(`banner ${key}: uploaded ${b.file} → ${info.url}`);
  }
  return urls;
}

/**
 * The URL an already-uploaded banner serves at, or null.
 *
 * The address is READ BACK from the platform's own folder listing rather than composed here. The
 * upload returns an absolute `https://<host>/cms-content/assets/…` URL, and hand-building that string
 * would bake this deployment's asset-storage layout into the seeder — the GOLDEN RULE case: correct
 * once, then silently wrong (every run re-uploading, or every mission pointing at a 404) the moment a
 * deployment stores blobs anywhere else.
 */
async function listBannerFolder() {
  const r = await api('GET', `/api/assets?folderUrl=${encodeURIComponent(BANNER_FOLDER)}`, null, { expectStatus: [200, 201] });
  return (r?.results || []).filter((x) => x.type !== 'folder');
}

async function servingBannerUrl(key) {
  const entry = (await listBannerFolder()).find((x) => x.name === BANNERS[key].file);
  if (!entry?.url) return null;
  return (await assetUrlOk(entry.url)) ? entry.url : null;
}

/**
 * Prove the banner is actually FETCHABLE and is an image. An unreachable or wrong-typed bannerUrl
 * renders as a blank card, which reads as a storefront bug — so it is asserted here, at the only point
 * where the cause is still visible.
 */
async function verifyBannerServes(key, url) {
  if (DRY_RUN) return { key, url, status: 'dry-run', contentType: null };
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}cb=${Date.now()}`);
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !/^image\//i.test(contentType)) {
    throw new Error(`banner ${key} at ${url} → HTTP ${res.status}, content-type "${contentType}" (expected 2xx + image/*)`);
  }
  return { key, url, status: res.status, contentType };
}

/** Remove the uploaded banner assets. Full teardown only — a scoped one leaves siblings using them. */
async function deleteBanners() {
  // Only what is actually THERE is deleted. Deleting an already-absent asset does not no-op on this
  // platform — it answers HTTP 500 *"Could not find file …"* — so a blind delete makes the second
  // teardown of an already-clean env fail, which reads as a broken teardown rather than a finished one.
  const present = new Set((await listBannerFolder()).map((e) => e.name));
  const removed = [];
  for (const [key, b] of Object.entries(BANNERS)) {
    if (!present.has(b.file)) { verbose(`banner ${key}: already absent`); continue; }
    const rel = bannerAssetRel(key);
    await api('DELETE', `/api/assets?urls=${encodeURIComponent(rel)}`, null, { expectStatus: [200, 204] });
    removed.push(rel);
  }
  const residue = await verifyRemoved(async () => {
    const still = [];
    for (const key of Object.keys(BANNERS)) if (await servingBannerUrl(key)) still.push(key);
    return still;
  });
  if (residue > 0) throw new Error(`teardown left ${residue} banner asset(s) serving under ${BANNER_FOLDER}`);
  return removed;
}

/* ── Product resolution ─────────────────────────────────────────────────────── */

/**
 * Resolve the two PerSku target products by LIVE DISCOVERY, never by a committed SKU. Sorted by SKU
 * before slicing so a re-run against an unchanged catalog picks the SAME two products and the overlay
 * stops churning. Their ids AND skus are per-env, so both go to the overlay — a SKU is a business key
 * for a fixture we author, but these are products we merely FOUND, so nothing about them is invariant.
 */
async function resolveTargetProducts() {
  const found = await discoverCatalogProducts(api, 12);
  const usable = found.filter((p) => p.id && p.sku).sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
  if (usable.length < PERSKU_PRODUCTS.length) {
    throw new Error(
      `PerSku goals need ${PERSKU_PRODUCTS.length} distinct catalog products; live discovery returned ${usable.length}. `
      + 'Seed the catalog first (npm run seed:catalog).',
    );
  }
  const out = {};
  PERSKU_PRODUCTS.forEach((p, i) => { out[p.slot] = usable[i]; });
  return out;
}

/* ── Main ───────────────────────────────────────────────────────────────────── */

async function seed() {
  const problems = validateSpecShape();
  if (problems.length) {
    console.error('ABORT: the committed mission spec set is not coherent:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }

  const gate = await setMissionsEnabled(true);
  if (gate.baseEnabled === false) {
    log(`ℹ ${STORE_SETTING.baseSetting}=false on this store. Missions are INDEPENDENT of it (verified in source), so they still work — but base-loyalty cases will not.`);
  }

  const template = await api('GET', '/api/loyalty-missions/new');

  // An OrderValueGoal's currencyCode is REQUIRED at save — null and "" are both rejected with
  // "Currency code is required for the order value goal" — and a currency is per-env store config, so
  // it is resolved from the store here rather than committed as a literal.
  const { store } = await readLoyaltySettings();
  const currencies = resolveCurrencies(store);
  log(`  currencies: store-default=${currencies['store-default']} · store-alternate=${currencies['store-alternate']}`);
  // Locales are resolved from the store for the same reason currencies are: a store's language list is
  // per-env config, so a committed locale code would author translations into a language the storefront
  // on that env may never be able to request.
  const locales = resolveLocales(store);
  log(`  locales:    store-default=${locales['store-default']} · store-alternate=${locales['store-alternate']}`);
  const specs = ONLY ? MISSIONS.filter((m) => m.aliasName === ONLY || m.key === ONLY) : MISSIONS;
  if (ONLY && !specs.length) { console.error(`ABORT: --only ${ONLY} matches no mission spec.`); process.exit(2); }

  // Banners are uploaded BEFORE any mission is written: a Published mission is immutable, so a banner
  // that is not ready at create time can never be attached afterwards. ALL THREE are uploaded even on
  // a --only run, so a re-seed of one mission cannot leave the folder half-populated for the others.
  const bannerUrls = await uploadBanners();
  const bannerChecks = [];
  for (const [key, url] of Object.entries(bannerUrls)) {
    const r = await verifyBannerServes(key, url);
    bannerChecks.push(r);
    log(`  banner ${key.padEnd(12)} ${r.status} ${r.contentType || ''} ${url}`);
  }

  const wantsProducts = specs.some(needsGoalItems);
  const products = wantsProducts && !DRY_RUN ? await resolveTargetProducts() : {};
  if (wantsProducts && !DRY_RUN) {
    for (const p of PERSKU_PRODUCTS) log(`  PerSku target ${p.slot}: ${products[p.slot].sku} — ${products[p.slot].name} (qty ${p.quantity})`);
  }

  const existing = DRY_RUN ? new Map() : await ourMissionsByName();
  const now = new Date();
  const writeback = {};

  for (const spec of specs) {
    const name = missionName(spec);
    const body = buildMissionBody(spec, { template, storeId: STORE_ID, now, currencies, locales, bannerUrls });
    const want = missionSignature(body);
    const have = existing.get(name);

    let mission = have;
    let action = 'reused';

    if (have && spec.recreateAlways) {
      await deleteMissions([have.id]);
      mission = null; action = 'recreated (recreateAlways)';
    } else if (have) {
      // A fetched record must be re-read in full: the search projection may omit dynamicExpression.
      const full = await api('GET', `/api/loyalty-missions/${have.id}`);
      const drifted = !signaturesMatch(missionSignature(full || have), want);
      // The window is compared against what the INTENT means, not against "is it open". MSN_EXPIRED is
      // supposed to be outside its window, so a plain expiry check would delete and recreate it on
      // every run — churning the GUID that `@td(MSN_EXPIRED.id)` resolves to. What is drift for one
      // intent is the fixture working for the other.
      const windowWrong = windowIsOpen(full || have, now) !== windowExpectsOpen(spec.window);
      if (drifted || windowWrong) {
        await deleteMissions([have.id]);
        mission = null;
        action = drifted
          ? 'recreated (signature drift)'
          : `recreated (window ${windowExpectsOpen(spec.window) ? 'expired' : 'reopened'})`;
      }
    }

    if (!mission) {
      mission = await api('POST', '/api/loyalty-missions', body, { expectStatus: [200, 201] });
      if (action === 'reused') action = 'created';
    }

    // A LocalizedString posted in the wrong shape is accepted with 201 and persisted as {"values":{}} —
    // no error, no warning, every translation gone. So the translations are RE-READ and asserted rather
    // than assumed: a silently un-localized fixture would let a C11 case pass on the fallback branch.
    if (spec.l10n && mission?.id && !DRY_RUN) {
      const back = await api('GET', `/api/loyalty-missions/${mission.id}`);
      for (const field of Object.keys(spec.l10n)) {
        const apiField = field === 'name' ? 'localizedName' : field;
        const got = localizedValues(back?.[apiField]);
        const want = localizedValues(body[apiField]);
        for (const [loc, text] of Object.entries(want)) {
          if (got[loc] !== text) {
            throw new Error(
              `${missionName(spec)}: ${apiField}[${loc}] did not round-trip `
              + `(sent ${JSON.stringify(text)}, stored ${JSON.stringify(got[loc])}). `
              + 'A LocalizedString must be posted as { values: { <locale>: <text> } }.',
            );
          }
        }
      }
      verbose(`${missionName(spec)}: localized fields verified on read-back`);
    }

    // Every mission's banner is re-read and re-checked, not just the localized one: `bannerUrl` is a
    // plain string the server neither resolves nor validates (it round-trips verbatim — verified live),
    // so a wrong or empty one has no symptom until a storefront card renders blank. A Published mission
    // is immutable, so the only moment this is fixable is now.
    if (mission?.id && !DRY_RUN) {
      const back = await api('GET', `/api/loyalty-missions/${mission.id}`);
      if (back?.bannerUrl !== body.bannerUrl) {
        throw new Error(
          `${missionName(spec)}: bannerUrl did not round-trip (sent ${JSON.stringify(body.bannerUrl)}, `
          + `stored ${JSON.stringify(back?.bannerUrl)})`,
        );
      }
    }

    let items = 0;
    if (needsGoalItems(spec) && mission?.id && !DRY_RUN) {
      items = await syncGoalItems(spec, mission.id, products);
    }

    // The banner URL is an absolute, host-bearing address handed back by THIS env's asset store, so it
    // is overlay data exactly like the mission GUID — a committed one would point every other env at
    // this deployment's blob storage.
    writeback[spec.aliasName] = { id: mission?.id || '', banner_url: body.bannerUrl };
    // The resolved currency is per-env, so a case reads it from the overlay rather than assuming USD.
    if (spec.goal.currency) writeback[spec.aliasName].goal_currency = currencies[spec.goal.currency];
    // The resolved locale codes are per-env too, so a localization case reads which cultures were
    // really seeded rather than assuming en-US/de-DE.
    if (spec.l10n) {
      writeback[spec.aliasName].locale_default = locales['store-default'];
      writeback[spec.aliasName].locale_alternate = locales['store-alternate'];
    }
    log(`✓ ${spec.aliasName.padEnd(26)} ${name.padEnd(34)} ${spec.status}/${spec.public ? 'public' : 'private'} banner=${bannerKeyFor(spec)} ${action}${items ? ` (+${items} SKU targets)` : ''}`);
  }

  // The two discovered products get their own aliases so a case can name the SKU it must buy.
  for (const p of PERSKU_PRODUCTS) {
    const r = products[p.slot];
    if (r) writeback[p.aliasName] = { productId: r.id, sku: r.sku, name: r.name, catalogId: r.catalogId || '' };
  }

  // The gate fixture records the OBSERVED state of both switches, so a case reads what is really
  // there rather than assuming the platform defaults.
  writeback[STORE_SETTING.aliasName] = {
    missions_enabled: String(gate.missionsEnabled),
    base_loyalty_enabled: String(gate.baseEnabled),
    store_id: STORE_ID,
  };

  writeEnvAliasOverride(writeback);
  log(DRY_RUN ? 'DRY RUN complete (no writes).' : `Seed complete — ${specs.length} mission(s).`);
}

async function teardown() {
  const ours = await ourMissionsByName();
  const targets = ONLY
    ? [...ours.values()].filter((m) => m.name === missionName(MISSION_BY_ALIAS[ONLY] || { key: ONLY }))
    : [...ours.values()];

  // No missions is not "nothing to do": a previous partial run can leave the uploaded artwork behind,
  // and an orphaned asset is residue whether or not anything still points at it.
  if (!targets.length) {
    log('No AGENT-TEST-MSN- missions found.');
    if (!ONLY) {
      const removed = await deleteBanners();
      log(`✓ deleted ${removed.length} banner asset(s) under ${BANNER_FOLDER}`);
    }
    return;
  }

  // Bottom-up: the SKU targets are children of the mission and are NOT protected by the mission's
  // immutability rules, so they are removed first and explicitly rather than trusted to cascade.
  for (const m of targets) {
    const items = await goalItemsFor(m.id);
    if (items.length) {
      const qs = items.map((i) => `ids=${encodeURIComponent(i.id)}`).join('&');
      await api('DELETE', `/api/loyalty-mission-goal-items?${qs}`, null, { expectStatus: [200, 204] });
      verbose(`removed ${items.length} goal item(s) from ${m.name}`);
    }
  }
  await deleteMissions(targets.map((m) => m.id));
  log(`✓ deleted ${targets.length} mission(s)`);

  // The residue check is scoped to what this run actually claimed to delete. Unscoped, a `--teardown
  // --only X` run counted the ten fixtures it deliberately left alone as residue and threw — so the
  // one way to prove a SINGLE fixture's teardown symmetry was to wipe the whole set and churn every
  // other mission's GUID.
  const wanted = new Set(targets.map((m) => m.name));
  const residue = await verifyRemoved(async () => (
    (await searchMissions()).filter((m) => isSeededMissionName(m.name) && (!ONLY || wanted.has(m.name)))
  ));
  if (residue > 0) throw new Error(`teardown left ${residue} ${ONLY ? `${[...wanted][0]} ` : 'AGENT-TEST-MSN- '}mission(s) behind`);

  // The uploaded artwork is ours too, so a full teardown removes it. A SCOPED teardown must not: the
  // missions it deliberately left alone still point at those URLs, and deleting the bytes would leave
  // them rendering a blank card — a fixture broken by its own cleanup.
  if (!ONLY) {
    const removed = await deleteBanners();
    log(`✓ deleted ${removed.length} banner asset(s) under ${BANNER_FOLDER}`);
  } else {
    log(`ℹ banner assets under ${BANNER_FOLDER} left in place — the missions still using them would render blank`);
  }
  log('✓ zero residue');

  // The gate is left ON deliberately. It is a store-wide switch, not an entity this seeder owns, and
  // turning it off would silently disable missions for anyone else using the env. Use `--missions off`.
  log(`ℹ ${STORE_SETTING.missionsSetting} left as-is — flip it explicitly with --missions off if you need it down.`);
}

async function main() {
  assertSafeTarget();
  await auth();

  if (MISSIONS_TOGGLE) {
    if (!['on', 'off'].includes(MISSIONS_TOGGLE)) { console.error('ABORT: --missions takes on|off'); process.exit(2); }
    const r = await setMissionsEnabled(MISSIONS_TOGGLE === 'on');
    writeEnvAliasOverride({ [STORE_SETTING.aliasName]: { missions_enabled: String(r.missionsEnabled), base_loyalty_enabled: String(r.baseEnabled), store_id: STORE_ID } });
    return;
  }

  if (TARGETING.customerIdCondition == null) {
    verbose('targeting note: this build offers group targeting only (UserGroupIsCondition.groups); there is no customer-id condition.');
  }

  if (TEARDOWN) { await teardown(); return; }
  await seed();
}

main().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });

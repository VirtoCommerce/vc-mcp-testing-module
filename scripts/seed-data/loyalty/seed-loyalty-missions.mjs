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
 * PROGRESS (VCST-5346). Mission DEFINITIONS alone render a page of identical 0% / warning /
 * not-completed cards, because the storefront draws every visual state from `loyaltyMissionProgress`.
 * Progress has no write API on this build — `/api/loyalty-mission-progress` is search+get, and the one
 * writer is `LoyaltyMissionHandler : IEventHandler<OrderChangedEvent>` filtered to `EntryState.Added`.
 * There is no order-STATUS gate, so this seeder provisions the states with ONE Swagger-shaped order
 * (`POST /api/order/customerOrders`, status New) for the `USER` role's SECURITY-ACCOUNT id, and then
 * asserts the result twice: through the admin progress search, and through `loyaltyMissionProgress`
 * itself — the only surface that reports `daysRemaining`, which is computed per request and never
 * stored. A re-provision recreates the WHOLE mission set (a progress row cannot be reset, and one
 * order contributes to one mission once); it only happens when the live state does not already match.
 *
 * GROUP TARGETING. Two fixtures (MSN_GROUP_VIP / MSN_GROUP_VIP_PRIVATE) carry a real
 * `UserGroupIsCondition`, and the seeder resolves BOTH audience accounts live before writing anything:
 * the member must be in the target group and the non-member must NOT be, compared the way the server
 * compares (whole-string, OrdinalIgnoreCase). Either check failing ABORTS the seed — a targeted fixture
 * whose audience nobody belongs to seeds cleanly and can only ever report an absence that reads as a
 * product defect. The OBSERVED group lists go to the overlay as MSN_GROUP_AUDIENCE; the accounts
 * themselves belong to the loyalty user seeder and are never created or deleted here.
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
  STORE_ID, DRY_RUN, TEARDOWN, ONLY, ROOT, BACK_URL, ADMIN, ADMIN_PASSWORD,
  log, verbose, assertSafeTarget, auth, api, idsParam,
  uploadAsset, assetUrlOk,
  writeEnvAliasOverride, verifyRemoved, discoverCatalogProducts,
} from '../../lib/seed-common.mjs';
import { roleByKey, resolveRole } from '../../lib/user-roles.mjs';
import {
  MISSIONS, MISSION_BY_ALIAS, STORE_SETTING, PERSKU_PRODUCTS, TARGETING,
  BANNERS, BANNER_FOLDER, BANNER_CONTENT_TYPE, bannerSourceRel, bannerAssetRel, bannerKeyFor,
  missionName, isSeededMissionName, needsGoalItems, resolveCurrencies, resolveLocales,
  buildMissionBody, buildGoalItems, reconcileGoalItems, localizedValues,
  missionSignature, signaturesMatch, windowIsOpen, windowExpectsOpen, validateSpecShape,
  PROGRESS_ORDER, PROGRESS_ORDER_ALIAS, PROGRESS_USER_ROLE, progressOrderNumber,
  predictProgress, percentagesMatch, progressFixtures, DANGER_THRESHOLD_DAYS, WINDOWS,
  TARGET_GROUP, GROUP_AUDIENCE, isGroupTargeted, groupsInclude,
} from './missions-specs.mjs';

const argv = process.argv.slice(2);
const missionsFlagIdx = argv.indexOf('--missions');
/** `--missions on|off` sets ONLY the gate and exits — the toggle-test helper. */
const MISSIONS_TOGGLE = missionsFlagIdx >= 0 ? String(argv[missionsFlagIdx + 1] || '').toLowerCase() : null;
/** Push the banner BYTES back up even though the URL already serves — for when the artwork changed. */
const REUPLOAD_BANNERS = argv.includes('--reupload-banners');

/**
 * ADDITIVE MODE: create what is missing, NEVER delete-and-recreate what is already there.
 *
 * The seeder's repair strategy is delete-and-recreate, because a Published mission is immutable. That
 * is correct in isolation and DESTRUCTIVE when someone else's work is sitting on top of these
 * fixtures: `LoyaltyMissionProgress` rows have no delete API on this build, so recreating a mission
 * mints a fresh GUID and ORPHANS every progress row against a dead mission id — and the only way back
 * is to place another order, which cannot be undone either. A parallel VCST-5346 session hit exactly
 * that risk on 2026-08-27 while holding live progress on MSN_ENDING_SOON / MSN_PROGRESS_PARTIAL /
 * MSN_PROGRESS_COMPLETED.
 *
 * So `--no-recreate` turns every recreate decision into a SKIP + a report. It deliberately does not
 * silence the drift — the run still says which fixture is wrong and why, it just refuses to be the
 * one that destroys the shared state. Use it whenever another session may be mid-run against the env;
 * combine with `--only <ALIAS>` to add a single new fixture and touch nothing else.
 */
const NO_RECREATE = argv.includes('--no-recreate');

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
  // A repaired QUANTITY is reported at normal verbosity, not just under --verbose. MSN_PERSKU_ANY was
  // found live on 2026-08-27 carrying slot B at 2 against a spec of 1 — targetValue 4 instead of 3 —
  // and the reconcile would have fixed it on the next run without anyone learning that it had ever
  // been wrong. A silent repair of a discriminating value is indistinguishable from no drift at all.
  if (update.length) {
    log(`  ⚠ ${missionName(spec)}: repaired ${update.length} drifted goal-item quantity/-ies → ${update.map((u) => `${u.productId}=${u.quantity}`).join(', ')}`);
  }
  verbose(`goal items for ${missionName(spec)}: +${create.length} ~${update.length} -${remove.length}`);

  if (DRY_RUN) return desired.length;
  // A PerSku mission with zero targets is structurally valid and permanently uncompletable — the
  // exact silent failure this seeder exists to prevent. Assert, do not assume.
  const after = await goalItemsFor(missionId);
  if (after.length !== desired.length) {
    throw new Error(`${missionName(spec)}: expected ${desired.length} goal items, found ${after.length}`);
  }
  // COUNT was asserted; QUANTITY was not — and quantity is what decides currentValue/targetValue and
  // therefore every percentage derived from this mission. A row count that matches while a quantity
  // does not is precisely how MSN_PERSKU_ANY sat at targetValue 4 while looking correctly seeded.
  const wantByProduct = new Map(desired.map((d) => [d.productId, Number(d.quantity)]));
  const wrong = after
    .filter((r) => Number(r.quantity) !== wantByProduct.get(r.productId))
    .map((r) => `${r.productId}: ${r.quantity} (want ${wantByProduct.get(r.productId)})`);
  if (wrong.length) {
    throw new Error(`${missionName(spec)}: goal-item quantities did not land — ${wrong.join('; ')}`);
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

/* ── Progress provisioning (VCST-5346) ──────────────────────────────────────
 *
 * The storefront's mission card renders PROGRESS, and progress has no write API on this build: the
 * only writer is `LoyaltyMissionHandler : IEventHandler<OrderChangedEvent>` filtered to
 * `EntryState.Added`, which enqueues `ProcessOrderAsync` on Hangfire. There is no order-STATUS gate,
 * so a plain `POST /api/order/customerOrders` provisions it — no cart, no checkout, no payment, no
 * browser. Everything here exists to make that one order produce a deterministic set of states.
 *
 * WHY A RE-PROVISION DELETES AND RECREATES *EVERY* MISSION, not just the ones whose state is wrong.
 * A given order contributes to a given mission exactly once (`TransactionExistsAsync(missionId,
 * orderId, userId)` plus a unique index), and a progress row cannot be deleted, edited or reset
 * through any API. So the only way back to a known progress state is a mission with a NEW id — at
 * which point a fresh order must be placed for it. But that fresh order also lands on every OTHER
 * mission that still carries progress from the previous order, adding a second contribution and
 * silently pushing e.g. MSN_ORDERCOUNT from 1/2 to 2/2. Recreating the whole set makes the resulting
 * progress a pure function of (the spec set) x (one order) instead of of the run history. It is a big
 * hammer, so it only swings when the live state does NOT already match: on an unchanged env the
 * seeder reuses everything and touches nothing.
 */

/** The account whose progress this is — resolved through the role registry, never as a literal. */
async function resolveProgressOwner() {
  const role = resolveRole(roleByKey(PROGRESS_USER_ROLE));
  if (!role.email) {
    throw new Error(
      `cannot resolve the ${PROGRESS_USER_ROLE} role's email (looked for ${roleByKey(PROGRESS_USER_ROLE).emailVars.join('|')} in .env.${process.env.TEST_ENV || 'vcst'}). `
      + 'The progress fixtures need a real storefront account; an order with no customer writes progress nobody can query.',
    );
  }
  const u = await api('GET', `/api/platform/security/users/${encodeURIComponent(role.email)}`, null, { expectStatus: [200, 404] });
  // MUST be the SECURITY-ACCOUNT id, not the contact/member id. The write side stores
  // `order.CustomerId` verbatim (`context.UserId = order.CustomerId`, no lookup) while the read side
  // keys on `GetCurrentUserId()` = the `sub` claim = AspNetUsers.Id. Using `memberId` writes a row the
  // storefront can never see, and it fails SILENTLY — the page just shows nothing started.
  if (!u?.id) {
    throw new Error(`security account for ${role.email} not found — cannot place the progress order (seed the user first: npm run seed:users)`);
  }
  return { email: role.email, userId: u.id, userName: u.userName || role.email, memberId: u.memberId || '' };
}

/** Live progress rows for our fixtures, keyed by missionId. */
async function liveProgressByMission(missionIds, userId) {
  if (!missionIds.length) return new Map();
  const r = await api('POST', '/api/loyalty-mission-progress/search', { missionIds, userId, take: 200 }, { expectStatus: [200, 201] });
  return new Map((r?.results || []).map((p) => [p.missionId, p]));
}

/** Does a live progress row match what the spec declares? A missing row never matches. */
function progressMatches(spec, row) {
  if (!row) return false;
  const want = predictProgress(spec);
  if (!want) return false;
  return row.status === want.status
    && percentagesMatch(Number(row.percentage), want.percentage)
    && Number(row.currentValue) === want.currentValue
    && Number(row.targetValue) === want.targetValue;
}

async function findProgressOrder() {
  const number = progressOrderNumber();
  const r = await api('POST', '/api/order/customerOrders/search', { keyword: number, take: 5 }, { expectStatus: [200, 201] });
  return (r?.results || []).find((o) => o.number === number) || null;
}

async function deleteProgressOrder() {
  const found = await findProgressOrder();
  if (!found) return false;
  await api('DELETE', `/api/order/customerOrders?${idsParam([found.id])}`, null, { expectStatus: [200, 204] });
  verbose(`deleted provisioning order ${found.number}`);
  return true;
}

/**
 * Create the provisioning order if it is not already there. Deliberately NOT a rebuild-on-drift: a
 * second order would add a SECOND contribution to every mission it matches, so an order that exists is
 * always reused. The caller deletes it first when a genuine re-provision is needed.
 *
 * `catalogId` is mandatory on a line item — omitting it fails as a raw SQL NOT NULL violation
 * (HTTP 500, verified live), not as a readable validation error.
 */
async function ensureProgressOrder(owner, products, currency) {
  const number = progressOrderNumber();
  const existing = await findProgressOrder();
  if (existing) {
    if (existing.customerId !== owner.userId) {
      throw new Error(
        `${number} exists but is owned by ${existing.customerId}, not ${owner.email} (${owner.userId}). `
        + 'Its progress landed under the wrong account and the storefront cannot see it. Re-run after `--teardown`.',
      );
    }
    verbose(`provisioning order ${number} exists → ${existing.id}`);
    return { id: existing.id, created: false };
  }
  const body = {
    number,
    storeId: STORE_ID,
    currency,
    status: PROGRESS_ORDER.status,
    customerId: owner.userId,
    customerName: `AGENT-TEST Missions (${owner.email})`,
    items: PROGRESS_ORDER.lines.map((l) => {
      const p = products?.[l.slot];
      if (!p?.id) throw new Error(`progress order line ${l.slot} has no resolved product`);
      return {
        sku: p.sku, productId: p.id, catalogId: p.catalogId, name: p.name,
        quantity: l.quantity, price: PROGRESS_ORDER.unitPrice, productType: 'Physical', currency,
      };
    }),
  };
  const created = await api('POST', '/api/order/customerOrders', body, { expectStatus: [200, 201] });
  log(`  ✓ provisioning order ${number} → ${created?.id} (${owner.email}, ${PROGRESS_ORDER.lines.map((l) => `${l.slot}x${l.quantity}`).join(' + ')})`);
  return { id: created?.id, created: true };
}

/**
 * Wait for Hangfire to write the progress the order implies, then assert it. Polling rather than a
 * fixed sleep because the write is asynchronous: asserting immediately reads an empty table and
 * reports a provisioning failure that is really a race.
 */
async function awaitProgress(specs, userId, missionIdByAlias, { attempts = 20, intervalMs = 3000 } = {}) {
  const ids = specs.map((s) => missionIdByAlias[s.aliasName]).filter(Boolean);
  let live = new Map();
  for (let i = 0; i < attempts; i++) {
    live = await liveProgressByMission(ids, userId);
    if (specs.every((s) => progressMatches(s, live.get(missionIdByAlias[s.aliasName])))) return live;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const detail = specs.map((s) => {
    const row = live.get(missionIdByAlias[s.aliasName]);
    const want = predictProgress(s);
    return `${s.aliasName}: want ${want.status} ${want.percentage}% (${want.currentValue}/${want.targetValue}), got ${row ? `${row.status} ${row.percentage}% (${row.currentValue}/${row.targetValue})` : 'NO PROGRESS ROW'}`;
  }).join('\n    ');
  throw new Error(`progress did not reach the declared state within ${(attempts * intervalMs) / 1000}s:\n    ${detail}`);
}

/** A token for the customer-facing GraphQL. `/graphql` needs its own bearer; seed-common keeps its private. */
async function graphqlToken() {
  const res = await fetch(`${BACK_URL}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', username: ADMIN, password: ADMIN_PASSWORD, scope: 'offline_access' }),
  });
  if (!res.ok) throw new Error(`graphql token failed: ${res.status}`);
  return (await res.json()).access_token;
}

/**
 * Assert the states through the query the FRONTEND actually reads.
 *
 * The admin REST search above proves the rows exist; it cannot prove the storefront sees them, and it
 * cannot see `daysRemaining` at all — that field is computed per request in the xAPI resolver and is
 * never persisted, so the danger-badge fixture is unverifiable anywhere else. Run as admin with an
 * explicit `userId` (the authorization handler allows admin-or-self), which keeps the seeder from
 * needing the customer's password.
 */
async function verifyViaCustomerQuery(userId) {
  const token = await graphqlToken();
  const query = `query($s:String!,$u:String){ loyaltyMissionProgress(storeId:$s userId:$u first:100){ totalCount items {
    missionId name status percentage currentValue targetValue daysRemaining isStarted missionType
    items { productId currentQuantity targetQuantity } } } }`;
  const res = await fetch(`${BACK_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables: { s: STORE_ID, u: userId } }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`loyaltyMissionProgress failed: ${JSON.stringify(json.errors).slice(0, 300)}`);
  const byName = new Map((json.data?.loyaltyMissionProgress?.items || []).map((i) => [i.name, i]));

  const problems = [];
  for (const spec of progressFixtures()) {
    const card = byName.get(missionName(spec));
    const want = predictProgress(spec);
    if (!card) { problems.push(`${spec.aliasName}: absent from the customer-facing query entirely`); continue; }
    if (card.status !== want.status) problems.push(`${spec.aliasName}: status ${card.status}, expected ${want.status}`);
    if (!percentagesMatch(Number(card.percentage), want.percentage)) problems.push(`${spec.aliasName}: percentage ${card.percentage}, expected ${want.percentage}`);
    if (card.isStarted !== true) problems.push(`${spec.aliasName}: isStarted=false — the card renders a transient 0% placeholder, not a real progress row`);
    // The danger badge is a pure function of daysRemaining, and this is the ONLY surface that reports it.
    if (WINDOWS[spec.window]?.endOffsetDays < DANGER_THRESHOLD_DAYS) {
      if (!(card.daysRemaining < DANGER_THRESHOLD_DAYS)) {
        problems.push(`${spec.aliasName}: daysRemaining=${card.daysRemaining}, not below the ${DANGER_THRESHOLD_DAYS}-day danger threshold — the badge renders warning`);
      }
    }
    const rows = card.items || [];
    if (want.rows.length && rows.length !== want.rows.length) problems.push(`${spec.aliasName}: ${rows.length} SKU row(s), expected ${want.rows.length}`);
    if (want.rows.length) {
      const met = rows.filter((r) => r.currentQuantity >= r.targetQuantity).length;
      if (met !== want.rowsMet) problems.push(`${spec.aliasName}: ${met} target-met SKU row(s), expected ${want.rowsMet}`);
    }
    log(`  ✓ ${spec.aliasName.padEnd(24)} ${String(card.status).padEnd(11)} ${String(card.percentage).padEnd(5)}% ${card.currentValue}/${card.targetValue} daysRemaining=${card.daysRemaining} rows=${rows.map((r) => `${r.currentQuantity}/${r.targetQuantity}`).join(',') || '—'}`);
  }
  if (problems.length) throw new Error(`the customer-facing query does not show the declared states:\n    ${problems.join('\n    ')}`);
}

/* ── Group-targeting audience ───────────────────────────────────────────────
 *
 * A group-targeted fixture is worth nothing without two accounts that are provably on OPPOSITE sides
 * of the group, and "provably" has to mean OBSERVED, not declared: the committed registry records who
 * we intend the audience to be, and this is the step that checks the env agrees. Both directions are
 * asserted because each fails silently on its own —
 *   - the member drifting OUT of the group makes MSN_GROUP_VIP invisible to everyone, which reads as a
 *     targeting bug rather than as a fixture problem;
 *   - the non-member drifting IN makes "a non-member does not see it" unfalsifiable, and the case
 *     passes forever. That one is not hypothetical: LOYALTY_NOBAL_USER already carries groups
 *     ["VIP"] despite its name suggesting an unrelated purpose, so the wrong pick was one line away.
 *
 * Verified in source: the groups come from the CONTACT's `Groups` collection via
 * `IMemberResolver.ResolveMemberByIdAsync(securityUserId)`, and the comparison is whole-string
 * OrdinalIgnoreCase. `groupsInclude` mirrors that, so this agrees with the predicate that will really
 * decide visibility rather than with a stricter one of our own.
 */
async function resolveAudienceAccount(roleKey) {
  const decl = roleByKey(roleKey);
  const role = resolveRole(decl);
  if (!role.email) {
    throw new Error(
      `cannot resolve the ${roleKey} role's email (looked for ${decl.emailVars.join('|')} in .env.${process.env.TEST_ENV || 'vcst'}). `
      + 'The group-targeted fixtures need both audience accounts; without one, targeting cannot be observed in either direction.',
    );
  }
  const acct = await api('GET', `/api/platform/security/users/${encodeURIComponent(role.email)}`, null, { expectStatus: [200, 404] });
  if (!acct?.id) {
    throw new Error(`security account for ${roleKey} (${role.email}) not found — seed the loyalty users first (npm run seed:loyalty-users)`);
  }
  // The group lives on the MEMBER, not the account: GetUserGroups resolves securityUserId -> memberId
  // -> member.Groups. An account with no member record yields a NULL UserGroups server-side, at which
  // point every UserGroupIsCondition returns false and the mission vanishes with no error.
  if (!acct.memberId) {
    throw new Error(
      `${roleKey} (${role.email}) has a security account but no memberId. The server reads groups off the `
      + 'CONTACT, so this account can never satisfy a UserGroupIsCondition — every targeted mission would '
      + 'silently disappear for it, and the absence would read as a product bug.',
    );
  }
  const member = await api('GET', `/api/members/${encodeURIComponent(acct.memberId)}`, null, { expectStatus: [200, 404] });
  const groups = Array.isArray(member?.groups) ? member.groups.map(String) : [];
  return { role: roleKey, email: role.email, userId: acct.id, memberId: acct.memberId, groups };
}

async function resolveGroupAudience() {
  const member = await resolveAudienceAccount(GROUP_AUDIENCE.memberRole);
  const nonMember = await resolveAudienceAccount(GROUP_AUDIENCE.nonMemberRole);

  if (!groupsInclude(member.groups, TARGET_GROUP)) {
    throw new Error(
      `${member.role} (${member.email}) carries groups ${JSON.stringify(member.groups)}, which do not include `
      + `"${TARGET_GROUP}". The group-targeted fixtures would have NO audience at all, so "a targeted mission `
      + 'reaches its group" could never be observed — and the resulting absence would read as a targeting defect.',
    );
  }
  if (groupsInclude(nonMember.groups, TARGET_GROUP)) {
    throw new Error(
      `${nonMember.role} (${nonMember.email}) is ALSO in "${TARGET_GROUP}" (groups ${JSON.stringify(nonMember.groups)}). `
      + 'With both control accounts inside the audience, "a non-member does NOT see it" cannot fail, and the '
      + 'positive control proves nothing — a mission with no targeting at all would pass identically.',
    );
  }
  log(`  audience: ${member.role} ${member.email} groups=${JSON.stringify(member.groups)} (in "${TARGET_GROUP}")`);
  log(`            ${nonMember.role} ${nonMember.email} groups=${JSON.stringify(nonMember.groups)} (NOT in "${TARGET_GROUP}")`);
  return { member, nonMember };
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
  /** Fixtures `--no-recreate` refused to rebuild. Reported at the end so the drift is never silent. */
  const kept = [];
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

  // The progress order's line items point at the SAME discovered products the PerSku goals target, so
  // a run that provisions progress needs them even if no selected spec has SKU targets of its own.
  const wantsProducts = specs.some(needsGoalItems) || (!ONLY && progressFixtures().length > 0);
  const products = wantsProducts && !DRY_RUN ? await resolveTargetProducts() : {};
  if (wantsProducts && !DRY_RUN) {
    for (const p of PERSKU_PRODUCTS) log(`  PerSku target ${p.slot}: ${products[p.slot].sku} — ${products[p.slot].name} (qty ${p.quantity})`);
  }

  // The audience is checked BEFORE any mission is written, and it ABORTS rather than warns. A
  // group-targeted mission seeded against an audience nobody is in is the vacuous-fixture failure this
  // whole module is written against — it seeds cleanly, resolves through @td(), and can only ever
  // report an absence that reads as a product defect.
  const wantsAudience = !DRY_RUN && specs.some(isGroupTargeted);
  const audience = wantsAudience ? await resolveGroupAudience() : null;

  // --- VCST-5346: decide whether the progress states need re-provisioning, BEFORE any mission is
  // written. A reset deletes the whole set (see the block comment above `resolveProgressOwner`), so
  // the decision has to precede the reuse loop rather than interrupt it.
  const wantsProgress = !ONLY && !DRY_RUN && progressFixtures().length > 0;
  let owner = null;
  let progressReset = false;
  /** True when --no-recreate declined a reset, so the progress assertions below cannot hold. */
  let progressRefused = false;
  if (wantsProgress) {
    owner = await resolveProgressOwner();
    log(`  progress owner: ${owner.email} → security account ${owner.userId} (role ${PROGRESS_USER_ROLE})`);
    const live = await ourMissionsByName();
    const rows = await liveProgressByMission(
      progressFixtures().map((s) => live.get(missionName(s))?.id).filter(Boolean),
      owner.userId,
    );
    const stale = progressFixtures().filter((s) => {
      const m = live.get(missionName(s));
      return !m || !progressMatches(s, rows.get(m.id));
    });
    progressReset = stale.length > 0;
    if (progressReset && NO_RECREATE) {
      // The whole-set reset is the single most destructive thing this seeder can do — it deletes every
      // mission so ONE order can redetermine the set. Under --no-recreate it is refused outright: the
      // progress rows it would orphan cannot be deleted, and the states it would rebuild may be the
      // very ones another session is asserting against right now.
      progressReset = false;
      progressRefused = true;
      for (const s of stale) kept.push({ alias: s.aliasName, id: live.get(missionName(s))?.id || '(absent)', reason: 'progress state does not match the spec' });
      log(`  ⚠ --no-recreate: NOT re-provisioning progress (${stale.map((s) => s.aliasName).join(', ')}). The whole-set reset would orphan undeletable LoyaltyMissionProgress rows.`);
    } else if (progressReset) {
      log(`  progress re-provision needed (${stale.map((s) => s.aliasName).join(', ')}) — recreating every mission so one order fully determines the set`);
      const all = [...live.values()];
      for (const m of all) {
        const items = await goalItemsFor(m.id);
        if (items.length) await api('DELETE', `/api/loyalty-mission-goal-items?${idsParam(items.map((i) => i.id))}`, null, { expectStatus: [200, 204] });
      }
      if (all.length) await deleteMissions(all.map((m) => m.id));
      await deleteProgressOrder();
      log(`  cleared ${all.length} mission(s) + the provisioning order`);
    } else {
      log('  progress states already match the spec — reusing them (no order placed)');
    }
  } else if (!DRY_RUN && ONLY) {
    log('  ℹ --only run: progress provisioning skipped (a re-provision is a whole-set operation, see resolveProgressOwner)');
  }

  const existing = DRY_RUN || progressReset ? new Map() : await ourMissionsByName();
  const now = new Date();
  const writeback = {};

  for (const spec of specs) {
    const name = missionName(spec);
    const body = buildMissionBody(spec, { template, storeId: STORE_ID, now, currencies, locales, bannerUrls });
    const want = missionSignature(body);
    const have = existing.get(name);

    let mission = have;
    let action = 'reused';

    if (have && spec.recreateAlways && NO_RECREATE) {
      kept.push({ alias: spec.aliasName, id: have.id, reason: 'recreateAlways' });
      action = 'KEPT (--no-recreate; NOT reset to Draft)';
    } else if (have && spec.recreateAlways) {
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
      const reason = drifted
        ? 'signature drift'
        : (windowWrong ? `window ${windowExpectsOpen(spec.window) ? 'expired' : 'reopened'}` : null);
      if (reason && NO_RECREATE) {
        // Reported, never silenced: the fixture IS wrong and the run says so — it simply refuses to be
        // the process that orphans someone else's undeletable progress rows to fix it.
        const detail = drifted
          ? `live ${JSON.stringify(missionSignature(full || have))} vs spec ${JSON.stringify(want)}`
          : reason;
        kept.push({ alias: spec.aliasName, id: have.id, reason, detail });
        action = `KEPT (--no-recreate; ${reason} NOT repaired)`;
      } else if (reason) {
        await deleteMissions([have.id]);
        mission = null;
        action = `recreated (${reason})`;
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
    const audienceLabel = isGroupTargeted(spec) ? `groups=[${spec.condition.groups.join(',')}]` : 'any-group';
    log(`✓ ${spec.aliasName.padEnd(26)} ${name.padEnd(34)} ${spec.status}/${spec.public ? 'public' : 'private'} ${audienceLabel.padEnd(13)} banner=${bannerKeyFor(spec)} ${action}${items ? ` (+${items} SKU targets)` : ''}`);
  }

  // --- VCST-5346: place the provisioning order, then prove the states landed. Skipped entirely when
  // --no-recreate declined the reset: the assertions below would fail on a state we deliberately chose
  // not to rebuild, turning a considered refusal into a run that reads as broken.
  if (wantsProgress && progressRefused) {
    log('  ⚠ progress verification skipped — --no-recreate left the live states as they were (see the KEPT report below).');
  } else if (wantsProgress) {
    const missionIdByAlias = Object.fromEntries(Object.entries(writeback).map(([k, v]) => [k, v.id]));
    const order = await ensureProgressOrder(owner, products, currencies['store-default']);
    // The write is asynchronous (Hangfire), so this polls rather than asserting straight away.
    await awaitProgress(progressFixtures(), owner.userId, missionIdByAlias);
    // …and then re-asks the question through the query the storefront itself reads. The REST search
    // proves rows exist; only this proves the customer can see them, and only this reports
    // daysRemaining, which is computed per request and never stored.
    await verifyViaCustomerQuery(owner.userId);
    writeback[PROGRESS_ORDER_ALIAS] = {
      id: order.id || '', user_id: owner.userId, user_email: owner.email, store_id: STORE_ID,
    };
  }

  // The audience fixture records what was OBSERVED, never what was assumed: the two emails are per-env
  // identity from .env.<env>, the security-account ids are runtime, and the group lists are live state
  // read off this env's contacts. A case resolves the pair from here instead of naming an account, and
  // `*_groups` is the evidence that the assertion it is about to make can actually fail.
  if (audience) {
    writeback[GROUP_AUDIENCE.aliasName] = {
      member_email: audience.member.email,
      member_user_id: audience.member.userId,
      member_groups: audience.member.groups.join('|'),
      nonmember_email: audience.nonMember.email,
      nonmember_user_id: audience.nonMember.userId,
      nonmember_groups: audience.nonMember.groups.join('|'),
    };
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

  // A refusal that nobody reads is the same as a silent repair. Everything --no-recreate declined is
  // listed here, with the id, so the fixture can be fixed deliberately (and by whoever owns the state
  // sitting on top of it) rather than incidentally by the next full seed.
  if (kept.length) {
    log(`⚠ --no-recreate kept ${kept.length} pre-existing fixture(s) that the spec says are WRONG:`);
    for (const k of kept) log(`    ${k.alias} (${k.id}) — ${k.reason}${k.detail && k.detail !== k.reason ? `\n      ${k.detail}` : ''}`);
    log('    Nothing was deleted. Re-run WITHOUT --no-recreate, once no other session depends on these ids, to repair them.');
  }
  log(DRY_RUN ? 'DRY RUN complete (no writes).' : `Seed complete — ${specs.length} mission(s)${kept.length ? `, ${kept.length} kept unrepaired` : ''}.`);
}

async function teardown() {
  // Bottom-up in the entity graph: the provisioning ORDER is what created every progress row, so it
  // goes before the missions it fed. A scoped (--only) teardown leaves it — the fixtures it did not
  // touch still depend on it, and re-creating it later would double-count on all of them.
  //
  // KNOWN, UNAVOIDABLE RESIDUE: LoyaltyMissionProgress rows cannot be deleted. `/api/loyalty-mission-
  // progress` is search+get only and nothing else in the module removes them, so the rows this order
  // produced outlive it. They are harmless — GetUserMissionsAsync iterates MISSIONS, so a row whose
  // mission is gone is unreachable from every API and every storefront surface — but they do
  // accumulate, like the loyalty operation-log rows in seed-loyalty-ephemeral-user.mjs. This is
  // reported rather than silently swallowed so a zero-residue claim is not made where none is possible.
  if (!ONLY) {
    const removed = await deleteProgressOrder();
    log(removed
      ? `✓ deleted the provisioning order ${progressOrderNumber()}`
      : `ℹ no provisioning order ${progressOrderNumber()} to delete`);
    log('ℹ LoyaltyMissionProgress rows are NOT deletable (search+get API only) — the rows this order produced remain, orphaned and unreachable once their mission is gone.');
    if (!DRY_RUN) writeEnvAliasOverride({ [PROGRESS_ORDER_ALIAS]: { id: '', user_id: '', user_email: '', store_id: '' } });
    // The audience ACCOUNTS are not ours to delete — they belong to the loyalty user seeder and other
    // suites sign in as them. What this seeder owns is the OBSERVATION, and a stale one is worse than
    // none: it would let a case claim a membership nobody re-checked. So the overlay entry is blanked
    // and the accounts are left alone.
    if (!DRY_RUN) {
      writeEnvAliasOverride({
        [GROUP_AUDIENCE.aliasName]: {
          member_email: '', member_user_id: '', member_groups: '',
          nonmember_email: '', nonmember_user_id: '', nonmember_groups: '',
        },
      });
    }
    log(`ℹ ${GROUP_AUDIENCE.memberRole} / ${GROUP_AUDIENCE.nonMemberRole} accounts left in place — they belong to the loyalty user seeder; only the observed-membership overlay was cleared.`);
  }

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

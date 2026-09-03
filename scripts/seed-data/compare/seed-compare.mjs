#!/usr/bin/env node
/**
 * Seeds the `/compare` (product comparison) fixtures — VCST-5735.
 *
 * SINGLE source of truth: ./compare-specs.mjs (side-effect-free, shared with the drift guard and
 * the unit tests). test-data/compare/compare-products.csv is the committed @td registry mirroring
 * only the DERIVABLE business columns; `platform_id` is committed BLANK and the runtime GUID is
 * written per env to test-data/aliases.<env>.json via syncEnvAliases — never into the CSV.
 *
 * What it provisions (see compare-specs.mjs for WHY each value is what it is):
 *   - two ad-hoc category roots, `Compare Fixtures` (Group A/B/C) and `Compare Nested` (whose child
 *     shares its parent's NAME so two different tab keys render one label),
 *   - 12 products, each with its quantity constraints (minQuantity / packSize / maxQuantity) and
 *     INLINE product properties (no catalog property definition is created, so nothing leaks onto
 *     the other products of the shared seed catalog and there is nothing extra to tear down),
 *   - one product with NO category, linked at the store virtual-catalog ROOT so its breadcrumbs
 *     carry zero Category entries (the `uncategorized` tab).
 *
 * USAGE:
 *   node scripts/seed-data/compare/seed-compare.mjs [--dry-run] [--verbose] [--only CMP-001] [--teardown]
 *
 * Safety: assertSafeTarget() blocks ENV_RISK=production; idempotent find-or-create by product code
 * scoped to the seed catalog; teardown deletes only AGENT-TEST-prefixed entities and verifies zero
 * residue.
 */

import {
  assertSafeTarget, auth, api, log, verbose,
  DRY_RUN, TEARDOWN, ONLY, VERBOSE, BACK_URL, STORE_ID,
  ensureVirtualCatalog, ensureFulfillmentCenter, ensureCategoryPath, buildStoreSeo,
  ensureCurrencies, enrichProductContent, syncEnvAliases, verifyRemoved, idsParam,
} from '../../lib/seed-common.mjs';
import {
  PRODUCTS, CATEGORY_ROOTS, CATEGORY_PATHS, CSV_FILE_KEY, CURRENCY,
  SEED_PREFIX, priceListName, productSlug, validateSpecShape,
} from './compare-specs.mjs';

let VIRTUAL_CATALOG_ID = null;

const records = ONLY ? PRODUCTS.filter((r) => r.cmpId === ONLY || r.alias === ONLY) : PRODUCTS;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function findProductByCode(code, catalogId) {
  const r = await api('POST', '/api/catalog/listentries', {
    keyword: code, ...(catalogId ? { catalogId } : {}), take: 10,
  }, { expectStatus: [200, 201, 400, 404] });
  const found = (r?.listEntries || r?.results || []).find((p) => p.code === code && p.type === 'product');
  return found ? { id: found.id, code, name: found.name } : null;
}

/**
 * INLINE product property values. `propertyId: null` / `isManageable: false` is the shape the live
 * imported products already use (verified on the Xerox WorkCentre 6515/DN, whose COLOR / FUNCTION /
 * LCD_Size all come back that way and are exposed by xAPI exactly like catalog-defined ones). Using
 * it means this seeder creates NO catalog property definition, so nothing is inherited by the other
 * products of the shared AGENT-TEST-SEED-B2B-Electronics catalog.
 */
const toProperty = (pr) => ({
  name: pr.name,
  type: 'Product',
  valueType: pr.valueType,
  required: false, dictionary: false, multivalue: false, multilanguage: false, hidden: false,
  isManageable: false, isReadOnly: false, isNew: false,
  values: [{ propertyName: pr.name, valueType: pr.valueType, value: pr.value }],
});

function productBody(rec) {
  const body = {
    name: rec.name,
    code: rec.code,
    productType: 'Physical',
    vendor: 'QA',
    isActive: true,
    isBuyable: true,
    trackInventory: true,
    seoInfos: [buildStoreSeo({ semanticUrl: productSlug(rec.name), pageTitle: rec.name })],
  };
  if (rec.minQuantity) body.minQuantity = Number(rec.minQuantity);
  if (rec.packSize) body.packSize = Number(rec.packSize);
  if (rec.maxQuantity) body.maxQuantity = Number(rec.maxQuantity);
  if (rec.properties?.length) body.properties = rec.properties.map(toProperty);
  return body;
}

let _priceList = null;
async function findOrCreatePriceList() {
  if (_priceList) return _priceList;
  const name = priceListName(CURRENCY);
  const search = await api('GET', `/api/pricing/pricelists?keyword=${encodeURIComponent(name)}`, null, { expectStatus: [200, 404] });
  let pl = (search?.results || []).find((p) => p?.name === name);
  if (pl) { log(`↻ pricelist: ${name} (${pl.id})`); _priceList = pl; return pl; }
  pl = await api('POST', '/api/pricing/pricelists', { name, currency: CURRENCY, description: 'Seeded for /compare fixtures (VCST-5735)' }, { expectStatus: [200, 201] });
  try {
    await api('POST', '/api/pricing/assignments', {
      name: `${name} → ${STORE_ID}`, pricelistId: pl.id, catalogId: VIRTUAL_CATALOG_ID, priority: 100,
    }, { expectStatus: [200, 201] });
    log(`✓ pricelist + catalog assignment: ${name} (${pl?.id})`);
  } catch (e) { log(`⚠ pricelist created but assignment failed: ${String(e.message).slice(0, 150)}`); }
  _priceList = pl;
  return pl;
}

async function setPrice(priceListId, productId, list) {
  await api('PUT', '/api/products/prices', [{
    productId,
    prices: [{ pricelistId: priceListId, productId, list: Number(list), currency: CURRENCY, minQuantity: 1 }],
  }], { expectStatus: [200, 204] });
}

async function ensureInventory(ffcId, productId, qty) {
  try {
    await api('PUT', '/api/inventory/plenty', [{
      fulfillmentCenterId: ffcId, productId, inStockQuantity: Number(qty), reservedQuantity: 0, status: 'Enabled',
    }], { expectStatus: [200, 204] });
  } catch (e) { log(`⚠ inventory ${productId}: ${String(e.message).slice(0, 140)}`); }
}

/** Link a product at the store virtual-catalog ROOT (no categoryId) — the `uncategorized` shape. */
async function linkAtVirtualRoot(productId) {
  await api('POST', '/api/catalog/listentrylinks', [{
    listEntryId: productId, listEntryType: 'product', catalogId: VIRTUAL_CATALOG_ID,
  }], { expectStatus: [200, 204] });
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

async function seedRecord(rec, ffcId, defaultCatalogId) {
  console.log(`\n=== ${rec.cmpId} ${rec.alias}: ${rec.name} (${rec.code}) ===`);

  let catalogId = defaultCatalogId;
  let categoryId = null;
  if (rec.categoryPath) {
    const loc = await ensureCategoryPath(api, rec.categoryPath);
    if (!loc) throw new Error(`could not resolve category path "${rec.categoryPath}"`);
    catalogId = loc.catalogId;
    categoryId = loc.categoryId;
    log(`  category: ${loc.name} (${categoryId})`);
  } else {
    log('  category: NONE (catalog root → uncategorized tab)');
  }

  const body = productBody(rec);
  let product = await findProductByCode(rec.code, catalogId);
  if (product) {
    verbose(`↻ product ${rec.code} (${product.id}) — re-applying body`);
    // Re-apply so a spec edit (a changed MOQ / property value) lands on the next run rather than
    // leaving a stale fixture that still LOOKS provisioned. Merge onto the live entity so platform
    // fields we do not own are preserved.
    const full = await api('GET', `/api/catalog/products/${product.id}`, null, { expectStatus: [200, 404] });
    if (full && !DRY_RUN) {
      const merged = { ...full, ...body, id: product.id, catalogId: full.catalogId, categoryId: categoryId ?? full.categoryId };
      // seoInfos: keep the existing record's id so the PUT updates rather than duplicating.
      if (full.seoInfos?.length) merged.seoInfos = full.seoInfos;
      await api('POST', '/api/catalog/products', merged, { expectStatus: [200, 201, 204] });
    }
  } else {
    product = await api('POST', '/api/catalog/products', { catalogId, categoryId, ...body }, { expectStatus: [200, 201] });
    log(`  ✓ created product (${product?.id})`);
  }

  if (DRY_RUN || !product?.id) return { ...rec, productId: product?.id ?? null };

  const pl = await findOrCreatePriceList();
  await setPrice(pl.id, product.id, rec.listPrice);
  await ensureInventory(ffcId, product.id, rec.stock);
  if (!rec.categoryPath) await linkAtVirtualRoot(product.id);
  await enrichProductContent(product.id, { images: 1, code: rec.code });

  log(`  ✓ price ${rec.listPrice} ${CURRENCY} · stock ${rec.stock} · moq ${rec.minQuantity} · pack ${rec.packSize} · max ${rec.maxQuantity || '∞'} · props ${rec.properties.length}`);
  return { ...rec, productId: product.id };
}

async function main() {
  assertSafeTarget();
  console.log(`\n🌱 Compare fixtures seed${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`   Target: ${BACK_URL} | Store: ${STORE_ID}`);
  console.log(`   Rows (${records.length}): ${records.map((r) => r.cmpId).join(', ')}\n`);

  // Fail LOUD on a vacuous fixture set rather than seeding data that cannot decide anything.
  const shape = validateSpecShape();
  if (shape.length) {
    console.error('ABORT: compare-specs.mjs is not a discriminating fixture set:');
    for (const p of shape) console.error(`  - ${p}`);
    process.exit(2);
  }

  await auth();
  VIRTUAL_CATALOG_ID = await ensureVirtualCatalog(api);
  log(`Virtual catalog: ${VIRTUAL_CATALOG_ID}`);
  await ensureCurrencies(api, [CURRENCY]);
  const ffc = await ensureFulfillmentCenter(api);
  if (!ffc?.id && !DRY_RUN) throw new Error('No fulfillment center available');
  await findOrCreatePriceList();

  // The uncategorized fixture still needs a PHYSICAL catalog to live in. Resolve the same one every
  // categorised record lands in (ensureCategoryPath's default) so teardown's catalog-scoped lookup
  // finds it too.
  const anchor = await ensureCategoryPath(api, CATEGORY_PATHS.A);
  const defaultCatalogId = anchor?.catalogId ?? null;

  const seeded = [];
  for (const rec of records) {
    try { seeded.push(await seedRecord(rec, ffc?.id, defaultCatalogId)); }
    catch (e) { console.error(`  ❌ ${rec.cmpId}: ${String(e.message).slice(0, 300)}`); seeded.push({ ...rec, error: e.message }); }
  }

  if (!DRY_RUN) {
    const ids = seeded.filter((s) => s.productId).map((s) => s.productId);
    try {
      // documentType MUST be 'Product' (not 'CatalogProduct', which is accepted and indexes
      // nothing) and the field MUST be `documentIds` (not `ids`, which degrades to a global
      // incremental) — see knowledge/execution/test-data-authoring.md §5a.
      await api('POST', '/api/search/indexes/index', [{ documentType: 'Product', documentIds: ids, rebuild: false }], { expectStatus: [200, 204] });
      log('✓ reindex triggered');
    } catch (e) { log(`⚠ reindex: ${String(e.message).slice(0, 120)}`); }

    // Runtime GUIDs → aliases.<env>.json only. The committed CSV keeps platform_id BLANK.
    const byKey = {};
    for (const s of seeded) if (s.productId) byKey[s.cmpId] = { platform_id: s.productId };
    if (Object.keys(byKey).length) {
      syncEnvAliases(CSV_FILE_KEY, byKey);
      log(`✓ aliases.${process.env.TEST_ENV || 'vcst'}.json: wrote ${Object.keys(byKey).length} runtime id(s)`);
    }
  }

  const ok = seeded.filter((s) => !s.error).length;
  console.log(`\n✅ Compare fixtures: ${ok}/${seeded.length} products seeded`);
  for (const s of seeded) {
    console.log(s.error ? `  ❌ ${s.cmpId}: ${String(s.error).slice(0, 120)}` : `  ✓ ${s.cmpId} ${s.alias} id=${s.productId}`);
  }
}

// ---------------------------------------------------------------------------
// teardown — reverse order, AGENT-TEST-only, zero-residue verified
// ---------------------------------------------------------------------------

async function teardown() {
  assertSafeTarget();
  await auth();
  console.log(`\n🧹 Compare fixtures teardown${DRY_RUN ? ' [DRY RUN]' : ''}`);
  VIRTUAL_CATALOG_ID = await ensureVirtualCatalog(api);

  // 1. Products. Hard AGENT-TEST name guard on top of the exact-code match, so a real product that
  //    happens to share a code can never be deleted.
  const ids = [];
  for (const rec of records) {
    const p = await findProductByCode(rec.code);
    if (!p?.id) continue;
    if (!String(p.name || '').startsWith(SEED_PREFIX)) { log(`⚠ skip ${rec.code}: "${p.name}" lacks the ${SEED_PREFIX} prefix — not a seed product`); continue; }
    ids.push(p.id);
  }
  if (ids.length && !DRY_RUN) {
    // MUST be `objectIds` — an empty ObjectIds wipes EVERY authorized product.
    await api('POST', '/api/catalog/listentries/delete', { objectIds: ids, objectType: 'CatalogProduct' }, { expectStatus: [200, 204, 404] })
      .catch((e) => log(`⚠ product delete: ${String(e.message).slice(0, 140)}`));
    log(`✗ deleted ${ids.length} product(s)`);
  } else log(ids.length ? `[DRY] would delete ${ids.length} product(s)` : '– no seeded compare products found');

  // 2. Pricelist (name is date-stable, so this is exactly the one this seeder made).
  const plName = priceListName(CURRENCY);
  const s = await api('GET', `/api/pricing/pricelists?keyword=${encodeURIComponent(plName)}`, null, { expectStatus: [200, 404] });
  const pls = (s?.results || []).filter((p) => p?.name === plName).map((p) => p.id);
  if (pls.length && !DRY_RUN) {
    await api('DELETE', `/api/pricing/pricelists?${idsParam(pls)}`, null, { expectStatus: [200, 204, 404] }).catch(() => {});
    log(`✗ deleted pricelist ${plName}`);
  }

  // 3. The two ad-hoc category roots this domain owns — unlink from the store virtual catalog
  //    FIRST (otherwise the live catalog keeps a dangling entry), then delete the subtree.
  //    ONLY runs on a full teardown: `--only` scopes to one product and must not remove a tab that
  //    the other fixtures still live in.
  if (!ONLY) {
    for (const rootName of CATEGORY_ROOTS) {
      const loc = await ensureCategoryPath(api, rootName);
      if (!loc?.categoryId || String(loc.categoryId).startsWith('dry-')) continue;
      if (DRY_RUN) { log(`[DRY] would unlink + delete category root "${rootName}" (${loc.categoryId})`); continue; }
      await api('POST', '/api/catalog/listentrylinks/delete', [{ listEntryId: loc.categoryId, listEntryType: 'category', catalogId: VIRTUAL_CATALOG_ID }], { expectStatus: [200, 204, 404] }).catch(() => {});
      await api('POST', '/api/catalog/listentries/delete', { objectIds: [loc.categoryId], objectType: 'Category' }, { expectStatus: [200, 204, 404] })
        .catch((e) => log(`⚠ category delete "${rootName}": ${String(e.message).slice(0, 140)}`));
      log(`✗ removed category root "${rootName}" (${loc.categoryId})`);
    }
  }

  const residual = await verifyRemoved(async () => {
    const out = [];
    for (const rec of records) {
      const p = await findProductByCode(rec.code);
      if (p?.id && String(p.name || '').startsWith(SEED_PREFIX)) out.push(p.id);
    }
    return out;
  });
  console.log(residual === 0
    ? '\n✅ Compare teardown verified — 0 fixtures remain'
    : `\n⚠ Compare teardown incomplete — ${residual} product(s) still present`);
  if (residual > 0 && !DRY_RUN) process.exit(1);
}

(TEARDOWN ? teardown() : main()).catch((e) => {
  console.error(`\n❌ Compare seed failed: ${e.message}`);
  if (VERBOSE) console.error(e.stack);
  process.exit(1);
});

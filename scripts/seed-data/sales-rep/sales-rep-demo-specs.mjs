/**
 * scripts/seed-data/sales-rep/sales-rep-demo-specs.mjs
 *
 * The DEMO sales-rep dataset — declarations and derivations, side-effect free. No env reads, no
 * network, no `main()`, so the seeder, the drift guard and the unit tests all import ONE source of
 * truth rather than three drifting copies.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE FIXTURE FAMILY. The AGENT-TEST fixtures are built to be
 * findable: the family prefix rides every display name, which is exactly what makes teardown a
 * one-line keyword sweep. A demo inverts that requirement — the data has to read as a real
 * business, so `AGENT-TEST-Org-AcmeCorp-20260310` and `AGENT-TEST Buyer` are disqualifying. The
 * prefix is not decoration here; it IS the delete mechanism, so removing it means replacing it:
 *
 *   1. A HIDDEN MARKER in `outerId` on every globally-enumerable entity. `outerId` is on the model
 *      (Member and CustomerOrder are IHasOuterId), it is metadata for "this came from an external
 *      system", and no storefront fragment or Admin grid column renders it. This is the same move
 *      `b2b/addresses-specs.mjs` already makes, and for the same reason.
 *   2. AN ID LEDGER in `test-data/aliases.<env>.json`, because two entity types have NO hidden
 *      field at all: a sales-rep document's create body is closed (`fileId/category/name/summary/
 *      pageCount/previewUrl`) and every one of those renders, and a task's five inputs are all
 *      list, filter or detail fields. For those the ledger is the only teardown handle.
 *
 * Neither layer is sufficient alone: a ledger cannot survive an interrupted run or a reverted
 * overlay, and a marker cannot reach a document. Teardown reads the ledger first and sweeps by
 * marker for orphans.
 *
 * WHAT THIS DATASET CANNOT DO. `createdDate` is server-assigned and silently ignored on POST and
 * PUT (see sales-rep-orders-specs.mjs), so demo order history CANNOT be backdated. The narrative is
 * therefore "a day in the life of two reps" rather than "this quarter" — which also makes every
 * placed-today / new-this-week dashboard counter read non-zero, a better demo than an empty widget.
 * Relative recency is controlled the only way it can be: POST order, latest last.
 *
 * NO CATALOG ENTITIES ARE DECLARED HERE, deliberately. Products come from live discovery
 * (`discoverCatalogProducts`), never from a hardcoded SKU. That also keeps `td:reconcile` check [7]
 * — which audits AGENT-TEST prefixes on seed-catalog entities — a non-issue by construction rather
 * than by exemption.
 */

import {
  pdfBytes, docxBytes, xlsxBytes, pngBytes, jpegBytes,
} from './sales-rep-docs-specs.mjs';

// ---- marker ----------------------------------------------------------------

/**
 * Deliberately NOT "AGENT-TEST". `sweepAgentTestMembers()` in user-provision.mjs enumerates members
 * by the literal keyword 'AGENT-TEST-', so a demo marker containing it would be collected and
 * deleted by an unrelated b2b teardown — a demo destroyed by a command that never mentioned it.
 */
export const DEMO_MARKER_PREFIX = 'DEMO-SR';

/** Member.OuterId and CustomerOrder.OuterId are [StringLength(128)]; over-long silently truncates. */
export const DEMO_MARKER_MAX_LENGTH = 128;

export const demoMarker = (type, key) => `${DEMO_MARKER_PREFIX}:${type}:${key}`;
export const isDemoMarker = (v) => String(v ?? '').trim().startsWith(`${DEMO_MARKER_PREFIX}:`);

/** The business key back out of a marker, or null when the value is not ours. */
export function demoMarkerKey(v) {
  if (!isDemoMarker(v)) return null;
  return String(v).trim().split(':').slice(2).join(':') || null;
}

/**
 * Teardown scope for a `--only <key>` run. A CONTENT match is scoped for free (the caller filters
 * the declared rows), but a MARKER match is not — an unscoped marker sweep during a scoped
 * teardown would delete fixtures the operator explicitly asked to keep.
 */
export function markerSweepInScope(outerId, only) {
  if (!isDemoMarker(outerId)) return false;
  if (!only) return true;
  return demoMarkerKey(outerId) === only;
}

/** The dataset flag written to `_meta.dataset_profile`; the fixtures profile is its counterpart. */
export const DEMO_PROFILE = 'sales-rep-demo';

/**
 * The overlay key the demo id ledger lives under. Declared HERE rather than in the seeder because
 * three files need it — the seeder WRITES it, `td:reconcile` check [12] READS it, and
 * `validate-sales-rep-demo-data.mjs` ASSERTS its shape — and a transcribed copy fails silently:
 * rename it in one place and reconcile reports "no ledger" forever while the seed still runs green.
 * The leading `_` is load-bearing: `selectProbeTargets()` in overlay-specs.mjs skips underscore
 * keys, which is the only thing keeping check [11] from member-probing every order and file GUID
 * the ledger holds and reporting each one STALE.
 */
export const DEMO_LEDGER_KEY = '_demo_sales_rep_ledger';

// ---- the narrative ---------------------------------------------------------

export const DEMO_STORE = 'B2B-store';
export const DEMO_CURRENCY = 'USD';

/**
 * Customer organizations. The names are the standard fictional-company set — they read as real,
 * and they name no actual customer, so nobody mid-demo has to wonder whether a slide just leaked a
 * client. Addresses are real, routable street addresses in the named cities: the rep dashboard's
 * shipTo formatter renders city + region, so a placeholder address shows up as a visibly empty cell.
 */
export const DEMO_ORGS = [
  {
    key: 'DORG-NORTHWIND',
    name: 'Northwind Traders',
    line1: '1201 Third Avenue, Suite 2200',
    city: 'Seattle', regionName: 'Washington', postalCode: '98101',
    countryCode: 'USA', countryName: 'United States',
    phone: '+1 206 555 0142', email: 'purchasing@northwindtraders.example',
    productSearch: 'steel',
    productMatch: /\b(bolt|screw|fastener|washer|nut|steel)\b/i,
  },
  {
    key: 'DORG-CONTOSO',
    name: 'Contoso Manufacturing',
    line1: '191 West Nationwide Boulevard',
    city: 'Columbus', regionName: 'Ohio', postalCode: '43215',
    countryCode: 'USA', countryName: 'United States',
    phone: '+1 614 555 0118', email: 'procurement@contoso-mfg.example',
    productSearch: 'printer',
    productMatch: /\b(printer|toner|cartridge|scanner|copier|multifunction)\b/i,
  },
  {
    key: 'DORG-FABRIKAM',
    name: 'Fabrikam Industrial',
    line1: '660 Woodward Avenue, Floor 12',
    city: 'Detroit', regionName: 'Michigan', postalCode: '48226',
    countryCode: 'USA', countryName: 'United States',
    phone: '+1 313 555 0173', email: 'supply@fabrikam-industrial.example',
    productSearch: 'battery',
    productMatch: /\b(battery|batteries|power station|power bank|powerbank|solar)\b/i,
  },
  {
    key: 'DORG-WINGTIP',
    name: 'Wingtip Electrical Supply',
    line1: '2201 East Camelback Road, Suite 650',
    city: 'Phoenix', regionName: 'Arizona', postalCode: '85016',
    countryCode: 'USA', countryName: 'United States',
    phone: '+1 602 555 0129', email: 'orders@wingtip-electrical.example',
    productSearch: 'cable',
    productMatch: /\b(cable|cord|charger|charging|wire)\b/i,
  },
];

/**
 * A product a demo order must never contain.
 *
 * The catalog on a QA-turned-demo environment still holds fixture products — `AGENT-TEST-Cordless
 * Drill`, `AGENT-TEST-Gloves Winter` are live on virtostart right now — because tearing down the
 * sales-rep domain correctly does NOT touch the catalog. Line-item names render in the order
 * detail, the rep hub and the storefront, so one unfiltered pick puts the family prefix on the
 * screen this whole dataset exists to keep clean. Filtering at discovery is the only place that
 * catches it: by the time the order is POSTed the name has already been copied into the line item.
 */
export const EXCLUDED_PRODUCT_RE = /AGENT-TEST|TEST-AGENT|\bDRY-\b/i;

/** True when a discovered catalog product is safe to put in a demo order. */
export function isDemoSafeProduct(p) {
  if (!p || !p.id || !(p.sku || p.code)) return false;
  return ![p.name, p.sku, p.code].some((v) => EXCLUDED_PRODUCT_RE.test(String(v ?? '')));
}

// ---- roles -----------------------------------------------------------------

/**
 * The REAL B2B organization-member roles, verified live against
 * `POST /api/platform/security/roles/search` on 2026-09-23 and matching the roles the b2b fixture
 * family already assigns in `test-data/b2b/users.csv`.
 *
 * These are platform roles, not job titles. An invented title like "Purchasing Manager" or "Plant
 * Buyer" reads plausibly in a spec file and then cannot be assigned to anything, because no such
 * role exists — the membership write silently keeps its default and the demo shows a member list
 * whose roles came from nowhere. A demo of a B2B platform that misrepresents that platform's own
 * permission model is worse than one with no roles at all.
 */
export const PLATFORM_ORG_ROLES = [
  'Organization maintainer',   // full org management + purchasing
  'Organization manager',
  'Organization employee',
  'Purchasing agent',          // cart + checkout + order history
];

/**
 * The sales-rep roles, and there are exactly TWO assignable — confirmed live from
 * `GET /api/sales-rep/roles`, which is also the set the Admin blade's single-select offers.
 * ("Sales Rep Documents Manager" exists as a platform role but is not offered here; the fixture
 * family composes it onto an account afterwards.)
 *
 * THE CHOICE IS LOAD-BEARING FOR THIS DEMO. Per the domain map §3b, the hub sidebar is
 * role-dependent: a plain `Sales Representative` gets Dashboard + My customers and **no Document
 * library** — no link and no dashboard widget. A rep on the basic role therefore cannot see a
 * single one of the documents this dataset seeds, and nothing anywhere reports that; the library
 * simply is not in their navigation. Any demo rep who is meant to show documents must hold
 * `Advanced Sales Representative`.
 */
export const SALES_REP_ROLE_BASIC = 'Sales Representative';
export const SALES_REP_ROLE_ADVANCED = 'Advanced Sales Representative';
export const PLATFORM_SALES_REP_ROLES = [SALES_REP_ROLE_BASIC, SALES_REP_ROLE_ADVANCED];

/** True when a rep on this role can reach the document library at all. */
export const roleSeesDocuments = (roleName) => String(roleName || '').trim() === SALES_REP_ROLE_ADVANCED;

/**
 * The two reps, and the organizations each serves.
 *
 * DORG-CONTOSO is served by BOTH on purpose. A demo where every customer has exactly one rep cannot
 * show the multi-rep surface at all — `customerSalesReps` would return a single row everywhere, and
 * the screen would look identical whether the platform supported shared accounts or not.
 *
 * `emailVar` rather than a literal: resolved from the environment at seed time, because attaching
 * sales-rep status to the wrong real person is not a recoverable mistake. The seeder throws on an
 * unresolved variable instead of guessing.
 */
export const DEMO_REPS = [
  {
    key: 'DEMO_REP_VOLKOVA',
    emailVar: 'SR_DEMO_REP_VOLKOVA_EMAIL',
    passwordVar: 'SR_DEMO_REP_VOLKOVA_PASSWORD',
    firstName: 'Alla', lastName: 'Volkova', fullName: 'Alla Volkova',
    store: DEMO_STORE,
    // Required, not aspirational: this rep is the one who demonstrates the document library, and
    // the basic role has no link and no widget for it. Verified live 2026-09-23: she already holds
    // Advanced, so this is an assertion the seeder checks, never a write it performs.
    salesRepRole: SALES_REP_ROLE_ADVANCED,
    showsDocuments: true,
    servedOrgs: ['DORG-NORTHWIND', 'DORG-CONTOSO', 'DORG-FABRIKAM'],
    purpose: 'Senior rep with the larger book. Already a sales rep on virtostart since 2022, so the '
      + 'demo ATTACHES served organizations rather than creating an account.',
  },
  {
    key: 'DEMO_REP_ZHUK',
    emailVar: 'SR_DEMO_REP_ZHUK_EMAIL',
    passwordVar: 'SR_DEMO_REP_ZHUK_PASSWORD',
    firstName: 'Oleg', lastName: 'Zhuk', fullName: 'Oleg Zhuk',
    store: DEMO_STORE,
    // Either role works for this rep — he demonstrates the customer/order side, not documents. The
    // seeder reports whichever he actually holds rather than requiring one.
    salesRepRole: null,
    showsDocuments: false,
    servedOrgs: ['DORG-CONTOSO', 'DORG-WINGTIP'],
    purpose: 'Second rep, smaller book, sharing Contoso with Volkova so the multi-rep-per-customer '
      + 'surface is non-degenerate.',
  },
];

/** Buyer contacts. Real names, per-organization email domains, no AGENT-TEST anywhere. */
export const DEMO_CONTACTS = [
  { key: 'DCT-NW-1', org: 'DORG-NORTHWIND', firstName: 'Margaret', lastName: 'Hale', email: 'm.hale@northwindtraders.example', role: 'Organization maintainer' },
  { key: 'DCT-NW-2', org: 'DORG-NORTHWIND', firstName: 'Daniel', lastName: 'Okafor', email: 'd.okafor@northwindtraders.example', role: 'Purchasing agent' },
  { key: 'DCT-CN-1', org: 'DORG-CONTOSO', firstName: 'Priya', lastName: 'Raman', email: 'p.raman@contoso-mfg.example', role: 'Organization maintainer' },
  { key: 'DCT-CN-2', org: 'DORG-CONTOSO', firstName: 'Thomas', lastName: 'Bergmann', email: 't.bergmann@contoso-mfg.example', role: 'Purchasing agent' },
  { key: 'DCT-FB-1', org: 'DORG-FABRIKAM', firstName: 'Elena', lastName: 'Duarte', email: 'e.duarte@fabrikam-industrial.example', role: 'Organization manager' },
  { key: 'DCT-FB-2', org: 'DORG-FABRIKAM', firstName: 'Marcus', lastName: 'Webb', email: 'm.webb@fabrikam-industrial.example', role: 'Purchasing agent' },
  { key: 'DCT-WT-1', org: 'DORG-WINGTIP', firstName: 'James', lastName: 'Whitfield', email: 'j.whitfield@wingtip-electrical.example', role: 'Organization maintainer' },
];

/**
 * Orders. `seq` is the POST order and the ONLY lever on relative recency, since createdDate is
 * server-assigned — so the row intended to read as each organization's latest is posted last.
 *
 * Line items come from the organization's OWN product pool, discovered live via its
 * `productSearch` phrase and then claimed globally so no product appears under two customers.
 *
 * `productMatch` is the SECOND filter, and it is not redundant. The catalog's search is relevance-
 * ORDERED but not relevance-BOUNDED: measured live 2026-09-23, "printer" returns 40 hits whose top 3
 * are printers and whose tail includes a bodycon dress and an autoclave, and "steel" returns a street
 * address ("1 Hopes Rise, Frankston South, VIC 3199") as a product. Taking the first N hits therefore
 * puts a dress on a printer manufacturer's order line in front of an audience. `productMatch` keeps
 * only hits whose NAME actually carries the category word, which is the difference between an order
 * that reads like a real purchase and one that reads like a random slice of a catalog.
 * Two properties depend on that, and neither survives an arbitrary catalog slice:
 *
 *   COHERENCE — an electrical supplier ordering ski boots reads as fake the moment anyone looks at
 *   an order. The phrases map each customer onto a product family that matches its business.
 *
 *   DISCRIMINATION — overlapping product sets make the top-sellers widget rank the same products
 *   for every customer, so the panel renders perfectly and proves nothing.
 */
export const DEMO_ORDERS = [
  { key: 'DORD-NW-01', org: 'DORG-NORTHWIND', buyer: 'DCT-NW-1', status: 'Completed', total: 4820.00, items: 4, seq: 10 },
  { key: 'DORD-NW-02', org: 'DORG-NORTHWIND', buyer: 'DCT-NW-2', status: 'Processing', total: 1265.50, items: 3, seq: 20 },
  { key: 'DORD-NW-03', org: 'DORG-NORTHWIND', buyer: 'DCT-NW-1', status: 'New', total: 7310.75, items: 5, seq: 80 },

  { key: 'DORD-CN-01', org: 'DORG-CONTOSO', buyer: 'DCT-CN-1', status: 'Completed', total: 12480.00, items: 6, seq: 15 },
  { key: 'DORD-CN-02', org: 'DORG-CONTOSO', buyer: 'DCT-CN-2', status: 'Cancelled', total: 940.00, items: 3, seq: 25 },
  { key: 'DORD-CN-03', org: 'DORG-CONTOSO', buyer: 'DCT-CN-1', status: 'Processing', total: 3175.20, items: 4, seq: 85 },

  { key: 'DORD-FB-01', org: 'DORG-FABRIKAM', buyer: 'DCT-FB-1', status: 'Completed', total: 8640.00, items: 5, seq: 30 },
  { key: 'DORD-FB-02', org: 'DORG-FABRIKAM', buyer: 'DCT-FB-2', status: 'New', total: 2290.40, items: 3, seq: 90 },


  { key: 'DORD-WT-01', org: 'DORG-WINGTIP', buyer: 'DCT-WT-1', status: 'Completed', total: 3420.60, items: 4, seq: 50 },
  { key: 'DORD-WT-02', org: 'DORG-WINGTIP', buyer: 'DCT-WT-1', status: 'New', total: 990.00, items: 2, seq: 99 },
];

export const DEMO_DOC_CATEGORIES = { CATALOGS: 'Catalogs', PRICING: 'Price Lists', CONTRACTS: 'Contracts' };

/**
 * Documents. Real business titles and real file bytes — the byte builders are imported from
 * sales-rep-docs-specs.mjs rather than reimplemented, because they already emit genuinely valid
 * PDF/DOCX/XLSX/PNG/JPEG files that open in a real viewer. A demo document that fails to open when
 * someone clicks it is worse than no document.
 *
 * Exactly ONE is pinned: the platform enforces a single pinned document, so declaring two would
 * make which-one-wins a race rather than a fixture.
 */
export const DEMO_DOCUMENTS = [
  { key: 'DDOC-CATALOG', sourceFile: 'newier.pdf', kind: 'pdf', fileName: 'Industrial-Catalog-2026.pdf', contentType: 'application/pdf', name: '2026 Industrial Catalog', category: DEMO_DOC_CATEGORIES.CATALOGS, pinned: true, pageCount: 148, summary: 'Full product catalog for the 2026 season, including the new fastener and abrasives ranges.' },
  { key: 'DDOC-PRICE-Q4', sourceFile: 'Test.xlsx', kind: 'xlsx', fileName: 'Price-List-Q4-2026.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'Q4 2026 Price List', category: DEMO_DOC_CATEGORIES.PRICING, pinned: false, pageCount: null, summary: 'Quarterly list pricing across all categories, effective 1 October.' },
  { key: 'DDOC-VOLUME', sourceFile: 'Status-summarry-block#CO240603-00002.pdf', kind: 'pdf', fileName: 'Volume-Pricing-Agreement-Northwind.pdf', contentType: 'application/pdf', name: 'Volume Pricing Agreement — Northwind Traders', category: DEMO_DOC_CATEGORIES.CONTRACTS, pinned: false, pageCount: 9, summary: 'Negotiated tier breaks and annual commitment terms.' },
  { key: 'DDOC-CREDIT', sourceFile: null, kind: 'docx', fileName: 'Credit-Application.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'Credit Application Form', category: DEMO_DOC_CATEGORIES.CONTRACTS, pinned: false, pageCount: 3, summary: 'Standard net-30 credit application for new business accounts.' },
  { key: 'DDOC-SDS', sourceFile: 'newier.pdf', kind: 'pdf', fileName: 'Safety-Data-Sheet-Lubricants.pdf', contentType: 'application/pdf', name: 'Safety Data Sheet — Industrial Lubricants', category: DEMO_DOC_CATEGORIES.CATALOGS, pinned: false, pageCount: 22, summary: 'GHS-compliant safety data for the industrial lubricant range.' },
  { key: 'DDOC-TERMS', sourceFile: 'Status-summarry-block#CO240603-00002.pdf', kind: 'pdf', fileName: 'Terms-And-Conditions.pdf', contentType: 'application/pdf', name: 'Terms and Conditions of Sale', category: DEMO_DOC_CATEGORIES.CONTRACTS, pinned: false, pageCount: 6, summary: 'Standard commercial terms applying to all orders.' },
  { key: 'DDOC-RETURNS', sourceFile: null, kind: 'docx', fileName: 'Returns-Policy.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'Returns and Warranty Policy', category: DEMO_DOC_CATEGORIES.CONTRACTS, pinned: false, pageCount: 4, summary: 'RMA process, warranty periods and restocking terms.' },
  { key: 'DDOC-WAREHOUSE', sourceFile: 'paperstraw.JPg', kind: 'jpg', fileName: 'Distribution-Centre-Memphis.jpg', contentType: 'image/jpeg', name: 'Memphis Distribution Centre', category: DEMO_DOC_CATEGORIES.CATALOGS, pinned: false, pageCount: null, summary: 'Regional distribution facility serving the south-east.' },
];

/**
 * Where a document's REAL bytes come from, mirroring `bannerSourceRel()` in missions-specs.mjs.
 *
 * The generated builders produce genuinely valid files, but minimal ones — a 562-byte PDF holding
 * one line of text. That is fine for a fixture nobody opens and wrong for a demo, where somebody
 * WILL click "2026 Industrial Catalog" in front of an audience. `sourceFile` points at a real
 * document in `test-data/uploads/`; the seeder reads it and falls back to the generated bytes when
 * the entry is null or the file is missing, so a checkout without the assets still seeds.
 *
 * Returns a repo-relative path, and reads nothing: this module stays side-effect free.
 */
export const DEMO_UPLOADS_DIR = 'test-data/uploads';
export const documentSourceRel = (spec) => (spec?.sourceFile ? `${DEMO_UPLOADS_DIR}/${spec.sourceFile}` : null);

/** Tasks. Real business copy — a rep hub whose task list reads "AGENT-TEST-TASK 04" demos nothing. */
export const DEMO_TASKS = [
  { key: 'DTSK-V-01', rep: 'DEMO_REP_VOLKOVA', name: 'Follow up on Northwind reorder', type: 'Call', priority: 'High', dueInDays: 0, description: 'Margaret confirmed budget; confirm quantities for the Q4 fastener line.' },
  { key: 'DTSK-V-02', rep: 'DEMO_REP_VOLKOVA', name: 'Send Q4 price list to Contoso', type: 'Email', priority: 'High', dueInDays: 0, description: 'Priya asked for the updated list ahead of their planning cycle.' },
  { key: 'DTSK-V-03', rep: 'DEMO_REP_VOLKOVA', name: 'Prepare volume pricing proposal — Fabrikam', type: 'Task', priority: 'Normal', dueInDays: 2, description: 'Model tier breaks at 500 / 1000 / 2500 units.' },
  { key: 'DTSK-V-04', rep: 'DEMO_REP_VOLKOVA', name: 'Quarterly business review — Fabrikam Industrial', type: 'Meeting', priority: 'Normal', dueInDays: 5, description: 'Review service levels and the pending power-station trial.' },
  { key: 'DTSK-V-05', rep: 'DEMO_REP_VOLKOVA', name: 'Chase cancelled order CN-02 with Contoso', type: 'Call', priority: 'Normal', dueInDays: 1, description: 'Understand why the plant buyer cancelled and whether it can be recovered.' },
  { key: 'DTSK-V-06', rep: 'DEMO_REP_VOLKOVA', name: 'Update credit terms for Northwind', type: 'Task', priority: 'Low', dueInDays: 9, description: 'Net-30 extension approved by finance; update the account record.' },

  { key: 'DTSK-Z-01', rep: 'DEMO_REP_ZHUK', name: 'Onboard Wingtip Electrical Supply', type: 'Meeting', priority: 'High', dueInDays: 0, description: 'First full account review with James; walk through the portal.' },
  { key: 'DTSK-Z-02', rep: 'DEMO_REP_ZHUK', name: 'Confirm delivery window for Wingtip order WT-02', type: 'Call', priority: 'High', dueInDays: 1, description: 'Customer needs delivery before the end of the month.' },
  { key: 'DTSK-Z-03', rep: 'DEMO_REP_ZHUK', name: 'Share safety data sheets with Contoso', type: 'Email', priority: 'Normal', dueInDays: 2, description: 'Plant compliance requested SDS for the lubricant range.' },
  { key: 'DTSK-Z-04', rep: 'DEMO_REP_ZHUK', name: 'Review Contoso account with Alla', type: 'Meeting', priority: 'Normal', dueInDays: 3, description: 'Shared account — align on coverage before the next quarter.' },
  { key: 'DTSK-Z-05', rep: 'DEMO_REP_ZHUK', name: 'Prepare Wingtip volume quote', type: 'Task', priority: 'Normal', dueInDays: 6, description: 'Quote the conduit and cabling lines at committed annual volume.' },
  { key: 'DTSK-Z-06', rep: 'DEMO_REP_ZHUK', name: 'Archive closed opportunities', type: 'Task', priority: 'Low', dueInDays: 12, description: 'Housekeeping on last quarter’s pipeline.' },
];

// ---- derivations -----------------------------------------------------------

/** Deterministic, real-looking order numbers. No family prefix — the marker lives in `outerId`. */
export const demoOrderNumber = (key) => `SO-${String(hashKey(key) % 900000 + 100000)}`;

/** Small stable hash so an order number is deterministic across reseeds without storing it. */
function hashKey(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i += 1) h = (h * 31 + String(s).charCodeAt(i)) >>> 0;
  return h;
}

/** Real file bytes per document spec — reuses the proven builders, never a fake byte string. */
export function buildDemoFileBytes(spec) {
  switch (spec.kind) {
    case 'pdf': return pdfBytes(spec.name || spec.fileName);
    case 'docx': return docxBytes(spec.name || spec.fileName);
    case 'xlsx': return xlsxBytes(spec.name || spec.fileName);
    case 'png': return pngBytes();
    case 'jpg': return jpegBytes();
    default: throw new Error(`unknown demo document kind "${spec.kind}" for ${spec.key}`);
  }
}

/** The create body for a demo document. Mirrors the fixture builder: `isPinned` is a separate call. */
export function buildDemoDocumentRequest(spec, fileId) {
  const body = { fileId, category: spec.category, name: spec.name };
  if (spec.summary) body.summary = spec.summary;
  if (spec.pageCount != null) body.pageCount = spec.pageCount;
  return body;
}

/** An order address built from the organization's own real address. */
export function demoOrderAddress(org, contact, addressType) {
  return {
    addressType,
    firstName: contact.firstName,
    lastName: contact.lastName,
    line1: org.line1,
    city: org.city,
    regionName: org.regionName,
    countryCode: org.countryCode,
    countryName: org.countryName,
    postalCode: org.postalCode,
    phone: org.phone,
    email: contact.email,
  };
}

/**
 * Split an order total across n line items so the extended prices sum EXACTLY to the total, by
 * assigning the rounding remainder to the first line.
 *
 * An even split drifts on uneven divisions — 200/3 gives 66.67 x 3 = 200.01 — and the platform then
 * recomputes order.Total to the drifted figure, so a content-based idempotency check sees a
 * mismatch and rebuilds the order on EVERY reseed. This is the derivation worth unit-testing; the
 * declarations above are not.
 */
export function splitTotal(total, n) {
  const count = Math.max(1, n | 0);
  const per = Math.round((total / count) * 100) / 100;
  const first = Math.round((total - per * (count - 1)) * 100) / 100;
  return Array.from({ length: count }, (_, i) => (i === 0 ? first : per));
}

/**
 * The full POST body for a demo order. Monetary totals on the shipment and payment records are
 * ZEROED deliberately: the platform's total calculator folds them back into order.Total, so a
 * non-zero shipment total inflates the order. The payment's `sum` carries the amount, mirroring a
 * real order.
 */
export function buildDemoOrderBody(spec, { org, contact, orgId, customerId, products = [] }) {
  const prices = splitTotal(spec.total, spec.items);
  const number = demoOrderNumber(spec.key);
  const items = prices.map((price, i) => {
    const p = products.length ? products[i % products.length] : null;
    return p
      ? { sku: p.sku, productId: p.id, catalogId: p.catalogId, name: p.name, quantity: 1, price, productType: 'Physical', currency: DEMO_CURRENCY }
      : { sku: `SKU-${spec.key}-${i + 1}`, productId: `demo-${spec.key}-${i + 1}`, catalogId: 'demo', name: `Item ${i + 1}`, quantity: 1, price, productType: 'Physical', currency: DEMO_CURRENCY };
  });
  const shipAddr = demoOrderAddress(org, contact, 'Shipping');
  const billAddr = demoOrderAddress(org, contact, 'Billing');
  const customerName = `${contact.firstName} ${contact.lastName}`;
  return {
    number,
    outerId: demoMarker('ORD', spec.key),
    storeId: DEMO_STORE,
    organizationId: orgId,
    organizationName: org.name,
    customerId,
    customerName,
    currency: DEMO_CURRENCY,
    status: spec.status,
    total: spec.total,
    subTotal: spec.total,
    shippingTotal: 0, shippingTotalWithTax: 0, taxTotal: 0,
    items,
    addresses: [shipAddr, billAddr],
    shipments: [{
      shipmentMethodCode: 'FixedRate', shipmentMethodOption: 'Ground', currency: DEMO_CURRENCY,
      organizationId: orgId, organizationName: org.name,
      price: 0, priceWithTax: 0, total: 0, totalWithTax: 0,
      status: 'New', number: `${number}-S1`, deliveryAddress: shipAddr, items: [],
    }],
    inPayments: [{
      gatewayCode: 'DefaultManualPaymentMethod', currency: DEMO_CURRENCY,
      customerId, customerName, organizationId: orgId, organizationName: org.name,
      sum: spec.total, price: 0, priceWithTax: 0, total: 0, totalWithTax: 0,
      status: 'New', paymentStatus: 'New',
      number: `${number}-P1`, billingAddress: billAddr,
    }],
  };
}

/** Organizations in POST order — the seeder creates parents before the contacts that reference them. */
export const orgByKey = (key) => DEMO_ORGS.find((o) => o.key === key) || null;
export const contactByKey = (key) => DEMO_CONTACTS.find((c) => c.key === key) || null;
export const repByKey = (key) => DEMO_REPS.find((r) => r.key === key) || null;

/** Orders in POST order. `seq` ascending, so the intended latest row lands last. */
export const ordersInPostOrder = () => [...DEMO_ORDERS].sort((a, b) => a.seq - b.seq);

/**
 * How many distinct products each organization needs, keyed by org key. The seeder discovers this
 * many per organization and claims them globally, so a shortfall is reported per customer rather
 * than as one unattributable total.
 */
export function productNeedByOrg(orders = DEMO_ORDERS) {
  const need = {};
  for (const o of orders) need[o.org] = (need[o.org] || 0) + o.items;
  return need;
}

/** Served-org expectations from a ledger, for the profile-aware reconcile check. */
export function demoServedOrgExpectations(ledger) {
  const entries = (ledger?.entities || []).filter((e) => e.type === 'rep-attachment');
  return entries.map((e) => ({ repKey: e.key, salesRepId: e.salesRepId, servedOrgIds: e.servedOrgIds || [] }));
}

// ---- gates -----------------------------------------------------------------

/** Fields a viewer can see. A family prefix in any of these defeats the point of the dataset. */
const GUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const FORBIDDEN_IN_VISIBLE = /AGENT-TEST/i;

/** Every user-visible string this dataset will put on a screen. */
export function visibleStrings() {
  const out = [];
  for (const o of DEMO_ORGS) out.push(['org.name', o.key, o.name], ['org.line1', o.key, o.line1], ['org.city', o.key, o.city], ['org.email', o.key, o.email]);
  for (const c of DEMO_CONTACTS) out.push(['contact.name', c.key, `${c.firstName} ${c.lastName}`], ['contact.email', c.key, c.email]);
  for (const r of DEMO_REPS) out.push(['rep.fullName', r.key, r.fullName]);
  for (const o of DEMO_ORDERS) out.push(['order.number', o.key, demoOrderNumber(o.key)]);
  for (const d of DEMO_DOCUMENTS) out.push(['doc.name', d.key, d.name], ['doc.fileName', d.key, d.fileName], ['doc.category', d.key, d.category], ['doc.summary', d.key, d.summary || '']);
  for (const t of DEMO_TASKS) out.push(['task.name', t.key, t.name], ['task.description', t.key, t.description || '']);
  return out;
}

/**
 * Every way this dataset could be wrong in a way no other guard catches. Two classes:
 * PRESENTATION (a family prefix or a raw GUID reaching a screen) and NON-VACUITY — a fixture set
 * that satisfies every structural check and still makes the feature's central question
 * undecidable. A top-sellers panel fed identical product sets, or a customer list where no customer
 * is shared between reps, renders perfectly and demonstrates nothing.
 */
export function demoProblems() {
  const problems = [];

  for (const [field, key, value] of visibleStrings()) {
    if (FORBIDDEN_IN_VISIBLE.test(value)) problems.push(`${field} (${key}) contains AGENT-TEST: "${value}"`);
    if (GUID_RE.test(value)) problems.push(`${field} (${key}) contains a raw GUID: "${value}"`);
  }

  for (const list of [DEMO_ORGS, DEMO_CONTACTS, DEMO_ORDERS, DEMO_DOCUMENTS, DEMO_TASKS, DEMO_REPS]) {
    const keys = list.map((x) => x.key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dupes.length) problems.push(`duplicate keys: ${[...new Set(dupes)].join(', ')}`);
  }

  for (const o of DEMO_ORGS) {
    if (!o.city || !o.regionName) problems.push(`org ${o.key} is missing city/regionName — the dashboard shipTo cell renders empty`);
  }

  const numbers = DEMO_ORDERS.map((o) => demoOrderNumber(o.key));
  const dupeNums = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  if (dupeNums.length) problems.push(`order numbers collide: ${[...new Set(dupeNums)].join(', ')}`);

  for (const o of DEMO_ORDERS) {
    const sum = splitTotal(o.total, o.items).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - o.total) > 0.005) problems.push(`order ${o.key}: line prices sum to ${sum}, declared total ${o.total}`);
    if (!orgByKey(o.org)) problems.push(`order ${o.key} references unknown org ${o.org}`);
    if (!contactByKey(o.buyer)) problems.push(`order ${o.key} references unknown contact ${o.buyer}`);
  }

  // Non-vacuity: at least one organization served by BOTH reps.
  const shared = DEMO_ORGS.filter((o) => DEMO_REPS.filter((r) => r.servedOrgs.includes(o.key)).length > 1);
  if (!shared.length) problems.push('no organization is served by more than one rep — the multi-rep surface is undemonstrable');

  // Non-vacuity: every organization needs its own product family, and two customers sharing a
  // search phrase would draw from one pool — top-sellers then ranks the same products for both and
  // the panel cannot discriminate. Runtime disjointness is enforced by the seeder's global claim;
  // this gate catches the DECLARATION that makes disjointness impossible.
  const phrases = DEMO_ORGS.map((o) => o.productSearch);
  for (const o of DEMO_ORGS) if (!o.productSearch) problems.push(`org ${o.key} declares no productSearch — its orders would draw from an arbitrary catalog slice`);
  for (const o of DEMO_ORGS) {
    if (!(o.productMatch instanceof RegExp)) {
      problems.push(`org ${o.key} declares no productMatch regex — catalog search is relevance-ordered but not relevance-bounded, so its orders would carry whatever the tail of the result set happens to hold`);
    } else if (!o.productMatch.test(o.productSearch)) {
      problems.push(`org ${o.key}: productMatch ${o.productMatch} does not match its own productSearch "${o.productSearch}" — the two filters disagree, and the pool would come back empty`);
    }
  }
  const dupePhrases = phrases.filter((p, i) => p && phrases.indexOf(p) !== i);
  if (dupePhrases.length) problems.push(`organizations share a productSearch phrase (${[...new Set(dupePhrases)].join(', ')}) — their product sets cannot be disjoint`);

  // The exclusion must actually exclude what is live in the catalog right now.
  for (const bad of ['AGENT-TEST-Cordless Drill', 'AGENT-TEST-Gloves Winter']) {
    if (isDemoSafeProduct({ id: 'x', sku: 'x', name: bad })) problems.push(`EXCLUDED_PRODUCT_RE does not reject "${bad}" — a fixture product would reach a demo order line`);
  }

  // Non-vacuity: a pipeline needs more than one status, and a status filter needs something to filter.
  const statuses = new Set(DEMO_ORDERS.map((o) => o.status));
  if (statuses.size < 3) problems.push(`only ${statuses.size} distinct order status(es) — the pipeline/filter surface is degenerate`);

  const pinned = DEMO_DOCUMENTS.filter((d) => d.pinned);
  if (pinned.length !== 1) problems.push(`${pinned.length} pinned document(s); the platform enforces exactly one`);
  if (new Set(DEMO_DOCUMENTS.map((d) => d.category)).size < 3) problems.push('fewer than 3 document categories — the category filter is degenerate');

  // Roles must be roles the platform actually has. An invented job title cannot be assigned, so
  // the membership silently keeps its default and the demo misrepresents the permission model it
  // exists to show.
  for (const c of DEMO_CONTACTS) {
    if (!PLATFORM_ORG_ROLES.includes(c.role)) {
      problems.push(`contact ${c.key} declares role "${c.role}", which is not a platform role (expected one of: ${PLATFORM_ORG_ROLES.join(' | ')})`);
    }
  }
  for (const r of DEMO_REPS) {
    if (r.salesRepRole && !PLATFORM_SALES_REP_ROLES.includes(r.salesRepRole)) {
      problems.push(`rep ${r.key} declares salesRepRole "${r.salesRepRole}", not one of the two assignable (${PLATFORM_SALES_REP_ROLES.join(' | ')})`);
    }
    // A rep who is supposed to show documents but is pinned to the basic role would render an
    // empty demo with no error anywhere — the library is simply absent from their navigation.
    if (r.showsDocuments && r.salesRepRole && !roleSeesDocuments(r.salesRepRole)) {
      problems.push(`rep ${r.key} is meant to show documents but declares "${r.salesRepRole}" — only ${SALES_REP_ROLE_ADVANCED} can reach the library`);
    }
  }
  if (DEMO_DOCUMENTS.length && !DEMO_REPS.some((r) => r.showsDocuments)) {
    problems.push(`${DEMO_DOCUMENTS.length} document(s) are declared but no rep is marked showsDocuments — nobody in the demo can open them`);
  }

  for (const t of DEMO_TASKS) if (!repByKey(t.rep)) problems.push(`task ${t.key} references unknown rep ${t.rep}`);
  for (const r of DEMO_REPS) {
    if (!DEMO_TASKS.some((t) => t.rep === r.key)) problems.push(`rep ${r.key} has no tasks — its task widget renders empty`);
    for (const k of r.servedOrgs) if (!orgByKey(k)) problems.push(`rep ${r.key} serves unknown org ${k}`);
  }

  for (const [type, key] of [['ORG', 'x'], ['CT', 'x'], ['ORD', 'x']]) {
    const m = demoMarker(type, key);
    if (m.length > DEMO_MARKER_MAX_LENGTH) problems.push(`marker "${m}" exceeds ${DEMO_MARKER_MAX_LENGTH} chars`);
    if (FORBIDDEN_IN_VISIBLE.test(m)) problems.push(`marker "${m}" contains AGENT-TEST and could be swept by sweepAgentTestMembers()`);
  }

  return problems;
}

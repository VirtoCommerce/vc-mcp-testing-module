/**
 * validate-missions-data.mjs — STATIC drift guard for the VCST-5319 Loyalty Missions fixtures.
 * `npm run td:validate:missions`. No network, no env, no auth — safe in CI.
 *
 * It answers one question: **can this fixture set still FAIL a test?**
 *
 * Existence is not the interesting property here. Every mission in this set is defined by a value that
 * looks arbitrary and is not — `public=false`, a target of 0, a reward of 0, a null currency, an
 * `all` flag that must disagree with its twin. Change any of them to something "more sensible" and the
 * fixture still seeds, still resolves through `@td()`, and still passes — while proving nothing. So the
 * checks below are written against the ways each fixture can survive while going vacuous, plus the two
 * mechanical rules the multi-env policy turns on: no runtime GUID in a committed file, and no per-env
 * value pinned in the base alias registry.
 *
 * Checks:
 *   [1] the spec set is coherent and still discriminating   (missions-specs.validateSpecShape)
 *   [2] every spec has a registered alias, and vice versa   (no orphan either way)
 *   [3] each alias mirrors its spec's business fields       (the registry cannot drift from the source)
 *   [4] no runtime GUID / per-env value in the BASE registry (they belong to aliases.<env>.json)
 *   [5] every alias declares its runtime fields in `fields`  (else the overlay can never reach them)
 *   [6] the gate alias names the real setting + records the base switch it must NOT touch
 *   [7] no committed file anywhere carries a seeded mission GUID
 *   [8] (informational) which envs' overlays currently carry ids
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MISSIONS, PERSKU_PRODUCTS, STORE_SETTING, RUNTIME_FIELDS_BY_KIND, NAME_PREFIX,
  BANNERS, bannerKeyFor, bannerSourceRel,
  missionName, validateSpecShape,
} from './missions-specs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUID_RE = /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/i;
/** The window every ordinary fixture sits on; only a fixture that DIFFERS mirrors its intent in the registry. */
const DEFAULT_WINDOW = 'active';

const problems = [];
const warnings = [];
const notes = [];
const fail = (m) => problems.push(m);
const warn = (m) => warnings.push(m);

const aliasPath = join(ROOT, 'test-data', 'aliases.json');
const aliases = JSON.parse(readFileSync(aliasPath, 'utf8'));

/**
 * Which fields are RUNTIME, per alias — not a union across all of them. `name` is runtime on a
 * discovered PerSku product and is the business key on a mission, so a flattened set would demand
 * that every mission blank its own identifier. Also drives check [5].
 */
const RUNTIME_BY_ALIAS = {
  [STORE_SETTING.aliasName]: RUNTIME_FIELDS_BY_KIND.storeSetting,
  ...Object.fromEntries(PERSKU_PRODUCTS.map((p) => [p.aliasName, RUNTIME_FIELDS_BY_KIND.perSkuProduct])),
  // A currency-carrying mission has one MORE runtime field: the resolved code. The INTENT is authored
  // and committed; the code it resolves to is per-env store config.
  ...Object.fromEntries(MISSIONS.map((m) => [
    m.aliasName,
    [
      ...RUNTIME_FIELDS_BY_KIND.mission,
      // A currency-carrying mission has one MORE runtime field: the resolved code.
      ...(m.goal.currency ? ['goal_currency'] : []),
      // ...and a localized one has two: the locale CODES its intents resolved to. The TEXT is authored
      // and committed; the codes are per-env store config, exactly like a currency.
      ...(m.l10n ? ['locale_default', 'locale_alternate'] : []),
    ],
  ])),
};

/* [1] ─────────────────────────────────────────────────────────────────────── */
for (const p of validateSpecShape()) fail(`[1] ${p}`);

/* [2] ─────────────────────────────────────────────────────────────────────── */
const owned = [
  STORE_SETTING.aliasName,
  ...PERSKU_PRODUCTS.map((p) => p.aliasName),
  ...MISSIONS.map((m) => m.aliasName),
];
for (const name of owned) {
  if (!aliases[name]) fail(`[2] alias ${name} is declared in the spec module but absent from test-data/aliases.json — @td(${name}.*) resolves to nothing`);
}
// The reverse orphan: an MSN_* alias nobody seeds is worse than a missing one, because it resolves to
// a plausible-looking committed value forever and no seeder will ever refresh it.
for (const name of Object.keys(aliases)) {
  if (!/^MSN_/.test(name)) continue;
  if (!owned.includes(name)) fail(`[2] alias ${name} looks like a mission fixture but no spec owns it — nothing seeds or tears it down`);
}

/* [3] ─────────────────────────────────────────────────────────────────────── */
for (const m of MISSIONS) {
  const a = aliases[m.aliasName];
  if (!a) continue;
  const g = m.goal;
  const expectTarget = String(g.type === 'OrderValueGoal' ? g.value : g.type === 'OrderCountGoal' ? g.count : (g.all ? 'PerSkuAll' : 'PerSkuAny'));
  const expect = {
    name: missionName(m),
    status: m.status,
    public: String(m.public),
    goal_type: g.type,
    goal_target: expectTarget,
    reward: m.reward,
  };
  for (const [k, v] of Object.entries(expect)) {
    if (a[k] !== v) fail(`[3] ${m.aliasName}.${k} is ${JSON.stringify(a[k])} in aliases.json but ${JSON.stringify(v)} in missions-specs.mjs — the registry has drifted from its source of truth`);
  }
  // A non-default window is the whole point of the fixture that carries it, so the registry must name
  // it: without the mirror, an expired fixture quietly re-authored as `active` reads as identical to
  // every other mission and the case asserting its absence starts passing for no reason.
  if (m.window !== DEFAULT_WINDOW) {
    if (a.window_intent !== m.window) {
      fail(`[3] ${m.aliasName}.window_intent is ${JSON.stringify(a.window_intent)} in aliases.json but the spec declares ${JSON.stringify(m.window)} — the registry no longer names the property this fixture exists for`);
    }
  } else if ('window_intent' in a) {
    fail(`[3] ${m.aliasName} carries window_intent but sits on the default "${DEFAULT_WINDOW}" window — a dead field reads as coverage that does not exist`);
  }

  if (g.currency) {
    if (a.goal_currency_intent !== g.currency) {
      fail(`[3] ${m.aliasName}.goal_currency_intent is ${JSON.stringify(a.goal_currency_intent)} but the spec declares ${JSON.stringify(g.currency)}`);
    }
    if (!('goal_currency' in a)) {
      fail(`[3] ${m.aliasName} declares a currency intent but has no goal_currency field for the resolved code — the seeder writes it and @td() would never see it`);
    }
  } else if ('goal_currency_intent' in a || 'goal_currency' in a) {
    fail(`[3] ${m.aliasName} carries currency fields but its goal type (${g.type}) has no currency — dead fields read as coverage that does not exist`);
  }

  // The localized fixture's TEXT is authored, so the registry must mirror it exactly — otherwise a
  // case asserts one string while the seeder writes another, and the mismatch reads as a product bug.
  if (m.l10n) {
    const expectText = {
      name_default: m.l10n.name?.['store-default'],
      name_alternate: m.l10n.name?.['store-alternate'],
      description_default: m.l10n.description?.['store-default'],
      description_alternate: m.l10n.description?.['store-alternate'],
    };
    for (const [k, v] of Object.entries(expectText)) {
      if (a[k] !== v) fail(`[3] ${m.aliasName}.${k} is ${JSON.stringify(a[k])} in aliases.json but ${JSON.stringify(v)} in missions-specs.mjs — a case would assert text the seeder never writes`);
    }
  } else if (['name_default', 'locale_default'].some((k) => k in a)) {
    fail(`[3] ${m.aliasName} carries localization fields but its spec declares no l10n — dead fields read as coverage that does not exist`);
  }

  // EVERY mission carries a banner (the storefront card renders it), so the registry names WHICH
  // artwork — derived from the goal type — while the URL stays runtime. A wrong banner_key is the
  // quiet failure here: the card still renders, just with the wrong picture, and nothing else objects.
  const wantBanner = bannerKeyFor(m);
  if (a.banner_key !== wantBanner) {
    fail(`[3] ${m.aliasName}.banner_key is ${JSON.stringify(a.banner_key)} in aliases.json but its ${g.type} resolves to ${JSON.stringify(wantBanner)} — the card would render the wrong mission type's artwork`);
  }
  if (!('banner_url' in a)) {
    fail(`[3] ${m.aliasName} has no banner_url field for the resolved asset URL — the seeder writes it and @td(${m.aliasName}.banner_url) would never see it`);
  }
}

// Every declared banner must have its source file committed, or the seeder throws mid-run having
// already written some missions — and a Published one can never gain a banner afterwards.
for (const key of Object.keys(BANNERS)) {
  const rel = bannerSourceRel(key);
  if (!existsSync(join(ROOT, rel))) fail(`[3] banner "${key}" declares ${rel}, which is not committed — the seeder cannot upload it`);
}
for (const p of PERSKU_PRODUCTS) {
  const a = aliases[p.aliasName];
  if (!a) continue;
  if (a.slot !== p.slot) fail(`[3] ${p.aliasName}.slot is ${JSON.stringify(a.slot)} but the spec says ${JSON.stringify(p.slot)}`);
  if (a.quantity !== p.quantity) fail(`[3] ${p.aliasName}.quantity is ${JSON.stringify(a.quantity)} but the spec says ${p.quantity}`);
}

/* [4] ─────────────────────────────────────────────────────────────────────── */
for (const name of owned) {
  const a = aliases[name];
  if (!a) continue;
  for (const f of RUNTIME_BY_ALIAS[name] || []) {
    if (!(f in a)) continue;
    const v = a[f];
    if (v !== '' && v != null) {
      fail(`[4] ${name}.${f} = ${JSON.stringify(v)} in the COMMITTED base registry. It is runtime/per-env and must be "" here — its value belongs in aliases.<env>.json, or a suite run against another env resolves the wrong entity.`);
    }
  }
  const serialized = JSON.stringify({ ...a, _notes: '' });
  if (GUID_RE.test(serialized)) {
    fail(`[4] ${name} carries a GUID in the committed base registry (DV-021 class) — move it to aliases.<env>.json`);
  }
}

/* [5] ─────────────────────────────────────────────────────────────────────── */
// The overlay is layered field-by-field over the base, but ONLY for fields the alias declares. An
// undeclared runtime field is silently unreachable: the seeder writes it, and @td() never sees it.
for (const [name, fields] of Object.entries(RUNTIME_BY_ALIAS)) {
  const a = aliases[name];
  if (!a) continue;
  if (!a.fields) { fail(`[5] ${name} has no \`fields\` map — an inline alias without it exposes nothing to @td()`); continue; }
  for (const f of fields) {
    if (!(f in a.fields)) fail(`[5] ${name}.fields is missing "${f}" — the seeder writes it to the overlay but @td(${name}.${f}) can never resolve it`);
  }
}

/* [6] ─────────────────────────────────────────────────────────────────────── */
const gate = aliases[STORE_SETTING.aliasName];
if (gate) {
  if (gate.setting_name !== STORE_SETTING.missionsSetting) fail(`[6] ${STORE_SETTING.aliasName}.setting_name must be "${STORE_SETTING.missionsSetting}"`);
  if (gate.setting_group !== STORE_SETTING.missionsGroup) fail(`[6] ${STORE_SETTING.aliasName}.setting_group must be "${STORE_SETTING.missionsGroup}"`);
  if (gate.base_setting_name !== STORE_SETTING.baseSetting) {
    fail(`[6] ${STORE_SETTING.aliasName}.base_setting_name must be "${STORE_SETTING.baseSetting}" — a case needs to know which switch is the base one so it does not conflate the two`);
  }
  if (gate.platform_default !== 'false') {
    fail(`[6] ${STORE_SETTING.aliasName}.platform_default must be "false" — the feature is OFF unless a store turns it on, and a case that assumes otherwise tests the wrong default`);
  }
}

/* [7] ─────────────────────────────────────────────────────────────────────── */
// A mission GUID that reaches a committed file is the multi-env failure this whole policy exists for.
// Scan the committed test-data tree and this seeder's own directory for anything naming a fixture next
// to a GUID.
const scanDirs = [join(ROOT, 'test-data'), join(ROOT, 'scripts', 'seed-data', 'loyalty')];
const overlayRe = /^aliases\.[a-z0-9-]+\.json$/i;
for (const dir of scanDirs) {
  if (!existsSync(dir)) continue;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(csv|json|mjs|js)$/i.test(e.name)) continue;
      if (overlayRe.test(e.name)) continue;             // overlays are exactly where GUIDs belong
      if (e.name === 'aliases.json') continue;          // covered precisely by [4]
      const text = readFileSync(full, 'utf8');
      if (!text.includes(NAME_PREFIX)) continue;
      for (const line of text.split(/\r?\n/)) {
        if (line.includes(NAME_PREFIX) && GUID_RE.test(line)) {
          fail(`[7] ${full.slice(ROOT.length + 1)} has a line naming a mission fixture next to a GUID — runtime ids belong in aliases.<env>.json only`);
          break;
        }
      }
    }
  };
  walk(dir);
}

/* [8] ─────────────────────────────────────────────────────────────────────── */
for (const f of readdirSync(join(ROOT, 'test-data'))) {
  if (!overlayRe.test(f)) continue;
  const env = f.replace(/^aliases\./, '').replace(/\.json$/, '');
  let o = {};
  try { o = JSON.parse(readFileSync(join(ROOT, 'test-data', f), 'utf8')); } catch { continue; }
  const seeded = MISSIONS.filter((m) => o[m.aliasName]?.id);
  if (seeded.length) notes.push(`${env}: ${seeded.length}/${MISSIONS.length} mission id(s) present`);
  else if (env !== 'localhost') warn(`no mission ids in aliases.${env}.json — @td(MSN_*.id) resolves to "" there until \`TEST_ENV=${env} npm run seed:loyalty-missions\` runs`);
}

/* ── Report ─────────────────────────────────────────────────────────────────── */
console.log(`td:validate:missions — ${MISSIONS.length} missions, ${PERSKU_PRODUCTS.length} PerSku targets, 1 store-settings fixture`);
for (const n of notes) console.log(`  · ${n}`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('✓ clean');

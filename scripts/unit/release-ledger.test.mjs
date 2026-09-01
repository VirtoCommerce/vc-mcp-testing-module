// Guards the generated VC release ledger — `.claude/knowledge/domain/release-ledger.md`.
//
// WHY THIS IS A UNIT TEST AND NOT A `*:check` SCRIPT
// `npm test` (tsx --test scripts/unit/**/*.test.mjs, .github/workflows/unit-tests.yml) is the
// ONLY thing this repo's CI actually runs. None of the four existing drift guards
// (tokens:check, selectors:check, sitemap:check, schema:check) is wired into any workflow,
// and every cron in .github/workflows/ is commented out. So a guard that must really run has
// to live here — the same reasoning mirror-parity.test.mjs states as "a guard nobody runs is
// a comment". `npm run releases:check` exists too and calls the same code path, but it needs
// network; these assertions are hermetic so a flaky forum can never redden main.
//
// FIXTURE PROVENANCE
// scripts/unit/fixtures/news-digest-15.rss is a 4-item slice of a real capture of
// https://www.virtocommerce.org/c/news-digest/15.rss with the image markup stripped. It is
// built FROM the real feed rather than hand-authored on purpose: a hand-made fixture can
// drift from the HTML upstream actually emits, which is the very thing it exists to catch.
// The four items are chosen to cover every parse path — see the per-test comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseRss,
  buildDigests,
  classifyTitle,
  nameFromRepo,
  computeLatest,
  renderDoc,
  cmpSemver,
} from '../maintenance/refresh-release-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = resolve(ROOT, 'scripts/unit/fixtures/news-digest-15.rss');
const DOC = resolve(ROOT, '.claude/knowledge/domain/release-ledger.md');
const SNAPSHOT = resolve(ROOT, '.claude/knowledge/domain/release-ledger-snapshot.json');

const digests = buildDigests(parseRss(readFileSync(FIXTURE, 'utf8')));
const byMonth = (m) => digests.find((d) => d.month === m);
const featureTitled = (month, needle) =>
  byMonth(month).features.find((f) => f.title.includes(needle));

// ---------------------------------------------------------------------------
// 1. Parser contract — the net for "upstream changed its heading convention"
// ---------------------------------------------------------------------------

test('ledger parser: the fixture yields the expected digest classification', () => {
  assert.equal(digests.length, 4);
  assert.deepEqual(
    digests.map((d) => [d.month, d.kind]),
    [
      ['2026-09', 'monthly'],
      ['2026-08', 'monthly'],
      [null, 'annual-roundup'], // "The Year 2025 Release Notes" — 0 versioned headings
      ['2024-11', 'monthly'], // "November 2024 News Digest" — off-pattern title
    ]
  );
});

test('ledger parser: month comes from the TITLE, never pubDate', () => {
  // Every digest publishes in the last week of the PRECEDING month. The September 2026
  // digest carries pubDate 2026-08-26; keying on it would shift the whole ledger by a month.
  const sept = byMonth('2026-09');
  assert.match(sept.publishedIso, /^2026-08-26/);
  assert.equal(sept.month, '2026-09');

  assert.deepEqual(classifyTitle("Virto's Release Notes | August 2026"), {
    kind: 'monthly',
    month: '2026-08',
    year: '2026',
  });
  // Curly apostrophe + a trailing parenthetical.
  assert.equal(classifyTitle('Virto’s Release Notes | May 2026 (Comics Edition)').month, '2026-05');
  // Entirely off pattern.
  assert.equal(classifyTitle('November 2024 News Digest').month, '2024-11');
  assert.equal(classifyTitle('The Year 2025 Release Notes').kind, 'annual-roundup');
  assert.equal(classifyTitle('Some unrelated topic').kind, 'unrecognized');
});

test('ledger parser: an annual roundup is classified, never mined', () => {
  const annual = digests.find((d) => d.kind === 'annual-roundup');
  assert.equal(annual.features.length, 0);
  assert.equal(annual.headingsUnparsed, 0, 'a roundup has no versioned headings BY CONSTRUCTION, so it must not register as a parse failure');
});

test('ledger parser: modern "Title. Component X.Y.Z" heading splits into title + component', () => {
  const f = featureTitled('2026-09', 'Customizable dashboard layout');
  assert.ok(f, 'expected the Sales Rep dashboard feature');
  assert.equal(f.title, 'Customizable dashboard layout');
  assert.deepEqual(f.components, [
    {
      name: 'Sales Rep',
      version: '3.1002.0',
      repo: 'vc-module-sales-rep',
      releaseUrl: 'https://github.com/VirtoCommerce/vc-module-sales-rep/releases/tag/3.1002.0',
    },
  ]);
});

test('ledger parser: legacy bare "Component X.Y.Z" heading yields a component with no title', () => {
  // The 2024-11 digest predates the "Title. Component Version" convention entirely.
  const f = byMonth('2024-11').features.find((x) => x.components[0].version === '3.854.0');
  assert.equal(f.title, 'Platform', 'with no title in the heading, the component name IS the label');
  assert.equal(f.components[0].repo, 'vc-platform');
});

test('ledger parser: a "+"-joined heading yields one component per release anchor', () => {
  const f = featureTitled('2026-09', 'Replacing AutoMapper');
  assert.equal(f.components.length, 3);
  assert.deepEqual(
    f.components.map((c) => c.repo),
    [
      'vc-module-x-pickup',
      'vc-module-catalog-csv-export-import',
      'vc-module-profile-experience-api',
    ]
  );
  assert.equal(f.title, 'Replacing AutoMapper', 'the title comes from the FIRST anchor only');
});

test('ledger parser: an anchor whose TEXT carries no version still resolves, from the tag', () => {
  // "Per-store asset (CDN) URLs. Store 3.1006.0 + xCatalog + xAPI" — the 2nd and 3rd anchor
  // texts are bare component names; both versions live only in the href. Requiring a semver
  // in the text (as the first implementation did) dropped these two silently.
  const f = featureTitled('2026-08', 'Per-store asset');
  assert.equal(f.components.length, 3);
  assert.deepEqual(
    f.components.map((c) => `${c.name}@${c.version}`),
    ['Store@3.1006.0', 'xCatalog@3.1013.0', 'xAPI@3.1014.0']
  );
});

test('ledger parser: repo comes from the release anchor, and is never invented', () => {
  for (const d of digests) {
    for (const f of d.features) {
      for (const c of f.components) {
        if (c.repo === null) {
          assert.equal(c.releaseUrl, null, 'no repo means no fabricated release URL');
        } else {
          assert.equal(
            c.releaseUrl,
            `https://github.com/VirtoCommerce/${c.repo}/releases/tag/${c.version}`
          );
        }
      }
    }
  }
});

test('ledger parser: a breaking change is flagged from the section text', () => {
  // The digests mark it as a :warning: emoji IMG plus "Breaking changes:", so the marker is
  // only visible in the section's TEXT — never as a literal glyph to grep for.
  const f = featureTitled('2026-09', 'Invites and status');
  assert.equal(f.breaking, true);
  assert.equal(featureTitled('2026-09', 'Dark themes').breaking, false);
});

test('ledger parser: docs deep links are captured, capped, and deduped', () => {
  const f = featureTitled('2026-09', 'Customer sales data');
  assert.ok(f.docsUrls.length > 0);
  assert.ok(f.docsUrls.length <= 3, 'capped so one feature cannot dominate the doc');
  assert.equal(new Set(f.docsUrls).size, f.docsUrls.length);
  for (const u of f.docsUrls) assert.match(u, /^https:\/\/docs\.virtocommerce\.org\//);
});

test('ledger parser: nothing is silently dropped', () => {
  // A zero-feature month must stay distinguishable from a quiet month, so an unparseable
  // versioned heading is COUNTED and recorded rather than skipped.
  for (const d of digests) {
    assert.equal(d.headingsUnparsed, d.unparsed.length);
    assert.equal(d.headingsUnparsed, 0, `fixture should parse cleanly; ${d.month} did not: ${JSON.stringify(d.unparsed)}`);
    if (d.kind === 'monthly') {
      assert.equal(
        d.features.length + d.headingsUnparsed,
        d.headingsVersioned,
        'every versioned heading becomes exactly one feature or one unparsed entry'
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Component naming — the corpus-level canonicalization
// ---------------------------------------------------------------------------

test('component naming: prose does not leak into the component slot', () => {
  // The heading is "Admin session hardening Platform 3.1042.0" — no ". " separator, so the
  // punctuation rule alone made the whole phrase the "component". The canonical name for
  // vc-platform (derived from how the corpus labels it) is what recovers the real split.
  const f = byMonth('2026-08').features.find((x) => x.components[0].version === '3.1042.0');
  assert.equal(f.components[0].name, 'Platform');
  assert.equal(f.title, 'Admin session hardening');
});

test('component naming: the xAPI family never collapses into its non-x namesakes', () => {
  // nameFromRepo deliberately does NOT strip the `x-` prefix: "Catalog" derived from
  // vc-module-x-catalog is a substring of the correct name "xCatalog", so the
  // shorten-to-derived correction would merge two genuinely different components.
  assert.equal(nameFromRepo('vc-module-x-catalog'), 'X Catalog');
  assert.equal(nameFromRepo('vc-platform'), 'Platform');
  assert.equal(nameFromRepo('vc-module-azure-app-configuration'), 'Azure App Configuration');

  const f = featureTitled('2026-08', 'Per-store asset');
  const names = f.components.map((c) => c.name);
  assert.ok(names.includes('xCatalog'), `expected xCatalog, got ${names.join(', ')}`);
  assert.ok(!names.includes('Catalog'), 'xCatalog must not be rewritten to Catalog');
});

test('component naming: one canonical name per repo across the corpus', () => {
  const byRepo = new Map();
  for (const d of digests) {
    for (const f of d.features) {
      for (const c of f.components) {
        if (!c.repo) continue;
        if (!byRepo.has(c.repo)) byRepo.set(c.repo, new Set());
        byRepo.get(c.repo).add(c.name);
      }
    }
  }
  for (const [repo, names] of byRepo) {
    assert.equal(names.size, 1, `${repo} was labelled ${names.size} different ways: ${[...names].join(' / ')}`);
  }
});

test('cmpSemver orders the VC four-digit minor correctly', () => {
  // 3.1054.0 > 3.917.1 is the whole point: a string compare puts "3.917" above "3.1054",
  // which would make the ledger report a stale version as the latest.
  assert.ok(cmpSemver('3.1054.0', '3.917.1') > 0);
  assert.ok(cmpSemver('2.56.0', '2.9.0') > 0);
  assert.ok(cmpSemver('3.1001.2', '3.1001.0') > 0);
  assert.equal(cmpSemver('3.1.0', '3.1.0'), 0);
});

test('computeLatest picks the highest version per component, not the newest month', () => {
  const latest = computeLatest(digests, null);
  assert.equal(latest.Platform.version, '3.1054.0');
  assert.equal(latest.Frontend.version, '2.56.0');
  // Carried into the snapshot so the doc render stays a pure projection of it.
  assert.equal(latest.Platform.previousVersion, null, 'no prior snapshot means no "was" value');
  const bumped = computeLatest(digests, { Platform: { version: '3.1049.0' } });
  assert.equal(bumped.Platform.previousVersion, '3.1049.0');
});

// ---------------------------------------------------------------------------
// 3. The committed artifacts
// ---------------------------------------------------------------------------

test('committed ledger: doc and snapshot both exist', () => {
  assert.ok(existsSync(DOC), `${DOC} missing — run \`npm run releases:refresh\``);
  assert.ok(existsSync(SNAPSHOT), `${SNAPSHOT} missing — run \`npm run releases:refresh\``);
});

test('committed ledger: the doc is exactly what the snapshot renders', () => {
  // Catches a hand-edit to a generated file — the GOLDEN RULE failure mode. Provenance lines
  // move on every run, so they are stripped before comparing (same rule as
  // sync-design-tokens.mjs), which keeps a date-only refresh from reading as drift.
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const committed = readFileSync(DOC, 'utf8');
  const tail = committed.slice(committed.indexOf('## Changelog'));
  const normalize = (s) =>
    s
      .replace(/\r\n/g, '\n')
      .replace(/^generated:.*$/gm, '')
      .replace(/^\*\*Generated\*\*.*$/gm, '')
      .replace(/^### rev \d+ — \d{4}-\d{2}-\d{2}$/gm, '');
  assert.equal(
    normalize(renderDoc(snap, tail)),
    normalize(committed),
    'release-ledger.md no longer matches its snapshot — it was hand-edited, or the renderer changed. Run `npm run releases:refresh`.'
  );
});

test('committed ledger: stays within its size bound', () => {
  const lines = readFileSync(DOC, 'utf8').split('\n').length;
  assert.ok(lines <= 550, `release-ledger.md is ${lines} lines (bound 550). It grows ~1 line/month because each new month pushes one out of the full window into the compact index; a jump means the window widened.`);
  const monthSections = [...readFileSync(DOC, 'utf8').matchAll(/^### \d{4}-\d{2} — /gm)].length;
  assert.ok(monthSections <= 6, `${monthSections} full month sections (bound 6)`);
});

test('committed ledger: version facts live in frontmatter only, never restated in the body', () => {
  // This is the sitemap.md defect, foreclosed: that file reports one platform version in its
  // header and a different, older one in section 13, because ONE FACT lived in TWO PLACES and
  // diff-gated rewriting only touched one of them.
  const text = readFileSync(DOC, 'utf8');
  const end = text.indexOf('\n---', 4);
  const body = text.slice(end);
  const offenders = [];
  for (const line of body.split('\n')) {
    if (/^\s*\|/.test(line)) continue; // the generated tables ARE the version data
    if (/\b3\.10\d\d\.\d+\b/.test(line) && !/backend-admin-checklists|3\.1007\.2|3\.917\.1|3\.1063\.0/.test(line)) {
      offenders.push(line.trim());
    }
  }
  assert.deepEqual(offenders, [], 'a version literal in the prose body will rot independently of the frontmatter');
});

test('committed ledger: staleness is surfaced (warn), then enforced (fail)', () => {
  // Two tiers on purpose. A hard-only threshold gets bumped or skipped the first time it
  // reddens main; the soft tier means that by the time the hard one trips, everyone has seen
  // the warning repeatedly. Failing on the calendar alone is what trains people to ignore a
  // suite, so the soft tier must NOT fail.
  const text = readFileSync(DOC, 'utf8');
  const generated = (text.match(/^generated:\s*(\d{4}-\d{2}-\d{2})/m) || [])[1];
  const staleAfter = Number((text.match(/^stale_after_days:\s*(\d+)/m) || [])[1]);
  const expiresAfter = Number((text.match(/^expires_after_days:\s*(\d+)/m) || [])[1]);
  assert.ok(generated, 'the doc must carry a machine-comparable `generated:` date');
  assert.ok(staleAfter > 0 && expiresAfter > staleAfter);

  const ageDays = Math.floor((Date.now() - Date.parse(generated)) / 86_400_000);
  if (ageDays > expiresAfter) {
    assert.fail(
      `release ledger is ${ageDays} days old (expires after ${expiresAfter}). Run \`npm run releases:refresh\`. A stale ledger read as current turns "I don't know what shipped" into a confident "nothing shipped".`
    );
  }
  if (ageDays > staleAfter) {
    console.warn(
      `[release-ledger] WARN: ${ageDays} days since last refresh (digests are monthly, stale after ${staleAfter}). Run \`npm run releases:refresh\`.`
    );
  }
});

test('committed ledger: declares itself non-exhaustive', () => {
  // Presence is evidence; absence is not. Without this an agent will reason from silence and
  // report "that feature does not exist" off an editorial monthly digest.
  const text = readFileSync(DOC, 'utf8');
  assert.match(text, /^exhaustive:\s*false/m);
  assert.match(text, /Presence is evidence; absence is NOT/);
});

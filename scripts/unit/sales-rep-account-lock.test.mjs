// Unit tests for the VCST-5733 #21 account-lock toggle (set-rep-account-lock.mjs) + the
// SR_REP_LOCKABLE fixture's resting-state contract. Pure — no env, no network.
//
// Importing the script must NOT run it: `main()` is behind an invoked-directly guard precisely so
// this file can import its helpers without authenticating against a live environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { LOCKABLE_REP_KEYS, isLockedNow } from '../seed-data/sales-rep/set-rep-account-lock.mjs';
import { repFixtureStatus, DISPOSABLE_LAYOUT_REP_KEYS, parseServedOrgs } from '../seed-data/sales-rep/sales-rep-layout-specs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readCsv = (rel) => parse(readFileSync(join(ROOT, rel), 'utf8'), { columns: true, skip_empty_lines: true, trim: true, relax_quotes: true, relax_column_count: true });
const REPS = readCsv('test-data/sales-rep/sales-reps.csv');
const repRow = (key) => REPS.find((r) => r.rep_key === key);

test('isLockedNow reads whatever the server stored, and treats a PAST lockoutEnd as unlocked', () => {
  const now = Date.parse('2026-09-02T12:00:00Z');
  assert.equal(isLockedNow({ lockoutEnd: '9999-12-31T23:59:59.9999999+00:00' }, now), true);
  // the value the /unlock endpoint actually writes — not null, but long past
  assert.equal(isLockedNow({ lockoutEnd: '0001-01-01T00:00:00+00:00' }, now), false);
  assert.equal(isLockedNow({ lockoutEnd: '2026-08-26T09:27:49.9578383+00:00' }, now), false);
  assert.equal(isLockedNow({ lockoutEnd: null }, now), false);
  assert.equal(isLockedNow({}, now), false);
  // an unparsable value must not read as LOCKED — that would wedge the toggle into refusing to lock
  assert.equal(isLockedNow({ lockoutEnd: 'not-a-date' }, now), false);
});

test('lockoutEnabled alone is NOT a lock — only a future lockoutEnd is', () => {
  // The seeded rep rests at lockoutEnabled=true / lockoutEnd=0001-01-01, i.e. lockable but unlocked.
  // Reading lockoutEnabled as the state would report every such account as permanently locked.
  assert.equal(isLockedNow({ lockoutEnabled: true, lockoutEnd: '0001-01-01T00:00:00+00:00' }), false);
});

test('the lockable allowlist is minimal and never contains a load-bearing rep', () => {
  assert.deepEqual(LOCKABLE_REP_KEYS, ['SR_REP_LOCKABLE']);
  // SR_REP_PRIMARY backs ~40 cases and owns the customerId of the VCST-5733 order fixtures.
  assert.ok(!LOCKABLE_REP_KEYS.includes('SR_REP_PRIMARY'));
  // the disposable-LAYOUT rep is a different kind of disposable; the two allowlists must not merge
  for (const k of DISPOSABLE_LAYOUT_REP_KEYS) assert.ok(!LOCKABLE_REP_KEYS.includes(k), `${k} is on both allowlists`);
});

test('every lockable rep exists, is seeded, and RESTS UNLOCKED', () => {
  for (const key of LOCKABLE_REP_KEYS) {
    const row = repRow(key);
    assert.ok(row, `${key} is not in sales-reps.csv`);
    assert.match(String(row.seeded).trim().toLowerCase(), /^(true|yes|y|1)$/, `${key} must be seeded`);
    // is_locked=false is what makes repFixtureStatus() Approved, which is what makes
    // hasStaleLockout() treat a leftover lockout as STALE and clear it on the next reseed.
    // Flip this to true and the self-heal silently stops working while everything still looks fine.
    assert.equal(repFixtureStatus(row), 'Approved', `${key} must rest UNLOCKED so the seeder self-heal applies`);
  }
});

test('a lockable rep serves at least one org, so a post-unlock query returns real data', () => {
  for (const key of LOCKABLE_REP_KEYS) {
    const { orgKeys } = parseServedOrgs(repRow(key).served_orgs);
    assert.ok(orgKeys.length >= 1, `${key} serves no org — step 1b/4b of the procedure could not tell a working query from an empty one`);
  }
});

test('the statically-locked rep is NOT the account-state fixture, and the two are distinct reps', () => {
  // SR_REP_BLOCKED is locked at rest, so /connect/token refuses it and the GraphQL gate is never
  // reached. If someone ever "simplifies" by pointing the #21 procedure at it, this fails.
  const blocked = repRow('SR_REP_BLOCKED');
  if (blocked) {
    assert.equal(repFixtureStatus(blocked), 'Locked');
    assert.ok(!LOCKABLE_REP_KEYS.includes('SR_REP_BLOCKED'));
  }
});

test('no rep key is duplicated and the lockable rep has its own email', () => {
  const keys = REPS.map((r) => r.rep_key);
  assert.equal(new Set(keys).size, keys.length);
  const emails = REPS.map((r) => String(r.email).toLowerCase());
  assert.equal(new Set(emails).size, emails.length);
});

// Unit tests for the STORE-LEVEL membership-roles whitelist spec module. Pure — no env, no network.
//
// SCOPE, per `.claude/rules/test-data.md` FOURTH RULE: this file tests the DERIVATION and nothing
// else. It deliberately does NOT assert that ORG_ROLE_NAMES equals three particular strings, that
// DESCRIPTOR_POOL holds three particular strings, or that the alias declares particular fields —
// those are DECLARATIONS, they live one file away in the same commit, and `td:validate:b2b` already
// owns them (and adds the overlay-split and committed-pre_state checks on top). Every guard function
// below is therefore exercised with SYNTHETIC inputs, so a failure here means the logic is wrong,
// never merely that someone edited the fixture on purpose.
//
// The four computations whose silent failure is expensive:
//   1. `sameSet` — the platform REORDERS a dictionary value on write, so an order-sensitive
//      comparison would call every successful write a failure and every re-run a change.
//   2. `capturePreState` — write-once. Recapture on a second apply would record the FIXTURE as the
//      original, and teardown would permanently restore the fixture instead of the environment.
//   3. `planTeardown` — must REFUSE rather than fall back to empty, because an empty store value is
//      a third behavioural state (the picker falls back to the GLOBAL whitelist), not a clean slate.
//   4. `selectSalesRepRoles` — the permission predicate. Name-matching over-collects badly on the
//      real environment, so the predicate being permission-driven is the whole point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tenantValuesPath, toSet, sameSet, selectSalesRepRoles, buildWhitelist, buildWriteBody,
  planWrite, capturePreState, planTeardown, entriesOutsideDefaultPage,
  findRoleProblems, findDecidabilityProblems, findAliasProblems,
} from '../seed-data/b2b/membership-roles-whitelist-specs.mjs';

/* ── 1. URL builder ───────────────────────────────────────────────────────────────────────────── */

test('tenantValuesPath builds the v2 tenant-values route and encodes the tenant id', () => {
  assert.equal(tenantValuesPath('B2B-store'), '/api/platform/settings/v2/tenant/Store/B2B-store/values');
  // A store id may legally contain a space or a slash; an unencoded one would silently address a
  // different route (or 404) rather than erroring.
  assert.equal(tenantValuesPath('My Store'), '/api/platform/settings/v2/tenant/Store/My%20Store/values');
  assert.equal(tenantValuesPath('a/b'), '/api/platform/settings/v2/tenant/Store/a%2Fb/values');
  assert.equal(tenantValuesPath('X', 'Catalog'), '/api/platform/settings/v2/tenant/Catalog/X/values');
  assert.throws(() => tenantValuesPath(''), /tenantId is required/);
  assert.throws(() => tenantValuesPath(null), /tenantId is required/);
});

/* ── 2. Set semantics — order-independent, case-insensitive, blank-tolerant ───────────────────── */

test('toSet normalises case and whitespace and drops blanks', () => {
  const s = toSet(['  Organization Employee ', 'organization employee', '', null, 'Purchasing agent']);
  assert.equal(s.size, 2);
  assert.ok(s.has('organization employee'));
  assert.ok(s.has('purchasing agent'));
  assert.equal(toSet(null).size, 0);
  assert.equal(toSet('not an array').size, 0);
});

test('sameSet is ORDER-INDEPENDENT — the platform reorders a dictionary value on write', () => {
  // Measured live: POST ["Organization employee","Sales Representative"] read back as
  // ["Sales Representative","Organization employee"]. Order sensitivity here would make every
  // successful write report as a failed read-back.
  assert.ok(sameSet(['A', 'B'], ['B', 'A']));
  assert.ok(sameSet(['Organization employee'], ['organization employee']));
  assert.ok(sameSet([], []));
  assert.ok(!sameSet(['A'], ['A', 'B']), 'a superset must not compare equal');
  assert.ok(!sameSet(['A', 'B'], ['A']), 'a subset must not compare equal');
  assert.ok(!sameSet(['A'], ['B']));
  assert.ok(!sameSet([], ['A']), 'empty vs non-empty is a real difference — empty is its own behavioural state');
});

/* ── 3. The sales-rep predicate ───────────────────────────────────────────────────────────────── */

test('selectSalesRepRoles selects by PERMISSION, not by name', () => {
  const roles = [
    { name: 'Sales Representative', permissions: ['sales-rep:access'] },
    { name: 'Advanced Sales Representative', permissions: ['sales-rep:access', 'sales-rep-documents:read'] },
    // These three are the real trap: on vcst they all LOOK sales-rep and carry no sales-rep grant.
    { name: 'Sales Rep', permissions: ['customer:read', 'store:read'] },
    { name: 'Sales Executive', permissions: ['order:read'] },
    { name: 'AGENT-TEST-SalesRep-Full', permissions: ['customer:read', 'customer:create'] },
    // Carries a sales-rep permission, but NOT the grant — must be excluded.
    { name: 'Sales Rep Documents Manager', permissions: ['sales-rep-documents:read', 'sales-rep-documents:write'] },
    { name: 'Catalog manager', permissions: [] },
    { name: 'No perms field' },
  ];
  assert.deepEqual(selectSalesRepRoles(roles).map((r) => r.name), ['Sales Representative', 'Advanced Sales Representative']);
});

test('selectSalesRepRoles accepts permissions as objects as well as strings, and is case-insensitive', () => {
  const roles = [
    { name: 'A', permissions: [{ name: 'sales-rep:access' }] },
    { name: 'B', permissions: ['SALES-REP:ACCESS'] },
    { name: 'C', permissions: [{ name: 'customer:read' }] },
  ];
  assert.deepEqual(selectSalesRepRoles(roles).map((r) => r.name), ['A', 'B']);
});

test('selectSalesRepRoles returns empty rather than throwing on junk input', () => {
  assert.deepEqual(selectSalesRepRoles(null), []);
  assert.deepEqual(selectSalesRepRoles([{ name: 'X', permissions: null }]), []);
  assert.deepEqual(selectSalesRepRoles([], 'sales-rep:access'), []);
});

/* ── 4. Composition ───────────────────────────────────────────────────────────────────────────── */

test('buildWhitelist dedupes case-insensitively but PRESERVES the first spelling', () => {
  // The stored value is a display name the picker renders verbatim, so a case fold would leak to UI.
  const out = buildWhitelist(['Organization Employee', 'Purchasing agent'], ['organization employee', 'Sales Representative']);
  assert.deepEqual(out, ['Organization Employee', 'Purchasing agent', 'Sales Representative']);
});

test('buildWhitelist keeps org roles first, drops blanks, and trims', () => {
  assert.deepEqual(buildWhitelist(['  A  ', '', null], ['B']), ['A', 'B']);
  assert.deepEqual(buildWhitelist([], []), []);
});

test('buildWriteBody produces a single-key partial-merge patch', () => {
  assert.deepEqual(buildWriteBody(['A', 'B'], 'Some.Setting'), { 'Some.Setting': ['A', 'B'] });
  assert.equal(Object.keys(buildWriteBody([], 'X')).length, 1, 'the body must never carry a second key');
  assert.throws(() => buildWriteBody('not an array'), /must be an array/);
});

/* ── 5. Idempotency ───────────────────────────────────────────────────────────────────────────── */

test('planWrite is a no-op when live already equals target, regardless of ORDER', () => {
  const p = planWrite(['B', 'A'], ['A', 'B']);
  assert.equal(p.changed, false);
  assert.equal(p.body, null);
});

test('planWrite writes when the sets differ, and the body carries the TARGET not the live value', () => {
  const p = planWrite(['A'], ['A', 'B'], 'S');
  assert.equal(p.changed, true);
  assert.deepEqual(p.body, { S: ['A', 'B'] });
});

/* ── 6. PRE-STATE capture — write-once. The expensive one. ────────────────────────────────────── */

test('capturePreState captures on a first apply', () => {
  const c = capturePreState(null, ['Organization employee'], ['Organization employee', 'Sales Representative']);
  assert.equal(c.capture, true);
  assert.deepEqual(c.value, ['Organization employee']);
});

test('capturePreState NEVER overwrites an existing capture — else teardown restores the fixture', () => {
  // A second apply sees live === the seeded set. Recapturing would record the FIXTURE as "original",
  // and teardown would then restore the fixture forever. This is the bug the guard exists for.
  const c = capturePreState('["Organization employee"]', ['Organization employee', 'Sales Representative'], ['Organization employee', 'Sales Representative']);
  assert.equal(c.capture, false);
  assert.match(c.reason, /already captured/);
});

test('capturePreState refuses when live ALREADY equals the target (nothing original left to record)', () => {
  const c = capturePreState(null, ['A', 'B'], ['B', 'A']);
  assert.equal(c.capture, false);
  assert.match(c.reason, /would record the FIXTURE as the original/);
});

test('capturePreState treats an EMPTY-STRING capture as absent, not as a captured empty list', () => {
  // The alias field is a string and is '' in the committed base. Reading '' as "captured []" would
  // make teardown clear the store whitelist — which is a real behavioural change, not a restore.
  assert.equal(capturePreState('', ['A'], ['A', 'B']).capture, true);
  assert.equal(capturePreState(undefined, ['A'], ['A', 'B']).capture, true);
  // A genuinely captured empty list is JSON '[]', which IS a capture and must not be recaptured.
  assert.equal(capturePreState('[]', ['A'], ['A', 'B']).capture, false);
});

/* ── 7. Teardown — restores the pre-state, refuses to guess ───────────────────────────────────── */

test('planTeardown REFUSES when nothing was captured — empty is not a neutral fallback', () => {
  const p = planTeardown(null, ['A', 'B']);
  assert.equal(p.restore, false);
  assert.equal(p.target, null);
  assert.match(p.reason, /GLOBAL whitelist/, 'the refusal must say WHY empty is not neutral');
  assert.equal(planTeardown('', ['A']).restore, false);
  assert.equal(planTeardown(undefined, ['A']).restore, false);
});

test('planTeardown parses a JSON-encoded capture and targets exactly it', () => {
  const p = planTeardown('["Organization employee"]', ['Organization employee', 'Sales Representative']);
  assert.equal(p.restore, true);
  assert.deepEqual(p.target, ['Organization employee']);
  assert.equal(p.changed, true);
});

test('planTeardown accepts an already-parsed array and reports no change when live matches', () => {
  const p = planTeardown(['A', 'B'], ['B', 'A']);
  assert.equal(p.restore, true);
  assert.equal(p.changed, false, 'order must not manufacture a spurious restore write');
});

test('planTeardown can restore to a captured EMPTY list when that is genuinely what was there', () => {
  const p = planTeardown('[]', ['A']);
  assert.equal(p.restore, true);
  assert.deepEqual(p.target, []);
  assert.equal(p.changed, true);
});

/* ── 8. Picker paging derivation ──────────────────────────────────────────────────────────────── */

test('entriesOutsideDefaultPage reports whitelist entries the un-keyworded picker cannot show', () => {
  const ordered = ['r1', 'r2', 'r3', 'r4', 'r5'];
  assert.deepEqual(entriesOutsideDefaultPage(ordered, ['r1', 'r4', 'r9'], 3), ['r4', 'r9']);
  assert.deepEqual(entriesOutsideDefaultPage(ordered, ['r1', 'r2'], 3), []);
  assert.deepEqual(entriesOutsideDefaultPage(ordered, ['R1'], 3), [], 'matching is case-insensitive, like the picker');
  assert.deepEqual(entriesOutsideDefaultPage([], ['r1'], 3), ['r1']);
});

/* ── 9. The guards, on SYNTHETIC inputs only ──────────────────────────────────────────────────── */

test('findRoleProblems flags a whitelist entry that matches no live role', () => {
  const probs = findRoleProblems({
    orgRoleNames: ['Real Role', 'Ghost Role'],
    salesRepRoles: [{ name: 'SR' }],
    liveRoles: [{ name: 'Real Role' }, { name: 'Ghost Rolex' }],
  });
  assert.equal(probs.length, 1);
  assert.match(probs[0], /Ghost Role/);
  assert.match(probs[0], /silently invisible/);
});

test('findRoleProblems FAILS LOUD when the sales-rep set resolves to zero', () => {
  // The instruction was "plus ALL sales-rep roles"; resolving that to nothing and seeding only the
  // org roles would report success while dropping half the requested set.
  const probs = findRoleProblems({ orgRoleNames: ['R'], salesRepRoles: [], liveRoles: [{ name: 'R' }] });
  assert.equal(probs.length, 1);
  assert.match(probs[0], /resolved to ZERO/);
});

test('findRoleProblems is clean when every entry resolves (case-insensitively)', () => {
  assert.deepEqual(findRoleProblems({
    orgRoleNames: ['organization employee'],
    salesRepRoles: [{ name: 'SR' }],
    liveRoles: [{ name: 'Organization Employee' }, { name: 'SR' }],
  }), []);
});

test('findDecidabilityProblems FAILS when the sales-rep half is empty (the vacuity case)', () => {
  const probs = findDecidabilityProblems({ orgRoleNames: ['A'], salesRepRoleNames: [], pool: ['A'] });
  assert.equal(probs.length, 1);
  assert.match(probs[0], /vacuous pass/);
});

test('findDecidabilityProblems FAILS when a sales-rep role drifts INSIDE the module pool', () => {
  // The discriminating property is that the sales-rep entries could ONLY have come from the stored
  // tenant value. A sales-rep role inside the descriptor pool destroys exactly that.
  const probs = findDecidabilityProblems({ orgRoleNames: ['A'], salesRepRoleNames: ['B'], pool: ['A', 'B'] });
  assert.equal(probs.length, 1);
  assert.match(probs[0], /INSIDE the module's hardcoded pool/);
});

test('findDecidabilityProblems FAILS when an org role sits outside the pool', () => {
  const probs = findDecidabilityProblems({ orgRoleNames: ['A', 'Z'], salesRepRoleNames: ['S'], pool: ['A'] });
  assert.equal(probs.length, 1);
  assert.match(probs[0], /"Z"/);
});

test('findDecidabilityProblems FAILS when the two halves overlap', () => {
  const probs = findDecidabilityProblems({ orgRoleNames: ['A'], salesRepRoleNames: ['A', 'S'], pool: ['A'] });
  assert.ok(probs.some((p) => /BOTH halves/.test(p)));
});

test('findDecidabilityProblems is clean for a properly diverging set', () => {
  assert.deepEqual(findDecidabilityProblems({ orgRoleNames: ['A', 'B'], salesRepRoleNames: ['S1', 'S2'], pool: ['A', 'B'] }), []);
});

test('findAliasProblems rejects a committed runtime field — that would leak one env state to all', () => {
  const base = {
    B2B_STORE_MEMBERSHIP_ROLES: {
      _inline: true,
      fields: {
        setting: 'Customer.MembershipRolesWhitelist', tenant_type: 'Store',
        org_roles: 'Organization employee;Purchasing agent;Organization maintainer',
        seeded_values: '', sales_rep_roles: '', pre_state: '', captured_at: '',
      },
      _notes: 'x',
    },
  };
  assert.deepEqual(findAliasProblems(base), [], 'a correctly-shaped registration is clean');

  const leaked = structuredClone(base);
  leaked.B2B_STORE_MEMBERSHIP_ROLES.fields.pre_state = '["Organization employee"]';
  const probs = findAliasProblems(leaked);
  assert.equal(probs.length, 1);
  assert.match(probs[0], /COMMITTED base/);
});

test('findAliasProblems reports a missing alias rather than throwing', () => {
  const probs = findAliasProblems({});
  assert.equal(probs.length, 1);
  assert.match(probs[0], /not registered/);
});

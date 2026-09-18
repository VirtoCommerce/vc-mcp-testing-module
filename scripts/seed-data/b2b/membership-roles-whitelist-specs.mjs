/**
 * membership-roles-whitelist-specs.mjs — side-effect-free source of truth for the STORE-LEVEL
 * MEMBERSHIP-ROLES WHITELIST fixture (`Customer.MembershipRolesWhitelist` on tenant `Store`/B2B-store).
 *
 * Importing this module has NO side effects (no env read, no fs, no network), so the runner
 * (`set-membership-roles-whitelist.mjs`), the drift guard (`validate-b2b-data.mjs`) and the unit
 * tests (`scripts/unit/membership-roles-whitelist.test.mjs`) all import the same functions.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────────────────────────
 * A STATE SETTER on a platform SETTING, in the shape of `set-membership-lock.mjs` — not an additive
 * find-or-create seeder. There is no entity to create and nothing to name, so `AGENT-TEST-` has
 * nothing to prefix here; the safety story is (1) the write touches exactly ONE settings key, and
 * (2) teardown restores the CAPTURED PRE-STATE rather than a hardcoded "clean" value.
 *
 * ── THE MECHANISM, MEASURED LIVE ON vcst 2026-09-18 + READ FROM SOURCE ──────────────────────────
 * The v2 settings API separates the dictionary POOL from the SELECTED value, and the LEGACY v1 API
 * conflates them. Getting this backwards is the single most likely way to write the wrong field:
 *
 *   GET  /api/platform/settings/v2/tenant/Store/schema        -> [{name, allowedValues, ...}]
 *          `allowedValues` = the POOL (what the operator may pick from). For this setting it is the
 *          HARDCODED C# literal, NOT anything stored per store.
 *   GET  /api/platform/settings/v2/tenant/Store/{id}/values   -> flat { settingName: value }
 *          a dictionary setting's value is the ARRAY of SELECTED entries. THIS is the whitelist.
 *   POST /api/platform/settings/v2/tenant/Store/{id}/values   <- flat { settingName: value }
 *          a PARTIAL MERGE: only the supplied keys move (measured — all 106 keys survived a
 *          single-key POST). It does NOT validate against the pool (measured — an out-of-pool role
 *          name was accepted and persisted).
 *
 * The legacy `GET /api/platform/settings` reports the SELECTED set in its `allowedValues` field,
 * which is why BL-B2B-011 says "content lives in allowedValues, never value". That is correct FOR V1
 * and inverted for V2. Both readings agree on the same underlying data; only the field name differs.
 *
 * ── EMPTY DOES NOT MEAN THE SAME THING AT STORE SCOPE ────────────────────────────────────────────
 * BL-B2B-011 records "an EMPTY whitelist means NO restriction -> ALL roles". That is true at GLOBAL
 * scope. At STORE scope it is NOT, and the difference is load-bearing for teardown:
 *   rolesPickerService.js (vc-module-customer@dev Scripts/services/rolesPickerService.js)
 *     var storeValues = (values && values[options.whitelistSettingId]) || [];
 *     if (storeValues.length) { whitelist = storeValues; reapplyWhitelist(); }
 * An EMPTY store value is falsy-length, so the store override is SKIPPED and the picker falls back
 * to the GLOBAL whitelist. On this environment the global value is `[]`, so global-empty then means
 * all roles — but that is two hops, not one, and a deployment with a non-empty global whitelist
 * would behave completely differently. Clearing this store key to empty is therefore NOT a neutral
 * teardown; it is a third behavioural state. Teardown restores the captured pre-state.
 */

import { GRANTING_ROLES, PERM_ACCESS } from '../sales-rep/sales-rep-docs-specs.mjs';

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 1. IDENTITY — the setting, the tenant, the alias
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

export const SETTING_NAME = 'Customer.MembershipRolesWhitelist';
export const TENANT_TYPE = 'Store';

/**
 * The `@td()` alias this fixture owns. Runtime/observed fields are EMPTY in the committed base and
 * are supplied per env by `aliases.<env>.json` (the multi-env writeback rule) — a whitelist is live
 * state, and the captured pre-state is by definition per-environment.
 */
export const ALIAS = 'B2B_STORE_MEMBERSHIP_ROLES';

/** Fields the alias declares. `seeded_values`/`pre_state`/`captured_at` are overlay-only. */
export const ALIAS_RUNTIME_FIELDS = Object.freeze(['seeded_values', 'sales_rep_roles', 'pre_state', 'captured_at']);
export const ALIAS_STATIC_FIELDS = Object.freeze(['setting', 'tenant_type', 'org_roles']);

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 2. THE VALUES — three authored org roles + a LIVE-RESOLVED sales-rep set
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The three organization roles, as the operator named them.
 *
 * These are NOT free invention and NOT transcribed from a screen: they are exactly the module's own
 * hardcoded `AllowedValues` literal, so each one is guaranteed to be an offerable option:
 *   vc-module-customer@dev src/VirtoCommerce.CustomerModule.Core/ModuleConstants.cs
 *     AllowedValues = ["Organization employee", "Purchasing agent", "Organization maintainer"]
 * The runner still matches every one against the LIVE roles list before writing (`findRoleProblems`)
 * — a whitelist entry that is not a real role is silently invisible in the picker and proves nothing.
 */
export const ORG_ROLE_NAMES = Object.freeze(['Organization employee', 'Purchasing agent', 'Organization maintainer']);

/** The module's hardcoded option pool, mirrored so the divergence guard can compare against it. */
export const DESCRIPTOR_POOL = Object.freeze(['Organization employee', 'Purchasing agent', 'Organization maintainer']);
export const DESCRIPTOR_POOL_SOURCE_REF =
  'vc-module-customer@dev src/VirtoCommerce.CustomerModule.Core/ModuleConstants.cs — Settings.General.MembershipRolesWhitelist.AllowedValues (hardcoded literal; IsDictionary=true, IsPublic=true)';

/**
 * "All sales-rep roles" is a LIVE-RESOLVED set, never a transcribed list.
 *
 * The discriminator is the PERMISSION, not the name, and the difference is not academic — measured
 * live on vcst 2026-09-18, matching on the name would have collected SIX roles that carry ZERO
 * sales-rep permissions (`Sales Rep`, `Sales Executive`, and four `AGENT-TEST-SalesRep-*` fixture
 * roles), while missing nothing the permission predicate finds. The permission is also the module's
 * OWN rule for what counts: only a role carrying `sales-rep:access` is a GRANTING role, and
 * `POST /api/sales-rep` silently substitutes one when handed a non-granting role
 * (SalesRepService.ResolveAssignableRoleAsync).
 */
export const SALES_REP_GRANT_PERMISSION = PERM_ACCESS; // 'sales-rep:access'

/**
 * The granting roles this repo already declares (`sales-rep/sales-rep-docs-specs.mjs`). Used ONLY as
 * a cross-check against the live resolution — live wins, because a deployment may legitimately add a
 * granting role. A divergence is reported, never silently accepted, and never substituted for the
 * live set.
 */
export const DECLARED_GRANTING_ROLES = Object.freeze([...GRANTING_ROLES]);

/**
 * The Admin SPA roles picker fetches a FIXED page of 20 and filters it client-side:
 *   rolesPickerService.js — roles.search({ keyword: keyword || '', take: 20 })
 * So a whitelisted role outside the first 20 of the unfiltered search does NOT render until the
 * tester types a keyword. With 60 roles on vcst this bites. Documented here so a later reader sees
 * "my whitelist entry is missing from the picker" as expected paging, not a defect.
 */
export const PICKER_PAGE_SIZE = 20;
export const PICKER_SOURCE_REF =
  'vc-module-customer@dev Scripts/services/rolesPickerService.js — roles.search({keyword, take: 20}) then filterByWhitelist(); matches whitelist entries against role.name OR role.id, case-insensitively';

/**
 * Whitelist edits only reach the picker after Settings -> Reset cache + a FULL page reload.
 * Stated here because chasing an un-refreshed picker is the classic phantom on this surface.
 */
export const REFRESH_REQUIREMENT =
  'Admin SPA: Settings -> Reset cache, then a FULL page reload. Without both, the picker serves the previous whitelist.';

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 3. PURE DERIVATION — the builders and transforms the unit tests own
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** The v2 tenant-values path for a store. Encoded — a store id may legally contain a space. */
export function tenantValuesPath(tenantId, tenantType = TENANT_TYPE) {
  const id = String(tenantId || '').trim();
  if (!id) throw new Error('tenantValuesPath: tenantId is required');
  return `/api/platform/settings/v2/tenant/${encodeURIComponent(tenantType)}/${encodeURIComponent(id)}/values`;
}

/** Normalise one whitelist entry for comparison. The picker matches case-insensitively. */
const norm = (v) => String(v ?? '').trim().toLowerCase();

/** Entries as a normalised Set, dropping blanks. */
export function toSet(values) {
  return new Set((Array.isArray(values) ? values : []).map(norm).filter(Boolean));
}

/**
 * Order-independent equality.
 *
 * NOT a stylistic choice: the platform REORDERS a dictionary value on write. Measured — posting
 * `["Organization employee","Sales Representative"]` read back as
 * `["Sales Representative","Organization employee"]`. An order-sensitive comparison would call every
 * successful write a failure, and every idempotent re-run a change.
 */
export function sameSet(a, b) {
  const sa = toSet(a); const sb = toSet(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

/**
 * Select the sales-rep roles from a live roles listing by PERMISSION.
 * @param roles [{ name, id, permissions: string[] }]
 * @returns the matching role objects, in the order given
 */
export function selectSalesRepRoles(roles, permission = SALES_REP_GRANT_PERMISSION) {
  const want = norm(permission);
  return (Array.isArray(roles) ? roles : []).filter(
    (r) => (r?.permissions || []).some((p) => norm(typeof p === 'string' ? p : p?.name) === want),
  );
}

/**
 * Compose the whitelist: the three org roles, then the live sales-rep roles.
 * Deduplicated case-insensitively while PRESERVING the first spelling seen — the stored value is a
 * display name and the picker shows it verbatim, so a case fold here would leak into the UI.
 */
export function buildWhitelist(orgRoleNames = ORG_ROLE_NAMES, salesRepRoleNames = []) {
  const out = []; const seen = new Set();
  for (const v of [...orgRoleNames, ...salesRepRoleNames]) {
    const n = norm(v);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(String(v).trim());
  }
  return out;
}

/** The POST body — a partial merge patch carrying exactly one key. */
export function buildWriteBody(values, settingName = SETTING_NAME) {
  if (!Array.isArray(values)) throw new Error('buildWriteBody: values must be an array');
  return { [settingName]: values };
}

/**
 * Idempotency: is a write needed, and what is being written?
 * @returns { changed, body|null, reason }
 */
export function planWrite(liveValues, targetValues, settingName = SETTING_NAME) {
  if (sameSet(liveValues, targetValues)) {
    return { changed: false, body: null, reason: 'live whitelist already equals the target set (order-independent)' };
  }
  return { changed: true, body: buildWriteBody(targetValues, settingName), reason: 'live whitelist differs from the target set' };
}

/**
 * THE CRITICAL DERIVATION — decide whether to capture the pre-state.
 *
 * Teardown restores what was there BEFORE this fixture, so the captured value must be the ORIGINAL,
 * never a previous run's own output. Two ways that goes wrong, both silent:
 *
 *   1. A second `apply` run recaptures, and since the live value is now the SEEDED set, the pre-state
 *      becomes the seeded set — teardown degrades to a no-op and the environment keeps the fixture
 *      forever. This is why an already-captured pre-state is NEVER overwritten.
 *   2. Capturing while live already equals the target would record the target as "original" for the
 *      same reason, so that case is refused too.
 *
 * `writeEnvAliasOverride` merges and never deletes, so a wrong capture is permanent until someone
 * edits the overlay by hand. Capture is therefore write-once.
 *
 * @returns { capture: boolean, value: string[]|null, reason }
 */
export function capturePreState(existingCapture, liveValues, targetValues) {
  const already = existingCapture !== null && existingCapture !== undefined && existingCapture !== '';
  if (already) {
    return { capture: false, value: null, reason: 'pre-state already captured — never overwritten, or teardown would restore this fixture instead of the original' };
  }
  if (sameSet(liveValues, targetValues)) {
    return { capture: false, value: null, reason: 'live already equals the target set — capturing now would record the FIXTURE as the original' };
  }
  return { capture: true, value: [...(liveValues || [])], reason: 'first apply on this env — recording the original whitelist so teardown can restore it' };
}

/**
 * Teardown plan: restore the captured pre-state.
 *
 * Refuses when nothing was captured. "Restore to empty" is NOT the fallback — at store scope an
 * empty value means "skip the override and use the global whitelist", a third behavioural state
 * (see the header). Guessing it would silently change how the picker behaves.
 *
 * @returns { restore: boolean, target: string[]|null, changed: boolean, reason }
 */
export function planTeardown(capturedPreState, liveValues) {
  if (capturedPreState === null || capturedPreState === undefined || capturedPreState === '') {
    return {
      restore: false,
      target: null,
      changed: false,
      reason: 'no pre-state captured for this env — refusing to guess. Restoring to empty is NOT neutral: at store scope an empty value makes the picker fall back to the GLOBAL whitelist. Restore the original by hand, or re-run apply on an env where capture can happen.',
    };
  }
  const target = Array.isArray(capturedPreState) ? capturedPreState : JSON.parse(capturedPreState);
  return {
    restore: true,
    target,
    changed: !sameSet(liveValues, target),
    reason: sameSet(liveValues, target) ? 'live already equals the captured pre-state — nothing to restore' : 'restoring the captured pre-state',
  };
}

/**
 * Which whitelist entries fall OUTSIDE the picker's default (keyword-less) page?
 * Pure, so the runner can report it without the reader having to re-derive the paging rule.
 */
export function entriesOutsideDefaultPage(orderedLiveRoleNames, whitelist, pageSize = PICKER_PAGE_SIZE) {
  const window = new Set((orderedLiveRoleNames || []).slice(0, pageSize).map(norm));
  return (whitelist || []).filter((v) => !window.has(norm(v)));
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 4. LIVE GUARDS — fail loud rather than seed something that proves nothing
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Every whitelist entry must correspond to a REAL live role, and the sales-rep set must be non-empty.
 *
 * Both failures are otherwise silent: `POST .../values` does NOT validate against the pool (measured
 * — an arbitrary string is accepted and persisted), and the picker simply never offers an entry that
 * matches no role. A fixture in that state looks provisioned and decides nothing.
 */
export function findRoleProblems({ orgRoleNames = ORG_ROLE_NAMES, salesRepRoles = [], liveRoles = [] } = {}) {
  const problems = [];
  const byName = new Map((liveRoles || []).map((r) => [norm(r?.name), r]));

  for (const want of orgRoleNames) {
    if (!byName.has(norm(want))) {
      const near = (liveRoles || []).map((r) => r?.name).filter((n) => norm(n).includes(norm(want).split(' ')[0]));
      problems.push(
        `org role "${want}" does not exist in the live roles list — a whitelist entry that matches no role is silently invisible in the picker, so seeding it would prove nothing.`
        + (near.length ? ` Live names containing "${norm(want).split(' ')[0]}": ${near.map((n) => `"${n}"`).join(', ')}` : ''),
      );
    }
  }

  if (!salesRepRoles.length) {
    problems.push(
      `no live role carries "${SALES_REP_GRANT_PERMISSION}" — "all sales-rep roles" resolved to ZERO. Refusing to seed just the org roles, `
      + 'because that silently drops half the requested set and the run would report success. '
      + `Cross-check: this repo declares ${DECLARED_GRANTING_ROLES.map((r) => `"${r}"`).join(', ')} as granting roles.`,
    );
  }
  return problems;
}

/**
 * SECOND-RULE guard (`.claude/rules/test-data.md` §SECOND RULE) — is the composed whitelist
 * DISCRIMINATING, and for WHICH link?
 *
 * The property that makes this fixture falsifiable is a DIVERGENCE across the module's hardcoded
 * pool: the three org roles are INSIDE `DESCRIPTOR_POOL`, the sales-rep roles are OUTSIDE it. So:
 *
 *   · an implementation that filters by the STORED tenant value  -> picker offers all 5
 *   · one that filters by the DESCRIPTOR's AllowedValues literal -> picker offers only the 3 org ones
 *   · one that ignores the store override entirely               -> picker offers ALL roles, because
 *     the GLOBAL value of this setting is [] on this environment and an empty whitelist skips filtering
 *
 * Three implementations, three distinguishable observations. Collapse the divergence — drop the
 * sales-rep half, or let a sales-rep role enter the pool — and the first two become indistinguishable.
 * THAT is what this guard fails on.
 */
export function findDecidabilityProblems({ orgRoleNames = ORG_ROLE_NAMES, salesRepRoleNames = [], pool = DESCRIPTOR_POOL } = {}) {
  const problems = [];
  const poolSet = toSet(pool);

  const orgOutside = orgRoleNames.filter((v) => !poolSet.has(norm(v)));
  if (orgOutside.length) {
    problems.push(
      `org role(s) ${orgOutside.map((v) => `"${v}"`).join(', ')} are NOT in the module's hardcoded pool [${pool.join(', ')}] `
      + `(${DESCRIPTOR_POOL_SOURCE_REF}). The inside/outside split is what makes the three implementations distinguishable — an org role outside the pool blurs it.`,
    );
  }

  if (!salesRepRoleNames.length) {
    problems.push(
      'the sales-rep half of the whitelist is EMPTY, so every entry sits inside the module\'s hardcoded pool. '
      + 'A picker driven by the STORED tenant value and one driven by the descriptor\'s AllowedValues literal would then render IDENTICALLY, '
      + 'and the case built on this fixture is a vacuous pass.',
    );
  }

  const srInside = salesRepRoleNames.filter((v) => poolSet.has(norm(v)));
  if (srInside.length) {
    problems.push(
      `sales-rep role(s) ${srInside.map((v) => `"${v}"`).join(', ')} are INSIDE the module's hardcoded pool — the outside-the-pool divergence has collapsed for them. `
      + 'The whole discriminating property is that these entries could only have come from the stored tenant value.',
    );
  }

  const overlap = orgRoleNames.filter((v) => toSet(salesRepRoleNames).has(norm(v)));
  if (overlap.length) {
    problems.push(`${overlap.map((v) => `"${v}"`).join(', ')} appears in BOTH halves — the two halves must stay disjoint or the divergence is not a divergence`);
  }
  return problems;
}

/**
 * What this fixture does NOT decide — stated at the fixture, per the SECOND RULE's "state the
 * fixture's own limits", so a green case cannot imply an answer it never gave.
 */
export const FIXTURE_LIMITS = Object.freeze([
  'It does NOT decide the NARROWING link ("a whitelist hides an org role that would otherwise be offered"). '
  + 'All three pool entries are whitelisted, so the org half of the picker looks identical to an unfiltered one. '
  + 'Deciding that needs a variant that OMITS a pool role — which is exactly what this store\'s pre-state '
  + '(["Organization employee"]) was, so capture it before overwriting and consider it a second variant.',
  'It does NOT decide server-side ENFORCEMENT. Per BL-B2B-011 the whitelist constrains only the Admin UI '
  + 'picker\'s offered options; PUT /api/organizations and changeOrganizationContactRole still accept a '
  + 'non-whitelisted roleId (VCST-5239 EPIC-5239-03 is the planned gate).',
  `It does NOT decide picker PAGING. The picker fetches a fixed page of ${PICKER_PAGE_SIZE} roles and filters client-side `
  + `(${PICKER_SOURCE_REF}), so a whitelisted role outside that window is absent for a reason that has nothing to do with the whitelist.`,
]);

/**
 * STATIC drift guard consumed by `validate-b2b-data.mjs` (`td:validate:b2b`).
 * Grades the COMMITTED declaration only — no network, so it cannot see the live sales-rep set.
 */
export function findAliasProblems(aliases = {}) {
  const problems = [];
  const def = aliases[ALIAS];
  if (!def) {
    problems.push(`alias ${ALIAS} is not registered in test-data/aliases.json — the seeded whitelist would have no @td() handle`);
    return problems;
  }
  if (!def._inline) problems.push(`alias ${ALIAS} must be declared _inline: true (it names a setting, not a CSV row)`);

  const fields = def.fields || {};
  for (const f of [...ALIAS_STATIC_FIELDS, ...ALIAS_RUNTIME_FIELDS]) {
    if (!(f in fields)) problems.push(`alias ${ALIAS} does not declare field "${f}"`);
  }
  // Runtime/observed fields must be EMPTY in the committed base — they are per-env overlay values.
  for (const f of ALIAS_RUNTIME_FIELDS) {
    const v = fields[f];
    if (v !== undefined && String(v).trim() !== '') {
      problems.push(
        `alias ${ALIAS}.${f} is populated in the COMMITTED base ("${v}") — it is per-env live state and belongs only in aliases.<env>.json. `
        + 'A committed value would resolve on every other env to this env\'s whitelist.',
      );
    }
  }
  // Static fields must agree with this module — one source of truth, no hand-maintained mirror.
  if (fields.setting !== undefined && fields.setting !== SETTING_NAME) {
    problems.push(`alias ${ALIAS}.setting is "${fields.setting}" but the spec declares "${SETTING_NAME}"`);
  }
  if (fields.tenant_type !== undefined && fields.tenant_type !== TENANT_TYPE) {
    problems.push(`alias ${ALIAS}.tenant_type is "${fields.tenant_type}" but the spec declares "${TENANT_TYPE}"`);
  }
  if (fields.org_roles !== undefined && fields.org_roles !== ORG_ROLE_NAMES.join(';')) {
    problems.push(`alias ${ALIAS}.org_roles is "${fields.org_roles}" but the spec declares "${ORG_ROLE_NAMES.join(';')}"`);
  }
  if (!String(def._notes || '').trim()) problems.push(`alias ${ALIAS} carries no _notes — a fixture whose limits are unstated reads as deciding more than it does`);
  return problems;
}

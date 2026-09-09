# BUG — `organizationOrders` returns a locked organization's full order history while `organization(id:)` refuses it

## Status: CONFIRMED

**Severity:** Medium-High · **Priority:** Medium · **Found:** 2026-09-09 · **Ticket:** VCST-5317 (**in-scope** — a direct consequence of PR #145's declared breaking change)
**Env:** vcst-qa — `BACK_URL=https://vcst-qa.govirto.com`
**Found by:** `/qa-test VCST-5317` Step 3a, confirmed and broadened by the Step 4 backend lane.

## Summary

PR #145 removes the server-side filter that excluded locked memberships from `contact.organizations` / `organizationsIds`, and declares the change breaking: *"any consumer relying on that implicit filtering must now check `isLockedForCurrentUser` itself."* It ships **no inventory of those consumers**. One of them does not check: `organizationOrders(organizationId:)` serves a locked organization's complete order history, while `organization(id:)` — same principal, same org id, same moment — refuses with `Forbidden`.

**The two reads disagree about what "your organization" means.** Which of them is wrong is a product decision; that they disagree is the defect.

## Steps to reproduce

1. Multi-org buyer with TechFlow **locked** and BuildRight active (`npm run seed:membership-lock -- --lane backend --state V2`).
2. Authenticate. Issue both reads against the **locked** org id, then repeat against the unlocked org as the control.

**Actual, at V2 — same principal, same org id:**

| Read | Locked org | Unlocked control |
|---|---|---|
| `organization(id:)` | `Forbidden`, `data.organization` null | 200 with data |
| `organizationOrders(organizationId:)` | **200, `totalCount` 66, full order rows** | 200, `totalCount` 14 |
| `organization(id:){contacts}` | `Forbidden` | — |
| `organizationContracts(organizationId:)` | 200, `totalCount` 0 | 200, `totalCount` 0 → **non-discriminating** |

**Expected:** the two org-scoped reads agree on whether the caller may read the named organization.

## Why this is not a fallback artefact — three controls

1. **A token carrying no `organization_id` was used**, so `BL-AUTH-016`'s silent `password`-grant fallback cannot account for it.
2. **A non-member org IS refused** (`Forbidden`, 4/4 sampled) — so `organizationOrders` is not simply ungated. It gates on **membership**; `organization(id:)` gates on **accessibility** (membership **and** not-locked).
3. **At V7** (every membership locked, token carries no org claim) `organizationOrders` still served **both** orgs — 66 and 14 — while `organization(id:)` refused even the formerly-active one. Reproduces identically when the locked org is the **active** one (V5).

## Layer Validation

| Layer | Result | Evidence |
|-------|--------|----------|
| 1. Storefront Frontend | N/A | not reached through the UI in this run |
| 2. Backend Admin | N/A | — |
| 3. GraphQL xAPI | **FAIL** | `scripts/.graphql-evidence/PRF-GQL-093-*.json` |
| 4. Platform REST API | N/A | the divergence is between two xAPI resolvers |

**Owning layer:** Layer 3 — xAPI.

## Root cause analysis

`ContactType.ResolveMyOrganizationIdsByStatusAsync` no longer short-circuits on `IsCurrentlyLocked` (PR #145 deletes the early `continue`), so a locked org flows through to every downstream consumer of the membership list. `organization(id:)`'s authorization path re-evaluates the lock per org; `organizationOrders(organizationId:)` validates membership only. Before #145 the divergence was unreachable, because the locked org never appeared in the list to begin with.

## Impact

A buyer locked out of an organization can still read that organization's entire order history — 66 orders on the fixture — through the storefront's own API surface. Bounded to organizations the caller is a **member** of; a non-member is refused, so this is not an open data leak.

## Module versions

Platform `3.1064.0` · `ProfileExperienceApiModule 3.1018.0-pr-145-4fe6` · `Customer 3.1024.0-pr-316-1ac3`. PR #145 **OPEN / unmerged**, PR-deployed to vcst-qa only — catchable before merge.

## Fix Routing (→ /qa-fix)

- **Owning layer:** Layer 3 — xAPI
- **Suggested repo:** `VirtoCommerce/vc-module-profile-experience-api` (the org-scoped read paths) — **verify against `vc-module-x-order`**, which may own `organizationOrders`' resolver
- **repoKind:** module
- **Ownership hint:** platform
- **RCA anchor:** `src/VirtoCommerce.ProfileExperienceApiModule.Data/Schemas/ContactType.cs` `ResolveMyOrganizationIdsByStatusAsync` (the deleted lock short-circuit) vs whichever resolver backs `organizationOrders`
- **Routing confidence:** **MEDIUM** — the defect is certain; the owning repo is not, because `organizationOrders` may resolve outside this module. Gate 1 must confirm before any clone.

## Evidence

- `scripts/.graphql-evidence/PRF-GQL-093-*.json` — the failing case's own captured request/response pairs, with the unlocked control
- Test model `reports/ba/test-models/VCST-5317-2026-09-09.md` scenario 19 · checklist `G17`
- Carrier: `PRF-GQL-093` (High, `Draft` — asserts only that the two reads **agree**, deliberately not that order history must be hidden)

## Not claimed

- **Which side is wrong is not decided here.** `organization(id:)` may be over-strict or `organizationOrders` under-strict; that is the product call, and `PRF-GQL-093` is written to avoid pre-empting it.
- `organizationContracts` is **undecidable** on this fixture (0 = 0) and needs a seeded contract before it means anything.
- `currentOrganizationAddresses` is **not addressable by org id** — it reads the token's current org only — so it cannot exhibit this class.
- The consumer sweep covered what a **storefront customer principal** can reach. A source-level sweep of every reader of `contact.organizations` / `organizationsIds` was **not** done; the blast radius beyond these four is unenumerated.

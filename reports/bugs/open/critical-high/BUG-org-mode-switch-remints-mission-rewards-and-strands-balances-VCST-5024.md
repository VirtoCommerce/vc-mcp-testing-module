# BUG — Switching a store to Organization mode re-mints every past mission reward and strands existing balances

## Status: CONFIRMED

**Severity:** Critical · **Priority:** High · **Found:** 2026-09-11 · **Ticket:** VCST-5024 (in-scope)
**Env:** vcst-qa — `BACK_URL=https://vcst-qa.govirto.com`, store `B2B-store`
**Found by:** `/qa-test VCST-5024`, observed across a live `Customer → Organization → Customer` cycle. Figures re-derived from the live ledger at the 5b verifier gate.

## Summary

Changing `Loyalty.LoyaltyBalanceCalculationMode` re-keys balances and mission progress to a new owner, **with no data migration in either direction**. Two consequences, one root cause:

1. **Every already-completed mission is granted again** at the new scope, inflating the organization's opening balance with points already paid out once.
2. **Existing balances and mission progress become unreachable** — they remain in the database but no shipped surface can read them at the new scope.

## Steps to reproduce

1. On a store with loyalty + missions enabled and members who already hold balances and completed missions, note each member's balance and mission progress.
2. Set `Loyalty.LoyaltyBalanceCalculationMode = Organization` (via the store entity — see the companion settings-API bug).
3. Have one member place a qualifying order.
4. Read the organization balance, and each member's balance and mission progress.
5. Set the mode back to `Customer` and read everything again.

**Actual, measured:**

| | |
|---|---|
| Member A, pre-flip, user-scoped mission rewards | **20 rows totalling 9,533** |
| Member A, post-flip, org-scoped mission rewards | **21 rows totalling 10,152** |
| Difference | the **same amount multiset plus one 619** (a genuinely new mission) |

So **20 of 21 reproduce the earlier set amount-for-amount**: `617, 508×3, 506×3, 505×3, 503×3, 500×5, 250, 100 = 9,533`. Those 9,533 points were **24% of the 40,152 opening pool** and had already been paid to the same member for the same missions, with no new qualifying activity.

On the flip, members' pre-existing balances (39,533 and 100,033) read as **0** at organization scope and their mission progress reverted to `0%`. On the flip back, the organization's 163,505 points became readable **only** through the admin-only `GET /api/loyalty-program-operation-log/balance/organization/{organizationId}` — no member can see or spend them from either scope.

**Expected:** a mode change either migrates the existing records to the new scope, or refuses while records exist under the other scope. Points already granted are never granted a second time.

## Root cause analysis

`LoyaltyMissionProgress` is keyed on a new `OwnerId` (`ResolveOwnerId(userId, organizationId)` — the organization when set, otherwise the user). Changing the mode changes the key, so `GetOrCreateProgressAsync` finds no progress and **creates fresh rows**, which then complete and grant again.

**The dedup index cannot catch it, and this is the mechanism worth quoting in the fix:** the 21 org-scope rows carry **21 distinct `objectId`s** and the `(objectId, amount)` overlap with the pre-flip population is **zero**. New progress rows under the new owner key mint new `objectId`s, so `(ObjectId, ObjectType, OperationType)` sees them as new. That is why `BL-LOY-007` can hold and `BL-LOY-018` break in the same run — which otherwise reads as a contradiction.

Symmetrically, `LoyaltyBalanceOperationLogSearchService` filters on `OrganizationId`, and rows written under the other scope match no query — they are stranded, not deleted.

**`BL-LOY-018` ("granted at most once") holds *within* a scope and does not survive a scope change.** The PR's own `TransactionExistsAsync` comment shows the author had a mode flip in mind for one gate; nothing covers this one.

## Please note the failure mode precisely

This is **opening-balance inflation on adoption**, **not** double-credit on rollback. Nobody ends up holding two spendable copies: the duplicate is written at organization scope, so switching back strands it rather than doubling anyone's balance. The money leaks when a store **adopts** the feature and keeps using it. An earlier draft of this finding had it the other way round and would have sent a developer hunting a rollback bug that does not exist.

## Module versions

Platform `3.1069.0` · `VirtoCommerce.Loyalty 3.1008.0-pr-17-116e` (tip of OPEN PR `vc-module-loyalty#17`).

## Impact

A merchant enabling organization-level loyalty starts with an inflated pool — here **24%** of it was already-spent money — and simultaneously makes every member's historical balance and mission progress invisible. Both are silent: no error, no warning, no admin notice. There is **no reversal path anywhere in this module** (`BL-LOY-019`, pre-existing), so neither effect can be undone.

The proportion is environment-specific — it reflects however much mission history exists — but the mechanism is not.

## Fix Routing (→ /qa-fix)

- **repo:** `VirtoCommerce/vc-module-loyalty` · **repoKind:** `module` · **confidence:** HIGH
- **Sites:** `Data/Services/LoyaltyMissionLogicService.cs` (`ResolveOwnerId`, `GetOrCreateProgressAsync`), `Data/Services/LoyaltyBalanceOperationLogSearchService.cs`, and the three `AddOrganizationId` migrations.
- **Shape — a product decision is needed first.** Either (a) migrate existing records to the new owner on change, (b) refuse the change while records exist under the other scope, or (c) treat an already-completed mission as completed for the new owner too. (c) alone fixes the re-mint without addressing the strand.
- **Not revert-safe:** the data effect has already occurred wherever the mode was changed.

## Evidence

- `reports/tickets/Sprint26-18/VCST-5024/evidence-2026-09-11-1558/network/G2-org-ledger-full.json` — all 33 organization rows, signed sum **163,505** (independently reconfirming the pooled figure)
- `reports/tickets/Sprint26-18/VCST-5024/testing-checklist.md` items **G1 / G2 / G4**
- `reports/tickets/Sprint26-18/VCST-5024/screenshots/` — storefront showing `Balance: 0` / *"No records found"* for a member holding 39,533

## Not claimed

- The re-mint was measured for **one** member over **one** flip. The per-member and per-store totals will differ.
- Whether a *third* mode change re-mints again is **not tested** — the org-scope progress rows now exist, so a second flip to the same organization plausibly does not. Untested either way.
- No claim about behaviour on a store with no prior mission history; the defect needs history to be visible.

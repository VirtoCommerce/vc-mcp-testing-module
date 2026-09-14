# Root cause — VCST-5024 / the no-organization spend block

**Env:** `vcst` · `FRONT_URL` https://vcst-qa-storefront.govirto.com · `BACK_URL` https://vcst-qa.govirto.com · `STORE_ID` B2B-store · `ENV_RISK` test
**Build:** Platform `3.1069.0` · `VirtoCommerce.Loyalty 3.1008.0-pr-17-116e` (tip of OPEN PR #17) · theme `2.58.0-pr-2475-d710-d710e94f`
**Investigated:** 2026-09-11 · symptom first observed in the `/qa-test VCST-5024` flip window 14:34:06Z–15:07:52Z

## Symptom

On a store with `Loyalty.LoyaltyBalanceCalculationMode = Organization`, an account that belongs to **no
organization** displays its own loyalty balance of **38,916 PTS** on `/account/points-history` and is
**refused at checkout** with `LOYALTY_INSUFFICIENT_BALANCE`, `required=6`, `available=0`. Place order is
disabled. The customer can see the points and cannot spend them.

## Lowest failing layer — PROVEN, not assumed

**Backend module**, `vc-module-loyalty`, `repoKind: module`. Not frontend: the storefront renders a
validation error the server produced, and the same server returns the correct balance on the read path.

The chain, every step read first-hand from `feat/VCST-5024-org-level` (the deployed tip):

| # | Site | Behaviour |
|---|---|---|
| 1 | `ExperienceApi/Validators/LoyaltyCartValidator.cs`, rule 4 | `if (store.IsOrganizationBalanceCalculationMode()) balance = await loyaltyService.GetOrganizationBalanceAsync(cart.OrganizationId);` — **no null-check on `cart.OrganizationId`**, which is `null` for a personal cart |
| 2 | `Data/Services/LoyaltyLogicService.cs:69-73` | `GetOrganizationBalanceAsync` → `GetLastLoyaltyOperationLogByOrganization(organizationId)` → `return operationLog?.Balance ?? 0;` |
| 3 | `Data/Services/LoyaltyLogicService.cs:350-355` | `if (organizationId.IsNullOrEmpty()) { return null; }` — the empty guard returns null … |
| 4 | back at step 2 | … so `?? 0` yields **0** |
| 5 | `LoyaltyCartValidator.cs`, rule 4 | `if (balance < pointsTotals.Total)` → `LOYALTY_INSUFFICIENT_BALANCE` with `available = 0` |

`LoyaltyPaymentMethod.PostProcessPaymentAsync` carries the **same shape** — it branches on the store
setting and passes `order.OrganizationId` with no null-check — so the defect has two sites, not one.

## Alternatives ruled out

**1. By-design — REFUTED, and this is the decisive evidence.** The READ path in the *same PR* explicitly
falls back to the user. `ExperienceApi/Queries/GetLoyaltyBalanceQueryBuilderHandler.cs:39-46`:

```csharp
if (!organizationId.IsNullOrEmpty()) { balanceRequest.OrganizationId = organizationId; }
else                                 { balanceRequest.UserId = request.UserId; }
```

and `ResolveOrganizationIdAsync:52-62` returns `null` when the organization is empty *or* the store is not
in organization mode. So the author wrote the fallback on the read path and omitted it on the spend path,
in one change. Had no-organization shoppers been intended to be blocked, the read path would block them
too — instead it deliberately serves them their own balance. **The asymmetry is the proof of intent.**

**2. Data drift / misconfigured fixture — REFUTED by the back office**, read at investigation time
(`.claude/rules/…` back-office rule; the mandatory row-15 check):

| Checked in Admin / Platform API | Value |
|---|---|
| Contact `Nina Solo` (`1967481c-…`) `organizations` | `[]` |
| `organizationsIds` | `undefined` |
| `POST /api/customer/organization-memberships/search {userId}` | **0 rows** |
| `GET /balance/user/{userId}` | **38,916** |
| Its 20 ledger rows, `organizationId` values | `[null]` — legitimately user-scoped, earned by a real order |
| Contact `status` | `Approved` |

The account genuinely holds the points and genuinely belongs to no organization. **The fixture is correct;
the behaviour is not.**

**3. Store misconfiguration — REFUTED.** Quoted from the store record: `Loyalty.Enable = true`,
`Loyalty.Mode = "Mixed Cart"`, `Loyalty.Currency = "PTS"`, `Loyalty.Missions.Enable = true`. The only
setting that differed during the window is the one under test. (It now reads `null` → effective
`Customer`, i.e. restored.)

**4. Confound — the PTS-only cart rule — ELIMINATED IN THE DATA.** A points-only cart also raises
`LOYALTY_ONLY_POINT_PRODUCTS_NOT_ALLOWED` (rule 2), which could have explained the refusal. With a cash
line, address, delivery method, payment method and PO number supplied, the cart carries **exactly one**
validation error. Re-parsed recursively for any `errorCode` in the document: count = 1.
Artifacts: `network/D2-cart-ptsonly-BOTH-errors.json` (2 errors) vs `network/D2-cart-mixed-SOLE-error.json`
(1 error, `required=6 available=0`), same cart id `0e56ebc2-7e7d-4750-b314-2a3ac8ef7d75`.

## The A/B control — the same account, both modes, opposite outcomes

Run live 2026-09-11 16:05–16:26, in the browser (the user surface), signed in as Nina Solo throughout:

| Store mode | Nina Solo's cart | Frame |
|---|---|---|
| **Organization** | `LOYALTY_INSUFFICIENT_BALANCE` — *"Not enough points — needs 6, you have 0."* Place order **disabled** | `screenshots/02-cart-blocked-needs-6-have-0.png` |
| **Customer** | **No loyalty validation error at all.** The only block is *"Complete all required information to proceed."* — the ordinary incomplete-cart state, not a balance refusal | `screenshots/03-customer-mode-no-error.png` |

Her balance is unchanged at **38,916** in both, and `loyaltyBalance(storeId:)` returned 38,916 on 12 of 12
consecutive reads in Customer mode. **The block is attributable to the store mode and to nothing else** —
not the account, not the cart, not the fixture, not timing. Animated: `screenshots/VCST-5024-noorg-cannot-spend.gif`.

**Method note, recorded because it nearly produced a false finding.** An intermediate attempt to establish
this control through direct GraphQL probes returned *non-deterministic* results (4 blocked / 8 clean over 12
identical calls) and was briefly written up as a second defect — a "stale cached cart validation". **That was
an artifact of the probe, not the product.** The probes passed `userId` and `currencyCode` explicitly while
the cart resolves from ambient context, so some calls addressed a different cart context — exactly the
failure `.claude/knowledge` records as *omitting an ambient argument yields 200 with wrong data, never an
error*. The browser showed the correct, stable behaviour throughout. **The control is the browser reading;
the probe readings are discarded.**

## Confidence

**HIGH.** Every claim above cites a captured artifact or a source line read at the deployed ref. The
failing layer is proven rather than inferred, both mandatory alternatives are refuted with evidence rather
than argument, and the mode-level A/B is demonstrated on the user surface in both directions.

## Fix routing

- **Owning layer:** backend module · **repo:** `VirtoCommerce/vc-module-loyalty` · **repoKind:** `module`
- **Fix sites:** `ExperienceApi/Validators/LoyaltyCartValidator.cs` rule 4, and
  `Data/Provider/LoyaltyPaymentMethod.cs` `PostProcessPaymentAsync` — both need the read path's fallback.
- **Shape of the fix:** resolve the balance the way the read path already does — organization when the
  store is in organization mode **and** the cart/order carries an organization, otherwise the user. The
  logic exists in `GetLoyaltyBalanceQueryBuilderHandler.ResolveOrganizationIdAsync`; the cleanest fix is to
  share it rather than re-implement it, so the two paths cannot diverge again.
- **Not revert-safe** — the feature is gated behind a store setting that defaults to `Customer`, so the
  blast radius is limited to stores that have adopted organization mode. Fix-forward.

## Environment note

This symptom is only reachable while a store is in `Organization` mode. The store used was returned to
`Customer` after the run — effective `Customer`, stored `null`, zero diff across all 106 settings against
the pre-flip baseline. **Reproducing this requires re-enabling organization mode on a store.**

### 5. Alternatives ruled out (MANDATORY — at least 2)

| alternative hypothesis | how it was ruled out |
|------------------------|----------------------|
| By-design / config-gated | REFUTED by the PR's own read path. `GetLoyaltyBalanceQueryBuilderHandler.cs:39-46` falls back to `balanceRequest.UserId` when the organization is empty, and `ResolveOrganizationIdAsync:52-62` returns null when the org is empty OR the store is not in organization mode. The same author, in the same change, wrote the fallback on the read path and omitted it on the spend path — so a no-organization shopper is deliberately served their own balance and then refused when spending it. Intent is to support them; the omission is the defect. |
| Env data drift (stale index / missing fixture / orphaned org) | REFUTED in the back office at investigation time: contact `Nina Solo` has `organizations: []`, `organizationsIds: undefined`, **0** rows from `POST /api/customer/organization-memberships/search`, status `Approved`; `GET /balance/user/{userId}` = **38,916** over 20 ledger rows whose `organizationId` is `null` on every one. The account genuinely holds the points and genuinely belongs to no organization — the fixture is correct. |
| Flaky / timing (race / ES lag / cache) | REFUTED by mechanism rather than by retry count: the value is produced by a synchronous null-guard (`GetLastLoyaltyOperationLogByOrganization:352-355` returns null for an empty id, then `?? 0`), not by a cache, index or async settle. There is no timing window in which it would return anything other than 0. |
| Confound — the points-only-cart rule | ELIMINATED IN THE DATA. Rule 2 (`LOYALTY_ONLY_POINT_PRODUCTS_NOT_ALLOWED`) could have explained the refusal. With a cash line, address, delivery, payment and PO supplied, the cart carries **exactly one** validation error; re-parsed recursively for any `errorCode`, count = 1. Compare `network/D2-cart-ptsonly-BOTH-errors.json` (2 errors) with `network/D2-cart-mixed-SOLE-error.json` (1), same cart id. |
| Store misconfiguration | REFUTED by quoting the store record: `Loyalty.Enable=true`, `Loyalty.Mode="Mixed Cart"`, `Loyalty.Currency="PTS"`, `Loyalty.Missions.Enable=true`. The only setting that differed during the window is the one under test. |

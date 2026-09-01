# `OrderValueGoal` accrues the order **TOTAL**, so shipping and tax complete a spend mission — a $49.50 goal completed on $45.00 of merchandise — **P1**

## Status: CONFIRMED (source + live, twice)
**Found by:** `/qa-test VCST-5320` → suite `075d` `MSN-028` · re-observed independently in `REG-2026-09-01-2050`
**Archetype:** `MONEY` · **Invariant:** `BL-LOY-016` (VIOLATED)

**Env:** vcst-qa @ Platform `3.1061.0`, `VirtoCommerce.Loyalty_3.1006.0-pr-14-da8a` (`da8abc6`)

## Summary

A loyalty mission's `OrderValueGoal` measures progress against `order.Total` — which includes shipping and tax, and is net of discounts — rather than against the merchandise value the customer actually spent on goods. A mission targeting **49.50** completed on an order carrying **45.00** of merchandise, because shipping and tax carried it to a total of 234.00. The gap is not marginal: on that order the goal advanced by **5.2× the merchandise value**.

## Steps to reproduce

1. Create a Published mission with an `OrderValueGoal`, target **49.50**, currency USD.
2. As a targeted customer, build a cart with **9 units at $5.00 = $45.00** merchandise — deliberately *below* the target.
3. Select **Fixed Rate (Ground)** delivery (+$150.00). Tax is levied at 20% of (subtotal + shipping) = +$39.00. Order total = **$234.00**.
4. Place the order and wait for settlement.
5. Read `loyaltyMissionProgress` for that mission and customer.

## Expected vs Actual

| | |
|---|---|
| **Expected** | Progress advances by the merchandise value (45.00). The mission stays `InProgress` — 45.00 is below the 49.50 target. |
| **Actual** | Progress advances by **234.00**. Mission reads `Completed`, `currentValue 234`, `percentage 100`. |

The target was placed deliberately *between* the two readings so that the correct and incorrect implementations produce **different** observations. It is not a rounding question.

## Reproductions

| Order | Merchandise | Shipping | Tax | Total | `currentValue` |
|---|---|---|---|---|---|
| `CO260901-00003` | 45.00 | 150.00 | 39.00 | 234.00 | **234** |
| `CO260901-00004` | 20.00 | 150.00 | 34.00 | 204.00 | **204** |
| `CO260901-00040` | 60.00 | 150.00 | 42.00 | 252.00 | **252** |

## Root cause

`vc-module-loyalty` @ `da8abc6` — `LoyaltyMissionLogicService.ApplyContribution`:

```csharp
case OrderValueGoal:
    // Currency mismatch is filtered out earlier in ApplyMissionInternalAsync.
    return order.Total;
```

No reference to `SubTotal`, `DiscountTotal`, `ShippingTotal` or `TaxTotal` exists anywhere in the mission path.

**Corroborating internal inconsistency:** on `CO260901-00004` the module's *own* Product-Points ledger row recorded **20 PTS = subTotal**, while the mission advanced by **204**. Two accrual bases, in one module, on one order.

## Impact

A spend-based mission is completable with materially less real revenue than the merchant configured — the shortfall grows with the shipping method, not only with the goods. Conversely a discount *reduces* progress, so a customer applying a promo code may fall short of a goal they would otherwise have reached.

## Note for the fix

The intended behaviour was **never declared** — no acceptance criterion on VCST-5319 states which figure a goal measures. `BL-LOY-016` records merchandise value as the invariant, derived from the customer-facing meaning of "order value for the target total value per mission period". Treat the fix as a **product decision to ratify**, not merely a code correction: the alternative (accrue the total, deliberately) is defensible if stated.

**Refs:** `BL-LOY-016` · `PROPOSED-BL-LOY-016` in `reports/ba/bl-proposals-2026-08-28.md` · test `075d` `MSN-028`, `083d` `MSN-E2E-003`

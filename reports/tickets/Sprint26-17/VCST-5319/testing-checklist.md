# Testing Checklist — VCST-5319 `[Missions][Backend] Implement initial missions backend`

**Path:** FULL · **Flow:** feature-test · **Env:** vcst-qa @ Platform `3.1061.0`, `VirtoCommerce.Loyalty_3.1006.0-pr-14-da8a` (`da8abc6`)
**Fixtures:** seed `20260901134918-9421` — 11 missions / 7 accounts / 4 products; pre-completion verified live per account (14 mission×account pairs, all `InProgress 0%`)
**Test Model:** `reports/ba/test-models/VCST-5319-2026-08-28.md` · **DoD:** none declared ⇒ `dod_pct: null`

Verdict column filled at Step 5. New cases are `Draft`.

## Story AC conditions (16)

| # | Condition | Covered by | Verdict |
|---|---|---|---|
| AC-1.a | `Missions enabled` store setting persists True/False | `MSN-009` / `MSN-010` (existing) | |
| AC-2.a | OrderValueGoal creatable, drives progress from order value | **`MSN-028`** (new) + `MSN-022` | |
| AC-2.b | OrderCountGoal creatable, drives progress from order count | **`MSN-027`** (new, JOURNEY) + `MSN-019` | |
| AC-2.c | PerSkuGoal (ALL/ANY) creatable, drives progress from SKU qty | **`MSN-029`** (new) + `MSN-026` | |
| AC-2.d | Progress resets/limits per the configured mission period | `MSN-003` — **DRIFT, no execution needed** (periodicity accepted, never branched on) | |
| AC-3.a | Name / Description configurable and render | `MSN-012` (existing) | |
| AC-3.b | Start/End bound the active window | `MSN-007` + `MSN-008` (existing) | |
| AC-3.c | `CustomerIDs` targets a mission to an explicit customer list | **NOT IMPLEMENTED — no execution** (see Findings 1) | |
| AC-3.d | Customer group targets a mission to group members | **`MSN-030`** (new) + `MSN-011` / `MSN-025` | |
| AC-3.e | Reward granted exactly once on completion | **`MSN-027`**, **`MSN-033`** (new) + `MSN-021` | |
| AC-4.a | Mission CMS record renders (MissionId / Names / Description / BannerUrl) | `MSN-012` (existing) | |
| AC-4.b | Untranslated locale falls back to store default, not blank/raw key | `MSN-012` (existing) | |
| AC-5.a | A grant is attributable to its specific mission via a reachable field | **`MSN-033`** (new) — **expected to expose `BL-LOY-015`, VIOLATED** | |
| AC-5.b | Mission log entries carry type/date/amount/balance like Program entries | **`MSN-033`** (new) — DRIFT: mission rows carry `object === null` | |
| AC-6.a | Summary exposes the nine named progress fields | **NOT AS SPECIFIED — no execution** (see Findings 2) | |
| AC-6.b | `IsCompleted` / `IsActive` booleans reflect state | `MSN-013` — DRIFT (status enum, not booleans) | |

## Gap-AC conditions (8)

| # | Condition | Covered by | Verdict |
|---|---|---|---|
| gap-1 | Cancel/refund reverses the order's mission contribution | **`MSN-032`** (new) — `{HYPOTHESIS}`, oracle undeclared | |
| gap-2 | OrderValueGoal accrual basis is explicitly defined | **`MSN-028`** (new) — target sits strictly between merchandise value and taxed total | |
| gap-3 | Loyalty-currency lines excluded from accrual | **`MSN-029`** (new) — `BL-LOY-009` by analogy | |
| gap-4 | Only a committed order status contributes | **uncovered** — no `MSN_E2E_STATUSGATE` fixture; `BL-ORD-009` dictionary framing | |
| gap-5 | Multiple same-order grants separately identifiable | **`MSN-033`** (new) — `BL-LOY-015` | |
| gap-6 | Concurrent/retried orders never double-grant | `MSN-021` (existing, dedup) — accrual half still open | |
| gap-7 | Cross-currency order value handled by a defined rule | `MSN-023` (existing) + **`MSN-031`** (new, read-side filter) | |
| gap-8 | Private untargeted mission excluded from a customer's view | **`MSN-030`** (new) + `MSN-015` (existing, CONFIRMED DEFECT) | |

## Invariants to verify

- `BL-LOY-009` — loyalty-currency lines earn zero → `MSN-029`
- `BL-LOY-015` — per-entity attribution of a many-entity settlement (**VIOLATED**) → `MSN-033`
- `BL-LOY-007` — dedup by (objectType, objectId, operationType) → `MSN-021`
- `BL-ORD-009` — order status is an admin-editable dictionary, not a fixed enum → gap-4 framing
- `BL-B2B-004` — approval is quote-based; **do not assert a native order-approval workflow**

## Integration seams with VCST-5346 (sibling, In progress)

- **`currencyCode` argument coupling — the live one.** `da8abc6` mitigates VCST-5842 via `mission.MissionCurrencyCode ?? context.GetValue("currencyCode")`, but the argument is **optional** (`Argument<StringGraphType>`, `:50`) while `StoreId` is `NonNullGraphType` (`:45`). If the storefront omits it, a PerSku mission resolves null and the page blanks → **`MSN-031`**.
- Frontend treats any `errors[]` entry as fatal for the whole response (VCST-5843), so one unresolvable product blanks all missions, not just the PerSku ones.
- No `IsCompleted`/`IsActive` fields means the frontend derives completion client-side — the source of the date-severity drift (VCST-5832).

## Findings needing no execution

Established from source at `da8abc6`; Step 5 must not re-derive them.

1. **`CustomerIDs` targeting does not exist** — zero hits in mission models, search criteria or the condition tree (only `UserGroupIsCondition` / `AnyUserGroupCondition`). AC-3 names it. Descope or gap — needs the author.
2. **Customer Mission Summary unmet as specified** — `CustomerId` not echoed on the row · `IsCompleted` has no DB column (only a `Status` string) · `IsActive` absent entirely · `OrderTotalValueCompleted`/`OrderQuantityCompleted` collapsed into a shared `currentValue` · `SkusCompleted` reshaped to `items[]` · `CompletedPercentage` → `percentage`. Six of nine.
3. **Periodicity is decorative** — accepted, never branched on; "per mission period" is load-bearing in all three goal-type ACs.
4. **`Mission.Public` is inert** — declared, never set by any server path, despite the dev comment marking that decision resolved.
5. **No organization dimension** — `LoyaltyMissionProgress` is `MissionId` + `UserId`; zero `organization` hits in the mission path; `loyaltyMissionProgress` takes no `organizationId`. A new org member inherits nothing and org purchasing never aggregates. **A PO question, not a test** — asserting org aggregation would assert a capability the platform never claimed (`BL-B2B-004` violation signal).

## Accepted gaps

- **gap-4 (order-status gate)** — uncovered; needs an `MSN_E2E_STATUSGATE` fixture. Same position on the sibling session's side.
- **`BL-LOY-015` has no citing case** (`BLC-004`, open by design) — the invariant describes a platform capability gap; a case asserting "attribution is impossible" would assert the absence of an API, not a behaviour.

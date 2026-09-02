# VCST-5319 — Missions: goal-driven loyalty campaigns you author in Admin

**Module:** `VirtoCommerce.Loyalty` `3.1006.0-pr-14-da8a`

### What changed

You can now build **Missions** in the Loyalty module — campaigns that watch a customer's orders and
award points automatically when a goal is met. Turn them on per store with the **Missions enabled**
setting, then author each mission with a goal type, an active window, an audience and a reward.

### What you can now do

Click **Loyalty** in the main menu → **Missions** → **Add**.

| Field | What it does | Example |
|---|---|---|
| Goal type | Which order fact drives progress | `OrderCountGoal` — counts placed orders |
| Target | The value that completes the mission | `2` |
| Start / End date | Bounds the window in which orders count | `2026-09-01` → `2026-09-30` |
| Audience | Customer group the mission is offered to | a customer group |
| Reward | Points credited once, on completion | `501` |

Progress and the credit are both persisted server-side: after the customer's first order the mission
reads `1 of 2 · InProgress`; after the second it reads `2 of 2 · Completed` and exactly one `Earned`
ledger row of `501 PTS` appears on their balance.

### Known limitations

- **Order-value goals include shipping and tax.** `OrderValueGoal` accrues the order total, not
  merchandise value — a $45 order with $150 shipping and $39 tax advances the goal by `234`.
- **Save validation is incomplete.** A negative reward amount and an End date earlier than the Start
  date are both accepted.
- **Per-customer targeting is not available.** Missions target a customer group; an explicit customer
  list is not supported.
- **Mission periodicity is not applied.** The setting is accepted but progress does not reset per
  period.
- **`Public = false` does not hide a mission.** The flag is stored but not enforced on read.
- **Cancelling or refunding an order does not reverse mission progress**, the completion status, or
  the points already credited.

---
*Verified on vcst-qa @ Platform `3.1061.0`, `VirtoCommerce.Loyalty_3.1006.0-pr-14-da8a` (`da8abc6`) ·
Evidence: `reports/tickets/Sprint26-17/VCST-5319/`*

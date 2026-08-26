# Rep-shared wishlist is accepted but grants the customer's organization no access at all — [High]

**Env:** vcst-qa @ Platform 3.1061.0, Theme 2.56.0 (`vc-module-x-cart` 3.1030.0)

## Summary

A Sales Rep can share a wishlist with a customer organization — `changeWishlist(scope: "Customer",
sharedWithId: <orgId>)` returns 200 with `sharingSetting { access: "Write" }` and no errors. But a
member of that exact organization then sees nothing: the list is absent from their own
`wishlists()` result, and both `wishlist(listId)` (read) and `removeWishlistItem` (edit) return
`Access denied.` The share is persisted and reported as granted, yet grants nothing.

This is the whole customer half of VCST-5335, whose AC reads *"if the Rep shares with my
organization … See this list in my shopping lists with the sign it was recommended by my Rep …
Lists can be edited."* Both VCST-5332 and VCST-5335 are **Done**.

## STR

Starting from an authenticated Sales Rep (`SALES_REP`) and a buyer in Acme
(`ACME_BUYER`, live `me.contact.organizationId` = `105c2c4e-23be-4258-8691-568a0ff190be`):

1. As the rep, `createWishlist(storeId, userId: <repId>, listName: "…")` → capture `listId`.
2. `addWishlistItem(listId, productId, quantity: 1)` → 1 item.
3. Share it with the buyer's organization:
   ```graphql
   mutation { changeWishlist(command: {
     listId: "<listId>"  scope: "Customer"  sharedWithId: "105c2c4e-23be-4258-8691-568a0ff190be"
   }) { id scope sharingSetting { sharedWithId scope access isOwner } } }
   ```
   → **200**, `errors: []`, `scope: "Customer"`, `sharingSetting { sharedWithId: "105c2c4e-…",
   scope: "Customer", access: "Write", isOwner: true }`.
4. Re-auth as `ACME_BUYER`, then `wishlists(storeId, userId: <buyerId>)`.
5. Also `wishlist(listId: "<listId>")` and `removeWishlistItem(listId, lineItemId)`.

## Expected vs Actual

| | Expected (VCST-5335) | Actual |
|---|---|---|
| Step 4 — buyer's own lists | shared list present, `sharingSetting.isOwner: false` | `wishlists.totalCount: 0`, `items: []` |
| Step 5 — buyer reads it | list returned | `errors: ["Access denied."]` (`Forbidden`), `data.wishlist: null` |
| Step 5 — buyer edits it | edit succeeds (`access: "Write"`) | `errors: ["Access denied."]`, `data.removeWishlistItem: null` |

## Alternatives ruled out

- **Wrong fixture org.** The buyer's live `organizationId` is byte-identical to the `sharedWithId`.
- **`sharedWithId` wants a user/contact id, not an org id.** Sharing with the buyer's *user* id is
  **rejected** (`changeWishlist` → `Access denied.`); the org id is accepted. The server itself
  treats the org id as the valid form.
- **`scope` literal casing** (`"Customer"` vs `"customer"`). The server echoed `"Customer"` back in
  both `changeWishlist.scope` and `sharingSetting.scope`.
- **Flaky / one build.** Reproduced identically on 2026-08-25 (`REG-2026-08-25-1128`) and
  2026-08-26 (`REG-2026-08-26-1600`), different list ids each time.

## Not affected

Cross-org isolation holds — a member of a *different* org (`TECHFLOW_BUYER`) correctly does not see
the shared list. No data leak.

## Possibly related

One `POST /graphql` in the same window returned **HTTP 500** carrying
`VirtoCommerce.Xapi.Core.Security.Authorization.AuthorizationError` ("Access denied.") from
`XCart.Data.Schemas.PurchaseSchema.AuthorizeAsync:1746` — an authorization denial escaping as a
server error instead of a GraphQL `errors[]`. Every denial in the STR above returned 200 +
`errors[]`, so a different code path is involved. Not attributable to a specific call (telemetry
carries no GraphQL operation name).

## Refs

Cases WISH-33 / WISH-34 (`regression/suites/Backend/graphql/050h-graphql-wishlist.csv`) ·
VCST-5332, VCST-5335 · evidence
`reports/regression/REG-2026-08-26-1600/graphql-evidence/WISH-3{3,4}-*.json` plus the `VERIFY-*`
discriminators in the same folder.

---
domain_slug: ucp
applicability: universal
rationale: |
  UCP (Universal Commerce Protocol) is the agentic-commerce adapter: it exposes Virto Commerce
  catalog/cart/checkout/order capability to an AI client (Claude, ChatGPT, any UCP-compliant agent)
  over Model Context Protocol + a REST twin, and hands the shopper back to the existing storefront to
  pay and place the order. First domain map for this feature — no prior BA analysis or domain map
  existed (`reports/ba/`, `.claude/knowledge/domain/` both had zero `ucp` hits before this pass) — and
  existing QA coverage is a single 23-case telemetry suite, so this map is the first place the feature's
  actual mechanism (buyer-identity resolution, the mint/redeem handoff, the doc-vs-build auth contract)
  is written down at all.
generated: 2026-09-16
rev: 1
stale_after_days: 60
expires_after_days: 120
sources:
  - none (no prior BA analysis, no prior domain map — confirmed by grep over reports/ba/, reports/tickets/**, .claude/knowledge/domain/, .claude/knowledge/oracles/business-logic.md, 2026-09-16)
  - live enumeration on vcst-qa (BACK_URL https://vcst-qa.govirto.com, FRONT_URL https://vcst-qa-storefront.govirto.com), 2026-09-16 — /.well-known/ucp, /.well-known/oauth-protected-resource/ucp/mcp, MCP initialize+tools/list+tools/call (search_products, create_cart, resolve_country, get_store_capabilities, checkout_and_handoff x3, handoff/restore x5, create_cart with X-Buyer-User-Id x2), one playwright-edge browser navigation to a live continue_url
  - VirtoCommerce/vc-module-ucp PR #7 "VCST-5378: Add authenticated buyer flow" (open/unmerged, dev branch feat/VCST-5378-unified-buyer-flow @ 18816231, artifact VirtoCommerce.UCP 3.1006.0-pr-7-1881, deployed on vcst-qa) — README.md, module.manifest, ModuleConstants.cs, UcpBuyerContextAccessor.cs, UcpMcpBuyerAuthenticationMiddleware.cs, UcpMcpIdentityTools.cs, UcpOAuthMetadataController.cs, UcpCheckoutService.cs, UcpCartService.cs (partial)
  - VirtoCommerce/vc-frontend PR #2467 "feat(VCST-5378): support authenticated UCP handoffs and storefront OAuth" (open/unmerged @ 8f0bff22, deployed on vcst-qa) — authorize.vue, router/index.ts, router/routes/{main,checkout}.ts, shared/checkout/ucp/{handoff,continuation}.ts
  - VirtoCommerce/vc-platform PR #3108 "VCST-5378: Support OAuth resources and storefront login" (open/unmerged @ 016f4d9c, deployed on vcst-qa as platform 3.1071.0-pr-3108-016f) — full diff read (AuthorizationController.cs, AuthorizationOptions.cs, OAuthAppsController.cs, appsettings.json, Startup.cs, tests)
  - VirtoOZ MCP, PlatformDeveloperGuide, queried first-hand 2026-09-16 (quotes verbatim in §3) — Fundamentals/UCP/{overview,mcp-server,web-api,configuration,quickstart}, Configuration-Reference/appsettingsjson
  - reports/bugs/rejected/BUG-ucp-checkout-address-502.md (2026-07-22, UCP PR #4 build) — live-reproduced-CLOSED this pass, see §3/§6
  - config/test-suites.json + regression/suites/Backend/ucp/094-ucp-observability.csv (23 cases)
excludes: >
  payment execution and order placement (owned by storefront checkout + payment modules, out of UCP's
  own responsibility by design); dynamic OAuth client registration (not implemented); a full live
  authenticated-buyer / OAuth consent walkthrough (needs a registered OAuth client with a matching
  `rsrc:` permission — a write action against Platform's OAuth-application registry not taken in this
  read-only pass, see G1); the production Virto Cloud routing topology the module's own README
  documents (storefront-proxies-`/ucp`-to-platform) — vcst-qa instead exposes `/ucp/mcp` directly on the
  platform host, which is a materially different topology from what the docs assume (see D2); Admin SPA
  UCP-specific surfaces beyond what a discovery pass turned up (see G5).
---

# UCP (Universal Commerce Protocol) — domain map

> Refresh with `/qa-domain-map ucp`. This file answers **what the feature is and where its surfaces
> are**. It does **not** carry behavioural rules — those are `BL-*` in `oracles/business-logic.md`
> (none exist yet for this domain) — and it can **never ground an assertion as `{DOC}`**. Pointer index
> plus surface inventory: it says *where to look* and *what exists*, never *what correct looks like*.

**Every claim carries a verdict.** `CONFIRMED` = observed live or read at source this pass ·
`DRIFT` = prior art says otherwise and prior art is wrong · `MISSING` = documented, does not exist ·
`UNVERIFIED` = not established, and **not** to be treated as true.

---

## §1 — Purpose and value chain

**Purpose:** UCP lets any UCP-compliant AI agent discover, browse, and check out a store through one
verified MCP/REST endpoint, in place of a bespoke integration per agent surface; the store stays the
merchant of record and keeps its own checkout, customer data, and pricing (`CONFIRMED` — README.md and
VirtoOZ `PlatformDeveloperGuide` overview page **agree** on this "what", verbatim: *"UCP lets any
compliant AI agent discover, browse, and check out a store through one verified endpoint... The store
stays the merchant of record, keeping its own checkout, customer data, and pricing rules."* They sharply
**disagree** on the "how" of buyer authentication — see D1, the map's highest-value row).

| # | Link, in the agent/shopper's words | Mechanism |
|---|---|---|
| 1 | The agent finds the installation | `GET /.well-known/ucp` (thin, anonymous) or MCP `initialize` at `/ucp/mcp` (rich system-instructions string). `CONFIRMED` live 2026-09-16 — see D4 for how thin |
| 2 | The agent browses the catalog | `search_products` / `get_product` → in-process XCatalog GraphQL via `IXApiInProcessExecutor`, no extra HTTP hop. `CONFIRMED` live: an anonymous `search_products("bolt")` returned a real priced, available product on `B2B-store` |
| 3 | The agent assembles a cart | `create_cart` / `update_cart` → XCart `addItem`/`changeCartItemQuantity`/`removeCartItem`/`addCoupon`/`removeCoupon`, UCP-replacement semantics (client states the *desired final* line-item set, the adapter computes the diff). An anonymous buyer gets a synthetic `ucp-anonymous-<32hex>` id. `CONFIRMED` live — minted `ucp-anonymous-5a5a2a207ee54a7a87b4174002f58aac` |
| 4 | *(optional)* The agent links the shopper's real account | `link_buyer_identity` tool → 401 + `WWW-Authenticate: Bearer ... resource_metadata=...` → MCP client completes Platform OAuth (authorization code + PKCE, `resource` = the exact `/ucp/mcp` URL) → every later tool call on that connection carries a Platform bearer whose `sub`/`organization_id` claims become the buyer/org context; an existing anonymous cart is optionally folded in via `update_cart` → XCart `mergeCart`. `CONFIRMED` at source (`UcpMcpIdentityTools.cs`, `UcpBuyerContextAccessor.cs`, `UcpCartService.MergeAnonymousCart`); **the live OAuth round trip itself was NOT exercised this pass** — no pre-registered OAuth client was available without a write action (G1) |
| 5 | The agent prepares checkout | `create_checkout` / `update_checkout` → `shipping_address`/`billing_address` (if supplied) applied to the **same cart** via XCart `addOrUpdateCartAddress` (+`addOrUpdateCartShipment`/`addOrUpdateCartPayment`) → an `incomplete` checkout snapshot. `CONFIRMED` live end-to-end, no error — see §6 for the historical bug this closes |
| 6 | The agent hands off to the storefront | `checkout_and_handoff` / `handoff_checkout` → mints a 32-byte random token, SHA-256-hashes it as a distributed-cache key, stores `{cart_id, checkout snapshot, addresses, buyer/org, expiry}` with a 15-minute absolute TTL (`UCP:HandoffTokenTtlMinutes`), returns `continue_url = "{storefront}/checkout?ucp_session={token}"`. `CONFIRMED` live |
| 7 | **THE ASYNC HOP — the shopper opens the link in a real browser, a separate process from the one that minted it** | The storefront's global router rewrites `?ucp_session=<raw token>` to `?ucp_resume=<opaque UUID>` on the very first navigation tick, storing the raw token only in tab-local `sessionStorage` (so it never survives into browser history or an OAuth redirect chain). The `/checkout` route then `POST`s the raw token to `/ucp/v1/internal/handoff/restore`, which reads-and-deletes the cache entry under a distributed lock (single-use) and redirects to `/cart/{cartId}?ucp_handoff=1`. **This redeem step is unreliable on vcst-qa** — see D2. Nothing in the mint step (`checkout_and_handoff`'s response) distinguishes a token that will redeem from one that won't |
| 8 | If the shopper is already signed in, their pre-existing cart absorbs the anonymous one | The storefront's **own** `mergeCart` GraphQL mutation (a second, independent caller of the same XCart mutation UCP itself calls in step 4's linked-cart path). `CONFIRMED` at source (`checkout.ts` `restoreHandoff`) |
| 9 | The shopper pays and places the order | Entirely inside the existing storefront checkout wizard (shipping method, payment, place order). **UCP's responsibility ends at step 7/8** — it does not implement payment execution or order placement (`CONFIRMED`, README + all three PR bodies, stated explicitly and repeatedly) |
| 10 | The agent (or shopper) checks on the order later | `track_order` → looks up `CustomerOrder` by `ShoppingCartId` (the agent usually has no `order_id` yet), scoped to the resolved buyer/organization context. `CONFIRMED` at source + README |
| 11 | *(reversal)* | **None observed.** No cancel/refund/revoke tool or endpoint exists anywhere in the 17-tool surface or the REST twin. See "Reverse edges" below |

### Reverse edges

UCP mints two forward effects with real consequence: (a) a **cart** (persisted VC commerce state) and
(b) a **handoff session** (a redeemable, TTL-bound cache entry that stands in for "checkout is ready").
Neither has a UCP-native reversal:

- **The handoff session self-expires** (15 min TTL) and is **consumed on first successful redeem**
  (`CONFIRMED` live — a second `restore` call against an already-redeemed token returns the same
  `ucp_session is invalid or expired`, HTTP 400, as an unminted one). That is a time/single-use bound,
  not a cancel — there is no `cancel_checkout` / `void_handoff` tool an agent could call to invalidate a
  `continue_url` it just decided not to send to the shopper.
- **The cart itself has no UCP-native delete/cancel tool.** `create_cart`/`update_cart` only ever grow or
  replace line items; nothing in the 17-tool surface removes a cart. Whatever cart lifecycle/cleanup
  exists is entirely the underlying XCart module's own (out of this map's scope), invisible to and
  unreachable from an agent that only has UCP tools.
- **Order cancellation/return is absent from the tool surface entirely** — `track_order` is read-only.
  A shopper who wants to cancel after checkout must do so through the ordinary storefront/Orders-module
  path, not through the AI agent that helped them buy.

**This absence is itself the finding, not a blank**: an agent conversation that creates several
abandoned carts and several unredeemed handoff sessions has no UCP-native way to clean any of it up.

### Actors

| Actor | Can do | Verdict |
|---|---|---|
| **AI agent / MCP client** (Claude, ChatGPT, any UCP-compliant client) | Every commerce tool, anonymously, with no identity at all by default | `CONFIRMED` live |
| **Anonymous shopper** (the human at the far end of the handoff) | Identified only by the opaque `ucp-anonymous-*` id baked into the cart at mint time; browser session carries no cookie/token linking it to that id until `applyUcpHandoffBuyer` writes it to `localStorage` | `CONFIRMED` source + live |
| **Authenticated Platform buyer** (B2C or B2B-org) | Reached only via `link_buyer_identity` + Platform OAuth; buyer_id/org_id come **exclusively** from the JWT `sub`/`organization_id` claims — client-supplied buyer/org fields are validated to *match*, never trusted to *set* | `CONFIRMED` at source (`UcpBuyerContextAccessor.ResolveAuthenticated`); **not exercised live** (G1) |
| **Platform OAuth/OIDC authorization server** (OpenIddict, in `vc-platform`) | Owns login, consent, PKCE, resource-scoped token issuance/refresh; UCP itself never issues or validates a token beyond an audience-string match in its own middleware | `CONFIRMED` at source (PR #3108) |
| **Merchant storefront** (`vc-frontend`) | Consumes the handoff, hosts the OAuth login continuation page (`/oauth/authorize`), executes payment and order placement | `CONFIRMED` at source + live |
| **Module operator/administrator** | Configures `UCP:*` appsettings and, on the platform side, `Authorization:Resources` / `Authorization:OAuthLoginPath`; also owns the OAuth application's `rsrc:<uri>` permission grant | `CONFIRMED` at source; the Admin-SPA-side experience of this was not walked live (G5) |

---

## §2 — Surface inventory

### 2a. Platform layer (`vc-platform`, OAuth/OIDC)

| Surface | Address | Notes |
|---|---|---|
| Resource registration | `Authorization:Resources[]` (appsettings array) | Absolute resource URIs OpenIddict will accept as an `aud`/`resource` value; a client also needs a matching `rsrc:<uri>` permission. `CONFIRMED` source (`AuthorizationOptions.cs`, `Startup.cs` `RegisterResources`) |
| Storefront-hosted login opt-in | `Authorization:OAuthLoginPath` (appsettings string, `null`/disabled by default) | When set (e.g. `/oauth/authorize`), OAuth clients are challenged to the **public storefront**'s login instead of Platform's own `/connect/authorize` login page. `CONFIRMED` source + live (vcst-qa's storefront ships `/oauth/authorize`, so this is presumably enabled there — not directly read from live appsettings this pass) |
| Token exchange | `POST /connect/token` | Now enforces `GetResources().Except(info.Principal.GetResources())` on a refresh/code exchange — asking for a resource outside the original grant returns `400 invalid_target`. `CONFIRMED` source |
| Storefront session bootstrap | `GET /connect/session`, `POST /connect/session` | Only live when `OAuthLoginPath` is set. `GET` issues an antiforgery `RequestToken`; `POST` validates same-origin + antiforgery + a `returnUrl` matching `^/connect/authorize\?[^#]*$` (no fragment) + a first-party `resource_server`-audienced, non-client, non-impersonated, sign-in-eligible token, then signs in a **non-persistent** Identity cookie capped at 5 minutes **and** the token's own expiry, scoped to that one authorize continuation. `CONFIRMED` source, with a matching unit-test file (`OAuthSessionTests.cs`) covering every rejection branch |
| Authorize / consent | `GET/POST /connect/authorize`, `POST` `submit.Accept`/`submit.Deny` | `Accept`/`Deny` now carry `[ValidateAntiForgeryToken]` (new); `Accept()` re-authenticates via the Identity cookie rather than trusting the ambient `User` principal directly. `CONFIRMED` source |
| Revoke | `POST /revoke/token` | When `OAuthLoginPath` is set, also signs out the Identity-cookie scheme so the short-lived consent cookie doesn't outlive the token. `CONFIRMED` source |
| OAuth application admin | existing generic "OAuth applications" REST (`OAuthAppsController`) | `Save` used to `Permissions.Clear()` on every save, silently dropping any `rsrc:` grant; now preserves `rsrc:`-prefixed permissions across a save. `CONFIRMED` source (fixed in this same PR — a footgun for whoever administers the UCP OAuth client, not itself a UCP surface) |
| Admin SPA | — | **Not manageable from a UCP-specific blade** — no such blade was located this pass; OAuth-application administration goes through the platform's existing generic UI. Not exhaustively walked (G5) |

### 2b. Module layer (`vc-module-ucp`)

| Surface | Address | Guard / notes |
|---|---|---|
| Discovery | `GET /.well-known/ucp` | `[AllowAnonymous]`. Live shape is **much thinner** than documented — see D4 |
| MCP protected-resource metadata | `GET /.well-known/oauth-protected-resource/ucp/mcp` | `[AllowAnonymous]`. Live: `{resource, authorization_servers, bearer_methods_supported, scopes_supported, resource_name}` — the `bearer_methods_supported` field wasn't seen in the one controller file read (`UcpOAuthMetadataController.cs` only sets the other four); the DTO itself (`UcpProtectedResourceMetadata.cs`) wasn't opened — `UNVERIFIED` source (G6) |
| MCP endpoint | `POST/GET /ucp/mcp` | Stateless Streamable HTTP (official C# MCP SDK). Guarded by `UcpMcpBuyerAuthenticationMiddleware`: strips any authenticated identity when no bearer header is present; on a bearer header, requires the token's `aud` to match this exact origin+path; sniffs the raw JSON-RPC body for a `tools/call` naming `link_buyer_identity` to decide whether an authenticated buyer is *required* before forwarding |
| MCP tools | 17, **`CONFIRMED` live via `tools/list` 2026-09-16**: `get_store_capabilities`, `search_products`, `get_product`, `create_cart`, `list_carts`, `get_cart`, `update_cart`, `create_checkout`, `update_checkout`, `checkout_and_handoff`, `get_payment_handlers`, `handoff_checkout`, `list_countries`, `resolve_country`, `list_regions`, `track_order`, **`link_buyer_identity`** | See D3 — the module's own `ModuleConstants.McpTools.UcpToolNames` set (used for `IsUcpTool()` scoping) lists only 16, excluding `link_buyer_identity` |
| REST twin | `/ucp/v1/{catalog/search, catalog/products/{id}, carts, carts/{cartId}, checkouts, checkouts/{checkoutId}, checkouts/{checkoutId}/payment-handlers, checkouts/{checkoutId}/handoff, orders/{orderId}, orders?cart_id=, geography/countries[/resolve], geography/countries/{id}/regions}` + `/ucp/v1/internal/handoff/restore` | Same buyer-context-accessor guard applies wherever a service resolves buyer context (every cart/checkout/order op); catalog + geography are anonymous-friendly by default (`UCP:AnonymousCatalog=true`) |
| Settings | `UCP.Enabled` (bool, default `false`, group `UCP\|General`) | README states explicitly: *"not yet enforced by the current preview endpoints"* — live toggle-and-retest not performed (G3) |
| Permissions | `ucp:access`/`create`/`read`/`update`/`delete` | Reserved for administrative capabilities the module does not yet expose through any blade — effectively inert today per README |
| Not manageable from this layer | — | No UCP-native cart/handoff cancellation (see Reverse edges); no dynamic OAuth client registration; no per-store enable/disable beyond the single global `UCP.Enabled` setting |

### 2c. Storefront layer (`vc-frontend`)

| Surface | Address | Notes |
|---|---|---|
| OAuth login continuation page | `/oauth/authorize` (route name `OAuthAuthorize`, `meta.requiresAuth: true`) | On mount: validates `returnUrl` matches `^/connect/authorize\?[^#]*$`; `GET /connect/session` for an antiforgery token; `POST /connect/session` with that token + `returnUrl`; on success, hard-redirects (`location.replace`) to the validated `returnUrl`. A 401 bounces to sign-in with `reauthenticate=1`; any other failure renders a local "authorization failed" empty-page. `CONFIRMED` source |
| Global handoff-token interception | `router/index.ts` `beforeEach` | Any `Checkout`-matched route carrying `?ucp_session=<raw token>` is **immediately** rewritten to `?ucp_resume=<opaque UUID>`, with the raw token stashed only in tab-local `sessionStorage` (`continuation.ts`) — so the secret never persists in browser history or travels through a sign-in/external-IdP redirect chain. `CONFIRMED` source |
| `/checkout` handoff consumption | `router/routes/checkout.ts` `beforeEnter` (on `to.query.ucp_resume`) | Reads the stashed token, `POST`s it to `/ucp/v1/internal/handoff/restore` (retries once with a refreshed auth header on a 401), applies the returned anonymous buyer id to `localStorage`+app globals if the visitor isn't already signed in, and — if they ARE signed in — merges the restored cart into their own via the storefront's **own** `mergeCart` GraphQL mutation (independent of UCP's identity-linking merge path, same target mutation). Redirects to `/cart/{cartId}?ucp_handoff=1` on success |
| Failure UX | same `beforeEnter` | 401 → sign-in redirect with `reauthenticate=1` (no user-visible error, by design — a fresh sign-in is expected to resolve it); 403 → localized `common.ucp.wrong_account` notification + sign-in redirect; 400/other → localized `common.ucp.expired` / `common.ucp.restore_failed` + redirect to `/cart`. `CONFIRMED` source, and the `common.ucp.*` keys exist in all 12 shipped locale files, not just `en.json` |
| Not manageable / not visible from this layer | — | Nothing surfaces the `ucp_session`/`ucp_resume` mechanics to the shopper at any point — by design, it is redirect-only. Nothing on the storefront lets a signed-in shopper see "an AI agent started this cart for me" as a distinct fact; it merges in silently |

---

## §3 — Where the layers DISAGREE

Six rows. **D1 and D2 are the two that matter most** — one is customer-facing and wrong today, the
other is the single biggest functional risk in the whole feature and is invisible to the one suite that
exists.

| # | Disagreement | Verdict |
|---|---|---|
| **D1** | **The published Platform Developer Guide documents an authentication model the deployed build actively rejects.** VirtoOZ `PlatformDeveloperGuide` ("Fundamentals/UCP/overview", Architecture + Key Features sections), fetched first-hand 2026-09-16: *"Buyer delegation is header-based, through the following headers: `X-Buyer-User-Id`, `X-Buyer-Organization-Id`. The service adds buyer claims to the principal used for xAPI execution."* — and its Key Features bullet: *"Buyer context propagation: header-based B2B buyer delegation through `X-Buyer-User-Id` and `X-Buyer-Organization-Id`."* Its own roadmap note adds: *"New UCP features are coming soon: ... OAuth2 or OIDC buyer delegation"* — i.e. the docs describe OAuth linking as **not yet built**. Live 2026-09-16, sending `X-Buyer-User-Id: some-user-42` on `create_cart` against vcst-qa returns `isError:true`, `code:"buyer_context_mismatch"`, `status_code:403`, message *"X-Buyer-\* headers are not accepted. Use Platform OAuth or an anonymous buyer_id."* Source confirms: `UcpBuyerContextAccessor.RejectLegacyBuyerHeaders()` (`VirtoCommerce.UCP.Data/Services/UcpBuyerContextAccessor.cs`) throws on either header, unconditionally. **The OAuth linking the docs call "coming soon" is the exact mechanism already deployed** (`link_buyer_identity`, PR #7/#2467/#3108). Anyone integrating from today's published docs sends the documented headers and gets a hard 403 on every buyer-scoped tool call. The module's own `module.manifest` `<releaseNotes>` field documents its 502→200 and JSON-RPC→isError breaking changes explicitly but says **nothing** about the header removal, so even the module's own self-reported changelog doesn't flag this | **`CONFIRMED`** on all three axes — `{DOC}` verbatim quote + `{OBSERVED}` live 403 + source citation |
| **D2** | **The handoff mint always reports success; the redeem is non-deterministic on this environment.** Five live reproductions 2026-09-16, identical steps each time (mint a fresh `continue_url` via `checkout_and_handoff`, redeem it via `POST /ucp/v1/internal/handoff/restore` well inside the 15-minute TTL): **2 clean failures** — `{"code":"invalid_request","message":"ucp_session is invalid or expired."}`, HTTP 400, on a token used for the very first time, seconds after mint — and **3 successes** (one confirmed via a genuine `playwright-edge` browser navigation to the published `continue_url`, matching a real shopper's path). `checkout_and_handoff` itself never varies: it always returns `status:"success"` and a syntactically valid `continue_url`, with no signal distinguishing a redeemable token from a doomed one. README/docs explicitly flag the mechanism this matches: *"The module registers `AddDistributedMemoryCache()` as a fallback, so handoff works without Redis in local or single-node deployments. In production multi-node deployments, the platform distributed cache should be Redis-backed so handoff restore works across nodes."* Whether vcst-qa's actual cache backing is per-pod memory or shared Redis is `UNVERIFIED` (G2), but the failure signature — an immediate miss on a brand-new key, intermixed with successes on identically-shaped requests — is exactly what per-pod memory plus non-sticky routing produces. **This is the single highest-value coverage gap in the domain**: it sits exactly on the "it worked when I checked" vs. "it never worked" line the async-hop framing warns about, and the one existing suite (094, pure telemetry) does not touch it at all | **`CONFIRMED` live 2026-09-16** (reproduction log above); root cause `UNVERIFIED` (G2) |
| **D3** | **The tool the live server advertises and the tool set the module's own scoping/redaction logic recognizes disagree by one.** `tools/list` against `/ucp/mcp` returns 17 tools including `link_buyer_identity` (`CONFIRMED` live). `ModuleConstants.McpTools.UcpToolNames` — the `HashSet` `IsUcpTool()` checks, and the exact population the README's Observability section names verbatim ("For the 16 UCP tools, an incoming MCP message filter keeps the `Error` status but replaces that description...") — lists only the original 16 and **excludes** `link_buyer_identity`. Consequence, straight from the README's own description of what that scoping controls: the status-description sanitizer that bounds a failing tool's error content to "UCP tool returned an error." applies to the 16, not to identity-linking — the one tool call that touches a live OAuth handshake | **`CONFIRMED` at source** (`ModuleConstants.cs` + `UcpMcpIdentityTools.cs`) **+ live tool count** |
| **D4** | **Discovery is a fraction of what both the docs and the module's own richer tool describe.** VirtoOZ `PlatformDeveloperGuide` "Web API > Discovery": *"The profile includes supported capabilities, default store metadata, endpoint metadata, headers, auth shape, integration guidance, payment handlers, and structured error codes."* Its own Quickstart walks an integrator through checking, in the discovery response, `default_store_id`, store currency/language/URL, `mcp_tools`, and `endpoints.ucp_base_url` — before ever connecting an MCP client. Live `GET /.well-known/ucp` on vcst-qa 2026-09-16 returns only `{version, status, services, capabilities, payment_handlers:{}}` — no `default_store_id`, no `stores[]`, no `mcp_tools`, no `endpoints`, no `headers`/`auth`/`error_codes`. The richer shape genuinely exists — it's what `get_store_capabilities` (an MCP **tool**, reachable only after already connecting) returns. A pure pre-connection discovery client — the exact scenario the Quickstart walks — sees almost nothing on this build, and the Quickstart's own smoke-test steps would fail verbatim here | **`CONFIRMED`** live + `{DOC}` verbatim quote both axes |
| **D5** | **No store is ever flagged as the default when `DefaultStoreId` is unset — consistent with docs, but it silently defeats every AI-facing instruction that assumes one.** Live `get_store_capabilities` on vcst-qa returns 5 stores (`B2B-store`, `Electronics`, `QA-STORE`, `test_del`, `TS-FULL-001`), every one `is_default:false`. This matches the documented fallback (*"If multiple stores are found, discovery returns them in `stores[]` and the client must choose a store explicitly"*) — not itself a defect. But the module's own MCP system instructions tell the agent *"When store_id... [is] unknown, call `get_store_capabilities` first and use the returned store metadata"* and *"If this installation exposes multiple stores without a default, use an explicit `store_id`... or ask the user to choose"* — i.e. the contract already anticipates this, but on every real multi-store environment observed so far there is nothing to default to, and two of the five returned stores read as test fixtures (`test_del` = "Test delete store", `TS-FULL-001`) rather than anything a shopper should be offered | `CONFIRMED` live; **not a defect** per the docs' own stated fallback — recorded because it is the concrete shape an agent actually has to reason about on this env |
| **D6** | **The historical `addOrUpdateCartAddress` 502 (rejected bug, 2026-07-22, UCP PR #4 build) does not reproduce on the current build.** `reports/bugs/rejected/BUG-ucp-checkout-address-502.md` recorded `checkout_and_handoff` with a shipping address failing `xapi_execution_failed` / HTTP 502 on every attempt against `VirtoCommerce.UCP 3.1003.0-pr-4`. Live 2026-09-16 against `VirtoCommerce.UCP 3.1006.0-pr-7-1881` (this PR's own build), the identical shape of call — `checkout_and_handoff` with a full US shipping address — succeeds cleanly end-to-end (checkout snapshot, address applied, `continue_url` minted). Source still routes through the same `addOrUpdateCartAddress` XCart mutation (`UcpCartService.ApplyCheckoutData`), unchanged in this PR's diff | **`CONFIRMED` live 2026-09-16 — historical, now closed.** Recorded so a future pass doesn't re-open it without new evidence |

---

## §4 — Coverage shape

**One suite touches this domain at all: `094-ucp-observability.csv`** (`regression/suites/Backend/ucp/094-ucp-observability.csv`, 23 cases, backend/api, P2, agent `qa-backend-expert`, tags `ucp, observability, telemetry, mcp, appinsights, opentelemetry`). Its subject is exclusively telemetry — span names/nesting, sampling behavior, PII redaction, error-envelope shape (200-not-502, `isError` not JSON-RPC error), correlation-id joins. `config/test-suites.json`'s own note on the entry: 19 of the 23 cases are still `Draft`, 4 are `Manual` (need an isolated stand + appsettings restart), and it is *"Excluded from the backend/full selections until `/qa-test` 5g promotion."* `.claude/knowledge/execution/module-suite-map.md` has **zero** references to `ucp` — this suite isn't even indexed there. The given fact for this pass: `npm run tc:scope` matched **zero** cases against "the authenticated-buyer observables."

**What 094 asserts nothing about** — i.e. everything this map's §1–§3 actually cover:

- Buyer-context resolution correctness (D1's header rejection, the agent-vs-buyer collision check, the anonymous-id format/validation, `RequireAuthenticatedBuyer`)
- The mint→redeem handoff round trip's functional reliability (D2) — no case fires `checkout_and_handoff` then `restore` and checks the result
- Catalog/cart/checkout business correctness — prices, totals, coupon application, address normalization through `ICountriesService`
- The identity-linking flow end to end (`link_buyer_identity` → OAuth → resumed call → merge)
- Platform-side OAuth resource/audience enforcement (`Authorization:Resources`, the `invalid_target` refusal, the `/connect/session` bootstrap)
- Anything on the storefront layer — `/oauth/authorize`, the `ucp_session`→`ucp_resume` rewrite, the storefront's own second `mergeCart` path, the localized failure notifications

**Zero / near-zero coverage, and every instance of it here is a hole, not a deliberate exclusion** — the
feature is simply too new (deployed via three still-open, unmerged PRs) for coverage to exist yet.

---

## §5 — Open gaps

| # | Gap | State |
|---|---|---|
| **G1** | Live authenticated-buyer flow (`link_buyer_identity` → OAuth code+PKCE → a resumed tool call carrying real buyer/org claims) | **OPEN.** Needs an OAuth application registered with `Authorization:Resources`-matching `rsrc:<mcp-url>` permission, plus either a Claude/ChatGPT custom-connector session or a scripted authorization-code+PKCE walkthrough. Provisioning that OAuth application is a write action, out of scope for this read-only pass |
| **G2** | Root cause of the handoff-redeem intermittency (D2) | **OPEN.** Needs visibility into vcst-qa's actual `IDistributedCache` backing (per-pod memory vs. shared Redis) and/or a larger statistically-powered repeat run; not reachable through any UI surface this pass covered |
| **G3** | Whether `UCP.Enabled=false` (its documented default) gates anything live | **OPEN.** README states it is "not yet enforced by the current preview endpoints"; a live toggle-and-retest needs an Admin-SPA settings write, avoided this pass |
| **G4** | B2B organization-scoped buyer behavior (a linked buyer whose token carries `organization_id`) | **OPEN**, blocked on G1 |
| **G5** | Whether a UCP-specific Admin SPA blade exists beyond the generic Settings > Modules > UCP page and the generic OAuth-applications UI | **OPEN** — not exhaustively walked this pass |
| **G6** | The `UcpProtectedResourceMetadata` model's `bearer_methods_supported` field, present live but not seen in the one controller file read | **OPEN** — `UcpProtectedResourceMetadata.cs` itself was not opened |
| **G7** | Whether `search_products`/`get_product` surface organization-specific pricing once a buyer is linked | **OPEN**, blocked on G1 |

---

## §6 — Prior-art verdicts

**No prior art exists for this domain.** Confirmed by grep 2026-09-16 over `reports/ba/**`,
`reports/tickets/**` (the only `ucp` hits were false positives matching "back**up**"),
`.claude/knowledge/domain/**`, and `.claude/knowledge/oracles/business-logic.md` (zero `BL-UCP-*` or
`BL-CROSS-*` entries mentioning UCP). This is `rev: 1` with nothing to reconcile against.

The one thing worth recording as **settled** for the next pass: `reports/bugs/rejected/BUG-ucp-checkout-address-502.md`'s underlying mechanism no longer reproduces on the current build (D6) — a future pass should not re-derive that from scratch, but also should not assume it's fixed *because* it was filed as rejected; it's fixed because this pass re-ran the exact repro and it passed.

---

## §7 — Amendments

*(none yet — appended by `/qa-test` `5-docs-map` after a run verifies something against this map)*

| Date | By | What moved |
|---|---|---|
| — | — | — |

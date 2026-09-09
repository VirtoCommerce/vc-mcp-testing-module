# Testing Checklist — VCST-5317

**Ticket:** VCST-5317 — header org switcher, locked organization membership handling
**Env:** `{{BACK_URL}}` / `{{FRONT_URL}}` (vcst-qa) — `ProfileExperienceApiModule 3.1018.0-pr-145-4fe6`, Platform `3.1064.0`
**PRs (both OPEN / unmerged, code deployed to this env only):** `vc-module-profile-experience-api` **#145** · `vc-frontend` **#2469**
**Contradiction:** the ticket's title, Story paragraph, Context/Gap and Technical Notes all describe **HIDE**; the deployed build implements **SHOW-AND-FLAG** (row rendered, `disabled`, padlock, tooltip). This checklist verifies the **as-built** (SHOW) behaviour — a HIDE expectation fails every L5/L6 line by design, not by defect; the hide-vs-disable call is a product decision this run reports on but does not make.
**Test Model:** `reports/ba/test-models/VCST-5317-2026-09-09.md` (L1–L8 chain, V1–V10 variants, 17 scenarios) — cited, not restated.
**Traps to bake in:** omitted `storeId` on `/connect/token` → `user_cannot_login_in_store`, masks the org code (4.a/4.b/4.c). A **consumed** refresh token fails code-less `invalid_grant`, easily mistaken for the org refusal (4.a). Never assert on the token response's `count` field — parameter count, not error count, `BL-AUTH-013` (4.a/4.b). 60s cache floor on the top-level membership read (`AbsoluteExpirationRelativeToNow = 1 min`) — any expiry line needs that settle or is flaky by construction (3.a/3.b/G8). **Settle after a passive lock expiry: ~2 min on the xAPI `isLockedForCurrentUser` flag** (measured: flag flipped at t+9 s) — and **never assert on the REST `onlyLocked` search after a passive expiry**: its cache is region-token-only with no time bound and still reported the row locked at t+162 s. The 60 s `AbsoluteExpirationRelativeToNow` bounds `GetLockedOrganizationIdsAsync` ONLY, not every read path.

## L1 — Lock write + session kill
- [ ] G2 — Lock lands on the user's **active** org mid-session → expect **all sessions terminated globally** (`RevokeTokenOrganizationMembershipChangedEventHandler` → `TerminateAllUserSessions`), not just the locked org's; user must re-authenticate, and the still-unlocked sibling org remains reachable after re-auth (session dies, account doesn't — `BL-AUTH-012` survives, the session does not). Folds in `UIP-TABS`: two tabs open, lock lands between them — expect both evicted, not just the tab that triggers the read. `{BL}` BL-AUTH-012

## L2 — xAPI list membership
- [ ] 2.a — `me { contact { organizations(first: 50) { totalCount items { id name isLockedForCurrentUser } } } }` returns `errors[]: []`, `@td(MULTI_ORG_TF_BR.email)` (backend lane). `{SPEC}` PR #145
- [ ] 2.b — `items[]` contains only orgs the caller holds a membership in; no foreign/other-user org id present. `{BL}` membership scoping
- [ ] 5.a — Lock user X in `@td(ORG_BUILDRIGHT.platform_id)` → user Y's switcher list (separate browser context, `@td(MULTI_ORG_TF_BR_ALT.email)`, frontend lane) is byte-identical to Y's pre-lock baseline. `{BL}` membership isolation
- [ ] G5 — Org-list query itself fails (`errors[]` non-empty or 5xx) → switcher degrades, header otherwise intact, no uncaught console exception. `{DOC}` ECL-10.2
- [ ] G6 — Lock filter/flag applies **before** paging — the locked org does not reappear on a later page; count assertions use `totalCount`, never rendered-row count (see `feedback_paged_count_vs_total_assertion`). `{SPEC}` extends `PRF-GQL-078`
- [ ] G13 — An org-scoped read **naming the locked org id directly** is refused server-side. **GROUNDED and REFUTED 2026-09-09 — no longer `{HYPOTHESIS}`.** Measured: `me.contact.organizationsIds` DOES return the locked id, but `organization(id: <locked>)` → `errors[0].extensions.code = Forbidden`, `data.organization` null — **and the discriminator: the same query against the unlocked ACTIVE org returns 200 with data**, so the refusal is lock-specific, not a blanket customer-principal denial. No claim-provider bypass reachable. `organizationsIds` is a **membership** list, not an **access** list. `{OBSERVED}` — **both legs are mandatory**; a lone Forbidden proves nothing. Carrier: `PRF-GQL-086`.
- [ ] G14 — The switcher's search input composes with the lock treatment (disabled row still appears/still flagged in filtered results), never bypasses it. `{HYPOTHESIS}`

## L3 — xAPI lock flag
- [ ] 2.c — Locked org's `isLockedForCurrentUser` is `true`; unlocked org's is `false`. Treat `undefined` as not-locked — nullability is inferred from the generated client type, not asserted from the backend schema; state that limit inline if it applies. `{SPEC}` OrganizationType.cs:55-60
- [ ] 3.a — Membership `IsLocked=true` with `LockoutEnd` **in the past** behaves as unlocked, no manual unlock — proves the read is `IsCurrentlyLocked`, not raw `IsLocked` (precedent: `VCST-5374`, regression-guarded by `PRF-GQL-080`). Needs the 60s settle window. `{BL}` OrganizationMembership.cs:22 **Reach V4 in ONE `/lock` call with a past `LockoutEnd` — no waiting.** Settle ~2 min on the xAPI flag, not 60 s; do not read the REST `onlyLocked` search here.
- [ ] 3.b — `LockoutEnd` within clock-skew of now → one of the two defined outcomes only, never a render error or a null row. `{BL}`
- [ ] G8 — Same expiry predicate re-asserted end-to-end through L3→L5, not just the flag: after a **~2 min settle on the xAPI flag** (NOT 60 s — see Traps), the row renders **enabled with no padlock** and render agreed with the flag at every sample. `{OBSERVED}` — measured 2026-09-09; this is a regression guard on currently-correct behaviour, not a hunt. **Do not assert on the REST `onlyLocked` search after a passive expiry** — it lagged to t+162 s and would false-FAIL. Carrier: `B2C-ORG-049` + `PRF-GQL-087`.

## L4 — Visibility gate
- [ ] 1.b′ — Rendered row count equals the user's **total** membership count (not the unlocked-only count). `{SPEC}` useUser.ts:382 + PR #145
- [ ] 6.a — All memberships locked → the switcher control is **still rendered** (gate reads unfiltered `totalCount`, not visible rows). `{SPEC}` useUser.ts:382
- [ ] G1 — 2-org user with exactly 1 locked does **not** lose the switcher (gate keys on total, not filtered count — this is the STALE-READ regression the model flags as a hypothesis to disprove). `{SPEC}` useUser.ts:382

## L5 — Row render
- [ ] 1.a′ — Both the unlocked and locked org are listed; the locked row carries the locked indicator (greyed out, padlock, tooltip), the unlocked row does not. `{SPEC}` PR #2469 diff
- [ ] 6.b — All memberships locked → every row renders disabled; record whether any empty-state copy exists and whether a console exception is thrown (AC-6 has no defined empty state through this path). `{SPEC}` PR #2469 + ContactType.cs
- [ ] G10 — Locked indicator is programmatically determinable (accessible name / `aria-disabled`), not colour-only; contrast holds on **Coffee and Red** themes only. Route the detailed audit to the visual lane (`ui-ux-expert`); a11y finding never blocks this story. `{BL}` BL-A11Y / a11y-gated-themes
- [ ] G11 — Locked label and any empty-state copy resolve from i18n keys; an untranslated key falls back to the default language, never the raw key. `{BL}` default-language fallback

## L6 — Click guard
- [ ] 1.c — Clicking the locked row does **not** switch; control is `disabled`, active org unchanged. **Never force a disabled control** (`VC-EXEC-003`) — the disabled state IS the validation working. `{SPEC}` PR #2469 top-header-organizations.vue
- [ ] G15 — **Mobile (≤500px): the earlier framing is REFUTED.** The hypothesis was tappable unguarded locked rows reaching L7; measured 2026-09-09 at 375 px **there are no rows at all** — the hamburger panel renders the current org as **non-interactive text** plus an account block (name / Logout / Purchasing), with **no `Organizations` listbox**. So the defect is a **missing capability** (a multi-org buyer cannot switch org on a phone, locked or not), not a missing guard. Enumerate the panel inventory per `VC-UI-002` (header controls re-mount) and assert the absence. `{OBSERVED}` — Carrier: `B2C-ORG-047`.

## L7 — Token refusal
- [ ] 4.a — In-session switch into the locked org, **non-`password`** grant, explicit `organization_id`, **freshly issued** refresh token → refused: `error: invalid_grant`, exactly one `errors[]` entry, `code: user_is_locked_in_organization`, active org unchanged. `{BL}` BL-AUTH-013
- [ ] 4.b — Single-accessible-org fixture, `password` grant naming the locked org → HTTP 400, same single code. `{BL}` BL-AUTH-013
- [ ] 4.c — Multi-org, `password` grant naming the locked org → **HTTP 200, no error**, active org = the accessible one. This is **correct** per `BL-AUTH-016` — assert it so a future "fix" that refuses outright is caught as a regression. `{BL}` BL-AUTH-016
- [ ] G3 — A refused switch surfaces org-specific copy, not the generic global-lockout message. `{HYPOTHESIS}`
- [ ] G7 — Single-org user whose only membership is locked → sign-in **succeeds with no org context** (`BL-AUTH-015`), not a refusal; account pages reachable post-login. `{BL}` BL-AUTH-015
- [ ] G9 — A membership both locked **and** at a blocking status → token layer returns the **lock** code (lock beats status); the two axes assert independently, never collapsed onto one indicator. `{HYPOTHESIS}`

## L8 — Sibling access preserved
- [ ] 6.c — All memberships locked → `/account/**` remains reachable, renders with no org context, no crash. `{BL}` BL-AUTH-015
- [ ] G12 — Eviction from a newly-locked **active** org resets cart / addresses / lists / pricing to the no-org-context baseline. `{BL}` BL-B2B-001

## Not covered by this checklist
- **Hide-vs-disable product decision** — explicitly out of scope per the Test Model ("the decision this model cannot make"); this run reports the SHOW-AND-FLAG divergence from the shipped docs, it does not adjudicate it.
- **Cross-product consistency with Sales Rep's exclude-on-lock behaviour** (`SR-GQL-012/017/024/124`, `050m`) — a cross-product UX-consistency call, not a per-ticket pass/fail condition; noted in the Test Model for the go/no-go owner.
- **Full WCAG 2.2 AA audit of the new disabled affordance/padlock/tooltip** — delegated whole to `ui-ux-expert`'s visual lane (G10 is the pointer, not the audit).
- **Exhaustive enumeration of every consumer of `contact.organizations` / `organizationsIds`** beyond `OrganizationIdRequestValidator` (G13) — the blast radius is unbounded without a source-level sweep; G13/scenario 17 is the entry point, flagged `{HYPOTHESIS} (scoped to the UN-ENUMERATED remainder only — G13 itself is now {OBSERVED}, grounded both legs, carrier PRF-GQL-086)`.
- **Customer-doc update** (StorefrontUserGuide still describes HIDE) — a `ba-doc-writer` deliverable, not a test condition.

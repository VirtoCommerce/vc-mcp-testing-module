# Admin SPA discards the server's 400 explanation on a membership status save; "Error details" is empty `[Medium]`

**Env:** vcst-qa @ Platform 3.1055.0, `VirtoCommerce.Customer` 3.1021.0-pr-312-3aa7

## Summary

Saving an out-of-contract Invite status on an organization membership fails with HTTP 400, and the
platform returns a body naming exactly which values are legal. The Admin SPA shows only a generic
`400: Bad request` banner, and its **"Error details" modal opens completely empty** — so the
admin never sees the explanation. Nothing persists, so this is an observability defect rather than
data corruption, but it would mask **any** 400 raised on this blade.

## STR

1. Sign in to the Admin SPA at `{{BACK_URL}}` as an administrator.
2. Contacts → open `@td(MULTI_ORG_TF_BR.email)`.
3. Open the **Organization memberships** widget → click the TechFlow membership row.
4. In **Invite status**, select **`Locked`** (the dropdown offers it — see Root cause).
5. Click **Save**.
6. When the red banner appears, click **View details**.

## Expected vs Actual

| | |
|---|---|
| **Expected** | The failure surfaces the server's explanation — `Status must be one of: Invited, Approved, Rejected, Deleted.` — either in the banner or in the "Error details" modal, so the admin can pick a legal value. |
| **Actual** | Banner reads only `400: Bad request`. **"Error details" opens with a warning icon and an OK button and no text at all.** The response body carrying the legal set is discarded by the client. |

The server side is correct: `PUT /api/customer/organization-memberships/{id}` → **400** with body verbatim
`Status must be one of: Invited, Approved, Rejected, Deleted.` (read off the network response). Read-back
confirms the membership status is unchanged.

![Save fails with a bare 400 banner](../screenshots/BUG-admin-membership-status-400-empty-details.png)

![The "Error details" modal is empty](../screenshots/BUG-admin-membership-status-400-details-modal.png)

## Root cause

Two separable issues; **this report covers (b)** and (b) is worth fixing regardless of how (a) is resolved.

- **(a) Why a doomed value is offered at all.** The blade populates Invite status from the
  `Customer.OrganizationMembershipStatuses` **dictionary setting**, whose live `allowedValues` is
  `["Approved","Invited","Rejected","Locked","Deleted"]` — five values. The write path validates
  against the four compiled `ModuleConstants.MembershipStatuses.ManuallySelectableStatuses`
  (`Invited, Approved, Rejected, Deleted`) and refuses anything else. The setting is
  `IsDictionary = true`, so `Locked` is an **admin-added row on this environment**, not a code change
  — arguably a content/config fix (remove the row) rather than a software one. Confirmed by a
  per-value probe: `Approved`/`Invited`/`Rejected`/`Deleted` → 200; `Locked` → 400.
  Locking is a **separate axis** (`IsLocked` + `LockoutEnd` → `IsCurrentlyLocked`), which is why
  `Locked` is structurally absent from the status vocabulary.
- **(b) The client drops the error body.** The 400 response body never reaches the UI, and the
  "Error details" modal renders empty rather than falling back to the raw message. This is
  independent of (a) — any 400 on this blade would be equally opaque.

## Not a duplicate of VCST-5061

`BUG-admin-error-toast-raw-loc-key-VCST-5061` (CLOSED — cannot reproduce) covered the *same surface*
with a **different symptom**: error toasts rendering the raw key `platform.errors.generic-error`
instead of its translation. Here every string is human-readable — the modal is **empty**, i.e. the
response body is dropped rather than mis-localized. Please do not close this as a duplicate of 5061.

## Notes

- Documented as designed-tension in `CUST-122` assertion 6 (suite `027-customer-orgs-invites`), which
  asserts the compiled-vs-dictionary divergence end-to-end. This report is the **UI** half that no
  test case covers.
- The **create path** has its own, separately-filed validation gap —
  `BUG-org-membership-create-no-input-validation-VCST-5028` (JIRA VCST-5314): `POST` accepts an empty
  `userId` (200, orphan row) and 500s on a missing one. That is why `CUST-122`'s guard-boundary
  assertion could not be exercised here without going through a known-broken path.
- Minor, not filed separately: the **New membership** blade renders a read-only
  `Locked state: Unlocked` row for a record that does not yet exist. Cosmetic.
- Related invariants: `BL-B2B-013` (membership status resolves per-org-first, then contact, then
  `Approved`), `BL-AUTH-016` (an org refusal is a single code, lock-first).

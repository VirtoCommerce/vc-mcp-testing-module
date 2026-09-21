---
name: doctor
description: "Run the vc-secrets diagnostic and interpret it — which declarations loaded, which secrets resolve, which need migrating, and what to do about each FAIL. Use when a wrapped MCP server shows failed, or after any change to a declaration."
argument-hint: "[--all]"
---

# doctor — diagnose the secret path

## Run it

On a client that substitutes plugin placeholders into this file before you see it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/vc-secrets.mjs" doctor   # add --all to force-check Key Vault secrets no enabled server consumes
```

On a client that substitutes nothing, the launcher sits two directories above this one — resolve the
relative path against **this file's directory**, not the working directory:

```bash
node ../../vc-secrets.mjs doctor                     # add --all for the same reason
```

**The shell must be able to reach the credential store.** `doctor` decrypts for real, so a restricted
or sandboxed shell — one that cannot read `~/.gnupg`, the Keychain or Credential Manager — reports a
`FAIL` on every local secret while saying nothing about the actual configuration. The tell is that
*all* of them fail at once. If the restriction cannot be lifted, say so and stop rather than reporting
those FAILs as findings.

## Reading the output

| Prefix | Meaning | Next step |
|---|---|---|
| `OK` | resolved | — |
| `INFO` | which declaration files loaded | confirm the expected scopes are there; a missing project file usually means the wrong working directory |
| `INFO <server/task> "x" (home) is authorized to receive "y"` | a project- or local-declared server or task consumes a secret or oauth entry whose authorization lives in your user file | allowed and often intended; report it so the operator knows the crossing exists |
| `FAIL <server/task> "x" (home) wants <secret\|oauth> "y" and is not authorized` / `... authorized for a different shape` | the same crossing, but the granting file has not granted it, or the launch shape has drifted from what was granted | paste the JSON block the line prints under the `where` it names, in the user file |
| `INFO oauth "y" (home): no registration block yet -- add {} under <where> ...` | a non-user-scope oauth entry has no registration block, and no non-user-scope launchable has already reported the same path | add `{}` at the named path so `vc-secrets login y` will run |
| `INFO … still required until the vc-secrets switch lands` | a plaintext token is present and this project has nothing wired yet | expected mid-migration; it becomes the `WARN` below once a server is wrapped |
| `WARN the installed shim speaks contract N` | the shim predates the launcher | re-run the vc-secrets install skill |
| `WARN … only under the legacy key` | the value exists, under the pre-plugin key | run the vc-secrets migrate skill — it cannot be re-typed, the store never hands a value back |
| `WARN … declared in both` | the same name in two homes | intended override, or an accident — say which one wins and let the operator decide |
| `WARN … unknown key … ignored` | the declaration is ahead of the installed launcher | update the plugin, or drop the key |
| `WARN <name> present in settings.local.json env — remove it (servers now read via vc-secrets)` | one of the five names the launcher watches (`ADO_MCP_AUTH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`) is still set in plaintext | remove the first three — they are stripped from the child and nothing reads them once wrapped. The two identifiers (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`) are **not** stripped — a server may legitimately inherit a tenant id — so remove them only once your declaration supplies them. This is a fixed list of five names, not a general plaintext sweep |
| `FAIL` | not resolvable | `set` it, or `az login` for a Key Vault secret |
| `FAIL wcm rejected a write at the size limit` | Credential Manager refused a value at its documented blob limit — the only backend with a size verdict here, and the only one this line can name | a store limit, not a configuration error: the token this machine produces may not fit, and no declaration change helps |
| `FAIL <backend> refused a write` | the rehearsal write failed for anything else — a locked keychain, a sandbox, a timeout — with the cause on the same line after the colon | act on that cause, not on size. The probe does not run at all when the backend's tool is missing, so a missing tool appears once, as its own FAIL |
| `SKIP` | a Key Vault secret no enabled server consumes | `--all` to check it anyway |
| `WARN <file>: cannot be read … so advice about leftover tokens may be wrong` | the file behind a wiring check couldn't be read | the legacy-token verdict above it is unreliable — fix the read access and re-run |
| `WARN … looks like a mistyped reference but is treated as a literal` | an env value looks like a `secrets:`-style typo for `secret:<name>` | fix the reference, or confirm the literal is intended |
| `WARN … projectId is meaningless at user scope` | a user-scope declaration sets `projectId` | remove it — user scope doesn't use one |
| `FAIL server "x" env Y: undeclared <secret\|oauth> "z"` | the env entry references a secret or oauth name absent from `secrets`/`oauth` | declare it, or fix the typo — this is different from the plain `FAIL` row above, which means a *declared* secret or oauth entry didn't resolve |

Exit code is 1 if any line is a `FAIL`, so it works as a gate in a script.

## Then, if a server still fails

`doctor` answers "is the secret resolvable". It says nothing about the server binary. For that, run
the probe, which completes a real `initialize` handshake through `run`. When nothing answers, it
separates three cases rather than reporting one: no token could be obtained (routine — nobody has
signed in yet), the launcher refused for some other reason, or the server binary exited without
answering. Only the last is the binary's fault:

```bash
node "${CLAUDE_PLUGIN_ROOT}/vc-secrets-probe.mjs" <server>
```

## Report

The output verbatim, then one line per non-`OK` entry saying what it means and the exact command to
fix it. Do not fix anything that changes a credential without asking first.

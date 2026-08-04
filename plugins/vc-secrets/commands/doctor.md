---
description: "Run the vc-secrets diagnostic and interpret it — which declarations loaded, which secrets resolve, which need migrating, and what to do about each FAIL. Use when a wrapped MCP server shows failed, or after any change to a declaration."
argument-hint: "[--all]"
---

# /vc-secrets:doctor — diagnose the secret path

## Run it

```bash
node "$VC_SECRETS" doctor          # add --all to force-check Key Vault secrets no enabled server consumes
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
| `INFO … uses "x", which you declared at user scope` | a project-declared server or task consumes one of your personal secrets | allowed and often intended; report it so the operator knows the crossing exists |
| `INFO … still required until the vc-secrets switch lands` | a plaintext token is present and this project has nothing wired yet | expected mid-migration; it becomes the `WARN` below once a server is wrapped |
| `WARN the installed shim speaks contract N` | the shim predates the launcher | re-run `/vc-secrets:install` |
| `WARN … only under the legacy key` | the value exists, under the pre-plugin key | `/vc-secrets:migrate` — it cannot be re-typed, the store never hands a value back |
| `WARN … declared in both` | the same name in two homes | intended override, or an accident — say which one wins and let the operator decide |
| `WARN … unknown key … ignored` | the declaration is ahead of the installed launcher | update the plugin, or drop the key |
| `WARN legacy token in settings/session env` | a plaintext credential still sits somewhere | remove it — nothing reads it once the server is wrapped |
| `FAIL` | not resolvable | `set` it, or `az login` for a Key Vault secret |
| `SKIP` | a Key Vault secret no enabled server consumes | `--all` to check it anyway |

Exit code is 1 if any line is a `FAIL`, so it works as a gate in a script.

## Then, if a server still fails

`doctor` answers "is the secret resolvable". It says nothing about the server binary. For that, run
the probe, which completes a real `initialize` handshake through `run`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/vc-secrets-probe.mjs" <server>
```

## Report

The output verbatim, then one line per non-`OK` entry saying what it means and the exact command to
fix it. Do not fix anything that changes a credential without asking first.

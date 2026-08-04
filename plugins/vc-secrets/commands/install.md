---
description: "Put the vc-secrets shim at a stable path and print the one environment variable that points at it. Run once per machine. NOT needed after an ordinary plugin update — the shim resolves the current version by itself."
argument-hint: ""
disable-model-invocation: true
---

# /vc-secrets:install — make the launcher reachable from a repo

A repo's committed `.mcp.json` cannot name the launcher's real location: plugin files live in a cache
directory whose path carries the plugin version, so it changes on every update. So the stable path
holds `vc-secrets-shim.mjs`, which resolves the plugin's current location per launch, and repos
reference the shim through one variable.

Install the **shim**, never a copy of the launcher. A copy would keep running an old version after an
update while the plugin's commands moved on — and the launcher's own version diagnostics would then
blame the plugin, which would be true of the copy and false of the plugin.

## Steps

1. **Find the stable directory.** `${CLAUDE_PLUGIN_DATA}` is the plugin's own data directory and
   survives updates, unlike `${CLAUDE_PLUGIN_ROOT}`. If it is not populated in this context, list
   `~/.claude/plugins/data/` and use the entry belonging to this plugin, creating it if absent. Say
   which of the two you used. Never write a cache path into any file.
2. **Copy** `${CLAUDE_PLUGIN_ROOT}/vc-secrets-shim.mjs` there, keeping the filename — the plugin's
   own guard hook recognizes the shim by that name at that location.
3. **Print** — do not write — the `env` entry for `~/.claude/settings.json`:
   ```json
   { "env": { "VC_SECRETS": "<absolute path>/vc-secrets-shim.mjs" } }
   ```
   That file belongs to the developer. A tool that edits someone's global settings unasked is a tool
   nobody trusts twice. Say that MCP servers pick the variable up only after a restart.
4. **Verify** by running `node <path>/vc-secrets-shim.mjs doctor` unsandboxed and reporting the
   output. On a machine with nothing stored yet the secrets report as not resolvable — that is
   expected, and the next step is `set`, not a bug report.

## When this has to be re-run

Not after a plugin update: the shim re-resolves the path every launch. Only when the shim's own
contract changes, and `doctor` says so in as many words. If a repo's `.mcp.json` fails with
`Missing environment variables: VC_SECRETS`, the variable was never set on this machine — step 3.

## Report

The directory you installed to and how you found it, the snippet to add, and the `doctor` output
verbatim. If a shim already existed there, say whether you replaced it.

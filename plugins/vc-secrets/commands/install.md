---
description: "Put the vc-secrets shim at a stable path and print the two environment lines that point at it. Run once per machine. NOT needed after an ordinary plugin update — the shim resolves the plugin's current location by itself."
argument-hint: ""
disable-model-invocation: true
---

# /vc-secrets:install — make the launcher reachable from a repo

A repo's committed `.mcp.json` cannot name the launcher's real location: plugin files live in a cache
directory whose path carries the plugin version, so it changes on every update. The stable path holds
`vc-secrets-shim.mjs`, which resolves the current install per launch, and repos reference the shim
through one variable.

## Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-shim.mjs"
```

The script does the three exact things — resolve the stable directory, copy the shim, print the two
variable lines — so they come out the same on every machine and are covered by tests. It is idempotent:
a second run reports `already up to date`.

It deliberately **prints** rather than writes. `~/.claude/settings.json` and a shell rc belong to the
developer, and a tool that edits either unasked is a tool nobody trusts twice.

## Then

1. **Relay its output verbatim.** Both variable lines matter, and they are read by different processes:
   the `settings.json` entry by a wrapped MCP server, the `export` by `set` / `unlock` / `doctor` /
   `migrate` when a human runs them in a terminal. Say that MCP servers pick the variable up only after
   a restart, and the shell rc only in a new shell.
2. **Run the `doctor` command the script prints** and report its output. On a machine with no declaration
   file yet the whole output is `FAIL no declaration file found` — expected at this point, not a bug
   report. The next step is writing a declaration, then `set`.
3. If the script exits non-zero, relay its message and stop. `CLAUDE_PLUGIN_ROOT` unset means this is not
   a complete plugin install; two candidate data directories means a stale one has to be removed first.

## Report

The shim's path, whether it was installed / replaced / already current, the two lines to add, and the
`doctor` output. If the script warned that it ignored `CLAUDE_PLUGIN_DATA`, pass that on — it means the
variable pointed at another plugin's directory, which happens when the command runs from a session where
a different plugin was active.

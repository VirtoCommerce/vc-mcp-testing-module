---
description: "Put the vc-secrets shim at a stable path and print the settings.json entry plus the literal commands that use it. Run once per machine. NOT needed after an ordinary plugin update — the shim resolves the plugin's current location by itself."
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-shim.mjs" --data-dir "${CLAUDE_PLUGIN_DATA}"
```

Claude Code substitutes both placeholders with the values belonging to the plugin that owns this file. The
documented substitution table names *skill and agent content*, and a plugin's `commands/` directory is one
of the documented locations for skills — so this line rests on that reading, and the first real run of
this command on a machine is what confirms it.

The script does not trust the value on arrival: it checks that the directory names this plugin. This line
is a shell line, so where the placeholder is *not* substituted the shell expands it from the inherited
environment instead, and the environment variable of that name carries whichever plugin's context set it.
An argument and an expansion are indistinguishable by the time the script reads them.

The script does the three exact things — resolve the stable directory, copy the shim, print the settings
entry and the commands that use it — so they come out the same on every machine and are covered by tests.
It is idempotent: a second run reports `already up to date`.

It deliberately **prints** rather than writes. `~/.claude/settings.json` belongs to the developer, and a
tool that edits it unasked is a tool nobody trusts twice. There is no shell setup to do: `set`, `unlock`,
`doctor`, and `migrate` are run with the shim's literal path, which the script already computed.

## Then

1. **Relay its output verbatim.** The `settings.json` entry is what a wrapped MCP server reads, and it
   picks the variable up only after a restart — say so. The four commands below it are what a human runs
   by hand; they need nothing added to a shell.
2. **Run the `doctor` command the script prints** and report its output. On a machine with no declaration
   file yet the whole output is `FAIL no declaration file found` — expected at this point, not a bug
   report. The next step is writing a declaration, then `set`.
3. If the script exits non-zero, relay its message and stop. `CLAUDE_PLUGIN_ROOT` unset means this is not
   a complete plugin install; a `--data-dir` that is not an absolute path means the placeholder reached the
   script as text, which a shell would have expanded, so the line ran somewhere neither substitutes.

## Report

The shim's path, whether it was installed / replaced / already current, the `settings.json` entry to add,
the literal commands, and the `doctor` output. The path is printed with how the directory was chosen: anything other than `--data-dir`
means the placeholder did not reach the script, and the warning naming the ignored directory has to be
passed on too. The shim works either way, but a substitution that never happens is worth knowing about
before it is depended on elsewhere.

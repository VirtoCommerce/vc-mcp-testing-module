# vc-secrets

This launcher runs a **declared process** with the secrets that process needs — an MCP server, or a task that is
not one. The config entry holds a call to the launcher instead of a credential:

```json
{ "mcpServers": { "github": {
    "command": "node",
    "args": ["${VC_SECRETS}", "run", "github"] } } }
```

At launch, `vc-secrets` reads that server's declaration, resolves the secrets it names from the OS
credential store (or Azure Key Vault), injects them into **the process tree rooted at that declared
process**, and stays as its parent to forward stdio and kill the tree on exit. Two things that phrase does
not say: a sibling process gets nothing, and the declared process's own children get everything it got —
environment is inherited, and nothing can un-inherit it. The child also keeps your ambient environment, as
any spawned process does, so a credential already exported in your shell reaches it too; moving those into
declarations is what removes them. No token in `.mcp.json`, in `~/.claude.json`, in a settings `env` block,
or in a `.env` file.

**What this protects, and what it does not.** It protects credentials **at rest** — out of the files that
get committed, synced, pasted into an issue, or read by anything that can read your config — and against
**accidental exposure** through those files. It does **not** isolate a secret from the process you declared,
from that process's descendants, or from other code running as the same OS user: whatever can run commands
as you can read the same credential store directly, with or without this tool. Read the rest of this file
with that boundary in mind; nothing below quietly widens it.

What it does not do: there is deliberately **no command that prints a secret value**, and no verb that
runs an arbitrary command with secrets attached. Only declared servers and tasks are launched — and
since a task inherits stdio, a *declared* task can of course print what it was given
(`{"command": "printenv"}`). That is why a task's argv belongs in a reviewed declaration: the guarantee
is that the caller cannot choose the command, not that a reviewer can stop reading.

This plugin ships **no MCP servers**. Each server is declared by whoever needs it — a repo for the
team's servers, a person for their own.

## Commands

| Command | What it does |
|---|---|
| `/vc-secrets:install` | Put the shim at a stable path and print the settings entry plus the commands that use it |
| `/vc-secrets:doctor` | Resolve everything a live server needs and report what is broken |
| `/vc-secrets:migrate` | One-time: move secrets stored under the pre-plugin flat `mcpw:<name>` credential (or `~/.config/mcpw/secrets/<name>.gpg`) to their namespaced keys |

`install` deliberately installs a **shim**, not a copy of the launcher: plugin files live in a cache
directory whose path carries the version, so a copy would keep running an old launcher after an
update while the plugin's commands moved on. The shim resolves the plugin's current location on every
launch, so an ordinary plugin update needs no reinstall.

From a terminal, everything runs through the shim, by its literal path — `install` prints the exact
command for each verb, so there is nothing to configure first. (If you'd rather type a short name than
paste the path each time, export it as `VC_SECRETS` from your shell's own startup file — that's a
convenience you set up yourself, not something this tool needs or writes.) The `settings.json` entry
`install` also prints is separate and unrelated to your terminal: it reaches only the processes Claude
Code itself starts, which is why a wrapped MCP server needs it but a command you type by hand does not:

| Verb | |
|---|---|
| `set <name>` | Store one secret. Hidden prompt; the value never appears in argv. Only works for a name already declared — it refuses an unknown one. |
| `run <server>` | Resolve and run that server on stdio, staying as its parent. This is what an MCP entry calls. |
| `task <name>` | Same, for a declared non-MCP command — a load-test harness, a migration step. |
| `doctor` | Diagnose. Exits non-zero on any `FAIL`, so it works as a gate. |
| `unlock` | Warm the gpg agent for the session (gpg backend only) — decrypts whichever of the current or the older stored file exists. No-op on Windows and macOS. |
| `migrate` | Copy legacy-prefix entries to namespaced keys. Idempotent. |

## Declarations

Reviewable, and committed where they belong. Three homes, precedence
**local > project > user** — the same relationship `settings.local.json` has to `settings.json`:

| Scope | File | Committed | For |
|---|---|---|---|
| `project` | `<repo>/.claude/vc-secrets.json` | yes | the team's servers |
| `local` | `<repo>/.claude/vc-secrets.local.json` | no, gitignore it | yours, in this repo only |
| `user` | `~/.claude/vc-secrets.json` | no | yours, everywhere |

```jsonc
{
  "schemaVersion": 1,
  "projectId": "my-module",              // required once a project-scope secret exists
  "secrets": {
    "ado-pat": { "backend": "local" },
    "monitor-sp": { "backend": "keyvault", "vault": "myvault", "secret": "sp-nonprod", "format": "json" }
  },
  "servers": {
    "azure-devops": {
      "command": "npx",
      "args": ["-y", "@azure-devops/mcp@2.8.1", "my-org", "-a", "envvar"],
      "env": { "ADO_MCP_AUTH_TOKEN": "secret:ado-pat" }
    },
    "monitor": {
      "command": "dnx",
      "args": ["Azure.Mcp@3.0.0-beta.27", "--yes", "server", "start", "--read-only"],
      "env": { "AZURE_CLIENT_SECRET": "secret:monitor-sp.clientSecret" }
    }
  }
}
```

### Tasks: the same thing, for what is not an MCP server

Plenty of things need a credential without being an MCP server — a load-test harness, a one-off
migration step, a script calling an API. Declare those as `tasks` and run them with `task <name>`:

```jsonc
"tasks": {
  "loadtest": { "command": "bash", "args": ["run.sh"], "env": { "API_PASSWORD": "secret:api-user" } }
}
```

Identical validation, identical injection, identical process-group teardown. The important part is
what is **absent**: there is no verb that takes a command from the caller. `vc-secrets exec -- <cmd>`
would be the convenient version of this, and it would also be a secret printer — `exec -- printenv` —
which is exactly what a tool with no read command must not acquire. A task's argv lives in the
declaration, so it is reviewed in a pull request like a server's, and the caller chooses only *which
declared* task to run.

What this does not reach: a credential that must appear inside a URL or an argument the tool then
writes somewhere (a git remote with an embedded token, for instance). Injecting it into the
environment does not help there; that case wants a git credential helper, not this.

- A pinned version belongs here, not in `.mcp.json` — this file is the single source of a wrapped
  server's argv.
- **Every `env` value carries its kind**: `secret:<name>` for a reference, `literal:<value>` for a
  constant. Anything else is refused when the declaration loads. A pasted credential has no shape it can
  hide in — the reader who forgets the prefix gets an error, not a plaintext token in the file this tool
  exists to empty. It also ends the near-miss family: `secrets:<name>` with the plural no longer means
  anything, so it cannot be silently accepted as a constant.
- `secret:<name>` resolves the whole value; `secret:<name>.<field>` needs `"format": "json"`.
- `literal:` is stripped once: `literal:literal:x` sets the value `literal:x`.
- The rule covers `env`, which is where a credential belongs if it must be given to a process at all.
  `args` stay free text — a token there would be visible in the machine's process list anyway, so it is
  reviewable text rather than a surface this tool can defend.
- `projectId` is **declared, never derived.** A git worktree has a different path from its main
  checkout, so a path-derived identity would hide the secrets you already set. It may appear in the
  project or the local file; if in both, they must agree. `user` is reserved.
- Being declared, it is also **claimable**: two repos that write the same `projectId` share one
  namespace, and a developer with both checked out gives each the other's secrets. So the separation
  between projects is a convention this tool keeps for you, not a boundary it enforces against a
  declaration that wants to cross it. Don't copy a `projectId` between repos.

## Where a secret is stored, and under what key

Keys are namespaced by the declaration's home, so a project's secrets and your personal ones never
share a key:

| Declared in | Key |
|---|---|
| project or local (same project) | `vc-secrets:<projectId>:<name>` |
| user | `vc-secrets:user:<name>` |

Precedence is the client's own, and deliberately so: Claude Code resolves a server defined in several
scopes as local, then project, then user, taking **the whole entry** from the winner rather than merging
fields. The same name in more than one home is therefore normal here too, across the user boundary
included — and `doctor` reports every such collision with the home that won, which is how the client
answers the same ambiguity when it shows you the effective set.

A project-declared server may **reference** a user-scope secret — one personal PAT used from several repos
is the ordinary case, and declaring it per project would put copies of the same credential in as many
namespaces, each of which you would then have to remember to rotate. But naming your secret is not consent
to receive it. You authorize the **shape** that may, in your own file:

```json
{
  "secrets": {
    "personal-pat": {
      "backend": "local",
      "authorized": {
        "servers": {
          "gh": { "command": "npx", "args": ["-y", "gh-mcp"], "envKeys": ["T"] }
        }
      }
    }
  }
}
```

A launch compares the declaration against that block and refuses on any difference — a changed `command`,
changed `args`, an added env key. `doctor` reports each crossing: `INFO` when it is authorized, `FAIL` with
the block to paste when it is not, built from the declaration as it stands so you read the command before
approving it. `authorized` takes effect only in the user file; anywhere else the party asking for the
approval would be the one writing it, and the loader says so and ignores it.

The shape, rather than the name, is what has to match, and the reason is one level of indirection: your
`.mcp.json` entry says `node "$VC_SECRETS" run gh`, and that is what the MCP client asks you to approve.
The declaration deciding what `gh` actually runs sits below that approval — rewrite it and the client sees
no change to re-ask about. So an approved name is not an approved command, and the authorization pins the
command.

Your own user-scope servers and tasks need no block: you wrote both sides, and there is no one to
authorize against.

**A `keyvault` secret needs the same authorization even when the project declares it**, and this is the one
place the rule is not about which file the declaration sits in. A project-declared `local` secret is already
harmless: its key is namespaced to the project, so it reads what *you* set for that project and nothing
else — the `set` you ran is the authorization. A vault read has no such act behind it. `keyFor` is not
consulted; the vault and secret name are read from the declaration as written, and the read is paid for by
whatever identity `az` holds, which the repository does not own. So a committed declaration naming any vault
your login can reach would otherwise hand over that secret. The vault and the secret name stay in the
repository, where they belong; the authorization is keyed by that pair in your file:

```json
{
  "vaults": {
    "team-nonprod": {
      "db-password": {
        "servers": { "api": { "command": "npx", "args": ["-y", "api-mcp"], "envKeys": ["DB_PASSWORD"] } }
      }
    }
  }
}
```

Same comparison, same `doctor` output, same paste. `vaults` takes effect only in the user file — in a
repository file it is ignored with a warning, for the reason `authorized` is user-scope only.

One consequence worth knowing: when a project declares a secret whose name you also use personally, the
project's entry wins **and keys the project's namespace**, so its server reads
`vc-secrets:<projectId>:<name>` and not your personal value. Nothing silently borrows the other's
credential; the two simply live under different keys.

The value itself lives where your platform keeps credentials: a Credential Manager generic
credential (Windows), a Keychain generic password (macOS), or a gpg-encrypted file under
`~/.config/vc-secrets/secrets/<scope>/` (Linux/WSL, `$XDG_CONFIG_HOME` honoured). Use `set` rather
than writing these by hand — it gets the file mode, the atomic replace and the key shape right.

## Setup

Every verb reads the declaration, so write one first — `<repo>/.claude/vc-secrets.json` for the team's
secrets, `~/.claude/vc-secrets.json` for your own. On a fresh machine, skipping this step means every
verb below throws.

```bash
# 0. Write a declaration (see "Declarations" above) before anything else.
/vc-secrets:install                          # installs the shim, prints the settings entry and the commands below
node "<the path install printed>" set <name> # <name> must be one of the secrets your declaration lists
node "<the path install printed>" unlock     # gpg backend only, once per session, in a real terminal
node "<the path install printed>" doctor     # expect no FAIL
```

`install` prints an `env` entry for `~/.claude/settings.json`, setting `VC_SECRETS` to the shim's stable
path, and the exact commands above with that path already filled in — copy-paste, no shell setup needed.
It prints rather than writes: that file is yours, and a tool that edits a developer's global settings
unasked is a tool nobody trusts twice. If you'd rather type `$VC_SECRETS` than the full path, export it
yourself from your shell's own startup file; the tool doesn't need you to.

Then wire each server with the launcher as its `command`, either by hand in the repo's `.mcp.json`
(project scope) or with `claude mcp add-json --scope user|local` for your own.

## Knobs

| Variable | Effect |
|---|---|
| `VC_SECRETS` | Where the shim lives; referenced from `.mcp.json` so no repo hardcodes a plugin path |
| `VC_SECRETS_LOCAL_BACKEND` | Override the detected backend (`wcm` / `keychain` / `gpg`). WSL is **not** treated as Windows |
| `VC_SECRETS_GPG_RECIPIENT` | Encrypt to a specific key instead of your default |
| `VC_SECRETS_POWERSHELL` | Set to `pwsh` if Constrained Language Mode blocks the in-box PowerShell's `Add-Type` |
| `VC_SECRETS_TIMING` | `1` prints the resolve-phase duration to stderr |
| `VC_SECRETS_CONFIG_DIR` | Test support — read declarations from one directory. `doctor` warns whenever it is set |

## When something fails

| Symptom | Meaning |
|---|---|
| `decryption failed: Operation cancelled` | gpg agent is cold — `unlock` in a terminal |
| `FAIL` on every local secret at once | the shell cannot reach the credential store (a sandboxed or restricted one cannot); rerun where it can |
| `secret "x" is only under the legacy key` | Run `migrate` — the value cannot be re-typed, the store never gives it back |
| `projectId disagrees` | The project and local files name different ids; they key the same secrets |
| `schemaVersion N needs a newer vc-secrets` | The declaration is ahead of the installed plugin — update the plugin |
| `Missing environment variables: VC_SECRETS` | The variable was never set on this machine — run `/vc-secrets:install` |
| A wrapped server shows failed in `/mcp` | `doctor` first (secret?), then the probe for the binary: take the `installPath` of `vc-secrets@vc-tools` from `~/.claude/plugins/installed_plugins.json`, then `node <installPath>/vc-secrets-probe.mjs <server>` |

The probe separates "secret not resolvable" from "server binary broken": `doctor` covers the first,
the probe the second by completing a real `initialize` handshake through `run`.

## Why an edit to a declaration gets blocked

The plugin ships a `PreToolUse` hook that denies agent Edit/Write on a declaration file and on the
shim. A declaration decides which command receives which secret, so it changes through a human PR;
the shim sits on the path of every launch and no plugin update overwrites it. The hook sees Edit,
Write, and NotebookEdit only — the same change made through a shell command goes past it — so it is a
speed bump that surfaces an unexpected edit, not a boundary. Editing those files in your own editor is
the intended path.

## Scope of the protection

This removes plaintext-at-rest on the MCP path and shrinks the accidental and prompt-injection
surface. It is **not** a boundary against a deliberately malicious agent running the same backend
tools itself, editing a declaration, or tampering with `PATH` — inside one OS user account there is
no such boundary. A real one needs a broker under a separate account.

Two things it does harden regardless: `NODE_OPTIONS`, `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`,
`DYLD_INSERT_LIBRARIES`, and `DYLD_LIBRARY_PATH` are refused as declaration `env` keys and stripped
from every child the launcher spawns, so a declaration cannot inject code into the process that holds
a secret. And a backend's stderr is redacted of any resolved value before it is reported, with the
in-process copy dropped right after the child starts.

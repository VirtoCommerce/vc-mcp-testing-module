# vc-secrets

This launcher runs a **declared process** with the secrets that process needs — an MCP server, or a task that is
not one. The config entry holds a call to the launcher instead of a credential:

```json
{ "mcpServers": { "github": {
    "command": "node",
    "args": ["${VC_SECRETS}", "run", "github"] } } }
```

At launch, `vc-secrets` reads that server's declaration, resolves the secrets it names from the OS
credential store (or Azure Key Vault), injects them into **that child process only**, and stays as
its parent to forward stdio and kill the tree on exit. No token in `.mcp.json`, in `~/.claude.json`,
in a settings `env` block, or in a `.env` file.

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
| `/vc-secrets:install` | Put the shim at a stable path and print the one environment variable to set |
| `/vc-secrets:doctor` | Resolve everything a live server needs and report what is broken |
| `/vc-secrets:migrate` | One-time: move secrets stored under the pre-plugin key prefix to their namespaced keys |

`install` deliberately installs a **shim**, not a copy of the launcher: plugin files live in a cache
directory whose path carries the version, so a copy would keep running an old launcher after an
update while the plugin's commands moved on. The shim resolves the plugin's current location on every
launch, so an ordinary plugin update needs no reinstall.

From a terminal, everything runs through the shim — `node "$VC_SECRETS" <verb>`:

| Verb | |
|---|---|
| `set <name>` | Store one secret. Hidden prompt; the value never appears in argv. |
| `run <server>` | Resolve and exec that server on stdio. This is what an MCP entry calls. |
| `task <name>` | Same, for a declared non-MCP command — a load-test harness, a migration step. |
| `doctor` | Diagnose. Exits non-zero on any `FAIL`, so it works as a gate. |
| `unlock` | Warm the gpg agent for the session (gpg backend only). |
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
- Nothing stops you pasting a literal credential into an `env` value, and nothing warns about it:
  these files are *meant* to hold references, and a value written there is plaintext at rest in the
  place this tool exists to empty. `secret:<name>` or a non-secret literal — nothing else belongs here.
- `secret:<name>` resolves the whole value; `secret:<name>.<field>` needs `"format": "json"`.
- Anything not a `secret:` reference is a literal.
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

A project-declared server may also **reference** a user-scope secret, and usually should: one personal
PAT used from several repos is the ordinary case, and declaring it per project would put copies of the
same credential in as many namespaces, each of which you would then have to remember to rotate. `doctor`
prints an `INFO` line for every project-declared server or task that consumes a secret you declared at
user scope — that relationship is invisible in either file on its own.

One consequence worth knowing: when a project declares a secret whose name you also use personally, the
project's entry wins **and keys the project's namespace**, so its server reads
`vc-secrets:<projectId>:<name>` and not your personal value. Nothing silently borrows the other's
credential; the two simply live under different keys.

Worth being exact about the remaining exposure, since it is a security tool: a declaration arrives with
whatever pull request adds it, so a repo could name your personal secret in a server of its own. What
stands between that and your credential is the same thing that always did — a new project-scope server in
`.mcp.json` is pending until you approve it, a task runs only when someone names it, and both the
declaration and the `.mcp.json` entry are diffable. This tool moves the secret out of those files; it does
not review them for you.

The value itself lives where your platform keeps credentials: a Credential Manager generic
credential (Windows), a Keychain generic password (macOS), or a gpg-encrypted file under
`~/.config/vc-secrets/secrets/<scope>/` (Linux/WSL, `$XDG_CONFIG_HOME` honoured). Use `set` rather
than writing these by hand — it gets the file mode, the atomic replace and the key shape right.

## Setup

```bash
/vc-secrets:install                  # installs the shim, prints the env line to add
node "$VC_SECRETS" set ado-pat
node "$VC_SECRETS" unlock            # gpg backend only, once per session, in a real terminal
node "$VC_SECRETS" doctor            # expect no FAIL
```

`install` prints an `env` entry for `~/.claude/settings.json` setting `VC_SECRETS` to the launcher's
stable path. It prints rather than writes: that file is yours, and a tool that edits a developer's
global settings unasked is a tool nobody trusts twice.

Then wire each server with the launcher as its `command`, either by hand in the repo's `.mcp.json`
(project scope) or with `claude mcp add-json --scope user|local` for your own.

## Knobs

| Variable | Effect |
|---|---|
| `VC_SECRETS` | Where the launcher lives; referenced from `.mcp.json` so no repo hardcodes a plugin path |
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
| A wrapped server shows failed in `/mcp` | `doctor` first (secret?), then the probe (`vc-secrets-probe.mjs <server>`) for the binary |

The probe separates "secret not resolvable" from "server binary broken": `doctor` covers the first,
the probe the second by completing a real `initialize` handshake through `run`.

## Why an edit to a declaration gets blocked

The plugin ships a `PreToolUse` hook that denies agent Edit/Write on a declaration file and on the
shim. A declaration decides which command receives which secret, so it changes through a human PR;
the shim sits on the path of every launch and no plugin update overwrites it. The hook sees Edit and
Write only — the same change made through a shell command goes past it — so it is a speed bump that
surfaces an unexpected edit, not a boundary. Editing those files in your own editor is the intended
path.

## Scope of the protection

This removes plaintext-at-rest on the MCP path and shrinks the accidental and prompt-injection
surface. It is **not** a boundary against a deliberately malicious agent running the same backend
tools itself, editing a declaration, or tampering with `PATH` — inside one OS user account there is
no such boundary. A real one needs a broker under a separate account.

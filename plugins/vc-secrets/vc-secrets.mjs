// vc-secrets.mjs — secrets launcher: runs a declared process (an MCP server, or a task) with its secrets.
// Resolves the secrets a declared child needs from the OS credential store at launch time and
// injects them into that one child only. README.md carries the declaration schema, the three
// declaration homes and their precedence.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_NAME = "vc-secrets.json";
const LOCAL_CONFIG_NAME = "vc-secrets.local.json";
const KEY_PREFIX = "vc-secrets";
const LEGACY_KEY_PREFIX = "mcpw";
const USER_SCOPE = "user";
// Bump when a declaration gains a shape an older launcher cannot honour. Refusing by version beats
// silently ignoring half a declaration — the reason unknown TOP-LEVEL keys are only a warning is
// that this field, not the key check, is what reports a genuine skew.
const SCHEMA_VERSION = 1;
const BACKENDS = ["local", "keyvault"];
const TOP_LEVEL_KEYS = ["schemaVersion", "projectId", "secrets", "servers", "tasks", "vaults"];
const SECRET_DECL_KEYS = ["backend", "vault", "secret", "format", "authorized"];
const SERVER_DECL_KEYS = ["command", "args", "env"];

// Env vars that inject code/libraries into any child process we spawn — must never
// reach a tool we invoke, whether inherited from the operator's shell (sanitizeEnv, below) or
// declared in vc-secrets.json as a server env key (loadConfig rejects these keys outright —
// closing the gap for both literal and secret-resolved values, since it's the KEY that matters).
const DANGEROUS_ENV_VARS = ["NODE_OPTIONS", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"];

// Matched without regard to case on every platform, not only where the environment is case-insensitive.
// A declaration is written once and travels: on Windows `node_options` reaches the child as NODE_OPTIONS,
// so a case-sensitive comparison would pass the exact key the list exists to refuse.
function isDangerousEnvKey(key) {
    return DANGEROUS_ENV_VARS.includes(key.toUpperCase());
}

function sanitizeEnv(env) {
    const out = {};
    for (const [key, value] of Object.entries(env)) {
        if (!isDangerousEnvKey(key)) {
            out[key] = value;
        }
    }

    return out;
}

class VcSecretsError extends Error {
    constructor(message, exitCode = 1) {
        super(message);
        this.exitCode = exitCode;
    }
}

// grammar: "secret:" name [ "." field ]; name [a-z0-9-]+, field [A-Za-z0-9_]+
const REF_RE = /^secret:([a-z0-9-]+)(?:\.([A-Za-z0-9_]+))?$/;
// A secret's declared name must be referenceable, so it obeys the same charset REF_RE does.
const SECRET_NAME_RE = /^[a-z0-9-]+$/;
// Launchable names are looser (they mirror MCP server names, which do carry dots and capitals), but a
// path separator or a control character in one has no legitimate use and several bad ones.
const LAUNCHABLE_NAME_RE = /^[A-Za-z0-9._-]+$/;

function parseReference(value) {
    if (typeof value !== "string" || !value.startsWith("secret:")) {
        return null;
    }
    const match = REF_RE.exec(value);
    if (!match) {
        throw new VcSecretsError(`invalid secret reference syntax: "${value}"`);
    }

    return { name: match[1], field: match[2] ?? null };
}

// Every env value carries its kind. The alternative — "anything that is not a `secret:` reference is a
// literal" — makes a pasted credential indistinguishable from an intended constant, which is the one
// thing a declaration must never be ambiguous about: it is the file this tool exists to keep free of
// values. It also ends a family of near-misses (`secrets:` with the plural, `Secret:`) by construction,
// since an unprefixed value no longer has a meaning to fall back to.
const LITERAL_PREFIX = "literal:";

function parseLiteral(value) {
    return typeof value === "string" && value.startsWith(LITERAL_PREFIX) ? value.slice(LITERAL_PREFIX.length) : null;
}

// realpath, not resolve: an aliased .claude — a symlinked home, a bind mount — is one file under two
// strings, and comparing the strings makes every same-file check miss. Falls back to resolve for a path
// that does not exist yet, where realpath cannot answer.
function canonicalPath(p) {
    try {
        return fs.realpathSync(p);
    } catch {
        return path.resolve(p);
    }
}

// Where each scope's declarations live. The project root is found by walking up from cwd rather
// than assuming it: the client spawns a server with cwd at the project, but a task or a hand-run
// `doctor` can start anywhere below it.
function configPaths(env = process.env, cwd = process.cwd()) {
    const home = env.HOME || os.homedir();
    const override = env.VC_SECRETS_CONFIG_DIR;
    // The override stands in for a PROJECT, not for every scope: a test needs project-scope
    // declarations to be project-scoped, or `projectId` and the keystore namespace go untested. A test
    // that wants user scope points HOME at a fixture instead.
    if (override) {
        return { user: null, project: path.join(override, CONFIG_NAME), local: path.join(override, LOCAL_CONFIG_NAME) };
    }
    let dir = path.resolve(cwd);
    let projectDir = null;
    // ~/.claude is the USER scope's home. The walk passes through it for any cwd under $HOME, and
    // accepting it as the project would make one file both scopes: the dedupe below then drops it, and
    // `doctor` loses its anchor for settings.local.json and .mcp.json — reporting a wired server's
    // leftover plaintext token as "still required", the opposite of the truth.
    const userClaude = canonicalPath(path.join(home, ".claude"));
    for (;;) {
        const claude = path.join(dir, ".claude");
        if (fs.existsSync(claude) && canonicalPath(claude) !== userClaude
            && (fs.existsSync(path.join(claude, CONFIG_NAME)) || fs.existsSync(path.join(claude, LOCAL_CONFIG_NAME)))) {
            projectDir = claude;
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }

    return {
        user: path.join(home, ".claude", CONFIG_NAME),
        project: projectDir ? path.join(projectDir, CONFIG_NAME) : null,
        local: projectDir ? path.join(projectDir, LOCAL_CONFIG_NAME) : null,
    };
}

// A project declaration that merely NAMES a user-scope secret grants itself the credential, and no gate
// above catches it: what the MCP client approves is `node $VC_SECRETS run <name>`, one level above the
// declaration that decides what `<name>` actually runs. Rewrite the command behind an already-approved
// name and every existing check still passes. So the owner of the secret authorizes the SHAPE that may
// receive it, in the user file, which no repository can carry — and a change to that shape stops the
// launch instead of riding along.
function consumerShape(launchable) {
    return { command: launchable.command, args: [...launchable.args], envKeys: Object.keys(launchable.env).sort() };
}

// The differences, in the words the reader needs to decide; null when the shapes agree.
function shapeDifferences(authorized, actual) {
    const diffs = [];
    if (authorized.command !== actual.command) {
        diffs.push(`command is ${JSON.stringify(actual.command)}, authorized ${JSON.stringify(authorized.command)}`);
    }
    if (JSON.stringify(authorized.args) !== JSON.stringify(actual.args)) {
        diffs.push(`args are ${JSON.stringify(actual.args)}, authorized ${JSON.stringify(authorized.args)}`);
    }
    const wanted = [...authorized.envKeys].sort();
    if (JSON.stringify(wanted) !== JSON.stringify(actual.envKeys)) {
        diffs.push(`env keys are ${JSON.stringify(actual.envKeys)}, authorized ${JSON.stringify(wanted)}`);
    }

    return diffs.length === 0 ? null : diffs;
}

function validateVaults(vaults) {
    if (vaults === undefined) {
        return;
    }
    if (typeof vaults !== "object" || vaults === null || Array.isArray(vaults)) {
        throw new VcSecretsError(`"vaults" must be an object keyed by vault name`);
    }
    for (const [vault, secrets] of Object.entries(vaults)) {
        if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) {
            throw new VcSecretsError(`vaults."${vault}" must be an object keyed by secret name`);
        }
        for (const [secret, block] of Object.entries(secrets)) {
            // Same validator as a secret's own `authorized` block: one shape rule, so a change to one
            // cannot leave the other authorizing something it no longer understands.
            validateAuthorized(`${vault}/${secret}`, block);
        }
    }
}

function validateAuthorized(secretName, authorized) {
    if (authorized === undefined) {
        return;
    }
    if (typeof authorized !== "object" || authorized === null || Array.isArray(authorized)) {
        throw new VcSecretsError(`secret "${secretName}": "authorized" must be an object`);
    }
    for (const [kind, entries] of Object.entries(authorized)) {
        if (kind !== "servers" && kind !== "tasks") {
            throw new VcSecretsError(`secret "${secretName}": authorized "${kind}" is not a kind (expected servers/tasks)`);
        }
        if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
            throw new VcSecretsError(`secret "${secretName}": authorized.${kind} must be an object keyed by name`);
        }
        for (const [name, shape] of Object.entries(entries)) {
            if (typeof shape !== "object" || shape === null || Array.isArray(shape)) {
                throw new VcSecretsError(`secret "${secretName}": authorized.${kind}."${name}" must be an object`);
            }
            if (typeof shape.command !== "string" || !shape.command) {
                throw new VcSecretsError(`secret "${secretName}": authorized.${kind}."${name}" needs a "command" string`);
            }
            if (!Array.isArray(shape.args) || !shape.args.every((a) => typeof a === "string")) {
                throw new VcSecretsError(`secret "${secretName}": authorized.${kind}."${name}" needs "args" as an array of strings`);
            }
            if (!Array.isArray(shape.envKeys) || !shape.envKeys.every((k) => typeof k === "string")) {
                throw new VcSecretsError(`secret "${secretName}": authorized.${kind}."${name}" needs "envKeys" as an array of strings`);
            }
        }
    }
}

// null when the reference needs no authorization; otherwise what is wrong with it, ready to be reported by
// `doctor` or thrown at launch. Both callers must agree, so the decision lives in one place.
// The condition is "nothing in the repository authorizes this read", which covers two cases and not a
// third. A user-scope declaration: the value is yours, so the authorization sits on it. A keyvault
// declaration at ANY scope: the read is paid for by whatever identity `az` is logged in as, which the
// repository does not own — while the vault and the secret name it reads DO come from the repository, so
// the authorization cannot live there either and is keyed by that pair in the user file. A project-declared
// `local` secret needs nothing: its key is namespaced to the project, so it reads what you set for that
// project and nothing else — the `set` you ran IS the authorization, and there is no equivalent act behind
// a vault read.
// Every lookup below reads parsed JSON, not one of the null-prototype maps this module builds — and a
// launchable may legally be named `toString` or `constructor` (LAUNCHABLE_NAME_RE allows both). A plain
// bracket read would return the inherited builtin instead of undefined, which then reaches
// shapeDifferences as an object with no envKeys and throws where a refusal belongs. Measured: one such
// name in a project file took down the whole doctor report, not just its own line.
function own(map, key) {
    return map !== null && typeof map === "object" && Object.hasOwn(map, key) ? map[key] : undefined;
}

function authorizationFor(cfg, decl) {
    if (decl.home === USER_SCOPE) {
        return { block: decl.authorized, where: `secrets."${decl.declaredName}".authorized` };
    }
    if (decl.backend === "keyvault") {
        return {
            block: own(own(cfg.vaults, decl.vault), decl.secret),
            where: `vaults."${decl.vault}"."${decl.secret}"`,
        };
    }

    return null;
}

function crossingProblem(cfg, kind, name, secretName) {
    const launchable = own(cfg[kind], name);
    const decl = own(cfg.secrets, secretName);
    if (!launchable || !decl || launchable.home === USER_SCOPE) {
        return null;
    }
    const source = authorizationFor(cfg, { ...decl, declaredName: secretName });
    if (source === null) {
        return null;
    }
    const actual = consumerShape(launchable);
    const authorized = own(own(source.block, kind), name);
    if (authorized === undefined) {
        return { secretName, actual, where: source.where, reason: "not authorized" };
    }
    const diffs = shapeDifferences(authorized, actual);

    return diffs === null
        ? null
        : { secretName, actual, where: source.where, reason: `authorized for a different shape: ${diffs.join("; ")}` };
}

// Servers and tasks are validated identically — same declaration shape, same env rules, same refusal
// of code-injection env keys. Kept as one function so a rule added for one kind cannot silently apply
// to only that one.
function validateLaunchables(label, map) {
    for (const [name, srv] of Object.entries(map)) {
        if (!LAUNCHABLE_NAME_RE.test(name)) {
            throw new VcSecretsError(`${label} "${name}": name must match ${LAUNCHABLE_NAME_RE.source}`);
        }
        if (!srv || typeof srv !== "object") {
            throw new VcSecretsError(`${label} "${name}": declaration must be an object`);
        }
        for (const key of Object.keys(srv)) {
            if (!SERVER_DECL_KEYS.includes(key)) {
                throw new VcSecretsError(`${label} "${name}": unknown key "${key}" (expected only ${SERVER_DECL_KEYS.join("/")})`);
            }
        }
        if (typeof srv.command !== "string" || !Array.isArray(srv.args) || typeof srv.env !== "object" || srv.env === null) {
            throw new VcSecretsError(`${label} "${name}": requires string "command", array "args", object "env"`);
        }
        if (srv.command.trim() === "") {
            throw new VcSecretsError(`${label} "${name}": "command" must not be empty`);
        }
        if (!srv.args.every((a) => typeof a === "string")) {
            throw new VcSecretsError(`${label} "${name}": every args element must be a string`);
        }
        // On Windows a .cmd/.bat shim is run through `cmd.exe /d /s /c "…"` with verbatim arguments, and
        // that line is built by wrapping each element in quotes. An embedded quote would close it and let
        // the rest be read as cmd syntax. Nothing legitimate needs one here, so it is refused at the
        // declaration rather than escaped at the seam.
        for (const value of [srv.command, ...srv.args]) {
            if (value.includes('"')) {
                throw new VcSecretsError(`${label} "${name}": a double quote in "command"/"args" is not allowed (it would break argument quoting on Windows)`);
            }
        }
        if (!Object.values(srv.env).every((v) => typeof v === "string")) {
            throw new VcSecretsError(`${label} "${name}": every env value must be a string`);
        }
        for (const [envKey, value] of Object.entries(srv.env)) {
            if (isDangerousEnvKey(envKey)) {
                throw new VcSecretsError(`${label} "${name}": env key "${envKey}" is not allowed (code-injection vector)`);
            }
            if (!value.startsWith("secret:") && parseLiteral(value) === null) {
                throw new VcSecretsError(`${label} "${name}": env ${envKey} must be "secret:<name>" or "literal:<value>" — an unprefixed value cannot be told apart from a pasted credential`);
            }
        }
    }
}

function parseConfigFile(file, warnings) {
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
        throw new VcSecretsError(`config is not valid JSON: ${file} (${e.message})`);
    }
    if (typeof cfg.schemaVersion === "number" && cfg.schemaVersion > SCHEMA_VERSION) {
        throw new VcSecretsError(`${file}: schemaVersion ${cfg.schemaVersion} needs a newer vc-secrets (this one speaks ${SCHEMA_VERSION}) — update the plugin`);
    }
    cfg.secrets ??= {};
    cfg.servers ??= {};
    cfg.tasks ??= {};
    for (const key of ["secrets", "servers", "tasks"]) {
        if (typeof cfg[key] !== "object" || cfg[key] === null || Array.isArray(cfg[key])) {
            throw new VcSecretsError(`${file}: "${key}" must be an object`);
        }
    }
    // An unknown key at the TOP level is a version skew, not a typo: the launcher and the
    // declarations now ship on separate clocks (plugin install vs git pull), so throwing here would
    // turn any forward-looking declaration into a total launch failure on older installs.
    // schemaVersion above reports real skew; inside declarations the check stays strict.
    for (const key of Object.keys(cfg)) {
        if (!TOP_LEVEL_KEYS.includes(key)) {
            warnings.push(`${file}: unknown key "${key}" ignored (this launcher speaks ${TOP_LEVEL_KEYS.join("/")})`);
        }
    }
    for (const [name, decl] of Object.entries(cfg.secrets)) {
        // The NAME was never validated here, only the declaration's values — and it reaches a keystore
        // key, a `security -s` argument, an env var, and two file paths. KEY_RE blocks the read and the
        // write, but `unlock` would still hand pinentry an arbitrary .gpg path, and `doctor` would still
        // try to decrypt one. Same charset REF_RE requires, so nothing legal is lost.
        if (!SECRET_NAME_RE.test(name)) {
            throw new VcSecretsError(`secret "${name}": name must match ${SECRET_NAME_RE.source}`);
        }
        if (!decl || typeof decl !== "object") {
            throw new VcSecretsError(`secret "${name}": declaration must be an object`);
        }
        for (const key of Object.keys(decl)) {
            if (!SECRET_DECL_KEYS.includes(key)) {
                throw new VcSecretsError(`secret "${name}": unknown key "${key}" (expected only ${SECRET_DECL_KEYS.join("/")})`);
            }
        }
        if (!BACKENDS.includes(decl.backend)) {
            throw new VcSecretsError(`secret "${name}": unknown backend "${decl.backend}" (expected ${BACKENDS.join("|")})`);
        }
        if (decl.format !== undefined && decl.format !== "json") {
            throw new VcSecretsError(`secret "${name}": unsupported format "${decl.format}" (only "json")`);
        }
        if (decl.backend === "keyvault" && (!decl.vault || !decl.secret)) {
            throw new VcSecretsError(`secret "${name}": keyvault backend requires "vault" and "secret"`);
        }
        // These two reach `az` as arguments, and on Windows `az` is a .cmd shim — see the quoting note in
        // validateLaunchables. Azure names cannot contain a quote anyway.
        for (const field of ["vault", "secret"]) {
            if (typeof decl[field] === "string" && decl[field].includes('"')) {
                throw new VcSecretsError(`secret "${name}": a double quote in "${field}" is not allowed`);
            }
        }
        validateAuthorized(name, decl.authorized);
    }
    validateLaunchables("server", cfg.servers);
    validateLaunchables("task", cfg.tasks);
    validateVaults(cfg.vaults);

    return cfg;
}

// Precedence local > project > user, mirroring settings.local.json over settings.json. Every entry
// keeps the scope it came from: that is what decides its keystore key, so losing it here would
// silently send a project secret to the user namespace.
const SCOPE_ORDER = [USER_SCOPE, "project", "local"];

// Precedence follows the client's own, documented for MCP servers as local, then project, then user —
// "the definition from the highest-precedence source" — and whole entries win, fields are never merged
// across scopes. Same names in several scopes are therefore normal, including across the user boundary:
// a tool living inside Claude Code that invented its own scope rules would be an exception every reader
// has to remember. What ambiguity that leaves is answered the way the client answers it — by showing the
// effective set: every collision is reported by `doctor` with the home that won.
function loadConfig(paths = configPaths()) {
    const warnings = [];
    // Null-prototype: a declaration named `__proto__` would otherwise assign the prototype instead of an
    // entry, so the name would vanish from the map with no error and no diagnostic.
    const secrets = Object.create(null);
    const servers = Object.create(null);
    const tasks = Object.create(null);
    const collisions = [];
    const files = {};
    let projectId = null;
    let projectIdFrom = null;

    // Two scopes can point at the same file — the test override does it deliberately, an aliased home
    // does it in the wild. Compared by realpath rather than by string: read twice, one file becomes two
    // homes, so its entries are attributed to the wrong scope (and a secret to the wrong keystore
    // namespace) and every name in it collides with itself.
    const seen = new Set();
    let vaults = Object.create(null);
    for (const scope of SCOPE_ORDER) {
        const file = paths[scope];
        if (!file || !fs.existsSync(file)) {
            continue;
        }
        const realFile = canonicalPath(file);
        if (seen.has(realFile)) {
            continue;
        }
        seen.add(realFile);
        files[scope] = file;
        let cfg;
        try {
            cfg = parseConfigFile(file, warnings);
        } catch (e) {
            throw e instanceof VcSecretsError && !e.message.startsWith(file) ? new VcSecretsError(`${file}: ${e.message}`, e.exitCode) : e;
        }
        if (cfg.projectId !== undefined) {
            if (typeof cfg.projectId !== "string" || !SECRET_NAME_RE.test(cfg.projectId)) {
                throw new VcSecretsError(`${file}: projectId must match ${SECRET_NAME_RE.source}`);
            }
            // "user" is the user scope's own namespace segment. A project claiming it would read and
            // overwrite personal secrets under keys indistinguishable from theirs.
            if (cfg.projectId === USER_SCOPE) {
                throw new VcSecretsError(`${file}: projectId "${USER_SCOPE}" is reserved for the user scope — pick another`);
            }
            if (scope === USER_SCOPE) {
                warnings.push(`${file}: projectId is meaningless at user scope — ignored`);
            } else if (projectId !== null && projectId !== cfg.projectId) {
                throw new VcSecretsError(`projectId disagrees: "${projectId}" in ${projectIdFrom}, "${cfg.projectId}" in ${file} — they key the same secrets, so one of them is wrong`);
            } else {
                projectId = cfg.projectId;
                projectIdFrom = file;
            }
        }
        if (cfg.vaults !== undefined) {
            if (scope === USER_SCOPE) {
                vaults = cfg.vaults;
            } else {
                // A repository authorizing the vault reads it asks for would be the grant written by the
                // party requesting it — the same reason `authorized` is user-scope only.
                warnings.push(`${file}: "vaults" only authorizes at user scope — ignored`);
            }
        }
        for (const [name, decl] of Object.entries(cfg.secrets)) {
            if (secrets[name]) {
                collisions.push({ kind: "secret", name, from: secrets[name].home, to: scope });
            }
            // `scope` is the keystore namespace (local shares the project's); `home` is which file
            // declared it. They differ for a local declaration, which is what keyFor and the crossing
            // report each need to read.
            if (decl.authorized !== undefined && scope !== USER_SCOPE) {
                // The point of the block is that its author owns the secret. A project authorizing its own
                // access would be the grant it is meant to require, written by the party asking for it.
                warnings.push(`${file}: secret "${name}": "authorized" only authorizes at user scope — ignored`);
            }
            secrets[name] = { ...decl, scope: scope === "local" ? "project" : scope, home: scope };
        }
        for (const [name, srv] of Object.entries(cfg.servers)) {
            if (servers[name]) {
                collisions.push({ kind: "server", name, from: servers[name].home, to: scope });
            }
            servers[name] = { ...srv, scope, home: scope };
        }
        for (const [name, task] of Object.entries(cfg.tasks)) {
            if (tasks[name]) {
                collisions.push({ kind: "task", name, from: tasks[name].home, to: scope });
            }
            tasks[name] = { ...task, scope, home: scope };
        }
    }

    if (Object.keys(files).length === 0) {
        throw new VcSecretsError(`no declaration file found — looked for ${[paths.user, paths.project, paths.local].filter(Boolean).join(", ")}`);
    }
    // Demanded whenever a project-scope secret exists at all, including Key Vault ones that do not
    // touch the keystore: a rule that only bites once someone adds a local-backend secret would fail
    // late, in a repo that had been working.
    if (projectId === null && Object.values(secrets).some((d) => d.scope === "project")) {
        throw new VcSecretsError(`a project-scope secret is declared but projectId is not — add "projectId" to ${files.project ?? files.local} (it namespaces the keystore entries, so it cannot be derived)`);
    }

    // A project-declared server MAY reference a user-scope secret: one personal PAT used from several
    // repos is the ordinary case, and forbidding it would force a copy of that credential into every
    // project's namespace — three copies to rotate instead of one, which is worse than what the ban
    // bought. What replaces the ban is visibility: `doctor` reports each crossing, so it is a fact the
    // developer can see rather than one nobody mentions.

    return { secrets, servers, tasks, vaults, projectId, collisions, warnings, files };
}

// The keystore key. Project and local declarations share one namespace on purpose — they are the
// same project, so a locally declared server may use the project's secrets.
function keyFor(name, decl, cfg) {
    if (decl.scope === USER_SCOPE) {
        return `${KEY_PREFIX}:${USER_SCOPE}:${name}`;
    }

    return `${KEY_PREFIX}:${cfg.projectId}:${name}`;
}

// `kind` is "servers" or "tasks". Both are launchables with the same declaration shape; the only
// difference is who starts them — the MCP client, or a person running `task`.
async function resolveEnvEntries(name, cfg, resolveSecret, kind = "servers") {
    if (!Object.hasOwn(cfg[kind], name)) {
        throw new VcSecretsError(`unknown ${kind === "tasks" ? "task" : "server"} "${name}" — not declared in ${CONFIG_NAME}`);
    }
    const server = cfg[kind][name];
    // validate every reference BEFORE contacting any backend
    const entries = [];
    for (const [envVar, value] of Object.entries(server.env)) {
        const ref = parseReference(value);
        if (ref === null) {
            // loadConfig refuses any other shape, so this cannot be a bare value reaching the child.
            entries.push({ envVar, literal: parseLiteral(value) });
            continue;
        }
        if (!Object.hasOwn(cfg.secrets, ref.name)) {
            throw new VcSecretsError(`env ${envVar}: undeclared secret "${ref.name}"`);
        }
        const problem = crossingProblem(cfg, kind, name, ref.name);
        if (problem !== null) {
            throw new VcSecretsError(`env ${envVar}: this ${kind === "tasks" ? "task" : "server"} is `
                + `${problem.reason} to receive "${ref.name}" — the authorization for it lives at `
                + `${problem.where} in ${path.join("~", ".claude", CONFIG_NAME)}; `
                + `run "vc-secrets doctor" for the block to add`);
        }
        const decl = cfg.secrets[ref.name];
        if (ref.field !== null && decl.format !== "json") {
            throw new VcSecretsError(`env ${envVar}: field access on "${ref.name}" requires format: "json"`);
        }
        entries.push({ envVar, ref, decl });
    }

    const rawCache = new Map();
    const jsonCache = new Map();
    const result = {};
    for (const entry of entries) {
        if (entry.literal !== undefined) {
            result[entry.envVar] = entry.literal;
            continue;
        }
        const { ref, decl } = entry;
        if (!rawCache.has(ref.name)) {
            rawCache.set(ref.name, await resolveSecret(ref.name, decl));
        }
        const raw = rawCache.get(ref.name);
        if (ref.field === null) {
            result[entry.envVar] = raw;
            continue;
        }
        if (!jsonCache.has(ref.name)) {
            try {
                jsonCache.set(ref.name, JSON.parse(raw));
            } catch {
                throw new VcSecretsError(`secret "${ref.name}": content is not valid JSON`);
            }
        }
        const parsed = jsonCache.get(ref.name);
        if (typeof parsed[ref.field] !== "string") {
            throw new VcSecretsError(`secret "${ref.name}": missing string field "${ref.field}"`);
        }
        result[entry.envVar] = parsed[ref.field];
    }

    return result;
}

const TIMEOUT_LOCAL_MS = 10_000;
const TIMEOUT_AZ_MS = 20_000;
const LOCAL_BACKENDS = ["wcm", "keychain", "gpg"];
const VALUE_ON_STDIN = "<VALUE_ON_STDIN>";
// The whole command goes on stdin, not just the value: `security` has no stdin path for a password, but
// its interactive mode reads COMMANDS there, which keeps the value out of argv. spec.stdinCommand builds
// the line from the value runTool is handed.
const COMMAND_ON_STDIN = "<COMMAND_ON_STDIN>";

// Quoting for `security -i`'s own tokenizer: double quotes with backslash escapes. A newline cannot be
// quoted into it at all — it ends the command — so the caller must not offer one.
function quoteForSecurityInteractive(value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function detectLocalBackend(platform = process.platform, env = process.env) {
    const override = env.VC_SECRETS_LOCAL_BACKEND;
    if (override !== undefined) {
        if (!LOCAL_BACKENDS.includes(override)) {
            throw new VcSecretsError(`VC_SECRETS_LOCAL_BACKEND="${override}" — expected ${LOCAL_BACKENDS.join("|")}`);
        }
        return override;
    }
    if (platform === "win32") {
        return "wcm";
    }
    if (platform === "darwin") {
        return "keychain";
    }

    return "gpg";
}

function redactSecrets(text, values) {
    let out = text;
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
        if (value) {
            out = out.split(value).join("***");
        }
    }

    return out;
}

function secretsDir(env = process.env) {
    const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");

    return path.join(base, KEY_PREFIX, "secrets");
}

// Keys are "vc-secrets:<scope>:<name>" (see keyFor) — a directory per scope is clearer than
// colons in filenames, even though the latter would be legal on Linux; the gpg backend is
// Linux/WSL-only, so there is no Windows-path angle to weigh here.
function keyToPath(key, env = process.env) {
    const [, scope, name] = key.split(":");

    return path.join(secretsDir(env), scope, `${name}.gpg`);
}

// Pre-rename storage layout, read-only: cmdMigrate copies a value forward from here into the
// new namespaced key, but nothing ever writes to this path again.
function legacyKeyToPath(name, env = process.env) {
    const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");

    return path.join(base, LEGACY_KEY_PREFIX, "secrets", `${name}.gpg`);
}

// PowerShell 5.1 P/Invoke for Credential Manager (no built-in cmdlets exist).
// Passed via -EncodedCommand: immune to Windows argv re-quoting; -ExecutionPolicy Bypass
// covers restricted policies; if Constrained Language Mode blocks Add-Type, set
// VC_SECRETS_POWERSHELL=pwsh — record it in README.md when hit.
// The keystore key arrives via env var VC_SECRETS_NAME; the value (write path) arrives on stdin.
const PS_CRED_READ = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CredMan {
  [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
}
'@
$ptr=[IntPtr]::Zero
if(-not [CredMan]::CredRead("$env:VC_SECRETS_NAME",1,0,[ref]$ptr)){ exit 3 }
$c=[System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][CredMan+CREDENTIAL])
[Console]::Out.Write([System.Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob,$c.CredentialBlobSize/2))
`;

const PS_CRED_WRITE = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.Encoding]::UTF8
$value=[Console]::In.ReadToEnd().TrimEnd("\`r","\`n")
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CredManW {
  [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
}
'@
$blob=[System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($value)
$c=New-Object CredManW+CREDENTIAL
$c.Type=1; $c.TargetName="$env:VC_SECRETS_NAME"; $c.UserName=$env:USERNAME; $c.Persist=2
$c.CredentialBlob=$blob; $c.CredentialBlobSize=$value.Length*2
if(-not [CredManW]::CredWrite([ref]$c,0)){ exit 3 }
`;

function psEncode(script) {
    return Buffer.from(script, "utf16le").toString("base64");
}

function psCommand(env = process.env) {
    return env.VC_SECRETS_POWERSHELL || "powershell.exe";
}

function psArgs(script) {
    return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", psEncode(script)];
}

// grammar: "vc-secrets:" scope ":" name; scope and name both [a-z0-9-]+ (scope is "user" or a
// projectId — see keyFor).
// Built from KEY_PREFIX so the constant stays the single source of the key shape — a literal here
// would keep validating the old prefix after a rename, and every read would look correct.
const KEY_RE = new RegExp(`^${KEY_PREFIX}:[a-z0-9-]+:[a-z0-9-]+$`);

function buildLocalRead(backend, key, env = process.env) {
    if (!KEY_RE.test(key)) {
        throw new VcSecretsError(`invalid secret key "${key}" — expected vc-secrets:<scope>:<name>`);
    }
    if (backend === "wcm") {
        return { cmd: psCommand(env), args: psArgs(PS_CRED_READ),
            extraEnv: { VC_SECRETS_NAME: key }, timeoutMs: TIMEOUT_LOCAL_MS, captureStdout: true };
    }
    if (backend === "keychain") {
        return { cmd: "security", args: ["find-generic-password", "-a", env.USER || os.userInfo().username, "-s", key, "-w"],
            timeoutMs: TIMEOUT_LOCAL_MS, captureStdout: true };
    }

    // --pinentry-mode cancel (GnuPG >= 2.1): a cold agent fails fast instead of popping pinentry,
    // which the 10s kill timer would otherwise interrupt mid-typing. Interactive unlock (cmdUnlock)
    // builds its own args without this flag — that is the only place pinentry may appear.
    return { cmd: "gpg", args: ["--quiet", "--batch", "--pinentry-mode", "cancel", "--decrypt", keyToPath(key, env)],
        timeoutMs: TIMEOUT_LOCAL_MS, captureStdout: true, keepTrailingNewline: true };
}

function buildLocalWrite(backend, key, env = process.env, { tmp = false, value = undefined } = {}) {
    if (!KEY_RE.test(key)) {
        throw new VcSecretsError(`invalid secret key "${key}" — expected vc-secrets:<scope>:<name>`);
    }
    if (backend === "wcm") {
        return { cmd: psCommand(env), args: psArgs(PS_CRED_WRITE),
            extraEnv: { VC_SECRETS_NAME: key }, stdinData: VALUE_ON_STDIN, timeoutMs: TIMEOUT_LOCAL_MS, captureStdout: false };
    }
    if (backend === "keychain") {
        const account = env.USER || os.userInfo().username;
        // Three shapes, and the differences are load-bearing. `set`: `-w` with no value makes security
        // prompt on the TTY, so the plaintext never passes through this process at all.
        if (value === undefined) {
            return { cmd: "security", args: ["add-generic-password", "-U", "-a", account, "-s", key, "-w"],
                interactive: true, timeoutMs: null, captureStdout: false };
        }
        // `migrate`: there IS no value to type — the point is to copy one the user cannot read — and
        // `security` takes no password on stdin. Its interactive mode takes the whole COMMAND there, which
        // is what keeps the value out of argv and out of this machine's process list.
        if (!/[\r\n]/.test(value)) {
            return { cmd: "security", args: ["-i"], stdinData: COMMAND_ON_STDIN,
                stdinCommand: (v) => `add-generic-password -U -a ${quoteForSecurityInteractive(account)} `
                    + `-s ${quoteForSecurityInteractive(key)} -w ${quoteForSecurityInteractive(v)}\n`,
                timeoutMs: TIMEOUT_LOCAL_MS, captureStdout: false };
        }

        // A line ending cannot be quoted into that command — it ends it — so this one value takes the
        // older route and its exposure is reported rather than hidden. Refusing instead would strand the
        // secret: migrate exists for values the user cannot retype.
        return { cmd: "security", args: ["add-generic-password", "-U", "-a", account, "-s", key, "-w", value],
            argvExposesValue: true, timeoutMs: TIMEOUT_LOCAL_MS, captureStdout: false };
    }
    const recipientArgs = env.VC_SECRETS_GPG_RECIPIENT
        ? ["--recipient", env.VC_SECRETS_GPG_RECIPIENT, "--trust-model", "always"]
        : ["--default-recipient-self"];
    // Write to a `.tmp` sibling first so a mid-write crash/kill can never leave
    // a half-encrypted `<name>.gpg` in place of a previously-valid secret — cmdSet renames it in
    // after gpg exits 0.
    const target = `${keyToPath(key, env)}${tmp ? ".tmp" : ""}`;

    return { cmd: "gpg", args: ["--quiet", "--batch", "--yes", ...recipientArgs, "--encrypt", "-o", target],
        stdinData: VALUE_ON_STDIN, timeoutMs: TIMEOUT_LOCAL_MS, captureStdout: false };
}

// Shared by cmdSet's non-interactive branch and cmdMigrate: runs a write `spec` built with a
// value already in hand. gpg gets an atomic tmp-then-rename so a reader never observes a
// partially-written or empty file; the other backends write in one shot.
async function writeLocalValue(backend, key, spec, value, env = process.env) {
    if (backend !== "gpg") {
        await runTool(spec, { stdinValue: value, redactValues: [value] });
        return;
    }
    fs.mkdirSync(path.dirname(keyToPath(key, env)), { recursive: true, mode: 0o700 });
    const finalPath = keyToPath(key, env);
    const tmpPath = `${finalPath}.tmp`;
    try {
        await runTool(spec, { stdinValue: value, redactValues: [value] });
        fs.chmodSync(tmpPath, 0o600);
        fs.renameSync(tmpPath, finalPath);
    } catch (e) {
        try {
            if (fs.existsSync(tmpPath)) {
                fs.unlinkSync(tmpPath);
            }
        } catch { /* best-effort cleanup — the original error is what matters */ }
        throw e;
    }
}

function buildKeyvaultRead(decl) {
    return { cmd: "az", args: ["keyvault", "secret", "show", "--vault-name", decl.vault, "--name", decl.secret, "--query", "value", "-o", "tsv"],
        timeoutMs: TIMEOUT_AZ_MS, captureStdout: true };
}

function runTool(spec, { stdinValue, redactValues = [] } = {}) {
    return new Promise((resolve, reject) => {
        // Backend tools need the same .cmd-shim handling cmdRun gives the server command: on Windows
        // `az` exists only as az.cmd, and a shell-less spawn cannot execute a batch shim. Without this
        // the ENOENT below surfaces as "not found on PATH", misreading a working `az` as absent.
        const invocation = buildSpawnInvocation(resolveSpawnCommand(spec.cmd), spec.args);
        const child = spawn(invocation.cmd, invocation.args, {
            env: sanitizeEnv({ ...process.env, ...(spec.extraEnv || {}) }),
            stdio: spec.interactive ? "inherit" : ["pipe", spec.captureStdout ? "pipe" : "ignore", "pipe"],
            windowsHide: true,
            ...invocation.opts,
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = (!spec.interactive && typeof spec.timeoutMs === "number")
            ? setTimeout(() => {
                settled = true;
                child.kill("SIGKILL");
                reject(new VcSecretsError(`${spec.cmd} timed out after ${spec.timeoutMs} ms`));
            }, spec.timeoutMs)
            : null;
        const clear = () => {
            if (timer !== null) {
                clearTimeout(timer);
            }
        };

        child.on("error", (e) => {
            clear();
            if (!settled) {
                settled = true;
                reject(new VcSecretsError(`${spec.cmd}: ${e.code === "ENOENT" ? "not found on PATH" : e.message}`));
            }
        });
        if (child.stdout) {
            child.stdout.setEncoding("utf8");
            child.stdout.on("error", () => {});   // abrupt pipe teardown on SIGKILL (e.g. Windows ECONNRESET)
            child.stdout.on("data", (d) => { stdout += d; });
        }
        if (child.stderr) {
            child.stderr.setEncoding("utf8");
            child.stderr.on("error", () => {});   // abrupt pipe teardown on SIGKILL (e.g. Windows ECONNRESET)
            child.stderr.on("data", (d) => { stderr += d; });
        }
        if (!spec.interactive && child.stdin) {
            child.stdin.on("error", () => {});   // EPIPE if the tool dies before reading — surfaced via exit code
            if (spec.stdinData === VALUE_ON_STDIN && stdinValue !== undefined) {
                child.stdin.write(stdinValue);
            } else if (spec.stdinData === COMMAND_ON_STDIN && stdinValue !== undefined) {
                child.stdin.write(spec.stdinCommand(stdinValue));
            }
            child.stdin.end();
        }
        child.on("close", (code) => {
            clear();
            if (settled) {
                return;
            }
            settled = true;
            if (code !== 0) {
                const err = new VcSecretsError(`${spec.cmd} exited ${code}: ${redactSecrets(stderr.trim(), redactValues)}`);
                err.toolExitCode = code;
                reject(err);
                return;
            }
            // gpg --decrypt emits exactly the stored bytes, so stripping there would silently change a
            // value that really ends in a newline — fatal for migrate, which reads and then rewrites.
            // security -w and the PowerShell reader add their own line ending, so those keep the strip.
            resolve(spec.keepTrailingNewline ? stdout : stdout.replace(/\r?\n$/, ""));
        });
    });
}

// Reported by `doctor` as "a legacy plaintext value is still present" — everything a pre-vc-secrets
// setup could have held in a server's env block, credentials and identifiers alike.
const LEGACY_ENV_VARS = ["ADO_MCP_AUTH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
// Deleted from the child's env by cmdLaunch before injection — the narrower list, because a
// tenant/client ID is an identifier, not a secret: a server that legitimately inherits one from the
// ambient shell must not be made to fail with an auth error naming nothing related to this tool.
// Only the actual credentials are stripped so a stale plaintext token cannot leak into the child.
const LEGACY_SECRET_ENV_VARS = ["ADO_MCP_AUTH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN", "AZURE_CLIENT_SECRET"];

function resolveSpawnCommand(command, { platform = process.platform, env = process.env, existsSync = fs.existsSync } = {}) {
    const P = platform === "win32" ? path.win32 : path.posix;
    if (platform !== "win32" || P.extname(command) !== "" || /[\\/]/.test(command)) {
        return { kind: "direct", cmd: command };
    }
    const dirs = (env.Path || env.PATH || "").split(";").filter(Boolean);
    const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = P.join(dir, command + ext);
            if (!existsSync(candidate)) {
                continue;
            }
            const lower = ext.toLowerCase();
            if (lower === ".cmd" || lower === ".bat") {
                return { kind: "cmd-shim", cmd: candidate };   // shell-less spawn cannot run .cmd shims
            }
            return { kind: "direct", cmd: candidate };
        }
    }

    return { kind: "direct", cmd: command };   // let spawn produce its own ENOENT
}

function buildSpawnInvocation(resolved, args) {
    if (resolved.kind !== "cmd-shim") {
        return { cmd: resolved.cmd, args, opts: {} };
    }
    // cmd.exe /d /s /c ""<exe>" "<arg>"…" — verbatim line sidesteps cmd's outer-quote stripping
    const line = [resolved.cmd, ...args].map((a) => `"${a}"`).join(" ");

    return { cmd: "cmd.exe", args: [`/d /s /c "${line}"`], opts: { windowsVerbatimArguments: true } };
}

// Pure mapping so the advice contract can be unit-tested without spawning real
// backends: wcm "not found" (exit 3) / keychain "not found" (exit 44) both point at "vc-secrets set";
// any other gpg failure gets the "vc-secrets unlock" hint (file exists but decrypt failed, e.g. cold agent);
// everything else passes through unchanged.
function mapResolveError(backend, name, e) {
    if (backend === "wcm" && e.toolExitCode === 3) {
        return new VcSecretsError(`secret "${name}" not found in Credential Manager — run "vc-secrets set ${name}"`);
    }
    if (backend === "keychain" && e.toolExitCode === 44) {
        return new VcSecretsError(`secret "${name}" not found in Keychain — run "vc-secrets set ${name}"`);
    }
    if (backend === "gpg") {
        return new VcSecretsError(`${e.message} — if the gpg agent is locked, run "vc-secrets unlock" in a terminal`);
    }

    return e;
}

function makeSecretResolver(cfg, env = process.env) {
    const resolvedValues = [];
    const resolver = async (name, decl) => {
        const key = keyFor(name, decl, cfg);
        const backend = decl.backend === "keyvault" ? "keyvault" : detectLocalBackend(process.platform, env);
        if (backend === "gpg" && !fs.existsSync(keyToPath(key, env))) {
            throw new VcSecretsError(`secret "${name}" not set — run "vc-secrets set ${name}"`);
        }
        const spec = backend === "keyvault" ? buildKeyvaultRead(decl) : buildLocalRead(backend, key, env);
        let value;
        try {
            value = await runTool(spec, { redactValues: resolvedValues });
        } catch (e) {
            throw mapResolveError(backend, name, e);
        }
        if (value === "") {
            throw new VcSecretsError(`secret "${name}": backend returned empty value — run "vc-secrets set ${name}" (or check az login)`);
        }
        resolvedValues.push(value);
        return value;
    };
    resolver.resolvedValues = resolvedValues;

    return resolver;
}

function applyKeystrokes(state, chunk) {
    let { value } = state;
    for (const c of chunk) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
            return { value, done: true, cancelled: false };
        }
        if (c === "\u0003") {
            return { value: "", done: true, cancelled: true };
        }
        if (c === "\u007f" || c === "\b") {
            value = value.slice(0, -1);
            continue;
        }
        if (c < " ") {
            continue;   // other control chars
        }
        value += c;
    }

    return { value, done: false, cancelled: false };
}

function promptHidden(question) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY) {
            reject(new VcSecretsError("vc-secrets set requires an interactive terminal"));
            return;
        }
        process.stderr.write(question);
        const wasRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        process.stdin.resume();
        let state = { value: "" };
        const onData = (chunk) => {
            state = applyKeystrokes(state, chunk.toString("utf8"));
            if (!state.done) {
                return;
            }
            process.stdin.setRawMode(wasRaw);
            process.stdin.off("data", onData);
            process.stdin.pause();
            process.stderr.write("\n");
            if (state.cancelled) {
                process.exit(130);
            }
            resolve(state.value);
        };
        process.stdin.on("data", onData);
    });
}

async function cmdSet(name, cfg) {
    const decl = cfg.secrets[name];
    if (!decl) {
        throw new VcSecretsError(`unknown secret "${name}" — declare it in ${CONFIG_NAME} first`);
    }
    if (decl.backend !== "local") {
        throw new VcSecretsError(`secret "${name}" is backend "${decl.backend}" — set it in its own store, not via vc-secrets`);
    }
    const key = keyFor(name, decl, cfg);
    const backend = detectLocalBackend();
    const spec = buildLocalWrite(backend, key, process.env, { tmp: backend === "gpg" });
    if (spec.interactive) {
        await runTool(spec);                 // macOS: security prompts on the TTY; no timer
    } else {
        const value = await promptHidden(`value for "${name}" (hidden): `);
        if (!value) {
            throw new VcSecretsError("empty value — nothing stored");
        }
        await writeLocalValue(backend, key, spec, value, process.env);
    }
    process.stderr.write(`vc-secrets: stored "${name}" (${decl.scope}) in ${backend}\n`);
}

async function cmdUnlock(cfg) {
    if (detectLocalBackend() !== "gpg") {
        process.stderr.write("vc-secrets: unlock is a no-op on this platform\n");
        return;
    }
    if (!process.env.GPG_TTY) {
        // Guarded form on purpose: in a non-interactive shell `tty` prints "not a tty", and exporting
        // that hands gpg a bogus terminal path instead of leaving the variable unset.
        process.stderr.write("vc-secrets: GPG_TTY is not set — pinentry may fail; add `if [ -t 0 ]; then export GPG_TTY=$(tty); fi` to your shell rc\n");
    }
    // Legacy paths count. `migrate` documents `unlock` as its prerequisite, and before a migration NO
    // secret exists under a new key — so looking only there left the agent cold, and migrate then failed
    // on the very run it was supposed to enable. One decrypt warms the agent for all of them; the first
    // file that exists is enough.
    const files = [];
    for (const [name, decl] of Object.entries(cfg.secrets)) {
        if (decl.backend !== "local") {
            continue;
        }
        const current = keyToPath(keyFor(name, decl, cfg));
        const legacy = legacyKeyToPath(name);
        if (fs.existsSync(current)) {
            files.push({ name, file: current });
        } else if (fs.existsSync(legacy)) {
            files.push({ name: `${name} (legacy)`, file: legacy });
        }
    }
    if (files.length === 0) {
        process.stderr.write("vc-secrets: no stored local secrets to unlock\n");
        return;
    }
    for (const { file } of files) {
        // interactive: pinentry gets the TTY; -o /dev/null: plaintext never enters vc-secrets or the terminal
        await runTool({ cmd: "gpg", args: ["--quiet", "--decrypt", "-o", "/dev/null", file],
            interactive: true, timeoutMs: null, captureStdout: false });
    }
    process.stderr.write(`vc-secrets: gpg agent warmed (${files.map((f) => f.name).join(", ")})\n`);
}

// Pre-rename storage: wcm/keychain credential name was `mcpw:<name>` (no scope, no projectId —
// see legacyKeyToPath for the gpg equivalent). Returns null for "not found", never throws for it,
// so cmdMigrate can tell "nothing to migrate" from "backend actually failed".
async function readLegacyLocalValue(backend, name, env = process.env) {
    if (backend === "gpg") {
        const legacyPath = legacyKeyToPath(name, env);
        if (!fs.existsSync(legacyPath)) {
            return null;
        }

        return await runTool({ cmd: "gpg", args: ["--quiet", "--batch", "--pinentry-mode", "cancel", "--decrypt", legacyPath],
            timeoutMs: TIMEOUT_LOCAL_MS, captureStdout: true, keepTrailingNewline: true });
    }
    const legacyName = `${LEGACY_KEY_PREFIX}:${name}`;
    const spec = backend === "wcm"
        ? { cmd: psCommand(env), args: psArgs(PS_CRED_READ), extraEnv: { VC_SECRETS_NAME: legacyName }, timeoutMs: TIMEOUT_LOCAL_MS, captureStdout: true }
        : { cmd: "security", args: ["find-generic-password", "-a", env.USER || os.userInfo().username, "-s", legacyName, "-w"],
            timeoutMs: TIMEOUT_LOCAL_MS, captureStdout: true };
    try {
        return await runTool(spec);
    } catch (e) {
        // exit 3 (wcm) / 44 (keychain) both mean "not found" — same codes mapResolveError reads.
        if ((backend === "wcm" && e.toolExitCode === 3) || (backend === "keychain" && e.toolExitCode === 44)) {
            return null;
        }
        throw e;
    }
}

// "Is the new key already populated?" has to distinguish ABSENT from UNREADABLE. Treating every read
// failure as absence is what turns migrate into "write the pre-rotation value over the current one":
// a cold gpg agent, a timeout, or a decrypt to the wrong recipient all fail here, and the legacy read
// that follows succeeds — so the overwrite is committed and reported as a successful migration.
async function newKeyPresent(backend, key, env = process.env) {
    if (backend === "gpg") {
        return fs.existsSync(keyToPath(key, env));
    }
    try {
        await runTool(buildLocalRead(backend, key, env));

        return true;
    } catch (e) {
        // The only two codes that mean "no such entry"; everything else is an unreadable store.
        if ((backend === "wcm" && e.toolExitCode === 3) || (backend === "keychain" && e.toolExitCode === 44)) {
            return false;
        }
        throw e;
    }
}

async function cmdMigrate(cfg) {
    const backend = detectLocalBackend();
    const lines = [];
    let migrated = 0;
    let failed = 0;
    for (const [name, decl] of Object.entries(cfg.secrets)) {
        if (decl.backend !== "local") {
            continue;
        }
        const key = keyFor(name, decl, cfg);
        let present;
        try {
            present = await newKeyPresent(backend, key, process.env);
        } catch (e) {
            failed += 1;
            lines.push(`${name}: cannot tell whether it is already migrated, refusing to touch it — ${e.message}`);
            continue;
        }
        if (present) {
            lines.push(`${name}: already present`);
            continue;
        }

        let legacyValue;
        try {
            legacyValue = await readLegacyLocalValue(backend, name, process.env);
        } catch (e) {
            failed += 1;
            lines.push(`${name}: migration failed — ${e.message}`);
            continue;
        }
        if (legacyValue === null) {
            lines.push(`${name}: no legacy entry — run "vc-secrets set ${name}"`);
            continue;
        }

        try {
            const spec = buildLocalWrite(backend, key, process.env, { tmp: backend === "gpg", value: legacyValue });
            if (spec.argvExposesValue) {
                lines.push(`${name}: the value contains a line ending, so it passed through the command line of a `
                    + `short-lived process — visible to anything reading this machine's process list during the write`);
            }
            await writeLocalValue(backend, key, spec, legacyValue, process.env);
            if (backend === "keychain") {
                // Read back and compare. `security -i` reports a failed sub-command through an exit code
                // this loop cannot check on a machine without macOS, and a store that accepted something
                // other than what was handed to it must not be reported as a migration. gpg is left out:
                // its read needs a warm agent, so a cold one would fail a write that in fact succeeded.
                const stored = await runTool(buildLocalRead(backend, key, process.env), { redactValues: [legacyValue] });
                if (stored !== legacyValue) {
                    throw new VcSecretsError("the store returned a different value than was written — the legacy entry is untouched, migrate it by hand");
                }
            }
            migrated += 1;
            lines.push(`${name}: migrated`);
        } catch (e) {
            failed += 1;
            lines.push(`${name}: migration failed — ${e.message}`);
        }
    }
    // Deliberately no per-collision advice. project↔local collisions share one namespace, so there is no
    // second key to mention; a user↔project collision DOES leave the user-scope key unwritten, but the
    // legacyOnly probe in `doctor` reports exactly that, by name, and the legacy entry stays in place —
    // so the guidance belongs where it can be re-checked rather than in a one-shot line printed here.
    lines.push(`vc-secrets: migrate — ${migrated} migrated, ${failed} failed`);
    // sync write: stderr is an async pipe on Windows, and process.exit abandons pending writes
    fs.writeSync(2, lines.join("\n") + "\n");
    if (failed > 0) {
        process.exit(1);
    }
}

function readEnableLists(file) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return { enabled: [], disabled: [], envKeys: [] };
    }

    const env = parsed.env;
    const hasEnvObject = env !== null && typeof env === "object" && !Array.isArray(env);

    return {
        enabled: Array.isArray(parsed.enabledMcpjsonServers) ? parsed.enabledMcpjsonServers : [],
        disabled: Array.isArray(parsed.disabledMcpjsonServers) ? parsed.disabledMcpjsonServers : [],
        envKeys: hasEnvObject ? Object.keys(env) : [],   // names only; values are never read
    };
}

// Which servers already launch through this tool. Reading the project's .mcp.json alone was not enough:
// a personal server is wired with `claude mcp add-json --scope user|local`, which writes ~/.claude.json,
// so for a user-scope-only setup nothing looked wired — and `doctor` then advised keeping a plaintext
// token that is already dead. Both files are read, and ~/.claude.json carries per-project blocks too.
function readWiredServers(mcpJsonPath, userJsonPath = null, projectRoot = null, problems = []) {
    const wired = new Set();
    // Case-insensitive, and across `command` too. The documented entry carries `${VC_SECRETS}` — which
    // does not contain the lowercase string — so a case-sensitive args-only match failed on exactly the
    // configuration this plugin tells people to write, leaving `wired` empty and the legacy-token advice
    // stuck at "still required".
    const mentionsLauncher = (v) => typeof v === "string" && v.toLowerCase().includes("vc-secrets")
        || typeof v === "string" && v.toUpperCase().includes("VC_SECRETS");
    const collect = (mcpServers) => {
        for (const [name, entry] of Object.entries(mcpServers ?? {})) {
            const fields = [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])];
            if (fields.some(mentionsLauncher)) {
                wired.add(name);
            }
        }
    };
    // An unreadable file is not "nothing is wired": that answer silently restores the advice this
    // function exists to correct, and `doctor` is where an unreadable input must be said out loud.
    const load = (file) => {
        try {
            return JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (e) {
            if (fs.existsSync(file)) {
                problems.push(`${file}: cannot be read (${e.message}) — treating it as no wiring, so advice about leftover tokens may be wrong`);
            }

            return null;
        }
    };

    if (mcpJsonPath) {
        collect(load(mcpJsonPath)?.mcpServers);
    }
    const userJson = userJsonPath ? load(userJsonPath) : null;
    if (userJson) {
        collect(userJson.mcpServers);   // --scope user really is machine-wide
        // Per-project blocks are NOT. Collecting all of them made "wired" machine-global, and `wired`
        // is what flips the legacy-token line from "still required" to "remove it" — so a repo wired
        // here would make `doctor` advise deleting a plaintext token that a DIFFERENT, unmigrated repo
        // still needs. Server names like `github` collide across repos by convention, so this is the
        // ordinary case, not a corner: only the block for the project being diagnosed is read.
        for (const [dir, project] of Object.entries(userJson.projects ?? {})) {
            if (projectRoot && canonicalPath(dir) === canonicalPath(projectRoot)) {
                collect(project?.mcpServers);
            }
        }
    }

    return wired;
}

function doctorReport(cfg, { env, platform, enableLists, resolvable, skipped, toolsMissing, wired, configDirOverride, legacyOnly = [], shimContract = null, wiringProblems = [] }) {
    const lines = [];
    const loadedFiles = Object.entries(cfg.files ?? {}).map(([scope, file]) => `${scope}=${file}`).join(", ");
    if (loadedFiles) {
        lines.push(`INFO config files loaded: ${loadedFiles}`);
    }
    for (const warning of cfg.warnings ?? []) {
        lines.push(`WARN ${warning}`);
    }
    for (const collision of cfg.collisions ?? []) {
        lines.push(`WARN ${collision.kind} "${collision.name}" declared in both ${collision.from} and ${collision.to} — ${collision.to} wins`);
    }
    let backend = null;
    try {
        backend = detectLocalBackend(platform, env);
    } catch (e) {
        lines.push(`FAIL ${e.message}`);   // report, never crash the diagnostic tool
    }
    if (configDirOverride) {
        lines.push("WARN VC_SECRETS_CONFIG_DIR is set — vc-secrets is reading a non-default config");
    }
    for (const problem of wiringProblems) {
        lines.push(`WARN ${problem}`);
    }
    // settings.local.json is where a stale token actually lives; the session env only carries it
    // when something exported it. Reporting the file is what makes the message actionable —
    // `doctor` run from a plain terminal never sees the file's env block in its own process.
    const fileEnvKeys = enableLists.envKeys ?? [];
    for (const varName of LEGACY_ENV_VARS) {
        let where = null;
        if (fileEnvKeys.includes(varName)) {
            where = "settings.local.json env";
        } else if (varName in env) {
            where = "session env";
        }
        if (where === null) {
            continue;
        }
        lines.push(wired.size > 0
            ? `WARN ${varName} present in ${where} — remove it (servers now read via vc-secrets)`
            : `INFO ${varName} present in ${where} — still required until the vc-secrets switch lands`);
    }
    for (const tool of toolsMissing) {
        lines.push(`FAIL required tool "${tool}" not found on PATH`);
    }
    const legacyOnlySet = new Set(legacyOnly);
    for (const [name, status] of Object.entries(resolvable)) {
        if (status === true) {
            lines.push(`OK secret "${name}" resolvable`);
        } else if (legacyOnlySet.has(name)) {
            // Not a FAIL: the secret exists, just not yet under the new key — migrate resolves it.
            lines.push(`WARN secret "${name}" is only under the legacy key — run "vc-secrets migrate"`);
        } else if (typeof status === "string") {
            // A missing "az"/"gpg"/etc. already produced its own "required tool ... not found on PATH"
            // FAIL above; repeating it once per secret that needs the same tool is noise, not signal.
            // Not anchored at the end: mapResolveError appends backend-specific advice for gpg, so a
            // trailing anchor matched every backend except the one Linux and WSL actually use.
            const missingTool = /^(\S+): not found on PATH/.exec(status)?.[1];
            if (missingTool && toolsMissing.includes(missingTool)) {
                continue;
            }
            lines.push(`FAIL secret "${name}" not resolvable — ${status}`);
        } else {
            lines.push(`FAIL secret "${name}" not resolvable — run "vc-secrets set ${name}" (local) or check az login (keyvault)`);
        }
    }
    for (const name of skipped) {
        lines.push(`SKIP secret "${name}" (keyvault) — no enabled server consumes it; use --all to force`);
    }
    // Tasks carry the same env references as servers, so an unchecked task would be the one place a
    // typo'd or undeclared reference survives until someone actually runs it.
    for (const [label, map] of [["server", cfg.servers], ["task", cfg.tasks ?? {}]]) {
        for (const [srvName, srv] of Object.entries(map)) {
            for (const [envVar, value] of Object.entries(srv.env)) {
                try {
                    const ref = parseReference(value);
                    if (ref !== null && !Object.hasOwn(cfg.secrets, ref.name)) {
                        lines.push(`FAIL ${label} "${srvName}" env ${envVar}: undeclared secret "${ref.name}"`);
                    }
                } catch (e) {
                    lines.push(`FAIL ${label} "${srvName}" env ${envVar}: ${e.message}`);
                }
            }
        }
    }
    // Crossing from a project declaration to a personal secret is allowed and often intended, but it is
    // the one relationship a reader of either file alone cannot see: the project file names a secret it
    // did not declare, and the user file has no idea who consumes it.
    for (const [kind, map] of [["servers", cfg.servers], ["tasks", cfg.tasks ?? {}]]) {
        const label = kind === "tasks" ? "task" : "server";
        for (const [name, decl] of Object.entries(map)) {
            if (decl.home === USER_SCOPE) {
                continue;   // you wrote both sides; there is no grant to report
            }
            const reported = new Set();
            for (const value of Object.values(decl.env)) {
                let ref = null;
                try {
                    ref = parseReference(value);
                } catch { /* reported as a FAIL above */ }
                if (ref === null || reported.has(ref.name)) {
                    continue;
                }
                const sdecl = cfg.secrets[ref.name];
                // Only references that need authorizing are worth a line: a project-declared `local`
                // secret is namespaced to the project, so there is no grant to report either way.
                if (!sdecl || authorizationFor(cfg, { ...sdecl, declaredName: ref.name }) === null) {
                    continue;
                }
                reported.add(ref.name);
                const problem = crossingProblem(cfg, kind, name, ref.name);
                if (problem === null) {
                    lines.push(`INFO ${label} "${name}" (${decl.home}) is authorized to receive "${ref.name}"`);
                    continue;
                }
                // The block, not advice about the block: what stands between the reader and a working
                // launch is one paste, and asking them to translate a diff into JSON adds a way to get it
                // wrong. A shape they can read is also a shape they can refuse.
                const shape = JSON.stringify({ [name]: problem.actual }, null, 2).split("\n").map((l) => `       ${l}`).join("\n");
                lines.push(`FAIL ${label} "${name}" (${decl.home}) wants "${ref.name}" and is ${problem.reason}.`
                    + `\n     Read the command below; if you want it to have that secret, put this under`
                    + ` ${problem.where}.${kind} in ~/.claude/${CONFIG_NAME}:\n${shape}`);
            }
        }
    }
    if (typeof shimContract === "number" && shimContract < REQUIRED_SHIM_CONTRACT) {
        lines.push(`WARN the installed shim speaks contract ${shimContract}, this launcher expects ${REQUIRED_SHIM_CONTRACT} — re-run /vc-secrets:install`);
    }
    if (backend !== null && lines.length === 0) {
        lines.push(`OK platform=${platform} backend=${backend} — nothing to report`);
    }

    return lines;
}

function commandOnPath(tool) {
    const probe = process.platform === "win32" ? "where" : "which";

    return spawnSync(probe, [tool], { stdio: "ignore", windowsHide: true }).status === 0;
}

const DOCTOR_FLAGS = ["--all"];

async function cmdDoctor(cfg, flags = []) {
    // An unrecognized flag used to be ignored, so `doctor --al` printed the same SKIP as a run
    // with no flag at all — output indistinguishable from "checked it and skipped". A diagnostic
    // that silently drops what it doesn't understand reports a state that was never checked.
    const unknown = flags.filter((f) => !DOCTOR_FLAGS.includes(f));
    if (unknown.length > 0) {
        throw new VcSecretsError(`doctor: unknown argument "${unknown[0]}" (expected only ${DOCTOR_FLAGS.join(", ")})`);
    }
    const checkAll = flags.includes("--all");
    // .claude/vc-secrets.json's directory anchors both files: settings.local.json is its sibling,
    // .mcp.json is one directory above. No project declaration → nothing to anchor on, so both
    // checks are skipped rather than guessed at — a missing project is not itself a fault.
    const projectFile = cfg.files.project ?? cfg.files.local;
    const claudeDir = projectFile ? path.dirname(projectFile) : null;
    const enableLists = claudeDir ? readEnableLists(path.join(claudeDir, "settings.local.json")) : { enabled: [], disabled: [], envKeys: [] };
    const wiringProblems = [];
    const wired = readWiredServers(
        claudeDir ? path.join(claudeDir, "..", ".mcp.json") : null,
        path.join(process.env.HOME || os.homedir(), ".claude.json"),
        claudeDir ? path.dirname(claudeDir) : null,
        wiringProblems);

    // which secrets does an ENABLED (or wired) server actually consume? A task has no enable list —
    // it is run on purpose — so anything it references counts as consumed, otherwise a Key Vault
    // secret used only by a task would be reported SKIP and never checked. Servers and tasks are
    // iterated separately so a task cannot mark a same-named SERVER enabled merely by existing — that
    // would drop the SKIP that keeps a teammate's `doctor` from FAILing on a Key Vault secret they
    // cannot reach.
    const consumed = new Set();
    const addConsumed = (srv, enabled) => {
        for (const value of Object.values(srv.env)) {
            try {
                const ref = parseReference(value);
                if (ref !== null && (enabled || cfg.secrets[ref.name]?.backend === "local")) {
                    consumed.add(ref.name);
                }
            } catch { /* reported by doctorReport */ }
        }
    };
    for (const [srvName, srv] of Object.entries(cfg.servers)) {
        addConsumed(srv, enableLists.enabled.includes(srvName) || wired.has(srvName));
    }
    for (const task of Object.values(cfg.tasks ?? {})) {
        addConsumed(task, true);
    }

    let localBackend = null;
    try {
        localBackend = detectLocalBackend();
    } catch { /* reported via doctorReport */ }

    const resolver = makeSecretResolver(cfg);
    const resolvable = {};
    const skipped = [];
    const legacyOnly = [];
    for (const [name, decl] of Object.entries(cfg.secrets)) {
        if (decl.backend === "keyvault" && !checkAll && !consumed.has(name)) {
            skipped.push(name);   // opt-in servers must not turn the team's doctor red
            continue;
        }
        try {
            await resolver(name, decl);
            resolvable[name] = true;
        } catch (e) {
            resolvable[name] = e && e.message ? e.message : false;
            if (decl.backend === "local" && localBackend !== null) {
                try {
                    if ((await readLegacyLocalValue(localBackend, name, process.env)) !== null) {
                        legacyOnly.push(name);
                    }
                } catch { /* a broken legacy probe doesn't change this secret's own FAIL */ }
            }
        }
    }
    resolver.resolvedValues.length = 0;

    const backendTools = localBackend === "wcm" ? [psCommand()] : localBackend === "keychain" ? ["security"] : localBackend === "gpg" ? ["gpg"] : [];
    const needsAz = Object.values(cfg.secrets).some((d) => d.backend === "keyvault")
        && (checkAll || [...consumed].some((n) => cfg.secrets[n]?.backend === "keyvault"));
    const toolsMissing = [...backendTools, ...(needsAz ? ["az"] : [])].filter((t) => !commandOnPath(t));

    const lines = doctorReport(cfg, {
        env: process.env, platform: process.platform, enableLists, resolvable, skipped,
        toolsMissing, wired, configDirOverride: Boolean(process.env.VC_SECRETS_CONFIG_DIR), legacyOnly,
        shimContract: activeShimContract, wiringProblems,
    });
    // sync write: stderr is an async pipe on Windows, and process.exit abandons pending writes
    fs.writeSync(2, lines.join("\n") + "\n");
    if (lines.some((l) => l.startsWith("FAIL"))) {
        process.exit(1);
    }
}

// One launch path for both kinds. A `task` is not an MCP server, but everything that matters here is
// the same: resolve, strip the inherited legacy vars, inject into this child only, forward stdio, and
// take the whole process group down on a signal. Giving tasks their own copy of this is how the two
// would drift on the parts that are security-relevant.
async function cmdLaunch(kind, name, cfg) {
    const startedAt = process.hrtime.bigint();
    const resolver = makeSecretResolver(cfg);
    const secretEnv = await resolveEnvEntries(name, cfg, resolver, kind);
    if (process.env.VC_SECRETS_TIMING === "1") {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        process.stderr.write(`vc-secrets: resolve phase took ${ms.toFixed(0)} ms\n`);   // budget measurement
    }
    const server = cfg[kind][name];
    const childEnv = sanitizeEnv(process.env);
    for (const varName of LEGACY_SECRET_ENV_VARS) {
        if (!(varName in secretEnv)) {
            delete childEnv[varName];   // a stale session token must not leak into the child
        }
    }
    Object.assign(childEnv, secretEnv);

    const invocation = buildSpawnInvocation(resolveSpawnCommand(server.command), server.args);
    const child = spawn(invocation.cmd, invocation.args, {
        stdio: "inherit",
        env: childEnv,
        detached: process.platform !== "win32",   // own process group → we can kill the whole tree
        ...invocation.opts,
    });
    resolver.resolvedValues.length = 0;   // shrink the in-heap window

    const killTree = (signal) => {
        if (process.platform === "win32") {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
            return;
        }
        try {
            process.kill(-child.pid, signal);
        } catch {
            child.kill(signal);
        }
        setTimeout(() => {
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch { /* group already gone */ }
        }, 5000).unref();
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => killTree(signal));
    }
    child.on("error", (e) => {
        // sync write: stderr is an async pipe on Windows, and process.exit abandons pending writes
        fs.writeSync(2, `vc-secrets: failed to spawn ${server.command}: ${e.message}\n`);
        process.exit(1);
    });
    child.on("close", (code, signal) => {
        process.exit(signal ? 1 : (code ?? 1));   // signal collapse to 1 is accepted
    });
}

function cmdRun(serverName, cfg) {
    return cmdLaunch("servers", serverName, cfg);
}

// The declared-task counterpart of `run`. There is deliberately no verb that takes a command from the
// caller: a task's argv lives in the declaration, so it is reviewed in a PR like a server's, and the
// tool still has no way to print a secret or route one into something chosen at the call site.
function cmdTask(taskName, cfg) {
    return cmdLaunch("tasks", taskName, cfg);
}

// --- CLI entry ---
function fail(e) {
    // sync write: stderr is an async pipe on Windows, and process.exit abandons pending writes
    fs.writeSync(2, `vc-secrets: ${e?.message ?? String(e)}\n`);   // one line, no stack
    process.exit(e instanceof VcSecretsError ? e.exitCode : 1);
}

// Raised only when the shim's own contract changes. `doctor` compares it against what the shim
// reported so a stale shim says so itself — the failure it would otherwise cause (an old pointer to a
// launcher whose entry contract moved) surfaces as a missing export, which reads like a broken install.
const REQUIRED_SHIM_CONTRACT = 1;
let activeShimContract = null;

const VERBS = ["run", "task", "set", "unlock", "doctor", "migrate"];
const USAGE = `usage: vc-secrets <${VERBS.join("|")}> [name]`;

async function main(argv) {
    const [command, arg] = argv;
    // Usage and the diagnostic must survive a machine with no declarations at all: `doctor` is what
    // you reach for when nothing works, so it reports the missing file as a FAIL instead of dying on
    // it. Every other verb genuinely needs a declaration and fails as before.
    if (!VERBS.includes(command)) {
        throw new VcSecretsError(USAGE);
    }
    let cfg;
    try {
        cfg = loadConfig();
    } catch (e) {
        if (command !== "doctor") {
            throw e;
        }
        fs.writeSync(2, `FAIL ${e.message}\n`);
        process.exit(1);
    }
    if (command === "run" && arg) {
        await cmdRun(arg, cfg);
        return;
    }
    if (command === "set" && arg) {
        await cmdSet(arg, cfg);
        return;
    }
    if (command === "task" && arg) {
        await cmdTask(arg, cfg);
        return;
    }
    if (command === "unlock") {
        await cmdUnlock(cfg);
        return;
    }
    if (command === "doctor") {
        await cmdDoctor(cfg, argv.slice(1));
        return;
    }
    if (command === "migrate") {
        await cmdMigrate(cfg);
        return;
    }
    throw new VcSecretsError(USAGE);   // a known verb reached here missing its required argument
}

// The single entry point, used both by direct invocation below and by the shim — which cannot rely on
// the gate at the bottom, because when the shim runs it is argv[1], not this file. Two entry paths
// diverging is how the wrapped and unwrapped invocations start behaving differently.
async function runCli(argv, { shimContract } = {}) {
    if (typeof shimContract === "number") {
        activeShimContract = shimContract;
    }
    process.on("uncaughtException", fail);
    process.on("unhandledRejection", fail);

    return main(argv).catch(fail);
}

export {
    runCli, REQUIRED_SHIM_CONTRACT,
    VcSecretsError, REF_RE, parseReference, parseLiteral, LITERAL_PREFIX, CONFIG_NAME, LOCAL_CONFIG_NAME, KEY_PREFIX,
    SCHEMA_VERSION, SCOPE_ORDER, configPaths, parseConfigFile, loadConfig, keyFor, keyToPath, legacyKeyToPath,
    resolveEnvEntries, detectLocalBackend, redactSecrets, secretsDir, psEncode, psCommand, PS_CRED_READ, PS_CRED_WRITE,
    buildLocalRead, buildLocalWrite, buildKeyvaultRead, TIMEOUT_LOCAL_MS, TIMEOUT_AZ_MS, VALUE_ON_STDIN,
    COMMAND_ON_STDIN, quoteForSecurityInteractive,
    runTool, resolveSpawnCommand, buildSpawnInvocation, makeSecretResolver, cmdRun, cmdTask, cmdLaunch,
    validateLaunchables, LEGACY_ENV_VARS, LEGACY_SECRET_ENV_VARS,
    mapResolveError, applyKeystrokes, promptHidden, cmdSet, cmdUnlock, cmdDoctor, cmdMigrate, newKeyPresent,
    SECRET_NAME_RE, LAUNCHABLE_NAME_RE, doctorReport,
    readEnableLists, readWiredServers, DANGEROUS_ENV_VARS, sanitizeEnv,
    consumerShape, shapeDifferences, validateAuthorized, validateVaults, authorizationFor, crossingProblem, own,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    runCli(process.argv.slice(2));
}

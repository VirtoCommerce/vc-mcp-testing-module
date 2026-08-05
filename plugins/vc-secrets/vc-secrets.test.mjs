import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as m from "./vc-secrets.mjs";

const LAUNCHER_PATH = fileURLToPath(new URL("./vc-secrets.mjs", import.meta.url));

const tmpDirs = [];
after(() => {
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Writes a single project-scope declaration file and returns its containing directory — for tests
// that only care about VC_SECRETS_CONFIG_DIR-style single-home config (most structural checks).
function tmpConfigDir(cfg) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, m.CONFIG_NAME), JSON.stringify(cfg));
    return dir;
}

// Same, but returns the {user, project, local} paths object loadConfig now takes directly.
function projectPaths(cfg) {
    return { user: null, project: path.join(tmpConfigDir(cfg), m.CONFIG_NAME), local: null };
}

// Writes up to three homes into one tmp directory under distinct filenames and returns the paths
// object — for precedence/collision/projectId tests that need more than one scope populated.
function scopedPaths({ user, project, local } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-scopes-"));
    tmpDirs.push(dir);
    const write = (name, cfg) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, JSON.stringify(cfg));
        return file;
    };

    return {
        user: user ? write("user.json", user) : null,
        project: project ? write("project.json", project) : null,
        local: local ? write("local.json", local) : null,
    };
}

test("parseReference: plain name", () => {
    assert.deepEqual(m.parseReference("secret:ado-pat"), { name: "ado-pat", field: null });
});

test("parseReference: name with field", () => {
    assert.deepEqual(m.parseReference("secret:azure-monitor-sp.tenantId"), { name: "azure-monitor-sp", field: "tenantId" });
});

test("parseReference: non-reference is null (literal passthrough)", () => {
    assert.equal(m.parseReference("plain-value"), null);
});

test("parseReference: invalid chars in name → VcSecretsError", () => {
    assert.throws(() => m.parseReference("secret:Bad_Name"), m.VcSecretsError);
});

test("parseLiteral: only an explicit prefix is a literal, and the prefix is stripped once", () => {
    assert.equal(m.parseLiteral("literal:as-is"), "as-is");
    assert.equal(m.parseLiteral("literal:"), "");
    // A value that really begins with the prefix: strip once, keep the rest verbatim.
    assert.equal(m.parseLiteral("literal:literal:x"), "literal:x");
    assert.equal(m.parseLiteral("plain"), null);
    assert.equal(m.parseLiteral("secrets:ado-pat"), null);
});

test("loadConfig: reads and validates, entries carry their scope", () => {
    const cfg = { projectId: "proj-x", secrets: { "ado-pat": { backend: "local" } }, servers: { github: { command: "x", args: [], env: {} } } };
    const loaded = m.loadConfig(projectPaths(cfg));
    assert.equal(loaded.secrets["ado-pat"].backend, "local");
    assert.equal(loaded.secrets["ado-pat"].scope, "project");
    assert.equal(loaded.servers.github.scope, "project");
});

test("loadConfig: missing file → VcSecretsError", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-empty-"));
    tmpDirs.push(dir);
    assert.throws(() => m.loadConfig({ user: null, project: path.join(dir, m.CONFIG_NAME), local: null }), m.VcSecretsError);
});

test("loadConfig: unknown backend → VcSecretsError", () => {
    const cfg = { secrets: { x: { backend: "nope" } }, servers: {} };
    assert.throws(() => m.loadConfig(projectPaths(cfg)), m.VcSecretsError);
});

test("loadConfig: bad format / non-string args / non-string env → VcSecretsError", () => {
    assert.throws(() => m.loadConfig(projectPaths({
        secrets: { x: { backend: "local", format: "xml" } }, servers: {} })), /format/);
    assert.throws(() => m.loadConfig(projectPaths({
        secrets: {}, servers: { s: { command: "x", args: [1], env: {} } } })), /args/);
    assert.throws(() => m.loadConfig(projectPaths({
        secrets: {}, servers: { s: { command: "x", args: [], env: { A: null } } } })), /env/);
});

test("loadConfig: null secret entry → VcSecretsError", () => {
    assert.throws(() => m.loadConfig(projectPaths({ secrets: { x: null }, servers: {} })), m.VcSecretsError);
});

test("loadConfig: null server entry → VcSecretsError", () => {
    assert.throws(() => m.loadConfig(projectPaths({ secrets: {}, servers: { s: null } })), m.VcSecretsError);
});

test("loadConfig: array-shaped secrets/servers → VcSecretsError", () => {
    assert.throws(() => m.loadConfig(projectPaths({ secrets: [], servers: [] })), m.VcSecretsError);
});

test("loadConfig: unknown top-level key → warning, not a throw", () => {
    const cfg = { secrets: {}, servers: {}, extra: 1 };
    const loaded = m.loadConfig(projectPaths(cfg));
    assert.ok(loaded.warnings.some((w) => w.includes('unknown key "extra"')));
});

test("loadConfig: unknown key inside a secret declaration still throws", () => {
    const cfg = { secrets: { x: { backend: "local", bogus: 1 } }, servers: {} };
    assert.throws(() => m.loadConfig(projectPaths(cfg)), /secret "x".*unknown key "bogus"/);
});

test("loadConfig: unknown key inside a server declaration still throws", () => {
    const cfg = { secrets: {}, servers: { s: { command: "x", args: [], env: {}, bogus: 1 } } };
    assert.throws(() => m.loadConfig(projectPaths(cfg)), /server "s".*unknown key "bogus"/);
});

test("loadConfig: empty or whitespace-only command → VcSecretsError", () => {
    assert.throws(
        () => m.loadConfig(projectPaths({ secrets: {}, servers: { s: { command: "", args: [], env: {} } } })),
        /server "s".*"command" must not be empty/);
    assert.throws(
        () => m.loadConfig(projectPaths({ secrets: {}, servers: { s: { command: "   ", args: [], env: {} } } })),
        /server "s".*"command" must not be empty/);
});

test("loadConfig: dangerous env key in server declaration → VcSecretsError", () => {
    const cfg = { secrets: {}, servers: { s: { command: "x", args: [], env: { LD_PRELOAD: "p" } } } };
    assert.throws(() => m.loadConfig(projectPaths(cfg)), /LD_PRELOAD/);
});

test("loadConfig: precedence local > project within a project, per kind, and the winner keeps its scope", () => {
    const home = (tag) => ({
        projectId: "proj-x",
        secrets: { shared: { backend: "keyvault", vault: `vault-${tag}`, secret: "s" } },
        servers: { shared: { command: `cmd-${tag}`, args: [], env: {} } },
        tasks: { shared: { command: `cmd-${tag}`, args: [], env: {} } },
    });
    const paths = scopedPaths({ project: home("project"), local: home("local") });
    const cfg = m.loadConfig(paths);
    assert.equal(cfg.secrets.shared.vault, "vault-local");
    assert.equal(cfg.secrets.shared.scope, "project", "a local-scope secret keys the same namespace as project");
    assert.equal(cfg.servers.shared.command, "cmd-local");
    assert.equal(cfg.servers.shared.scope, "local");
    assert.equal(cfg.tasks.shared.command, "cmd-local");
    assert.equal(cfg.tasks.shared.scope, "local");
});

test("loadConfig: a project shadowing a user-scope name wins, as in the client, and the collision is reported", () => {
    // The client's documented order for a server defined in several scopes is local, then project, then
    // user, whole entry from the winner. Diverging from it would be an exception every reader has to
    // remember; the ambiguity is answered by reporting the collision, not by refusing to load.
    const paths = scopedPaths({
        user: { servers: { shared: { command: "cmd-user", args: [], env: {} } } },
        project: { projectId: "proj-x", servers: { shared: { command: "cmd-project", args: [], env: {} } } },
    });
    const cfg = m.loadConfig(paths);
    assert.equal(cfg.servers.shared.command, "cmd-project");
    assert.equal(cfg.servers.shared.home, "project");
    assert.deepEqual(cfg.collisions, [{ kind: "server", name: "shared", from: "user", to: "project" }]);
});

test("loadConfig: a project secret shadowing a user-scope name keys the PROJECT namespace", () => {
    // The point of the two fields: the winner's `home` is project, so its key is the project's — the
    // personal value under vc-secrets:user:<name> is not what the project's server will read.
    const paths = scopedPaths({
        user: { secrets: { shared: { backend: "local" } } },
        project: { projectId: "proj-x", secrets: { shared: { backend: "local" } } },
    });
    const cfg = m.loadConfig(paths);
    assert.equal(m.keyFor("shared", cfg.secrets.shared, cfg), `${m.KEY_PREFIX}:proj-x:shared`);
});

const CROSSING_SHAPE = { command: "npx", args: ["-y", "gh-mcp"], envKeys: ["T"] };

function crossingPaths(authorized) {
    const secret = { backend: "local" };
    if (authorized !== undefined) {
        secret.authorized = authorized;
    }

    return scopedPaths({
        user: { secrets: { "personal-pat": secret } },
        project: { projectId: "proj-x", servers: { gh: { command: "npx", args: ["-y", "gh-mcp"], env: { T: "secret:personal-pat" } } } },
    });
}

function crossingReport(cfg) {
    return m.doctorReport(cfg, {
        env: {}, platform: "linux", enableLists: { enabled: [], disabled: [], envKeys: [] },
        resolvable: {}, skipped: [], toolsMissing: [], wired: new Set(),
    });
}

test("a project declaration cannot take a user-scope secret by naming it — the owner authorizes the shape", async () => {
    // The gate above this one does not cover it: what the MCP client approves is `node $VC_SECRETS run gh`,
    // and the declaration deciding what `gh` runs sits below that. So naming the secret is not consent.
    const cfg = m.loadConfig(crossingPaths(undefined));
    let called = false;
    await assert.rejects(
        () => m.resolveEnvEntries("gh", cfg, async () => { called = true; return "tok"; }),
        /not authorized to receive "personal-pat"/);
    assert.equal(called, false, "the backend must not be contacted for a launch that is refused");

    // The config still LOADS: doctor's job is to report this, which it cannot do if the load throws.
    const lines = crossingReport(cfg);
    const fail = lines.find((l) => l.startsWith("FAIL") && l.includes('server "gh"'));
    assert.ok(fail, `expected a FAIL naming the server, got:\n${lines.join("\n")}`);
    assert.match(fail, /not authorized/);
    // The block to paste, not advice about it: a reader translating a description into JSON is a reader
    // given one more way to get it wrong.
    assert.match(fail, /"command": "npx"/);
    assert.match(fail, /"envKeys": \[\s*"T"\s*\]/);
    assert.match(fail, /authorized\.servers/);
});

test("an authorized shape passes, and its authorization is reported rather than silent", async () => {
    const cfg = m.loadConfig(crossingPaths({ servers: { gh: CROSSING_SHAPE } }));
    assert.deepEqual(await m.resolveEnvEntries("gh", cfg, async () => "tok"), { T: "tok" });

    const lines = crossingReport(cfg);
    assert.ok(lines.some((l) => l.startsWith("INFO") && l.includes('server "gh"') && l.includes("personal-pat")),
        `expected the authorized crossing to be reported, got:\n${lines.join("\n")}`);
});

test("changing the command behind an authorized name stops the launch — the attack the shape exists for", async () => {
    // An agent rewriting the project declaration keeps the approved NAME and swaps what runs under it.
    // Nothing in the client notices: `.mcp.json` still says `run gh`.
    const paths = scopedPaths({
        user: { secrets: { "personal-pat": { backend: "local", authorized: { servers: { gh: CROSSING_SHAPE } } } } },
        project: { projectId: "proj-x", servers: { gh: { command: "printenv", args: [], env: { T: "secret:personal-pat" } } } },
    });
    const cfg = m.loadConfig(paths);
    await assert.rejects(() => m.resolveEnvEntries("gh", cfg, async () => "tok"), /authorized for a different shape/);

    const fail = crossingReport(cfg).find((l) => l.startsWith("FAIL") && l.includes('server "gh"'));
    assert.ok(fail);
    assert.match(fail, /command is "printenv", authorized "npx"/);
});

test("an added env key changes the shape, because it changes what the process holding the secret gets", async () => {
    const paths = scopedPaths({
        user: { secrets: { "personal-pat": { backend: "local", authorized: { servers: { gh: CROSSING_SHAPE } } } } },
        project: { projectId: "proj-x", servers: { gh: { command: "npx", args: ["-y", "gh-mcp"],
            env: { T: "secret:personal-pat", EXTRA: "literal:x" } } } },
    });
    await assert.rejects(() => m.resolveEnvEntries("gh", m.loadConfig(paths), async () => "tok"),
        /env keys are \["EXTRA","T"\], authorized \["T"\]/);
});

const VAULT_SHAPE = { command: "printenv", args: ["V"], envKeys: ["V"] };

function vaultPaths(vaults) {
    const user = { secrets: {} };
    if (vaults !== undefined) {
        user.vaults = vaults;
    }

    return scopedPaths({
        user,
        project: { projectId: "demo",
            secrets: { x: { backend: "keyvault", vault: "victim-prod", secret: "db-password" } },
            tasks: { build: { command: "printenv", args: ["V"], env: { V: "secret:x" } } } },
    });
}

test("a project-declared keyvault secret needs the owner's authorization too — the repo picks the vault, your login pays", async () => {
    // The namespace that makes a project-declared `local` secret inert does not exist here: keyFor is not
    // consulted for keyvault, so the vault and secret name in the repository are read as written, with
    // whatever identity `az` holds. Demonstrated before this rule existed: a committed declaration plus a
    // printenv task returned the value of any secret the developer's login could read.
    const cfg = m.loadConfig(vaultPaths(undefined));
    let called = false;
    await assert.rejects(
        () => m.resolveEnvEntries("build", cfg, async () => { called = true; return "v"; }, "tasks"),
        /not authorized to receive "x"/);
    assert.equal(called, false, "the vault must not be contacted for a refused launch");
});

test("the vaults block authorizes by vault and secret name, and pins the consumer's shape", async () => {
    const authorized = { "victim-prod": { "db-password": { tasks: { build: VAULT_SHAPE } } } };
    const cfg = m.loadConfig(vaultPaths(authorized));
    assert.deepEqual(await m.resolveEnvEntries("build", cfg, async () => "v", "tasks"), { V: "v" });

    // Same shape, different vault: the authorization does not transfer.
    const elsewhere = m.loadConfig(vaultPaths({ "other-vault": { "db-password": { tasks: { build: VAULT_SHAPE } } } }));
    await assert.rejects(() => m.resolveEnvEntries("build", elsewhere, async () => "v", "tasks"), /not authorized/);

    // Authorized vault and secret, but the command behind the task changed.
    const swapped = m.loadConfig(scopedPaths({
        user: { secrets: {}, vaults: authorized },
        project: { projectId: "demo",
            secrets: { x: { backend: "keyvault", vault: "victim-prod", secret: "db-password" } },
            tasks: { build: { command: "curl", args: ["V"], env: { V: "secret:x" } } } },
    }));
    await assert.rejects(() => m.resolveEnvEntries("build", swapped, async () => "v", "tasks"),
        /command is "curl", authorized "printenv"/);
});

test("a project-declared LOCAL secret still needs nothing — the set you ran is the authorization", async () => {
    // The rule must not spread to the case the namespace already covers: this reads
    // vc-secrets:demo:x, which holds only what was set for this project.
    const cfg = m.loadConfig(scopedPaths({
        user: { secrets: {} },
        project: { projectId: "demo", secrets: { x: { backend: "local" } },
            tasks: { build: { command: "printenv", args: ["V"], env: { V: "secret:x" } } } },
    }));
    assert.deepEqual(await m.resolveEnvEntries("build", cfg, async () => "v", "tasks"), { V: "v" });
});

test("doctor names the file and the path to paste into, and which of the two it is", () => {
    const lines = m.doctorReport(m.loadConfig(vaultPaths(undefined)), {
        env: {}, platform: "linux", enableLists: { enabled: [], disabled: [], envKeys: [] },
        resolvable: {}, skipped: [], toolsMissing: [], wired: new Set(),
    });
    const fail = lines.find((l) => l.startsWith("FAIL") && l.includes('task "build"'));
    assert.ok(fail, lines.join("\n"));
    assert.match(fail, /vaults\."victim-prod"\."db-password"/);
    assert.match(fail, /"command": "printenv"/);
});

test("a vaults block in a repository file authorizes nothing, and says so", () => {
    const cfg = m.loadConfig(scopedPaths({
        user: { secrets: {} },
        project: { projectId: "demo",
            vaults: { "victim-prod": { "db-password": { tasks: { build: VAULT_SHAPE } } } },
            secrets: { x: { backend: "keyvault", vault: "victim-prod", secret: "db-password" } },
            tasks: { build: { command: "printenv", args: ["V"], env: { V: "secret:x" } } } },
    }));
    assert.ok(cfg.warnings.some((w) => w.includes('"vaults" only authorizes at user scope')), cfg.warnings.join("\n"));
    await_refusal: {
        assert.equal(m.crossingProblem(cfg, "tasks", "build", "x")?.reason, "not authorized");
    }
});

test("a launchable named after an Object.prototype member is refused, and doctor still reports", async () => {
    // LAUNCHABLE_NAME_RE allows `toString`, `constructor`, `__proto__`. The authorization blocks come from
    // JSON.parse, so a plain bracket read returned the inherited builtin instead of undefined: it passed
    // the "is it authorized" test and then threw inside the shape comparison. One such name in a committed
    // declaration took the entire doctor report down — a diagnostic that dies on the config it exists to
    // diagnose is worse than the finding it was hiding.
    for (const hostile of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
        const cfg = m.loadConfig(scopedPaths({
            user: { secrets: { pat: { backend: "local", authorized: { servers: {} } } } },
            project: { projectId: "demo", servers: {
                [hostile]: { command: "x", args: [], env: { T: "secret:pat" } },
                healthy: { command: "y", args: [], env: { U: "literal:u" } },
            } },
        }));
        await assert.rejects(() => m.resolveEnvEntries(hostile, cfg, async () => "v"), /not authorized/, hostile);

        const lines = m.doctorReport(cfg, {
            env: {}, platform: "linux", enableLists: { enabled: [], disabled: [], envKeys: [] },
            resolvable: {}, skipped: [], toolsMissing: [], wired: new Set(),
        });
        assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes(hostile)), `${hostile}: ${lines.join("\n")}`);
    }
});

test("a vault or secret named after an Object.prototype member does not authorize by inheritance", async () => {
    const cfg = m.loadConfig(scopedPaths({
        user: { secrets: {}, vaults: {} },
        project: { projectId: "demo",
            secrets: { x: { backend: "keyvault", vault: "toString", secret: "constructor" } },
            tasks: { build: { command: "printenv", args: [], env: { V: "secret:x" } } } },
    }));
    await assert.rejects(() => m.resolveEnvEntries("build", cfg, async () => "v", "tasks"), /not authorized/);
});

test("an authorized block outside the user file authorizes nothing, and says so", () => {
    // Otherwise the party asking for the grant would be writing it.
    const paths = scopedPaths({
        user: { secrets: { "personal-pat": { backend: "local" } } },
        project: { projectId: "proj-x",
            secrets: { "own-pat": { backend: "local", authorized: { servers: { gh: CROSSING_SHAPE } } } },
            servers: { gh: { command: "npx", args: ["-y", "gh-mcp"], env: { T: "secret:personal-pat" } } } },
    });
    const cfg = m.loadConfig(paths);
    assert.ok(cfg.warnings.some((w) => w.includes("only authorizes at user scope")), cfg.warnings.join("\n"));
});

test("loadConfig: a user-scope server may of course use a user-scope secret", () => {
    const paths = scopedPaths({
        user: {
            secrets: { "personal-pat": { backend: "local" } },
            servers: { mine: { command: "x", args: [], env: { T: "secret:personal-pat" } } },
        },
    });
    const cfg = m.loadConfig(paths);
    assert.equal(cfg.servers.mine.env.T, "secret:personal-pat");
});

test("loadConfig: a name declared in two homes appears in collisions with the right from/to", () => {
    const decl = { projectId: "proj-x", secrets: { dup: { backend: "local" } }, servers: {}, tasks: {} };
    const paths = scopedPaths({ project: decl, local: decl });
    const cfg = m.loadConfig(paths);
    assert.deepEqual(cfg.collisions, [{ kind: "secret", name: "dup", from: "project", to: "local" }]);
});

test("loadConfig: two scopes resolving to the same file load once, no self-collision", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-samefile-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "shared.json");
    fs.writeFileSync(file, JSON.stringify({ projectId: "proj-x", secrets: { x: { backend: "local" } }, servers: {}, tasks: {} }));
    const cfg = m.loadConfig({ user: null, project: file, local: file });
    assert.equal(Object.keys(cfg.secrets).length, 1);
    assert.deepEqual(cfg.collisions, []);
    assert.equal(cfg.secrets.x.scope, "project");
});

test("loadConfig: projectId absent while a project-scope secret exists → VcSecretsError", () => {
    const paths = scopedPaths({ project: { secrets: { x: { backend: "local" } }, servers: {}, tasks: {} } });
    assert.throws(() => m.loadConfig(paths), /projectId is not/);
});

test("loadConfig: projectId disagrees between project and local → VcSecretsError", () => {
    const paths = scopedPaths({
        project: { projectId: "proj-a", secrets: {}, servers: {}, tasks: {} },
        local: { projectId: "proj-b", secrets: {}, servers: {}, tasks: {} },
    });
    assert.throws(() => m.loadConfig(paths), /projectId disagrees/);
});

test("loadConfig: projectId matching in project and local → fine", () => {
    const paths = scopedPaths({
        project: { projectId: "proj-a", secrets: {}, servers: {}, tasks: {} },
        local: { projectId: "proj-a", secrets: {}, servers: {}, tasks: {} },
    });
    assert.equal(m.loadConfig(paths).projectId, "proj-a");
});

test("loadConfig: projectId at user scope → warning, ignored", () => {
    const paths = scopedPaths({ user: { projectId: "proj-a", secrets: {}, servers: {}, tasks: {} } });
    const cfg = m.loadConfig(paths);
    assert.equal(cfg.projectId, null);
    assert.ok(cfg.warnings.some((w) => w.includes("projectId is meaningless at user scope")));
});

test("loadConfig: schemaVersion above what the launcher supports → VcSecretsError names the version", () => {
    const paths = scopedPaths({ project: { schemaVersion: 999, secrets: {}, servers: {}, tasks: {} } });
    assert.throws(() => m.loadConfig(paths), /schemaVersion 999/);
});

test("loadConfig: tasks validated identically to servers — bad shape and dangerous env key both throw", () => {
    assert.throws(() => m.loadConfig(projectPaths({ secrets: {}, servers: {}, tasks: { t: null } })), /task "t"/);
    assert.throws(() => m.loadConfig(projectPaths({ secrets: {}, servers: {}, tasks: { t: { command: "x", args: [1], env: {} } } })), /task "t".*args/);
    assert.throws(() => m.loadConfig(projectPaths({ secrets: {}, servers: {}, tasks: { t: { command: "x", args: [], env: { NODE_OPTIONS: "x" } } } })), /task "t".*NODE_OPTIONS/);
});

test("configPaths: walks up from a nested cwd to find <repo>/.claude/vc-secrets.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-repo-"));
    tmpDirs.push(root);
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, m.CONFIG_NAME), JSON.stringify({ secrets: {}, servers: {} }));
    const nested = path.join(root, "nested", "deeper");
    fs.mkdirSync(nested, { recursive: true });
    const paths = m.configPaths({ HOME: "/nonexistent-home" }, nested);
    assert.equal(paths.project, path.join(claudeDir, m.CONFIG_NAME));
    assert.equal(paths.local, path.join(claudeDir, m.LOCAL_CONFIG_NAME));
});

const CFG = {
    secrets: {
        "ado-pat": { backend: "local" },
        "azure-monitor-sp": { backend: "keyvault", vault: "demo-vault", secret: "monitor-sp-nonprod", format: "json" },
    },
    servers: {
        "azure-mcp": { command: "npx", args: ["-y"], env: { ADO_MCP_AUTH_TOKEN: "secret:ado-pat", LITERAL: "literal:as-is" } },
        "azure-monitor": {
            command: "dnx", args: [],
            env: { AZURE_TENANT_ID: "secret:azure-monitor-sp.tenantId", AZURE_CLIENT_SECRET: "secret:azure-monitor-sp.clientSecret" },
        },
        "bad-ref": { command: "x", args: [], env: { X: "secret:nope" } },
        "bad-field": { command: "x", args: [], env: { X: "secret:ado-pat.field" } },
    },
    tasks: {},
    // A keyvault read is paid for by whatever identity `az` holds, so it needs the owner's authorization
    // even though the vault and secret name come from the project — hence this block rather than a
    // `authorized` block on a declaration the project owns.
    vaults: { "demo-vault": { "monitor-sp-nonprod": { servers: {
        "azure-monitor": { command: "dnx", args: [], envKeys: ["AZURE_TENANT_ID", "AZURE_CLIENT_SECRET"] },
    } } } },
};

test("resolveEnvEntries: literal passthrough + secret resolution", async () => {
    const env = await m.resolveEnvEntries("azure-mcp", CFG, async () => "tok");
    assert.deepEqual(env, { ADO_MCP_AUTH_TOKEN: "tok", LITERAL: "as-is" });
});

test("resolveEnvEntries: json fields, one fetch per secret", async () => {
    let calls = 0;
    const env = await m.resolveEnvEntries("azure-monitor", CFG, async () => {
        calls += 1;
        return JSON.stringify({ tenantId: "t", clientId: "c", clientSecret: "s" });
    });
    assert.deepEqual(env, { AZURE_TENANT_ID: "t", AZURE_CLIENT_SECRET: "s" });
    assert.equal(calls, 1);
});

test("resolveEnvEntries: unknown server → VcSecretsError, resolver never called", async () => {
    let called = false;
    await assert.rejects(
        m.resolveEnvEntries("ghost", CFG, async () => { called = true; return ""; }),
        m.VcSecretsError);
    assert.equal(called, false);
});

test("resolveEnvEntries: unknown task name names it a task, not a server", async () => {
    let called = false;
    await assert.rejects(
        m.resolveEnvEntries("ghost", CFG, async () => { called = true; return ""; }, "tasks"),
        /unknown task "ghost"/);
    assert.equal(called, false);
});

test("resolveEnvEntries: undeclared secret → VcSecretsError before resolving", async () => {
    await assert.rejects(m.resolveEnvEntries("bad-ref", CFG, async () => ""), /undeclared secret/);
});

test("resolveEnvEntries: field on non-json secret → VcSecretsError", async () => {
    await assert.rejects(m.resolveEnvEntries("bad-field", CFG, async () => "x"), /format: "json"/);
});

test("resolveEnvEntries: json parse failure names reference, not value", async () => {
    await assert.rejects(
        m.resolveEnvEntries("azure-monitor", CFG, async () => "SECRET-NOT-JSON"),
        (e) => e instanceof m.VcSecretsError && !e.message.includes("SECRET-NOT-JSON") && e.message.includes("azure-monitor-sp"));
});

test("resolveEnvEntries: missing json field named, value absent", async () => {
    await assert.rejects(
        m.resolveEnvEntries("azure-monitor", CFG, async () => JSON.stringify({ clientSecret: "hush" })),
        (e) => e instanceof m.VcSecretsError && e.message.includes("tenantId") && !e.message.includes("hush"));
});

test("resolveEnvEntries: prototype-chain server name → VcSecretsError /unknown server/", async () => {
    await assert.rejects(m.resolveEnvEntries("constructor", CFG, async () => ""), /unknown server/);
});

test("resolveEnvEntries: prototype-chain secret name → VcSecretsError /undeclared secret/, resolver never called", async () => {
    let called = false;
    const cfg = { secrets: {}, servers: { s: { command: "x", args: [], env: { X: "secret:constructor" } } } };
    await assert.rejects(
        m.resolveEnvEntries("s", cfg, async () => { called = true; return ""; }),
        /undeclared secret/);
    assert.equal(called, false);
});

test("detectLocalBackend: platform rule (WSL is linux → gpg)", () => {
    assert.equal(m.detectLocalBackend("win32", {}), "wcm");
    assert.equal(m.detectLocalBackend("darwin", {}), "keychain");
    assert.equal(m.detectLocalBackend("linux", {}), "gpg");
});

test("detectLocalBackend: VC_SECRETS_LOCAL_BACKEND override, invalid rejected", () => {
    assert.equal(m.detectLocalBackend("linux", { VC_SECRETS_LOCAL_BACKEND: "keychain" }), "keychain");
    assert.throws(() => m.detectLocalBackend("linux", { VC_SECRETS_LOCAL_BACKEND: "vault9000" }), m.VcSecretsError);
});

test("redactSecrets: all occurrences, longest value first", () => {
    assert.equal(m.redactSecrets("err tok1 and tok1/tok2", ["tok1", "tok2"]), "err *** and ***/***");
    assert.equal(m.redactSecrets("abc", ["ab", "abc"]), "***");
    assert.equal(m.redactSecrets("clean", []), "clean");
});

test("keyFor: project scope uses the project's namespace, user scope uses \"user\"", () => {
    assert.equal(m.keyFor("ado-pat", { scope: "project" }, { projectId: "myproj" }), "vc-secrets:myproj:ado-pat");
    assert.equal(m.keyFor("ado-pat", { scope: "user" }, {}), "vc-secrets:user:ado-pat");
});

test("keyToPath: puts the file under a per-scope directory", () => {
    const projectPath = m.keyToPath("vc-secrets:myproj:ado-pat", { HOME: "/h" });
    assert.ok(projectPath.endsWith(path.join("myproj", "ado-pat.gpg")));
    const userPath = m.keyToPath("vc-secrets:user:ado-pat", { HOME: "/h" });
    assert.ok(userPath.endsWith(path.join("user", "ado-pat.gpg")));
});

test("builders: no secret and no raw script in argv, timeouts per spec", () => {
    const gpgRead = m.buildLocalRead("gpg", "vc-secrets:user:ado-pat", { HOME: "/h" });
    assert.equal(gpgRead.cmd, "gpg");
    assert.equal(gpgRead.timeoutMs, 10_000);
    assert.ok(gpgRead.args.some((a) => a.endsWith("ado-pat.gpg")));
    const pinentryIdx = gpgRead.args.indexOf("--pinentry-mode");
    assert.ok(pinentryIdx !== -1, "non-interactive gpg read must set --pinentry-mode (no pinentry under the kill timer)");
    assert.equal(gpgRead.args[pinentryIdx + 1], "cancel");

    const wcmRead = m.buildLocalRead("wcm", "vc-secrets:user:ado-pat", {});
    assert.equal(wcmRead.cmd, "powershell.exe");
    assert.ok(wcmRead.args.includes("-EncodedCommand"), "must use EncodedCommand, not -Command");
    assert.ok(!wcmRead.args.some((a) => a.includes("CredRead")), "raw script must not be in argv");
    const encoded = wcmRead.args[wcmRead.args.indexOf("-EncodedCommand") + 1];
    assert.ok(Buffer.from(encoded, "base64").toString("utf16le").includes("CredRead"));
    assert.deepEqual(wcmRead.extraEnv, { VC_SECRETS_NAME: "vc-secrets:user:ado-pat" });

    const wcmViaPwsh = m.buildLocalRead("wcm", "vc-secrets:user:ado-pat", { VC_SECRETS_POWERSHELL: "pwsh" });
    assert.equal(wcmViaPwsh.cmd, "pwsh");

    const wcmWrite = m.buildLocalWrite("wcm", "vc-secrets:user:ado-pat", {});
    assert.equal(wcmWrite.stdinData, m.VALUE_ON_STDIN);
    const writeEncoded = wcmWrite.args[wcmWrite.args.indexOf("-EncodedCommand") + 1];
    assert.ok(Buffer.from(writeEncoded, "base64").toString("utf16le").includes("InputEncoding"),
        "write script must set Console.InputEncoding to UTF-8 (non-ASCII secrets)");

    const kcWrite = m.buildLocalWrite("keychain", "vc-secrets:user:ado-pat", { USER: "u" });
    assert.equal(kcWrite.interactive, true);
    assert.equal(kcWrite.timeoutMs, null, "interactive specs must not carry a kill timer");

    const gpgWrite = m.buildLocalWrite("gpg", "vc-secrets:user:ado-pat", { HOME: "/h", VC_SECRETS_GPG_RECIPIENT: "dev@x" });
    assert.ok(gpgWrite.args.includes("--trust-model"), "explicit recipient needs trust-model always");

    const kv = m.buildKeyvaultRead({ vault: "demo-vault", secret: "monitor-sp-nonprod" });
    assert.equal(kv.cmd, "az");
    assert.deepEqual(kv.args, ["keyvault", "secret", "show", "--vault-name", "demo-vault", "--name", "monitor-sp-nonprod", "--query", "value", "-o", "tsv"]);
    assert.equal(kv.timeoutMs, 20_000);
});

test("buildLocalRead/buildLocalWrite: reject keys outside vc-secrets:<scope>:<name> (path traversal guard)", () => {
    assert.throws(() => m.buildLocalRead("gpg", "../evil", { HOME: "/h" }), m.VcSecretsError);
    assert.throws(() => m.buildLocalWrite("gpg", "../evil", { HOME: "/h" }), m.VcSecretsError);
    assert.throws(() => m.buildLocalRead("gpg", "vc-secrets:user:../evil", { HOME: "/h" }), m.VcSecretsError);
    assert.throws(() => m.buildLocalWrite("gpg", "vc-secrets:user:../evil", { HOME: "/h" }), m.VcSecretsError);
});

test("buildLocalWrite: gpg tmp target for atomic write", () => {
    const spec = m.buildLocalWrite("gpg", "vc-secrets:user:ado-pat", { HOME: "/h" }, { tmp: true });
    const target = spec.args[spec.args.indexOf("-o") + 1];
    assert.ok(target.endsWith(path.join("ado-pat.gpg.tmp")), `expected .gpg.tmp target, got "${target}"`);

    const finalSpec = m.buildLocalWrite("gpg", "vc-secrets:user:ado-pat", { HOME: "/h" });
    const finalTarget = finalSpec.args[finalSpec.args.indexOf("-o") + 1];
    assert.ok(finalTarget.endsWith("ado-pat.gpg") && !finalTarget.endsWith(".tmp"), "default (no tmp option) targets the final path");
});

test("cmdUnlock: must keep showing pinentry interactively — no --pinentry-mode reaches the gpg it runs", { skip: process.platform === "win32" && "gpg backend is not selected on win32" }, async () => {
    const secretsHome = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-unlock-"));
    tmpDirs.push(secretsHome);
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = secretsHome;
    const cfg = { secrets: { "ado-pat": { backend: "local", scope: "user" } } };
    const keyPath = m.keyToPath(m.keyFor("ado-pat", cfg.secrets["ado-pat"], cfg));
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, "ciphertext");
    const argsLog = path.join(secretsHome, "gpg-args.log");
    process.env.VC_SECRETS_UNLOCK_ARGS_LOG = argsLog;   // read only by the stub below, not by production code
    try {
        await withStubOnPath("gpg", "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$VC_SECRETS_UNLOCK_ARGS_LOG\"\nexit 0\n",
            () => m.cmdUnlock(cfg));
    } finally {
        process.env.XDG_CONFIG_HOME = savedXdg;
        delete process.env.VC_SECRETS_UNLOCK_ARGS_LOG;
    }
    const loggedArgs = fs.readFileSync(argsLog, "utf8").trim().split("\n");
    assert.ok(!loggedArgs.includes("--pinentry-mode"),
        "cmdUnlock is the ONLY place pinentry may appear; it must not cancel it");
    assert.deepEqual(loggedArgs, ["--quiet", "--decrypt", "-o", "/dev/null", keyPath]);
});

test("runTool: stdout capture, stdin pass, timeout, redacted stderr, toolExitCode", async () => {
    const echo = { cmd: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"],
        stdinData: m.VALUE_ON_STDIN, timeoutMs: 10_000, captureStdout: true };
    assert.equal(await m.runTool(echo, { stdinValue: "tok-123" }), "tok-123");

    const fail = { cmd: process.execPath, args: ["-e", "console.error('boom tok-123'); process.exit(3)"],
        timeoutMs: 10_000, captureStdout: true };
    await assert.rejects(m.runTool(fail, { redactValues: ["tok-123"] }),
        (e) => e instanceof m.VcSecretsError && e.toolExitCode === 3 && e.message.includes("boom ***") && !e.message.includes("tok-123"));

    const hang = { cmd: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"], timeoutMs: 200, captureStdout: true };
    await assert.rejects(m.runTool(hang), /timed out after 200/);
});

test("runTool: child exits without reading stdin → VcSecretsError, no crash", async () => {
    const spec = { cmd: process.execPath, args: ["-e", "process.exit(5)"],
        stdinData: m.VALUE_ON_STDIN, timeoutMs: 10_000, captureStdout: true };
    await assert.rejects(
        m.runTool(spec, { stdinValue: "x".repeat(1024 * 1024) }),
        (e) => e instanceof m.VcSecretsError && e.toolExitCode === 5);
});

test("runTool: missing binary → actionable VcSecretsError", async () => {
    await assert.rejects(
        m.runTool({ cmd: "vc-secrets-no-such-tool", args: [], timeoutMs: 1000, captureStdout: true }),
        /not found on PATH/);
});

test("runTool: interactive spec never arms the timer (outlives timeoutMs, no SIGKILL)", async () => {
    const spec = { cmd: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0), 300)"],
        interactive: true, timeoutMs: 50, captureStdout: false };
    await m.runTool(spec);
});

test("runTool: timeoutMs: null disarms the timer (outlives the would-be deadline)", async () => {
    const spec = { cmd: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0), 300)"],
        interactive: false, timeoutMs: null, captureStdout: true };
    await m.runTool(spec);
});

test("runTool: executes a .cmd shim instead of reporting it missing", { skip: process.platform !== "win32" && "win32-only: .cmd shims" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-shim-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "vc-secrets-fake-az.cmd"), "@echo off\r\necho shim-ok\r\n");
    const prevPath = process.env.Path;
    process.env.Path = `${dir};${prevPath}`;
    try {
        const spec = { cmd: "vc-secrets-fake-az", args: [], timeoutMs: 10_000, captureStdout: true };
        assert.equal(await m.runTool(spec), "shim-ok");
    } finally {
        process.env.Path = prevPath;
    }
});

test("resolveSpawnCommand: win32 .cmd shim found case-insensitively", () => {
    const existsSync = (p) => p.toLowerCase().replace(/\\/g, "/") === "c:/program files/nodejs/npx.cmd";
    const r = m.resolveSpawnCommand("npx", {
        platform: "win32",
        env: { Path: "C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        existsSync,
    });
    assert.equal(r.kind, "cmd-shim");
    assert.ok(r.cmd.toLowerCase().endsWith("npx.cmd"));
});

test("resolveSpawnCommand: win32 .exe is direct", () => {
    const existsSync = (p) => p.toLowerCase().replace(/\\/g, "/") === "c:/bin/github-mcp-server.exe";
    const r = m.resolveSpawnCommand("github-mcp-server", {
        platform: "win32", env: { Path: "C:\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" }, existsSync,
    });
    assert.equal(r.kind, "direct");
    assert.ok(r.cmd.toLowerCase().endsWith(".exe"));
});

test("resolveSpawnCommand: non-win32 and pathful commands unchanged", () => {
    assert.deepEqual(m.resolveSpawnCommand("npx", { platform: "linux", env: {}, existsSync: () => true }),
        { kind: "direct", cmd: "npx" });
    assert.deepEqual(m.resolveSpawnCommand("C:\\x\\y.cmd", { platform: "win32", env: {}, existsSync: () => true }),
        { kind: "direct", cmd: "C:\\x\\y.cmd" });
});

test("buildSpawnInvocation: verbatim cmd line quotes every token", () => {
    const inv = m.buildSpawnInvocation({ kind: "cmd-shim", cmd: "C:\\Program Files\\nodejs\\npx.cmd" }, ["-y", "@azure-devops/mcp@2.8.1"]);
    assert.equal(inv.cmd, "cmd.exe");
    assert.deepEqual(inv.args, ['/d /s /c ""C:\\Program Files\\nodejs\\npx.cmd" "-y" "@azure-devops/mcp@2.8.1""']);
    assert.equal(inv.opts.windowsVerbatimArguments, true);

    const direct = m.buildSpawnInvocation({ kind: "direct", cmd: "npx" }, ["-y"]);
    assert.deepEqual(direct, { cmd: "npx", args: ["-y"], opts: {} });
});

test("cmdRun: child gets literal env, legacy + dangerous vars stripped, exit code forwarded, stdout silent", () => {
    const dir = tmpConfigDir({
        secrets: {},
        servers: { probe: { command: process.execPath,
            args: ["-e", "if(process.env.PROBE!=='v'||process.env.ADO_MCP_AUTH_TOKEN||process.env.NODE_OPTIONS){process.exit(9)};process.exit(7)"],
            env: { PROBE: "literal:v" } } },
    });
    const r = spawnSync(process.execPath, [LAUNCHER_PATH, "run", "probe"],
        { env: { ...process.env, VC_SECRETS_CONFIG_DIR: dir, ADO_MCP_AUTH_TOKEN: "stale", NODE_OPTIONS: "--max-old-space-size=4096" }, encoding: "utf8" });
    assert.equal(r.status, 7);
    assert.equal(r.stdout, "");
});

test("cmdRun: unknown server → exit 1, single-line stderr without stack", () => {
    const dir = tmpConfigDir({ secrets: {}, servers: {} });
    const r = spawnSync(process.execPath, [LAUNCHER_PATH, "run", "ghost"],
        { env: { ...process.env, VC_SECRETS_CONFIG_DIR: dir }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown server/);
    assert.ok(!r.stderr.includes("    at "), "no stack frames");
    assert.equal(r.stdout, "");
});

test("mapResolveError: wcm exit 3 → Credential Manager advice", () => {
    const e = Object.assign(new Error("CredRead failed"), { toolExitCode: 3 });
    const mapped = m.mapResolveError("wcm", "ado-pat", e);
    assert.ok(mapped instanceof m.VcSecretsError);
    assert.match(mapped.message, /not found in Credential Manager — run "vc-secrets set ado-pat"/);
});

test("mapResolveError: keychain exit 44 → Keychain advice", () => {
    const e = Object.assign(new Error("security: item not found"), { toolExitCode: 44 });
    const mapped = m.mapResolveError("keychain", "ado-pat", e);
    assert.ok(mapped instanceof m.VcSecretsError);
    assert.match(mapped.message, /not found in Keychain — run "vc-secrets set ado-pat"/);
});

test("mapResolveError: gpg failure → unlock hint", () => {
    const e = new Error("gpg exited 2: decryption failed: No secret key");
    const mapped = m.mapResolveError("gpg", "ado-pat", e);
    assert.ok(mapped instanceof m.VcSecretsError);
    assert.match(mapped.message, /decryption failed: No secret key — if the gpg agent is locked, run "vc-secrets unlock" in a terminal/);
});

test("mapResolveError: other backend/exit-code combinations pass through unchanged", () => {
    const e = new Error("az: not logged in");
    assert.equal(m.mapResolveError("keyvault", "x", e), e);
    const wcmOther = Object.assign(new Error("boom"), { toolExitCode: 1 });
    assert.equal(m.mapResolveError("wcm", "x", wcmOther), wcmOther);
});

test("makeSecretResolver: gpg backend, file absent → not-set advice (pre-check before spawning)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-gpg-"));
    tmpDirs.push(tmp);
    const env = { VC_SECRETS_LOCAL_BACKEND: "gpg", XDG_CONFIG_HOME: tmp };
    const resolver = m.makeSecretResolver({}, env);
    await assert.rejects(
        resolver("ado-pat", { backend: "local", scope: "user" }),
        (e) => e instanceof m.VcSecretsError && /not set — run "vc-secrets set ado-pat"/.test(e.message));
});

test("applyKeystrokes: typing, backspace, control chars, paste with terminator", () => {
    let s = { value: "" };
    s = m.applyKeystrokes(s, "ab");
    s = m.applyKeystrokes(s, "\u007f");           // backspace
    assert.deepEqual(s, { value: "a", done: false, cancelled: false });
    s = m.applyKeystrokes(s, "bc-PASTED\r");      // paste arrives as ONE chunk incl. CR
    assert.deepEqual(s, { value: "abc-PASTED", done: true, cancelled: false });
    assert.equal(m.applyKeystrokes({ value: "x" }, "\u0003").cancelled, true);   // Ctrl-C
    assert.equal(m.applyKeystrokes({ value: "" }, "\u0007").value, "", "control chars ignored");
});

test("doctorReport: legacy env var phase-aware, names only", () => {
    const base = { platform: "linux", enableLists: { enabled: [], disabled: [] }, resolvable: {}, skipped: [], toolsMissing: [], configDirOverride: false };
    const pre = m.doctorReport({ secrets: {}, servers: {} },
        { ...base, env: { ADO_MCP_AUTH_TOKEN: "SENTINEL-DO-NOT-PRINT" }, wired: new Set() });
    assert.ok(pre.some((l) => l.startsWith("INFO") && l.includes("ADO_MCP_AUTH_TOKEN") && l.includes("until the vc-secrets switch")));
    const post = m.doctorReport({ secrets: {}, servers: {} },
        { ...base, env: { ADO_MCP_AUTH_TOKEN: "SENTINEL-DO-NOT-PRINT" }, wired: new Set(["azure-mcp"]) });
    assert.ok(post.some((l) => l.startsWith("WARN") && l.includes("remove it")));
    assert.ok(![...pre, ...post].some((l) => l.includes("SENTINEL-DO-NOT-PRINT")), "values must never appear");
});

test("doctorReport: skipped keyvault, missing tools, config override, dangling refs", () => {
    const cfg = { secrets: { "ado-pat": { backend: "local" } },
        servers: { s: { command: "x", args: [], env: { A: "secret:ghost", B: "literal:fine" } } } };
    const lines = m.doctorReport(cfg, {
        env: {}, platform: "linux",
        enableLists: { enabled: [], disabled: [] },
        resolvable: { "ado-pat": false }, skipped: ["azure-monitor-sp"],
        toolsMissing: ["gpg"], wired: new Set(), configDirOverride: true,
    });
    assert.ok(lines.some((l) => l.startsWith("SKIP") && l.includes("azure-monitor-sp")));
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("ado-pat")));
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("gpg") && l.includes("PATH")));
    assert.ok(lines.some((l) => l.includes("VC_SECRETS_CONFIG_DIR")));
    assert.ok(lines.some((l) => l.includes('undeclared secret "ghost"')));
});

test("doctorReport: prototype-chain secret name → still flagged as undeclared", () => {
    const cfg = { secrets: {}, servers: { s: { command: "x", args: [], env: { A: "secret:constructor" } } } };
    const lines = m.doctorReport(cfg, {
        env: {}, platform: "linux", enableLists: { enabled: [], disabled: [] },
        resolvable: {}, skipped: [], toolsMissing: [], wired: new Set(), configDirOverride: false,
    });
    assert.ok(lines.some((l) => l.includes('undeclared secret "constructor"')),
        "a prototype-reachable name must not be mistaken for a declared secret");
});

test("doctorReport: invalid VC_SECRETS_LOCAL_BACKEND reported, not thrown", () => {
    const lines = m.doctorReport({ secrets: {}, servers: {} }, {
        env: { VC_SECRETS_LOCAL_BACKEND: "vault9000" }, platform: "linux",
        enableLists: { enabled: [], disabled: [] }, resolvable: {}, skipped: [], toolsMissing: [], wired: new Set(), configDirOverride: false,
    });
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("VC_SECRETS_LOCAL_BACKEND")));
});

test("doctorReport: green output lists each secret", () => {
    const lines = m.doctorReport({ secrets: { "ado-pat": { backend: "local" } }, servers: {} }, {
        env: {}, platform: "linux", enableLists: { enabled: [], disabled: [] },
        resolvable: { "ado-pat": true }, skipped: [], toolsMissing: [], wired: new Set(), configDirOverride: false,
    });
    assert.ok(lines.some((l) => l.startsWith("OK") && l.includes("ado-pat")));
});

test("doctorReport: resolvable carries per-secret failure reason (string) vs generic fallback (false)", () => {
    const base = { platform: "linux", enableLists: { enabled: [], disabled: [] }, skipped: [], toolsMissing: [], wired: new Set(), configDirOverride: false };
    const withReason = m.doctorReport({ secrets: { "ado-pat": { backend: "local" } }, servers: {} }, {
        ...base, env: {}, resolvable: { "ado-pat": 'gpg exited 2 — if the gpg agent is locked, run "vc-secrets unlock" in a terminal' },
    });
    assert.ok(withReason.some((l) => l.startsWith("FAIL")
        && l.includes("ado-pat")
        && l.includes('run "vc-secrets unlock" in a terminal')));

    const withoutReason = m.doctorReport({ secrets: { "ado-pat": { backend: "local" } }, servers: {} }, {
        ...base, env: {}, resolvable: { "ado-pat": false },
    });
    assert.ok(withoutReason.some((l) => l.startsWith("FAIL")
        && l.includes("ado-pat")
        && l.includes("run \"vc-secrets set ado-pat\" (local) or check az login (keyvault)")));
});

test("doctorReport: undeclared secret referenced from a task is a FAIL naming the task", () => {
    const cfg = { secrets: {}, servers: {}, tasks: { loadtest: { command: "x", args: [], env: { X: "secret:ghost" } } } };
    const lines = m.doctorReport(cfg, {
        env: {}, platform: "linux", enableLists: { enabled: [], disabled: [] },
        resolvable: {}, skipped: [], toolsMissing: [], wired: new Set(), configDirOverride: false,
    });
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes('task "loadtest"') && l.includes('undeclared secret "ghost"')));
});

test("doctorReport: a collision is a WARN naming both homes", () => {
    const cfg = { secrets: { "ado-pat": { backend: "local" } }, servers: {}, collisions: [{ kind: "secret", name: "ado-pat", from: "project", to: "local" }] };
    const lines = m.doctorReport(cfg, {
        env: {}, platform: "linux", enableLists: { enabled: [], disabled: [] },
        resolvable: { "ado-pat": true }, skipped: [], toolsMissing: [], wired: new Set(), configDirOverride: false,
    });
    assert.ok(lines.some((l) => l.startsWith("WARN") && l.includes('"ado-pat"') && l.includes("project") && l.includes("local")));
});

test("doctorReport: a legacy-only secret is a WARN naming migrate, and not also a FAIL", () => {
    const cfg = { secrets: { "ado-pat": { backend: "local" } }, servers: {} };
    const lines = m.doctorReport(cfg, {
        env: {}, platform: "linux", enableLists: { enabled: [], disabled: [] },
        resolvable: { "ado-pat": false }, skipped: [], toolsMissing: [], wired: new Set(), configDirOverride: false,
        legacyOnly: ["ado-pat"],
    });
    assert.ok(lines.some((l) => l.startsWith("WARN") && l.includes("ado-pat") && l.includes("migrate")));
    assert.ok(!lines.some((l) => l.startsWith("FAIL") && l.includes("ado-pat")));
});

test("doctorReport: a shim contract below REQUIRED_SHIM_CONTRACT is a WARN", () => {
    const cfg = { secrets: {}, servers: {} };
    const lines = m.doctorReport(cfg, {
        env: {}, platform: "linux", enableLists: { enabled: [], disabled: [] },
        resolvable: {}, skipped: [], toolsMissing: [], wired: new Set(), configDirOverride: false,
        shimContract: m.REQUIRED_SHIM_CONTRACT - 1,
    });
    assert.ok(lines.some((l) => l.startsWith("WARN") && l.includes("vc-secrets:install")));
});

test("readEnableLists: the two arrays plus env key NAMES; missing file tolerated", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-lists-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "settings.local.json"),
        JSON.stringify({ enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["b"], env: { SECRET: "never-read" } }));
    const parsed = m.readEnableLists(path.join(dir, "settings.local.json"));
    assert.deepEqual(parsed, { enabled: ["a"], disabled: ["b"], envKeys: ["SECRET"] });
    assert.ok(!JSON.stringify(parsed).includes("never-read"), "values must never leave the reader");
    assert.deepEqual(m.readEnableLists(path.join(dir, "nope.json")), { enabled: [], disabled: [], envKeys: [] });
});

test("readEnableLists: non-object env (null / array) yields no key names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-lists-env-"));
    tmpDirs.push(dir);
    for (const env of [null, ["A"], "A"]) {
        fs.writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify({ env }));
        assert.deepEqual(m.readEnableLists(path.join(dir, "settings.local.json")).envKeys, []);
    }
});

test("doctorReport: a legacy token in settings.local.json is reported even when absent from the session env", () => {
    const base = { env: {}, platform: "linux", resolvable: {}, skipped: [], toolsMissing: [], configDirOverride: false };
    // The terminal-run case: doctor's own process never inherits settings.local.json's env block,
    // so the file is the only place the stale token is visible.
    const post = m.doctorReport({ secrets: {}, servers: {} }, {
        ...base,
        enableLists: { enabled: [], disabled: [], envKeys: ["ADO_MCP_AUTH_TOKEN"] },
        wired: new Set(["azure-mcp"]),
    });
    assert.ok(post.some((l) => l.startsWith("WARN") && l.includes("ADO_MCP_AUTH_TOKEN")
        && l.includes("settings.local.json env") && l.includes("remove it")));
    const silent = m.doctorReport({ secrets: {}, servers: {} }, {
        ...base, enableLists: { enabled: [], disabled: [], envKeys: ["PERF_ADMIN_USER"] }, wired: new Set(["azure-mcp"]),
    });
    assert.ok(!silent.some((l) => l.includes("PERF_ADMIN_USER")), "unrelated env keys must not be reported");
});

test("cmdDoctor: an unknown argument is rejected, not ignored (a typo must not read as a clean run)", async () => {
    const cfg = { secrets: {}, servers: {} };
    await assert.rejects(() => m.cmdDoctor(cfg, ["--al"]), /unknown argument "--al"/);
    await assert.rejects(() => m.cmdDoctor(cfg, ["--all", "--bogus"]), /unknown argument "--bogus"/);
});

test("readWiredServers: detects vc-secrets-wired entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-wired-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {
        "azure-mcp": { command: "node", args: ["/home/dev/.claude/plugins/data/vc-secrets/vc-secrets-shim.mjs", "run", "azure-mcp"] },
        github: { command: "github-mcp-server", args: ["stdio"] },
    } }));
    assert.deepEqual([...m.readWiredServers(path.join(dir, ".mcp.json"))], ["azure-mcp"]);
    assert.deepEqual([...m.readWiredServers(path.join(dir, "absent.json"))], []);
});

test("sanitizeEnv: strips DANGEROUS_ENV_VARS, keeps everything else", () => {
    assert.deepEqual(
        m.sanitizeEnv({ NODE_OPTIONS: "x", LD_PRELOAD: "y", PATH: "p" }),
        { PATH: "p" });
    assert.deepEqual(
        m.sanitizeEnv({ LD_AUDIT: "a", LD_LIBRARY_PATH: "b", DYLD_INSERT_LIBRARIES: "c", DYLD_LIBRARY_PATH: "d" }),
        {});
    assert.deepEqual(m.sanitizeEnv({ FOO: "bar" }), { FOO: "bar" });
});

test("a dangerous env key is refused and stripped whatever its case — Windows reads them case-insensitively", () => {
    // `node_options` inherited from the operator's shell, or declared in a server's env, reaches a child
    // on Windows as NODE_OPTIONS: the platform folds the case, so a case-sensitive list would pass
    // through the exact injection it names. The declaration is written on one platform and run on another,
    // so the refusal cannot be conditional on this one.
    for (const key of ["node_options", "Node_Options", "ld_preload", "DyLd_Insert_Libraries"]) {
        assert.deepEqual(m.sanitizeEnv({ [key]: "x", PATH: "p" }), { PATH: "p" }, key);
        assert.throws(() => m.loadConfig(projectPaths({
            secrets: {}, servers: { s: { command: "node", args: [], env: { [key]: "--require=/tmp/x.js" } } } })),
        /code-injection vector/, key);
    }
});

// The pre-rename suite pinned two properties against the ONE repo's committed declaration. This plugin
// ships no servers, so there is no such file — and re-stating a fixture as its own assertion would be a
// test that cannot fail. What survives the move is the launcher property each check was really about.

test("a pinned argv reaches the child exactly as declared, even through the win32 .cmd rewrite", () => {
    const args = ["-y", "@vendor/mcp@1.2.3", "--flag", "value with spaces"];
    const cfg = { servers: { pinned: { command: "npx", args, env: {} } } };
    const loaded = m.loadConfig(projectPaths(cfg));

    // platform: "linux" would make buildSpawnInvocation the identity function — this only pins a JSON
    // round-trip. win32 with an extension-less command is what actually exercises the rewrite.
    const existsSync = (p) => p.toLowerCase().replace(/\\/g, "/") === "c:/bin/npx.cmd";
    const resolved = m.resolveSpawnCommand(loaded.servers.pinned.command, {
        platform: "win32", env: { Path: "C:\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" }, existsSync,
    });
    assert.equal(resolved.kind, "cmd-shim", "must exercise the .cmd-shim rewrite this test claims to guard");
    const invocation = m.buildSpawnInvocation(resolved, loaded.servers.pinned.args);

    // A version pin is only worth writing down if it survives to argv — verify each declared token
    // appears intact and in order inside the verbatim cmd.exe line.
    assert.equal(invocation.cmd, "cmd.exe");
    assert.deepEqual(invocation.args, [`/d /s /c ""${resolved.cmd}" ${args.map((a) => `"${a}"`).join(" ")}"`]);
    assert.equal(invocation.opts.windowsVerbatimArguments, true);
});

test("two servers naming different secrets get different values — the resolve cache keys by name", async () => {
    const cfg = {
        projectId: "demo",
        secrets: { "sp-a": { backend: "local" }, "sp-b": { backend: "local" } },
        servers: {
            a: { command: "x", args: [], env: { CLIENT_SECRET: "secret:sp-a" } },
            b: { command: "x", args: [], env: { CLIENT_SECRET: "secret:sp-b" } },
        },
    };
    const loaded = m.loadConfig(projectPaths(cfg));
    const asked = [];
    const fake = async (name) => {
        asked.push(name);

        return `value-of-${name}`;
    };
    const envA = await m.resolveEnvEntries("a", loaded, fake);
    const envB = await m.resolveEnvEntries("b", loaded, fake);

    // The failure this guards is a per-name cache degenerating into a per-run one, which would hand
    // the second server the first one's credential — with both servers looking correctly configured.
    assert.equal(envA.CLIENT_SECRET, "value-of-sp-a");
    assert.equal(envB.CLIENT_SECRET, "value-of-sp-b");
    assert.deepEqual(asked, ["sp-a", "sp-b"]);
});

// ── regressions from the pre-push review ───────────────────────────────────────────────────────────

// Puts an executable stub earlier on PATH than the real binary, so a backend read can be made to fail
// in a chosen way without touching any real credential store.
// On win32 a `#!/bin/sh` body is not executable by a shell-less spawn, and resolveSpawnCommand only
// recognizes a `.cmd`/`.bat` shim there — so the body is kept as `<name>.sh` and paired with a `.cmd`
// launcher that hands it to `sh` (Git Bash, present on GitHub's windows-latest runners), forwarding
// arguments and the child's exit code. `platform` defaults to process.platform but takes an explicit
// value so the win32 branch is unit-testable without faking a global.
function stubBinary(name, script, platform = process.platform) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-bin-"));
    tmpDirs.push(dir);
    if (platform === "win32") {
        fs.writeFileSync(path.join(dir, `${name}.sh`), script, { mode: 0o755 });
        fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\nsh "%~dp0${name}.sh" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    } else {
        fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
    }

    return dir;
}

test("stubBinary: on win32 writes a .sh body plus a .cmd launcher naming it", () => {
    const dir = stubBinary("gpg", "#!/bin/sh\nexit 0\n", "win32");
    assert.ok(fs.existsSync(path.join(dir, "gpg.sh")));
    assert.match(fs.readFileSync(path.join(dir, "gpg.cmd"), "utf8"), /gpg\.sh/);
});

// runTool spawns with process.env, not with the env handed to the builders, so a stub is only reachable
// by moving the real PATH aside for the duration of the call.
async function withStubOnPath(name, script, fn) {
    const binDir = stubBinary(name, script);
    const saved = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${saved}`;
    try {
        return await fn();
    } finally {
        process.env.PATH = saved;
    }
}

test("newKeyPresent: gpg — absence is the file not existing, not a failed read", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-gpg-"));
    tmpDirs.push(dir);
    const env = { XDG_CONFIG_HOME: dir };
    const key = `${m.KEY_PREFIX}:demo:tok`;
    assert.equal(await m.newKeyPresent("gpg", key, env), false);
    fs.mkdirSync(path.dirname(m.keyToPath(key, env)), { recursive: true });
    fs.writeFileSync(m.keyToPath(key, env), "ciphertext");
    assert.equal(await m.newKeyPresent("gpg", key, env), true);
});

test("newKeyPresent: a read that fails for any reason OTHER than absence throws instead of reporting absent", async () => {
    // The bug this pins destroyed credentials: migrate answered "already present?" through a bare catch,
    // so a cold agent or a timeout looked like absence and the stale legacy value was written over a
    // freshly rotated one — reported as "1 migrated, 0 failed".
    await withStubOnPath("security", "#!/bin/sh\nexit 1\n", () =>   // 44 means absent; 1 does not
        assert.rejects(() => m.newKeyPresent("keychain", `${m.KEY_PREFIX}:demo:tok`), /exited 1/));
});

test("newKeyPresent: keychain exit 44 IS absence", async () => {
    await withStubOnPath("security", "#!/bin/sh\nexit 44\n", async () => {
        assert.equal(await m.newKeyPresent("keychain", `${m.KEY_PREFIX}:demo:tok`), false);
    });
});

test('projectId "user" is refused — it is the user scope\'s own namespace', () => {
    const cfg = { projectId: "user", secrets: { tok: { backend: "local" } }, servers: {} };
    assert.throws(() => m.loadConfig(projectPaths(cfg)), /reserved for the user scope/);
});

test("a secret name that is not referenceable is refused at parse time", () => {
    for (const bad of ["../../../../etc/shadow", "A b\nc", "Upper", "with_underscore"]) {
        assert.throws(
            () => m.loadConfig(projectPaths({ secrets: { [bad]: { backend: "local" } }, servers: {} })),
            /name must match/,
            `expected "${bad}" to be refused`);
    }
});

test("a launchable named __proto__ does not vanish from the merged map", () => {
    // A computed key, because `{ __proto__: … }` in a literal sets the prototype instead of a property
    // — and JSON.stringify would then drop it, leaving the fixture empty and the test green for the
    // wrong reason. This is the same hazard the null-prototype merged map exists for.
    const cfg = { secrets: {}, servers: { ["__proto__"]: { command: "x", args: [], env: {} } } };
    const loaded = m.loadConfig(projectPaths(cfg));
    assert.deepEqual(Object.keys(loaded.servers), ["__proto__"]);
    assert.equal(loaded.servers["__proto__"].command, "x");
});

test("configPaths: the user's own ~/.claude/vc-secrets.json is never taken for the project file", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-home-"));
    tmpDirs.push(home);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", m.CONFIG_NAME), JSON.stringify({ secrets: {}, servers: {} }));
    const nested = path.join(home, "work", "repo", "src");
    fs.mkdirSync(nested, { recursive: true });

    const paths = m.configPaths({ HOME: home }, nested);

    // Both scopes resolving to one file would make loadConfig drop it as a duplicate, leaving doctor
    // with no anchor for settings.local.json / .mcp.json — and its legacy-token advice inverted.
    assert.equal(paths.user, path.join(home, ".claude", m.CONFIG_NAME));
    assert.equal(paths.project, null);
    assert.equal(paths.local, null);
});

// ── hooks/guard-declarations.mjs ───────────────────────────────────────────────────────────────────

const GUARD_HOOK_PATH = fileURLToPath(new URL("./hooks/guard-declarations.mjs", import.meta.url));

function runGuardHook(stdinText) {
    return spawnSync(process.execPath, [GUARD_HOOK_PATH], { input: stdinText, encoding: "utf8" });
}

function guardInput(filePath) {
    return JSON.stringify({ tool_input: { file_path: filePath } });
}

test("guard-declarations: blocks the project declaration <repo>/.claude/vc-secrets.json", () => {
    const r = runGuardHook(guardInput("/repo/.claude/vc-secrets.json"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /BLOCK/);
});

test("guard-declarations: blocks its .local.json sibling", () => {
    const r = runGuardHook(guardInput("/repo/.claude/vc-secrets.local.json"));
    assert.equal(r.status, 2);
});

test("guard-declarations: blocks the user-scope declaration ~/.claude/vc-secrets.json", () => {
    const r = runGuardHook(guardInput(path.join(os.homedir(), ".claude", "vc-secrets.json")));
    assert.equal(r.status, 2);
});

test("guard-declarations: blocks the installed shim under plugins/data/<id>/vc-secrets-shim.mjs", () => {
    const r = runGuardHook(guardInput("/home/dev/.claude/plugins/data/vc-secrets/vc-secrets-shim.mjs"));
    assert.equal(r.status, 2);
});

test("guard-declarations: allows an ordinary source file", () => {
    const r = runGuardHook(guardInput("/repo/src/index.js"));
    assert.equal(r.status, 0);
});

test("guard-declarations: allows .claude/settings.json", () => {
    const r = runGuardHook(guardInput("/repo/.claude/settings.json"));
    assert.equal(r.status, 0);
});

test("guard-declarations: unparseable stdin is not grounds to block", () => {
    const r = runGuardHook("not json");
    assert.equal(r.status, 0);
});

// ── vc-secrets-shim.mjs ─────────────────────────────────────────────────────────────────────────────

const SHIM_PATH = fileURLToPath(new URL("./vc-secrets-shim.mjs", import.meta.url));

// Points installPath at a temp dir holding a stub launcher that just proves which install ran — real
// launcher behaviour is already covered by the vc-secrets.mjs tests above; the shim's own job is
// picking the RIGHT install and handing it argv, which is what these tests exercise.
function writeStubInstall(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-shim-install-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "vc-secrets.mjs"),
        `export async function runCli() { process.stderr.write("STUB-RAN:${label}\\n"); }\n`);

    return dir;
}

// A fresh HOME per call so ~/.claude/plugins/installed_plugins.json is exactly what the test wrote —
// never the real machine's registry.
function runShim(args, { registry, cwd } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-shim-home-"));
    tmpDirs.push(home);
    if (registry !== undefined) {
        fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
        fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify(registry));
    }

    return spawnSync(process.execPath, [SHIM_PATH, ...args], { env: { ...process.env, HOME: home }, cwd: cwd ?? home, encoding: "utf8" });
}

test("shim: no registry file at all → names the plugin as not installed, exit 1", () => {
    const r = runShim(["doctor"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /install the vc-secrets plugin|is not installed/);
});

test("shim: registry present but the plugin has no records → not installed, exit 1", () => {
    const r = runShim(["doctor"], { registry: { version: 2, plugins: {} } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /vc-secrets@vc-tools.*is not installed/);
});

test("shim: a registry schema version mismatch warns but still runs the resolved install", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-shim-proj-"));
    tmpDirs.push(projectDir);
    const stub = writeStubInstall("proceed");
    const registry = { version: 999, plugins: { "vc-secrets@vc-tools": [
        { projectPath: projectDir, version: "1.0.0", lastUpdated: "2024-01-01", installPath: stub },
    ] } };
    const r = runShim(["doctor"], { registry, cwd: projectDir });
    assert.match(r.stderr, /schema version 999, this shim was written for 2/);
    assert.match(r.stderr, /STUB-RAN:proceed/);
});

test("shim: cwd matching none of the installs picks the higher VERSION, not the later lastUpdated", () => {
    const stubA = writeStubInstall("a");
    const stubB = writeStubInstall("b");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-shim-outside-"));
    tmpDirs.push(outsideDir);
    const registry = { version: 2, plugins: { "vc-secrets@vc-tools": [
        { projectPath: "/some/other/path/a", version: "1.2.0", lastUpdated: "2030-01-01", installPath: stubA },
        { projectPath: "/some/other/path/b", version: "1.10.0", lastUpdated: "2010-01-01", installPath: stubB },
    ] } };
    const r = runShim(["doctor"], { registry, cwd: outsideDir });

    // "a" has the later lastUpdated but the lower version — picking it would be exactly the staleness
    // this shim exists to prevent.
    assert.match(r.stderr, /belongs to none of the 2 installs; using version 1\.10\.0 from \/some\/other\/path\/b/);
    assert.match(r.stderr, /STUB-RAN:b/);
    assert.ok(!r.stderr.includes("STUB-RAN:a"));
});

// ── regressions: fixes shipped without a pinning test ─────────────────────────────────────────────

test("loadConfig: an aliased .claude (symlink) is loaded once, not read as two owners", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-alias-home-"));
    tmpDirs.push(homeDir);
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", m.CONFIG_NAME),
        JSON.stringify({ secrets: { tok: { backend: "local" } }, servers: {}, tasks: {} }));

    // A second home whose .claude is a SYMLINK to the first — the alias a bind-mounted or
    // symlinked $HOME produces in the wild.
    const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-alias-link-"));
    tmpDirs.push(aliasDir);
    fs.symlinkSync(path.join(homeDir, ".claude"), path.join(aliasDir, ".claude"), "dir");

    const paths = {
        user: path.join(homeDir, ".claude", m.CONFIG_NAME),
        project: path.join(aliasDir, ".claude", m.CONFIG_NAME),
        local: null,
    };

    // Pre-fix: same-file detection compared raw strings, so the aliased "project" path looked like a
    // genuinely different file. It re-parsed the one declaration under "project" scope and then
    // its entries were attributed to two homes at once — the secret keyed to the wrong namespace, and
    // every name in the file colliding with itself.
    const cfg = m.loadConfig(paths);
    assert.equal(Object.keys(cfg.secrets).length, 1);   // one name either way; the two lines below are the pin
    assert.equal(cfg.secrets.tok.scope, "user");
    assert.deepEqual(cfg.collisions, []);
});

test("readWiredServers: sees a server wired at user scope (top-level and per-project), ignores non-vc-secrets args, null project path is safe", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-userwired-"));
    tmpDirs.push(dir);
    const userJsonPath = path.join(dir, ".claude.json");
    fs.writeFileSync(userJsonPath, JSON.stringify({
        mcpServers: {
            "top-level-wired": { command: "node", args: ["/x/vc-secrets-shim.mjs", "run", "top-level-wired"] },
            other: { command: "other-mcp", args: ["stdio"] },
        },
        projects: {
            "/some/project": {
                mcpServers: { "project-wired": { command: "node", args: ["/x/vc-secrets-shim.mjs", "run", "project-wired"] } },
            },
        },
    }));

    // Pre-fix: readWiredServers only read the project .mcp.json; a user-scope-only wiring (via `claude
    // mcp add-json --scope user`, which lives solely in ~/.claude.json) never showed up as wired.
    const wired = m.readWiredServers(null, userJsonPath, "/some/project");
    assert.deepEqual([...wired].sort(), ["project-wired", "top-level-wired"]);
    assert.ok(!wired.has("other"), "a server whose args don't mention vc-secrets must not be reported wired");
});

test("readWiredServers: another project's wiring is not counted as this project's", () => {
    // `wired` decides whether doctor says "remove that plaintext token" or "it is still required".
    // Collecting every project's block made it machine-global, so a repo wired here would make doctor
    // advise deleting a token an unmigrated repo still needs — and a PAT does not come back.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-otherproj-"));
    tmpDirs.push(dir);
    const userJsonPath = path.join(dir, ".claude.json");
    fs.writeFileSync(userJsonPath, JSON.stringify({
        projects: {
            "/repo-a": { mcpServers: { github: { command: "node", args: ["/x/vc-secrets-shim.mjs", "run", "github"] } } },
        },
    }));

    assert.equal(m.readWiredServers(null, userJsonPath, "/repo-b").size, 0, "a different project's block must not count");
    assert.ok(m.readWiredServers(null, userJsonPath, "/repo-a").has("github"), "its own block must count");
    assert.equal(m.readWiredServers(null, userJsonPath, null).size, 0, "with no project root, no per-project block applies");
});

test("readWiredServers: an unreadable user config is reported, not silently read as 'nothing wired'", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-badjson-"));
    tmpDirs.push(dir);
    const userJsonPath = path.join(dir, ".claude.json");
    fs.writeFileSync(userJsonPath, "{ this is not json");
    const problems = [];

    assert.equal(m.readWiredServers(null, userJsonPath, "/repo-a", problems).size, 0);
    assert.equal(problems.length, 1, `expected the unreadable file to be reported, got ${JSON.stringify(problems)}`);
    assert.ok(problems[0].includes(userJsonPath));
});

test("doctorReport: duplicate-tool suppression matches gpg's real message shape (trailing unlock advice)", () => {
    // Build the status string exactly as makeSecretResolver would produce it: an ENOENT from runTool
    // ("gpg: not found on PATH"), then mapResolveError's unconditional gpg suffix.
    const mapped = m.mapResolveError("gpg", "ado-pat", new Error("gpg: not found on PATH"));
    const cfg = { secrets: { "ado-pat": { backend: "local" } }, servers: {} };
    const lines = m.doctorReport(cfg, {
        env: {}, platform: "linux", enableLists: { enabled: [], disabled: [] },
        resolvable: { "ado-pat": mapped.message }, skipped: [], toolsMissing: ["gpg"], wired: new Set(), configDirOverride: false,
    });

    // Pre-fix: the suppression regex was anchored at the end of the string (`$`), so it matched wcm/
    // keychain's bare "not found on PATH" but never gpg's, whose message always has the unlock advice
    // trailing after it — gpg is Linux/WSL's only backend, so this meant duplicate FAILs on every gpg box.
    const gpgLines = lines.filter((l) => l.includes("gpg"));
    assert.deepEqual(gpgLines, [`FAIL required tool "gpg" not found on PATH`],
        "exactly one gpg line — the missing-tool FAIL, not a second per-secret FAIL");
});

test("cmdMigrate: prints no advice about \"the other scope\" for a project/local secret collision", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-migrate-collision-"));
    tmpDirs.push(dir);
    // The only secret collision that can still occur: project and local declare the same name — they
    // share one keystore namespace, so any per-collision "set it in the other scope too" advice is false.
    const decl = { projectId: "demo", secrets: { dup: { backend: "local" } }, servers: {}, tasks: {} };
    fs.writeFileSync(path.join(dir, m.CONFIG_NAME), JSON.stringify(decl));
    fs.writeFileSync(path.join(dir, m.LOCAL_CONFIG_NAME), JSON.stringify(decl));
    const binDir = stubBinary("security", "#!/bin/sh\necho already-present\nexit 0\n");

    const r = spawnSync(process.execPath, [LAUNCHER_PATH, "migrate"], {
        env: { ...process.env, VC_SECRETS_CONFIG_DIR: dir, VC_SECRETS_LOCAL_BACKEND: "keychain", PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
        encoding: "utf8",
    });

    assert.equal(r.status, 0);
    assert.match(r.stderr, /dup: already present/);
    assert.ok(!/other scope|key was written/i.test(r.stderr), `unexpected scope-advice text in migrate output:\n${r.stderr}`);
});

test("cmdMigrate: refuses to touch a secret whose current state it cannot read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-migrate-unreadable-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, m.CONFIG_NAME),
        JSON.stringify({ projectId: "demo", secrets: { dup: { backend: "local" } }, servers: {}, tasks: {} }));
    const logPath = path.join(dir, "security-calls.log");
    // Behaviour depends on the service name (`-s ...`): the NEW key's read fails with an exit code that
    // does not mean absence (44 does; 1 does not); the LEGACY key's read would succeed, so a
    // catch-as-absent bug would sail through to a destructive overwrite.
    const binDir = stubBinary("security", `#!/bin/sh
echo "$@" >> "$SECURITY_CALL_LOG"
case "$*" in
  *"vc-secrets:demo:dup"*) exit 1 ;;
  *) echo LEGACY-SENTINEL; exit 0 ;;
esac
`);

    const r = spawnSync(process.execPath, [LAUNCHER_PATH, "migrate"], {
        env: {
            ...process.env, VC_SECRETS_CONFIG_DIR: dir, VC_SECRETS_LOCAL_BACKEND: "keychain",
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`, SECURITY_CALL_LOG: logPath,
        },
        encoding: "utf8",
    });

    // Pre-fix: "is the new key already populated?" swallowed any read failure as "no", so migrate then
    // read the legacy value and WROTE it over the current (unreadable — not absent) one, reporting a
    // successful migration. The fix refuses to touch the secret at all when it cannot tell.
    assert.equal(r.status, 1, "an unreadable new-key state must fail the run, not exit 0");
    assert.match(r.stderr, /dup: cannot tell whether it is already migrated, refusing to touch it/);
    assert.match(r.stderr, /0 migrated, 1 failed/);
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(calls.length, 1, `expected only the new-key probe, no legacy read or write: ${JSON.stringify(calls)}`);
    assert.ok(!calls.some((c) => c.includes("add-generic-password")),
        "must never write — the value already in the keystore has to survive an unreadable read");
});

test("cmdRun: identifiers (AZURE_TENANT_ID, AZURE_CLIENT_ID) survive into the child — only credentials are stripped", () => {
    const dir = tmpConfigDir({
        secrets: {},
        servers: { probe: { command: process.execPath,
            args: ["-e", "process.exit(process.env.AZURE_TENANT_ID==='tid' && process.env.AZURE_CLIENT_ID==='cid' ? 7 : 9)"],
            env: {} } },
    });
    const r = spawnSync(process.execPath, [LAUNCHER_PATH, "run", "probe"], {
        env: { ...process.env, VC_SECRETS_CONFIG_DIR: dir, AZURE_TENANT_ID: "tid", AZURE_CLIENT_ID: "cid" },
        encoding: "utf8",
    });

    // Pre-fix: cmdLaunch stripped the wide LEGACY_ENV_VARS list (which includes these two identifiers)
    // instead of the narrower LEGACY_SECRET_ENV_VARS, so a server legitimately inheriting an ambient
    // tenant/client ID would fail with an unrelated auth error.
    assert.equal(r.status, 7, `expected AZURE_TENANT_ID/AZURE_CLIENT_ID to survive into the child; stderr: ${r.stderr}`);
});

test("a launchable name with a path separator, a space, or a control character is refused at parse", () => {
    for (const bad of ["../evil", "with/slash", "with\\backslash", "has space", "ctrl\nchar"]) {
        assert.throws(
            () => m.loadConfig(projectPaths({ secrets: {}, servers: { [bad]: { command: "x", args: [], env: {} } } })),
            /name must match/,
            `expected server name "${bad}" to be refused`);
    }
});

test("cmdDoctor: a task's name does not mark a same-named server as enabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-doctor-taskname-"));
    tmpDirs.push(root);
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, m.CONFIG_NAME), JSON.stringify({
        projectId: "demo",
        secrets: { "kv-secret": { backend: "keyvault", vault: "v", secret: "s" } },
        servers: { shared: { command: "true", args: [], env: { KV: "secret:kv-secret" } } },
        tasks: { shared: { command: "true", args: [], env: {} } },
    }));
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-doctor-home-"));
    tmpDirs.push(isolatedHome);

    const r = spawnSync(process.execPath, [LAUNCHER_PATH, "doctor"],
        { cwd: root, env: { ...process.env, HOME: isolatedHome }, encoding: "utf8" });

    // Pre-fix concern named in the code's own comment: servers and tasks must be iterated SEPARATELY so
    // a task cannot mark a same-named server enabled merely by existing — that would drop the SKIP and
    // make an opt-in Key Vault secret get checked (and FAIL) for a teammate who never opted in.
    assert.match(r.stderr, /SKIP secret "kv-secret" \(keyvault\)/,
        `expected kv-secret to stay SKIPped; got:\n${r.stderr}`);
    assert.ok(!r.stderr.includes('OK secret "kv-secret"'),
        "the same-named task must not make the opt-in server look enabled/consumed");
    assert.ok(!/FAIL secret "kv-secret"/.test(r.stderr));
});

// ── regressions from the bot review on PR 210 ──────────────────────────────────────────────────────

test("doctorReport: a malformed secret: reference is a FAIL, not a 'treated as a literal' warning", () => {
    // `secret:ado_pat` (underscore) does not match REF_RE, so parseReference THROWS and the launch dies.
    // Reporting it as a mistyped literal told the operator a launch-breaking value was harmless.
    const cfg = {
        secrets: {}, tasks: {},
        servers: { s: { command: "x", args: [], env: { T: "secret:ado_pat" }, home: "project" } },
    };
    const lines = m.doctorReport(cfg, {
        env: {}, platform: "linux", enableLists: { enabled: [], disabled: [], envKeys: [] },
        resolvable: {}, skipped: [], toolsMissing: [], wired: new Set(),
    });
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("secret:ado_pat")), `expected a FAIL, got:\n${lines.join("\n")}`);
    assert.ok(!lines.some((l) => l.includes("treated as a literal")), "must not be reported as a harmless literal");
});

test("an env value that is neither prefix is refused, so a pasted credential cannot look like a constant", () => {
    // What this replaces: "anything that is not a secret: reference is a literal" made `secrets:ado-pat`
    // and a real token equally valid, and each was reported as a harmless constant.
    for (const value of ["ghp_realtokenshapedthing", "secrets:ado-pat", "Secret:ado-pat", ""]) {
        assert.throws(() => m.loadConfig(projectPaths({
            secrets: { "ado-pat": { backend: "local" } },
            servers: { s: { command: "x", args: [], env: { TOKEN: value } } } })),
        /must be "secret:<name>" or "literal:<value>"/, JSON.stringify(value));
    }
});

test("readWiredServers: the DOCUMENTED wiring form is detected", () => {
    // The README's entry is {command: "node", args: ["${VC_SECRETS}", "run", "x"]}. A case-sensitive
    // search for "vc-secrets" never matches "${VC_SECRETS}", so the one configuration this plugin tells
    // people to write looked unwired — and the earlier test passed only because its fixture used a
    // lowercase literal path nobody is told to write.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-documented-"));
    tmpDirs.push(dir);
    const mcpJsonPath = path.join(dir, ".mcp.json");
    fs.writeFileSync(mcpJsonPath, JSON.stringify({
        mcpServers: {
            "via-variable": { command: "node", args: ["${VC_SECRETS}", "run", "via-variable"] },
            "via-command": { command: "/home/dev/.claude/plugins/data/x/vc-secrets-shim.mjs", args: ["run", "via-command"] },
            unrelated: { command: "other-mcp", args: ["stdio"] },
        },
    }));

    const wired = m.readWiredServers(mcpJsonPath);
    assert.deepEqual([...wired].sort(), ["via-command", "via-variable"]);
    assert.ok(!wired.has("unrelated"));
});

test("the probe runs at all — its own imports resolve", () => {
    // `node --check` proves a file parses; an undefined identifier is not a syntax error. A mechanical
    // edit replaced process.stderr.write with fs.writeSync here and left `fs` unimported, so every
    // invocation threw ReferenceError while the file still checked clean. Spawning it is the only
    // assertion that would have caught that.
    const probe = fileURLToPath(new URL("./vc-secrets-probe.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [probe], { encoding: "utf8" });
    assert.ok(!/ReferenceError|is not defined/.test(r.stderr), `probe failed to run:\n${r.stderr}`);
    assert.match(r.stderr + r.stdout, /usage: node vc-secrets-probe\.mjs/);
});

// ── regressions from the Codex review ─────────────────────────────────────────────────────────────

test("keychain write: migrate gets a non-interactive shape, set keeps the prompt", () => {
    // With no value the prompt is right: `set` has a human at the TTY and the plaintext never passes
    // through this process. With a value it must NOT prompt — migrate holds a value the user cannot
    // retype, and the interactive shape asked for one anyway and stored whatever was typed as a
    // successful migration.
    const key = `${m.KEY_PREFIX}:demo:tok`;
    const prompting = m.buildLocalWrite("keychain", key, { USER: "u" });
    assert.equal(prompting.interactive, true);
    assert.ok(!prompting.args.includes("secret-value"));

    const copying = m.buildLocalWrite("keychain", key, { USER: "u" }, { value: "secret-value" });
    assert.ok(!copying.interactive, "a copy must not wait for a human");
    // And the value must not be in argv, where this machine's process list can read it while the write
    // runs. It rides the command that `security -i` reads from stdin instead.
    assert.deepEqual(copying.args, ["-i"]);
    assert.ok(!JSON.stringify(copying.args).includes("secret-value"));
    assert.equal(copying.stdinData, m.COMMAND_ON_STDIN);
    assert.match(copying.stdinCommand("secret-value"), /^add-generic-password -U -a "u" -s "vc-secrets:demo:tok" -w "secret-value"\n$/);
    assert.ok(!copying.argvExposesValue);
});

test("a value with a line ending falls back to argv, and says so instead of hiding it", () => {
    // `security -i` reads one command per line, so a newline in the value ends the command whatever the
    // quoting does. Refusing would strand a secret migrate exists to move, so the exposure is reported.
    const key = `${m.KEY_PREFIX}:demo:tok`;
    const spec = m.buildLocalWrite("keychain", key, { USER: "u" }, { value: "line1\nline2" });
    assert.equal(spec.argvExposesValue, true);
    assert.equal(spec.args.at(-1), "line1\nline2");
    assert.equal(spec.stdinData, undefined);
});

test("quoting for security -i escapes what would end or reshape the command", () => {
    const q = m.quoteForSecurityInteractive;
    assert.equal(q("plain"), '"plain"');
    assert.equal(q('a"b'), '"a\\"b"');
    assert.equal(q("a\\b"), '"a\\\\b"');
    // A quote followed by a second command is the shape that would matter if it were not escaped.
    assert.equal(q('x" \ndelete-generic-password -s y'), '"x\\" \ndelete-generic-password -s y"');
});

test("a gpg read preserves a trailing newline the stored value really contains", async () => {
    // gpg --decrypt emits the stored bytes. Stripping there rewrote the value during migrate, which
    // reads and then writes: "token\n" would be migrated as "token".
    const binDir = stubBinary("gpg", '#!/bin/sh\nprintf "token\\n"\n');
    const saved = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${saved}`;
    try {
        const spec = m.buildLocalRead("gpg", `${m.KEY_PREFIX}:demo:tok`, { XDG_CONFIG_HOME: "/tmp" });
        assert.equal(spec.keepTrailingNewline, true);
        assert.equal(await m.runTool(spec), "token\n");
    } finally {
        process.env.PATH = saved;
    }
});

test("a double quote in command/args/vault/secret is refused — it would break argv quoting on Windows", () => {
    const q = 'x" & whoami & rem "';
    assert.throws(() => m.loadConfig(projectPaths({
        secrets: {}, servers: { s: { command: "x", args: [q], env: {} } } })), /double quote/);
    assert.throws(() => m.loadConfig(projectPaths({
        secrets: {}, servers: { s: { command: q, args: [], env: {} } } })), /double quote/);
    assert.throws(() => m.loadConfig(projectPaths({
        secrets: { kv: { backend: "keyvault", vault: q, secret: "s" } }, servers: {} })), /double quote/);
});

test("install-shim: copies the shim, is idempotent, and prints the settings entry plus literal commands", () => {
    const script = fileURLToPath(new URL("./scripts/install-shim.mjs", import.meta.url));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-inst-"));
    tmpDirs.push(home);
    // A foreign CLAUDE_PLUGIN_DATA in the environment, and it changes nothing: with no --data-dir the
    // directory is computed. Measured provenance of such a value: a session where another plugin's
    // context had set it, which put the shim in `…/data/codex-openai-codex` before the variable was
    // dropped as an input.
    const env = { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: path.join(home, "data", "some-other-plugin") };

    const first = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr);
    const shim = path.join(home, ".claude", "plugins", "data", "vc-secrets-vc-tools", "vc-secrets-shim.mjs");
    assert.ok(fs.existsSync(shim), `expected the shim at ${shim}\n${first.stdout}${first.stderr}`);
    assert.match(first.stdout, /installed/);
    assert.match(first.stdout, /"VC_SECRETS"/);
    // No shell export: the shim's path is already stable and literal, so a human running set/unlock/
    // migrate/doctor by hand needs no per-shell setup, and none is printed or suggested.
    assert.doesNotMatch(first.stdout, /export/i);
    assert.doesNotMatch(first.stdout, /shell rc/i);
    const quoted = JSON.stringify(shim);
    for (const verb of ["set <name>", "unlock", "migrate", "doctor"]) {
        assert.ok(first.stdout.includes(`node ${quoted} ${verb}`), `expected the literal ${verb} command\n${first.stdout}`);
    }

    const second = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already up to date/);
    assert.equal(fs.existsSync(path.join(env.CLAUDE_PLUGIN_DATA, "vc-secrets-shim.mjs")), false,
        "must not write into another plugin's directory");
});

test("install-shim: --data-dir decides the location, in both spellings", () => {
    // The client hands over the directory it assigned; re-deriving a path the client already knows is
    // what this flag replaces. The value is honoured wherever it points, as long as it names this plugin.
    const script = fileURLToPath(new URL("./scripts/install-shim.mjs", import.meta.url));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-inst2-"));
    tmpDirs.push(home);
    const assigned = path.join(home, "elsewhere", "vc-secrets-vc-tools");
    const computed = path.join(home, ".claude", "plugins", "data", "vc-secrets-vc-tools");

    for (const argv of [["--data-dir", assigned], [`--data-dir=${assigned}`]]) {
        fs.rmSync(assigned, { recursive: true, force: true });
        const r = spawnSync(process.execPath, [script, ...argv], { encoding: "utf8", env: { ...process.env, HOME: home } });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(fs.existsSync(path.join(assigned, "vc-secrets-shim.mjs")), `${argv[0]}\n${r.stdout}${r.stderr}`);
        assert.equal(fs.existsSync(computed), false, "the computed default must not be created when a directory was passed");
        assert.match(r.stdout, /--data-dir/);
    }

    // A dropped argument would install into the computed default and report that as the choice, so an
    // argument that is neither spelling has to stop the run rather than be skipped.
    const typo = spawnSync(process.execPath, [script, "--data-dirs", assigned], { encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /unrecognised argument/);
});

test("install-shim: a --data-dir naming another plugin is ignored, with a warning", () => {
    // The regression this exists for: the documented line is a SHELL line, so where Claude Code does not
    // substitute `${CLAUDE_PLUGIN_DATA}` the shell expands it from the inherited environment — measured as
    // `…/data/codex-openai-codex`. That is an absolute path, so nothing syntactic rejects it, and a later
    // uninstall of that plugin would delete this plugin's shim with its data directory. Reproduced through
    // a real shell, because through argv alone the case cannot occur.
    const script = fileURLToPath(new URL("./scripts/install-shim.mjs", import.meta.url));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-inst3-"));
    tmpDirs.push(home);
    const foreign = path.join(home, ".claude", "plugins", "data", "some-other-plugin");
    fs.mkdirSync(foreign, { recursive: true });

    const r = spawnSync("bash", ["-c", `node ${JSON.stringify(script)} --data-dir "\${CLAUDE_PLUGIN_DATA}"`], {
        encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: foreign },
    });
    // Without this the missing-bash case fails on `r.stderr` being undefined, which names nothing.
    assert.equal(r.error, undefined, `a shell is required to reproduce this: ${r.error?.code}`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /ignoring --data-dir/);
    assert.equal(fs.existsSync(path.join(foreign, "vc-secrets-shim.mjs")), false, "must not write into another plugin's directory");
    assert.ok(fs.existsSync(path.join(home, ".claude", "plugins", "data", "vc-secrets-vc-tools", "vc-secrets-shim.mjs")));
    assert.match(r.stdout, /some-other-plugin/);
});

test("install-shim: a --data-dir that never expanded is refused, not turned into a directory", () => {
    // Reachable on Windows, where cmd.exe leaves `${...}` alone: the placeholder arrives as text and
    // `mkdir` on it would succeed quietly, creating a directory named after the variable.
    const script = fileURLToPath(new URL("./scripts/install-shim.mjs", import.meta.url));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-inst4-"));
    tmpDirs.push(home);

    const r = spawnSync(process.execPath, [script, "--data-dir", "${CLAUDE_PLUGIN_DATA}"], {
        encoding: "utf8", env: { ...process.env, HOME: home },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be an absolute path/);
    assert.equal(fs.existsSync(path.join(home, ".claude")), false, "nothing may be created on that path");
});

test("install-shim: an empty --data-dir falls back to the computed default and says which was used", () => {
    // A shell expanding an unset variable produces this, and it is what a human copy-pasting the
    // documented line into a terminal gets. The default is right for every install whose marketplace
    // carries the shipped name, so it proceeds — but the output has to name the choice.
    const script = fileURLToPath(new URL("./scripts/install-shim.mjs", import.meta.url));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-inst5-"));
    tmpDirs.push(home);

    const r = spawnSync(process.execPath, [script, "--data-dir", ""], {
        encoding: "utf8", env: { ...process.env, HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(home, ".claude", "plugins", "data", "vc-secrets-vc-tools", "vc-secrets-shim.mjs")));
    assert.match(r.stdout, /arrived empty/);
});

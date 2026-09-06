#!/usr/bin/env node
// vc-secrets-shim.mjs — the stable path an MCP entry points at.
//
// Why an indirection exists at all: a repo's committed .mcp.json cannot name the launcher's real
// location, because plugin files live in a cache directory whose path carries the plugin version and
// therefore changes on every update. Copying the launcher to a stable path instead would go stale
// silently — the plugin's commands would update while the launcher kept running an old version, and
// the launcher's own version diagnostics would then blame the plugin. So the stable path holds a
// POINTER: this file resolves the plugin's current location per launch — from the install registry
// where a client maintains one, and otherwise from the client's own plugin cache, whose layout
// carries the version in the path.
//
// Installed by the vc-secrets install skill. Rarely changes; when its contract does, SHIM_CONTRACT below goes
// up and `doctor` tells the developer to re-run install.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHIM_CONTRACT = 1;
const PLUGIN_KEY = "vc-secrets@vc-tools";
const REGISTRY_SCHEMA = 2;
const LAUNCHER = "vc-secrets.mjs";
const [PLUGIN_NAME] = PLUGIN_KEY.split("@");

// Only one of the three clients maintains an install registry, so resolution has two stages. The
// registry is preferred where it exists because it is the only source that knows about per-project
// installs. Everywhere else the cache layout is the source: measured as
// <root>/<marketplace>/<plugin>/<version>/ on both clients available to measure. The marketplace
// segment is globbed rather than named, because whoever registered the marketplace chose its name.
//
// Cursor has no entry yet. That is deliberate: an unmeasured root would be a guess, and a wrong one
// resolves to nothing in exactly the same way as an absent one while implying it was checked. When
// its layout is established it becomes one more line here.
const CACHE_ROOTS = [
    path.join(os.homedir(), ".claude", "plugins", "cache"),
    path.join(os.homedir(), ".codex", "plugins", "cache"),
];

// readdirSync does not follow links, so Dirent.isDirectory() is FALSE for a symlink to a directory —
// measured. Filtering on it alone silently skips a linked install, which either picks an older real
// directory or reports a plugin that is installed as missing. Loading a plugin from a local directory
// is a documented route on one of these clients, so linked entries are ordinary here. Whether the
// target is really usable is settled two lines later by looking for the launcher inside it.
const isDirLike = (entry) => entry.isDirectory() || entry.isSymbolicLink();

function installsInCaches() {
    const found = [];
    for (const root of CACHE_ROOTS) {
        let marketplaces;
        try {
            marketplaces = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;   // a client that is not installed contributes nothing, and that is not an error
        }
        for (const marketplace of marketplaces.filter(isDirLike)) {
            const pluginDir = path.join(root, marketplace.name, PLUGIN_NAME);
            let versions;
            try {
                versions = fs.readdirSync(pluginDir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const version of versions.filter(isDirLike)) {
                const installPath = path.join(pluginDir, version.name);
                // A version directory with no launcher in it is a partial or abandoned install. Ranking
                // it would hand the newest slot to a directory whose launch then fails on a missing
                // file, naming a path nobody chose.
                if (fs.existsSync(path.join(installPath, LAUNCHER))) {
                    found.push({ version: version.name, installPath });
                }
            }
        }
    }

    return found;
}

function fail(message) {
    // sync write: stderr is an async pipe on Windows, and process.exit abandons pending writes
    fs.writeSync(2, `vc-secrets: ${message}\n`);
    process.exit(1);
}

const registryPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
let registry = null;
try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
} catch {
    // No longer fatal. This file belongs to one client, and the plugin is meant to run under three —
    // failing here is what made every generated config entry naming this shim useless on the other
    // two. The cache walk covers them, and the failure at the end names every root that was tried.
}
// This file is owned by the client, so a schema change arrives with a Claude Code upgrade — no user
// action at all. Refusing to launch would take every wrapped server down at once, and the message lands
// on a server's stderr, which surfaces only as "server failed to start" — pointing away from here. So
// warn and continue: the single field consumed below is `plugins[key][].installPath`, and if that has
// moved, the checks after this fail with their own legible message.
if (registry && registry.version !== REGISTRY_SCHEMA) {
    fs.writeSync(2, `vc-secrets: ${registryPath} is schema version ${registry.version}, this shim was written for ${REGISTRY_SCHEMA} — continuing, but update the plugin\n`);
}

// Drop anything that is not an object before reading fields off it: the file is the client's, and a
// hostile or truncated shape must produce this function's own message rather than a raw TypeError.
const records = (Array.isArray(registry?.plugins?.[PLUGIN_KEY]) ? registry.plugins[PLUGIN_KEY] : [])
    .filter((r) => r !== null && typeof r === "object");

// One plugin can be installed several times (per project, plus user scope). Prefer the record whose
// project contains the current directory.
const cwd = path.resolve(process.cwd());
const matches = records.filter((r) => typeof r.projectPath === "string"
    && (cwd === path.resolve(r.projectPath) || cwd.startsWith(path.resolve(r.projectPath) + path.sep)));
// With nested projects several records match; the NEAREST one owns this directory, so the longest
// matching projectPath wins before version is consulted. Ranking all matches by version instead would
// hand a child project its parent's launcher whenever the parent happened to be newer.
const longest = Math.max(0, ...matches.map((r) => path.resolve(r.projectPath).length));
const byProject = matches.filter((r) => path.resolve(r.projectPath).length === longest);
const candidates = byProject.length > 0 ? byProject : records;

// When cwd belongs to none of them — a git worktree or a scratch directory often sits outside every
// registered project path — the tiebreak must be the VERSION. `lastUpdated` is refreshed
// independently of any version change, so ordering by it can select an older launcher against newer
// declarations: exactly the staleness this shim exists to prevent, and silent when it happens.
const versionKey = (r) => {
    const raw = String(r.version ?? "");
    // Split the prerelease suffix off before parsing. Without this, "1.0.0-rc.1" splits on dots into
    // ["1","0","0-rc","1"], parseInt("0-rc") is 0, and the extra fourth segment beats the absent one —
    // so a release candidate outranks its own release and runs against production declarations,
    // silently. A sentinel below every real segment restores the semver rule without a semver parser,
    // which this file has no dependency budget for.
    const dash = raw.indexOf("-");
    const core = dash === -1 ? raw : raw.slice(0, dash);
    const nums = core.split(".").map((p) => Number.parseInt(p, 10)).map((n) => (Number.isFinite(n) ? n : -1));
    nums.push(dash === -1 ? 1 : 0);

    return nums;
};
const newer = (a, b) => {
    const [va, vb] = [versionKey(a), versionKey(b)];
    for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
        const [x, y] = [va[i] ?? -1, vb[i] ?? -1];
        if (x !== y) {
            return x > y;
        }
    }

    return String(a.lastUpdated ?? "") > String(b.lastUpdated ?? "");
};
const pick = (rs) => rs.reduce((best, r) => (newer(r, best) ? r : best), rs[0]);

let record;
if (candidates.length > 0) {
    record = pick(candidates);
    if (byProject.length === 0 && records.length > 1) {
        fs.writeSync(2, `vc-secrets: this directory belongs to none of the ${records.length} installs; using version ${record.version ?? "unknown"} from ${record.projectPath ?? "user scope"}\n`);
    }
} else {
    // The registry knew nothing — either it does not exist, or it lists no install of this plugin.
    // Both are ordinary on a client that does not maintain one, so the caches decide.
    const cached = installsInCaches();
    if (cached.length === 0) {
        fail(`plugin ${PLUGIN_KEY} is not installed — looked in ${registryPath} and in ${CACHE_ROOTS.join(", ")}. `
            + "Install it from the marketplace, then run the vc-secrets install skill");
    }
    record = pick(cached);
}

const launcherIn = (r) => {
    if (typeof r?.installPath !== "string" || r.installPath === "") {
        return null;
    }
    const candidate = path.join(r.installPath, LAUNCHER);

    return fs.existsSync(candidate) ? candidate : null;
};

let launcher = launcherIn(record);
if (!launcher) {
    // The chosen record is unusable — no installPath, or one whose launcher has gone. A stale entry is
    // the ordinary result of a manual removal or a half-finished update, and a healthy install may be
    // sitting in a cache the registry knows nothing about. Failing here told the developer to reinstall
    // something already on disk. installsInCaches only returns directories that hold the launcher, so
    // anything it finds is usable by construction.
    const healthy = installsInCaches();
    if (healthy.length > 0) {
        record = pick(healthy);
        launcher = launcherIn(record);
        fs.writeSync(2, `vc-secrets: ${registryPath} points at an install that is gone; using version ${record.version ?? "unknown"} from the plugin cache\n`);
    }
}
if (!launcher) {
    fail(`no usable install of ${PLUGIN_KEY} — the record in ${registryPath} points nowhere and no plugin cache holds ${LAUNCHER}. `
        + "Reinstall it from the marketplace, then run the vc-secrets install skill");
}

// Everything up to runCli happens before the launcher installs its own handlers, so a failure here
// would otherwise surface as a raw Node stack trace from a cache path — unreadable, and it names the
// wrong component.
let mod;
try {
    mod = await import(pathToFileURL(launcher).href);
} catch (e) {
    fail(`cannot load ${launcher}: ${e.message}`);
}
if (typeof mod.runCli !== "function") {
    fail(`${launcher} does not export runCli — this shim is older than the plugin, re-run the vc-secrets install skill`);
}

await mod.runCli(process.argv.slice(2), { shimContract: SHIM_CONTRACT });

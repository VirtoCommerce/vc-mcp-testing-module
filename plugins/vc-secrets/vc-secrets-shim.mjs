#!/usr/bin/env node
// vc-secrets-shim.mjs — the stable path an MCP entry points at.
//
// Why an indirection exists at all: a repo's committed .mcp.json cannot name the launcher's real
// location, because plugin files live in a cache directory whose path carries the plugin version and
// therefore changes on every update. Copying the launcher to a stable path instead would go stale
// silently — the plugin's commands would update while the launcher kept running an old version, and
// the launcher's own version diagnostics would then blame the plugin. So the stable path holds a
// POINTER: this file resolves the plugin's current location per launch, from the same registry the
// client itself maintains.
//
// Installed by /vc-secrets:install. Rarely changes; when its contract does, SHIM_CONTRACT below goes
// up and `doctor` tells the developer to re-run install.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHIM_CONTRACT = 1;
const PLUGIN_KEY = "vc-secrets@vc-tools";
const REGISTRY_SCHEMA = 2;
const LAUNCHER = "vc-secrets.mjs";

function fail(message) {
    // sync write: stderr is an async pipe on Windows, and process.exit abandons pending writes
    fs.writeSync(2, `vc-secrets: ${message}\n`);
    process.exit(1);
}

const registryPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
let registry;
try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
} catch {
    fail(`cannot read ${registryPath} — install the vc-secrets plugin, then run /vc-secrets:install`);
}
// This file is owned by the client, so a schema change arrives with a Claude Code upgrade — no user
// action at all. Refusing to launch would take every wrapped server down at once, and the message lands
// on a server's stderr, which surfaces only as "server failed to start" — pointing away from here. So
// warn and continue: the single field consumed below is `plugins[key][].installPath`, and if that has
// moved, the checks after this fail with their own legible message.
if (registry.version !== REGISTRY_SCHEMA) {
    fs.writeSync(2, `vc-secrets: ${registryPath} is schema version ${registry.version}, this shim was written for ${REGISTRY_SCHEMA} — continuing, but update the plugin\n`);
}

// Drop anything that is not an object before reading fields off it: the file is the client's, and a
// hostile or truncated shape must produce this function's own message rather than a raw TypeError.
const records = (Array.isArray(registry.plugins?.[PLUGIN_KEY]) ? registry.plugins[PLUGIN_KEY] : [])
    .filter((r) => r !== null && typeof r === "object");
if (records.length === 0) {
    fail(`plugin ${PLUGIN_KEY} is not installed — install it from the marketplace, then run /vc-secrets:install`);
}

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
const versionKey = (r) => String(r.version ?? "").split(".").map((p) => Number.parseInt(p, 10)).map((n) => (Number.isFinite(n) ? n : -1));
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
const record = candidates.reduce((best, r) => (newer(r, best) ? r : best), candidates[0]);
if (byProject.length === 0 && records.length > 1) {
    fs.writeSync(2, `vc-secrets: this directory belongs to none of the ${records.length} installs; using version ${record.version ?? "unknown"} from ${record.projectPath ?? "user scope"}\n`);
}

if (typeof record.installPath !== "string" || record.installPath === "") {
    fail(`${registryPath} has no installPath for ${PLUGIN_KEY} — reinstall the plugin`);
}
const launcher = path.join(record.installPath, LAUNCHER);
if (!fs.existsSync(launcher)) {
    fail(`${launcher} is missing — the plugin install looks incomplete, reinstall it from the marketplace`);
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
    fail(`${launcher} does not export runCli — this shim is older than the plugin, re-run /vc-secrets:install`);
}

await mod.runCli(process.argv.slice(2), { shimContract: SHIM_CONTRACT });

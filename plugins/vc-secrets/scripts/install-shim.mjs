#!/usr/bin/env node
// install-shim.mjs — puts the shim at a stable path and prints the two variable lines.
//
// This exists as a script rather than as prose in the command file because the three operations are
// exact: resolve one directory, copy one file, print two lines. Prose would have the agent re-derive
// them on every run, and a script can be tested.
//
// It never writes settings.json or a shell rc: those belong to the developer, and a tool that edits
// them unasked is a tool nobody trusts twice. It prints; the human pastes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHIM = "vc-secrets-shim.mjs";
// The documented id shape: "<plugin>-<marketplace>", non-alphanumerics replaced by a dash.
const CANONICAL_DATA_ID = "vc-secrets-vc-tools";

function fail(message) {
    // sync write: stderr is an async pipe on Windows, and process.exit abandons pending writes
    fs.writeSync(2, `install-shim: ${message}\n`);
    process.exit(1);
}

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
    ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // scripts/ -> plugin root
const source = path.join(pluginRoot, SHIM);
if (!fs.existsSync(source)) {
    fail(`${source} not found — CLAUDE_PLUGIN_ROOT is ${process.env.CLAUDE_PLUGIN_ROOT ?? "unset"}, so this is not a complete plugin install`);
}

// CLAUDE_PLUGIN_DATA is the documented stable directory and survives updates; the cache path does not,
// which is the whole reason the shim exists. But it is set per PLUGIN, for whichever plugin's context is
// executing — measured: running this script from a session where another plugin's command was active
// pointed it at `…/data/codex-openai-codex`, and the shim was written into that plugin's directory. So
// the value is used only when it actually names this plugin; otherwise the documented layout is used.
const dataHome = path.join(process.env.HOME || os.homedir(), ".claude", "plugins", "data");
const declared = process.env.CLAUDE_PLUGIN_DATA;
let target = declared && path.basename(declared).toLowerCase().includes("vc-secrets") ? declared : null;
let how = "CLAUDE_PLUGIN_DATA";
if (!target) {
    if (declared) {
        fs.writeSync(2, `install-shim: ignoring CLAUDE_PLUGIN_DATA=${declared} — it belongs to another plugin\n`);
    }
    const existing = fs.existsSync(dataHome)
        ? fs.readdirSync(dataHome).filter((d) => d.toLowerCase().includes("vc-secrets"))
        : [];
    if (existing.length > 1) {
        fail(`${dataHome} holds more than one candidate (${existing.join(", ")}) — remove the stale one, then re-run`);
    }
    target = path.join(dataHome, existing[0] ?? CANONICAL_DATA_ID);
    how = existing.length === 1 ? `existing directory under ${dataHome}` : `created ${CANONICAL_DATA_ID} under ${dataHome}`;
}

const destination = path.join(target, SHIM);
let replaced = "installed";
if (fs.existsSync(destination)) {
    replaced = fs.readFileSync(destination, "utf8") === fs.readFileSync(source, "utf8")
        ? "already up to date"
        : "replaced an older copy";
}
try {
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(source, destination);
} catch (e) {
    fail(`cannot write ${destination}: ${e.message}`);
}

const lines = [
    `shim: ${destination} (${replaced}; directory chosen via ${how})`,
    "",
    "Add BOTH of these — they are read by different processes:",
    "",
    `  ~/.claude/settings.json   {"env": {"VC_SECRETS": ${JSON.stringify(destination)}}}`,
    `  shell rc                  export VC_SECRETS=${JSON.stringify(destination)}`,
    "",
    "The settings entry is what a wrapped MCP server reads; MCP servers pick it up only after a restart.",
    "The export is what `set`, `unlock`, `doctor` and `migrate` read when you run them by hand — without",
    "it those commands run `node \"\"` in a terminal. Neither file is written for you.",
    "",
    `Then verify:  node ${JSON.stringify(destination)} doctor`,
];
fs.writeSync(1, lines.join("\n") + "\n");

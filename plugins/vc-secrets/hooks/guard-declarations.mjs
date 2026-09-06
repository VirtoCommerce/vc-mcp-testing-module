#!/usr/bin/env node
// Blocks agent writes to the two files that decide which command receives which secret: a declaration
// file, and the shim every launch goes through.
//
// This is a speed bump, not a boundary: it sees the client's write tools only, so the same write
// through a shell command goes past it untouched. The block message says so on purpose — a guard that
// reads as "protected" invites someone to build a security argument on top of it, and this one cannot
// carry it.
//
// Protocol, verified on both clients that read this: the tool call arrives as JSON on stdin; exit 2
// WITH a non-empty reason on stderr denies the call, exit 0 allows it. Exit 2 with an EMPTY stderr is
// treated as a failure and the call proceeds, so the reason is part of the contract, not decoration.
//
// It takes no --client: the hook file is shared, so it has one command string, and the payload's own
// tool_name is what says which shape this is.

import fs, { readFileSync } from "node:fs";

import { targetsFrom } from "./targets.mjs";

const DECLARATION_RE = /\/\.claude\/vc-secrets(\.local)?\.json$/i;
const SHIM_RE = /\/plugins\/data\/[^/]+\/vc-secrets-shim\.mjs$/i;

let input;
try {
    input = JSON.parse(readFileSync(0, "utf8"));
} catch {
    process.exit(0);   // unparseable input is not grounds to block an edit
}

let targets;
try {
    targets = targetsFrom(input);
} catch (e) {
    // Nothing in targetsFrom throws today. The catch stays because exiting 1 from an unexpected throw
    // would ALLOW the call: refusing an edit is recoverable, letting a declaration edit through is not.
    fs.writeSync(2, `BLOCK: vc-secrets guard failed to read this payload — ${e.message}\n`);
    process.exit(2);
}

if (!targets.readable) {
    // This used to be indistinguishable from "I found nothing". It stays rare by construction: a tool
    // that is not a write tool reports readable: true, so this fires only for a write whose payload
    // this guard could not parse — which is exactly the case worth saying out loud.
    const what = typeof input.tool_name === "string" && input.tool_name ? input.tool_name : "unnamed tool";
    fs.writeSync(2, `vc-secrets guard: unrecognised ${what} payload — not inspected\n`);
    process.exit(0);
}

for (const raw of targets.paths) {
    const filePath = raw.replace(/\\/g, "/");
    // Covers all three homes: <repo>/.claude/vc-secrets.json, its .local. sibling, and
    // ~/.claude/vc-secrets.json
    if (DECLARATION_RE.test(filePath)) {
        fs.writeSync(2,
            "BLOCK: a vc-secrets declaration decides which command receives which secret — change it via a human PR, not an in-session edit. "
            + "(This guard sees the client's write tools only; it is a speed bump, not a security boundary.)\n");
        process.exit(2);
    }
    // The shim is what every server launch runs, and — unlike the launcher in the plugin cache — a
    // plugin update never overwrites it, so an edit here survives indefinitely.
    if (SHIM_RE.test(filePath)) {
        fs.writeSync(2,
            "BLOCK: the vc-secrets shim is on the path of every server launch — reinstall it with /vc-secrets:install instead of editing it.\n");
        process.exit(2);
    }
}

process.exit(0);

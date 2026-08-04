#!/usr/bin/env node
// Blocks agent Edit/Write on the two files that decide which command receives which secret:
// a declaration file, and the shim every launch goes through.
//
// This is a speed bump, not a boundary: it sees Edit/Write only, so the same write through a shell
// command goes past it untouched. The block message says so on purpose — a guard that reads as
// "protected" invites someone to build a security argument on top of it, and this one cannot carry it.
//
// Protocol (verified against the running client): the tool call arrives as JSON on stdin with
// tool_input.file_path; exit 2 with a reason on stderr denies the call, exit 0 allows it.

import fs, { readFileSync } from "node:fs";

let input;
try {
    input = JSON.parse(readFileSync(0, "utf8"));
} catch {
    process.exit(0);   // unparseable input is not grounds to block an edit
}

const filePath = ((input.tool_input || {}).file_path || "").replace(/\\/g, "/");

// Covers all three homes: <repo>/.claude/vc-secrets.json, its .local. sibling, and ~/.claude/vc-secrets.json
if (/\/\.claude\/vc-secrets(\.local)?\.json$/i.test(filePath)) {
    fs.writeSync(2, 
        "BLOCK: a vc-secrets declaration decides which command receives which secret — change it via a human PR, not an in-session edit. "
        + "(Edit/Write only; this is a speed bump, not a security boundary.)\n"
    );
    process.exit(2);
}

// The shim is what every server launch runs, and — unlike the launcher in the plugin cache — a plugin
// update never overwrites it, so an edit here survives indefinitely.
if (/\/plugins\/data\/[^/]+\/vc-secrets-shim\.mjs$/i.test(filePath)) {
    fs.writeSync(2, 
        "BLOCK: the vc-secrets shim is on the path of every server launch — reinstall it with /vc-secrets:install instead of editing it.\n"
    );
    process.exit(2);
}

process.exit(0);

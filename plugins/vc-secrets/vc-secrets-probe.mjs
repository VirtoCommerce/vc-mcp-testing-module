// vc-secrets-probe.mjs — verification aid: initialize-handshake through vc-secrets run.
// Usage: node vc-secrets-probe.mjs <server>
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const server = process.argv[2];
if (!server) {
    fs.writeSync(2, "usage: node vc-secrets-probe.mjs <server>\n");
    process.exit(2);
}
const child = spawn(process.execPath, [path.join(__dirname, "vc-secrets.mjs"), "run", server],
    { stdio: ["pipe", "pipe", "inherit"] });
const request = { jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vc-secrets-probe", version: "0" } } };
child.stdin.on("error", () => {});
child.stdin.write(JSON.stringify(request) + "\n");

const timer = setTimeout(() => {
    fs.writeSync(2, `probe: ${server} -> TIMEOUT (30 s)\n`);
    child.kill("SIGTERM");
    process.exit(1);
}, 30_000);

let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
            continue;
        }
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            continue;   // partial or non-JSON line
        }
        if (message.id !== 1) {
            continue;
        }
        clearTimeout(timer);
        const ok = Boolean(message.result?.serverInfo);
        fs.writeSync(2, `probe: ${server} -> ${ok ? `OK ${message.result.serverInfo.name}` : `FAIL ${line.slice(0, 200)}`}\n`);
        child.kill("SIGTERM");
        process.exit(ok ? 0 : 1);
    }
});
child.on("close", () => {
    clearTimeout(timer);
    fs.writeSync(2, `probe: ${server} -> server exited before responding\n`);
    process.exit(1);
});

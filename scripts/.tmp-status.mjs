import { readFileSync, writeFileSync } from "node:fs";
const P = "reports/regression/test-run-status.json";
const [id, status, ...kv] = process.argv.slice(2);
const s = JSON.parse(readFileSync(P, "utf-8"));
if (id === "__run__") {
  s.status = status;
  if (status === "completed") s.finishedAt = new Date().toISOString();
} else {
  const su = s.suites.find(x => x.id === id);
  if (!su) throw new Error("no suite " + id);
  su.status = status;
  for (const p of kv) { const i = p.indexOf("="); const k = p.slice(0, i); let v = p.slice(i + 1);
    su[k] = /^\d+$/.test(v) ? Number(v) : v; }
}
writeFileSync(P, JSON.stringify(s, null, 2) + "\n");
console.log("status updated:", id, status);

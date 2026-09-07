// Temp helper for REG-2026-09-07-1342 orchestration — updates both status file copies.
import fs from 'fs';

const ROOT = 'reports/regression/test-run-status.json';
const RUNDIR = 'reports/regression/REG-2026-09-07-1342/test-run-status.json';

const [, , mode, ...args] = process.argv;

function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function save(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }

if (mode === 'set') {
  // args: id status browser [attemptsIncrement]
  const [id, status, browser, attemptsInc] = args;
  for (const p of [ROOT, RUNDIR]) {
    const data = load(p);
    const s = data.suites.find(x => x.id === id);
    if (!s) { console.error('suite not found', id, 'in', p); continue; }
    s.status = status;
    if (browser && browser !== '-') s.browser = browser;
    if (attemptsInc) s.attempts = (s.attempts || 0) + parseInt(attemptsInc, 10);
    save(p, data);
  }
  console.log('set', id, status, browser);
} else if (mode === 'result') {
  // args: id pass fail blocked skipped
  const [id, pass, fail, blocked, skipped] = args;
  for (const p of [ROOT, RUNDIR]) {
    const data = load(p);
    const s = data.suites.find(x => x.id === id);
    if (!s) continue;
    s.pass = parseInt(pass, 10);
    s.fail = parseInt(fail, 10);
    s.blocked = parseInt(blocked, 10);
    s.skipped = parseInt(skipped, 10);
    save(p, data);
  }
  console.log('result', id, pass, fail, blocked, skipped);
} else if (mode === 'complete') {
  // args: finishedAtISO
  const [finishedAt] = args;
  for (const p of [ROOT, RUNDIR]) {
    const data = load(p);
    data.status = 'completed';
    data.finishedAt = finishedAt;
    save(p, data);
  }
  console.log('completed', finishedAt);
} else if (mode === 'show') {
  const data = load(ROOT);
  for (const s of data.suites) {
    console.log(s.id.padEnd(6), s.status.padEnd(10), (s.browser||'-').padEnd(20), 'attempts='+s.attempts, 'P='+s.pass, 'F='+s.fail, 'B='+s.blocked, 'S='+s.skipped);
  }
} else {
  console.error('usage: set <id> <status> <browser> [attemptsInc] | result <id> <p> <f> <b> <s> | complete <iso> | show');
  process.exit(1);
}

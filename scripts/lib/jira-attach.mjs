#!/usr/bin/env node
/**
 * Attach local files to a Jira issue.
 *
 * The Atlassian MCP connector has no attachment tool, so evidence (screenshots,
 * a repro recording) could only be added by hand. This closes that gap.
 *
 * Usage
 *   node scripts/lib/jira-attach.mjs <ISSUE-KEY> <file> [file...]
 *   npm run jira:attach -- VCST-5900 path/to/a.png path/to/b.mp4
 *
 *   --list     Only list what is already attached to the issue, upload nothing.
 *   --json     Machine-readable output (ids + filenames), for embedding in a comment.
 *
 * Credentials come from .env.local: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
 * (a classic Atlassian API token — Basic auth against the site URL). The token is
 * never printed.
 *
 * Note the `X-Atlassian-Token: no-check` header: without it Jira rejects the
 * upload as a suspected XSRF attempt with a bare 403 and no explanation.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.har': 'application/json',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
};

function credentials() {
  const raw = readFileSync('.env.local', 'utf8');
  const pick = (key) => raw.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1].trim();
  const base = pick('JIRA_BASE_URL');
  const email = pick('JIRA_EMAIL');
  const token = pick('JIRA_API_TOKEN');
  if (!base || !email || !token) {
    throw new Error('JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN missing from .env.local');
  }
  return { base: base.replace(/\/$/, ''), auth: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64') };
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const asJson = args.includes('--json');
const positional = args.filter((a) => !a.startsWith('--'));
const [issue, ...files] = positional;

if (!issue || (!listOnly && files.length === 0)) {
  console.error('Usage: node scripts/lib/jira-attach.mjs <ISSUE-KEY> <file> [file...] [--list] [--json]');
  process.exit(2);
}

const { base, auth } = credentials();

if (listOnly) {
  const res = await fetch(`${base}/rest/api/3/issue/${issue}?fields=attachment`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`list failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  const items = json.fields?.attachment ?? [];
  if (asJson) console.log(JSON.stringify(items.map((a) => ({ id: a.id, filename: a.filename, size: a.size })), null, 2));
  else {
    console.log(`${issue}: ${items.length} attachment(s)`);
    for (const a of items) console.log(`  ${a.id}  ${(a.size / 1024).toFixed(0).padStart(6)} KB  ${a.filename}`);
  }
  process.exit(0);
}

// One request per file: a partial failure then names the file that failed, instead
// of a single opaque error for the whole batch.
const results = [];
for (const path of files) {
  const name = basename(path);
  const size = statSync(path).size;
  const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';

  const form = new FormData();
  form.append('file', new Blob([readFileSync(path)], { type }), name);

  const res = await fetch(`${base}/rest/api/3/issue/${issue}/attachments`, {
    method: 'POST',
    headers: { Authorization: auth, Accept: 'application/json', 'X-Atlassian-Token': 'no-check' },
    body: form,
  });
  const json = await res.json().catch(() => null);

  if (!res.ok || !Array.isArray(json) || !json[0]?.id) {
    console.error(`FAILED  ${name}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    results.push({ filename: name, ok: false, status: res.status });
    continue;
  }
  results.push({ id: json[0].id, filename: json[0].filename, size, ok: true });
  if (!asJson) console.log(`OK  ${json[0].id}  ${(size / 1024).toFixed(0).padStart(6)} KB  ${json[0].filename}`);
}

if (asJson) console.log(JSON.stringify(results, null, 2));

const failed = results.filter((r) => !r.ok).length;
if (failed) {
  console.error(`\n${failed} of ${results.length} file(s) failed`);
  process.exit(1);
}

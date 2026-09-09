# MCP Servers & Browser Automation Reference

## MCP Servers (configured in .mcp.json)

| Server | Purpose | Config File |
|--------|---------|-------------|
| **playwright-chrome** | Browser automation with Chromium | `config/mcp-playwright-chrome.config.json` |
| **playwright-firefox** | Browser automation with Firefox | `config/mcp-playwright-firefox.config.json` |
| **playwright-edge** | Browser automation with Edge | `config/mcp-playwright-edge.config.json` |
| **postman** | API testing - collections, environments, monitors | N/A (uses `--minimal` flag) |
| **github** | PR review, code search, issue management | N/A (uses `GITHUB_PERSONAL_ACCESS_TOKEN` via `GIT_TOKEN`) |
| **context7** | Up-to-date library documentation lookup | N/A (HTTP MCP at `mcp.context7.com`, uses `CONTEXT7_API_KEY`) |

Additional MCP servers (configured at user/IDE level, or — depending on your local `.mcp.json` — project-level; `.mcp.json` is gitignored and per-machine, so some of these may appear there too):
- **Chrome DevTools MCP** - Console logs, network requests, performance tracing, HAR export
- **Azure MCP** - Azure Application Insights, resource health, monitoring, and diagnostics
- **Atlassian MCP** - JIRA integration for test case management and bug reporting
- **Figma MCP** (`figma-remote-mcp`) - Visual comparison testing against design specs, design-to-code workflow
- **Microsoft Learn MCP** - Microsoft/Azure docs search, code samples, and full-page fetch
- **VirtoOZ MCP** (`claude_ai_VirtoOZ_for_virtocommerce_com_docs`) - **Primary Virto Commerce documentation source.** 12 topic-scoped retrieval tools: `VirtoCommerce` (general), `PlatformUserGuide`, `PlatformDeveloperGuide`, `PlatformBackendSourceCode`, `PlatformFrontendSourceCode`, `StorefrontUserGuide`, `StorefrontDeveloperGuide`, `FrontendSourceCode`, `MarketplaceUserGuide`, `MarketplaceDeveloperGuide`, `DeploymentGuide`, `B2BExperts`. **All agents should use this via the `/vc-docs` skill** for VC architecture, module, API, deployment, and B2B questions — prefer it over Context7 for any Virto-specific topic.

The 6 servers in the table above are configured in `.mcp.json` (project-level). The additional servers above are typically at the user/IDE level, though a given machine's `.mcp.json` may also include Chrome DevTools, Azure, Figma, and Atlassian — verify against your local file.

## Browser Automation Rules

- Install browsers: `npx playwright install chromium firefox` (Edge uses the system-installed `msedge` channel).
- Default to `chromium` (not `chrome`) for Playwright MCP browser launches. WebKit is NOT supported on Windows — fall back to Edge or Chrome immediately without attempting installation.
- Always verify MCP server config uses correct browser engine names: `chromium`, `firefox`, `webkit` (not `chrome`, `edge`).
- After any MCP config change, remind the user that a server restart is required before the new config takes effect.
- Browser configs set viewport to 1920x1080, HAR capture enabled, isolated contexts, and
  `screenshot: "only-on-failure"`. **They do NOT record video** — `recordVideo` is absent from all
  three `config/mcp-playwright-*.config.json` files (this line previously claimed "video on failure",
  which sent an investigation looking for recordings that were never made). To capture a transition,
  use `npm run evidence:record` — see §Video & GIF evidence below.

## `.mcp.json` Setup

This file is gitignored. After cloning, create it locally. Windows uses `cmd /c npx`, Linux/Mac uses `npx` directly.

### Browser login secrets (`--secrets`) — use the SCOPED file, never `.env.local`

Suites that sign into the storefront/Admin SPA must enter real passwords via the **real UI** (never an API/token bypass). The Playwright MCP `--secrets <dotenv>` flag makes this safe: call `browser_type` with the secret's **NAME** (e.g. `browser_type(text="B2B_USER_PASSWORD")`) and the MCP substitutes the value and **redacts it in logs** — the plaintext never enters the agent's context or the transcript. Substitution triggers only when the typed text exactly equals a NAME in the file.

- **Point `--secrets` at a dedicated, minimal file — NOT `.env.local`.** `.env.local` also holds API tokens/keys (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITHUB_FIX_BUGS_TOKEN`, `JIRA_API_TOKEN`, `FIGMA_API_KEY`, `POSTMAN_API_KEY`, `BROWSERSTACK_ACCESS_KEY`). If those were reachable, a malicious page or prompt-injection could get the agent to type a PAT/API key into an arbitrary web form. Least privilege = a separate file with **login passwords only**.
- **Setup:** copy `templates/.env.playwright.local.template` → `.env.playwright.local` (auto-gitignored by the `.env.*.local` rule), fill from the team secret store, and add `"--secrets", ".env.playwright.local"` to each Playwright server's args (see `templates/.mcp.json.example`). Reconnect/restart the MCP after editing.
- The file is **not** suffix-promoted (read raw by the MCP) — put the concrete value for whichever env you run browser suites against, matching that env's `.env.local` values.

## Video & GIF evidence

Some defects do not live on a screen, they live in a **transition** — a redirect that fires on its
own, a flash of the wrong content, a layout jump, an element that vanishes. Two screenshots of the
before and after states do not show that the app did it by itself, so they do not evidence the bug.
For those, record.

```bash
# one recording of a page
npm run evidence:record -- --url "$BACK_URL/#!/resetpassword/{userId}/{token}"

# an INTERMITTENT defect: replay until the symptom appears, keep only the run that caught it
npm run evidence:record -- --url "..." --runs 20 --until login --headed --frames 2
```

`scripts/evidence/record-browser.mjs`. Each run is a fresh browser (no cache, no storage — the state
a user arriving from an emailed link is in), prints a timeline of URL changes, and writes a `.webm`
per run under `test-results/evidence/<timestamp>/`. Key flags: `--until <substr>` declares the
symptom (page URL comes to contain it) and **deletes the recordings of runs that missed**, so chasing
a race does not leave a pile of look-alike videos to sort by hand; `--runs N` sets the attempts;
`--headed` because a headless browser is faster and can win a race the real one loses; `--throttle`
(CPU 4x + Slow 4G, Chromium only) widens a race window; `--frames N` also extracts PNG stills.
Exit code is 1 when `--until` never matched — a miss is reportable data, not a pass.

**GIF needs a system ffmpeg.** The ffmpeg binary Playwright ships (reused here for frame extraction)
is built with `webm`/`png` only and has no GIF or MP4 encoder, so `--gif` reports that and skips
rather than failing. `winget install Gyan.FFmpeg` enables it.

**Session-wide recording** (every MCP browser action, not one scripted scenario) means adding
`recordVideo` to `contextOptions` in `config/mcp-playwright-<lane>.config.json`:

```json
"recordVideo": { "dir": "./test-results/chrome/video", "size": { "width": 1280, "height": 720 } }
```

Deliberately **not** enabled by default: Playwright has no "video only on failure" for a raw context
(that is a `@playwright/test` runner feature), so it records every page of every session — a full
121-suite regression would write video for all of it. Turn it on for a focused investigation, then
turn it off. As with every MCP config change, **a full server restart is required** — a `/mcp`
reconnect does not reliably restart the child process.

**Artifacts are gitignored on purpose.** `test-results/` is not tracked: a recording is evidence for
a tracker attachment, not a repo asset. Note that the Atlassian MCP cannot upload attachments, so a
video or GIF goes onto a ticket by hand. Retention + when a recording is warranted at all:
`.claude/rules/reports.md` §5.

## Storybook Visual Regression

Visual regression baselines are captured on-demand by the `/qa-storybook` skill (delegated to `ui-ux-expert` agent). No persistent `storybook/` directory is needed — baselines are stored in test evidence directories per ticket. Naming convention: `{story-name}-{viewport}.png` (e.g., `basic-desktop.png`, `hover-state-tablet.png`). See `skills/qa-storybook/` for methodology and guides.

# Review dimensions — the 10 checks `/prompt-review` applies

Supporting file for [`SKILL.md`](SKILL.md) Step 3. Each dimension says **what to check**, **how to
check it cheaply**, and **what severity a miss is**. Severities:

- **BLOCKER** — a run of this prompt does the wrong thing, or an unsafe thing (a write without a
  gate, a secret leak, a step that cannot execute, an instruction that contradicts a hard rule).
- **MAJOR** — a run is likely to go wrong or cost more than it should (over budget, a dangling
  citation on a step's critical path, a restated rule that already drifted, mis-triggering).
- **MINOR** — correctness holds, but the file will rot (a restated rule that has not drifted *yet*,
  a transcribed count, a memory slug used as provenance only-almost).
- **NIT** — wording, ordering, formatting. Never block on a NIT.

---

## D1 — Frontmatter & triggering

The `description` is the only part of a skill loaded into every session; it decides whether the
skill runs at all.

- `name` equals the directory / file name.
- `description` says **what** it does, **when** to use it, and **when not** (the nearest neighbour
  skill it must not be confused with). Leading `[Category]` tag for `.claude/skills/` per
  `.claude/skills/README.md` (root-level skills carry none).
- `argument-hint` matches the `## Usage` block and the arguments the steps actually parse.
- `disable-model-invocation: true` on anything that writes outward (tracker, GitHub, envs) or is
  expensive; absent on read-only reference skills that should auto-trigger (`/vc-docs`).
- Agents: `model` and `tools` present and justified by what the body asks it to do.

Severity: wrong/missing `disable-model-invocation` on a writing skill → BLOCKER; a description that
overlaps a neighbour with no disambiguation → MAJOR; missing tag/hint drift → MINOR.

## D2 — Size & loading tier

- Loaded-whole files (`SKILL.md`, commands, agents) ≤ 19,000 chars — BUDGET-004. Over the cap and
  **not** in `scripts/maintenance/.prompt-size-baseline.json` → BLOCKER (the build fails). In the
  baseline → MAJOR, with the overage as the number to cut.
- Content that only one branch/step needs (a mode, an error-recovery recipe, a long example, a
  schema) belongs in a supporting file — flag each such block with its char size.
- An agent definition is re-paid **on every dispatch** — weigh its bytes higher than a command's.
- Always-loaded tier (`CLAUDE.md`, `.claude/rules/`) — if the target adds a line there, apply the
  test in `CLAUDE.md` §Where the rules live (*would removing it cause a mistake on a task that never
  touches this topic?*).

## D3 — Single source of truth

- A rule, list or table that is **restated** from its owner (see the table in `CLAUDE.md`
  §Detailed References) instead of cited. Compare against the owner: drifted → MAJOR, identical
  today → MINOR (it will drift).
- A **count** (suites, cases, agents, skills, commands, selection groups, dimensions of another
  skill) transcribed into prose → MINOR; the fix is the command that prints it.
- A **version** or model ID transcribed → MINOR (read it from `plugin.json` / `package.json`).
- The command shell and its skill both carry the same step list → MAJOR once they differ.

## D4 — No hardcode (GOLDEN RULE)

`.claude/rules/test-data.md` §GOLDEN RULE applies to prompts too: URLs, hosts, org/user IDs, GUIDs,
passwords, store/culture codes in a prompt are transcribed constants.

- A hardcoded env URL → MAJOR (use `FRONT_URL` / `BACK_URL` / `{{VAR}}`).
- A literal password or token → BLOCKER.
- `{{VAR}}` passed to Playwright MCP `--secrets` instead of the bare key name → BLOCKER (silent miss,
  `.claude/rules/agents.md` §MCP servers).
- An evidence OUTPUT path baked into a prompt with a sprint/ticket in it → MAJOR (THIRD RULE).

## D5 — Portability (does it work for a teammate?)

- A memory slug (`feedback_*`, `reference_*`, `project_*`) that **carries** a claim rather than
  following a claim stated in full → MAJOR (`CLAUDE.md` §What reaches a teammate). As trailing
  provenance only → OK.
- A path to a per-user file (`~/.claude/…`, `settings.local.json`, an absolute Windows/macOS path).
- Plugin prompts (`plugins/*/`): a bare relative path that assumes the plugin root is the CWD →
  MAJOR (see `CLAUDE.md` §Project Overview — no `${CLAUDE_PLUGIN_ROOT}` in commands; paths resolve
  against the user's project).

## D6 — Step executability

Read the steps as the executing agent would, with no other context.

- Each step names its **inputs, action, output and stop condition**. "Analyse X" with no output
  shape → MAJOR.
- Every cited file, `§` heading and `npm run` script exists (context:check covers `.claude/`; check
  plugin paths by hand) → dangling on the critical path is MAJOR.
- Branches are exhaustive: what happens when a tool is missing, an MCP server is down, the target is
  empty, the user declines? A missing fallback where the step can fail → MAJOR.
- Ordering: no step consumes something a later step produces; independent reads are batched
  (`.claude/rules/agents.md` §Agent Delegation).
- Instructions do not contradict each other or a hard rule. A contradiction → BLOCKER.

## D7 — Write safety

- Every outward-facing write (tracker comment/transition, GitHub push/PR/comment, env deploy,
  Teams message) is **gated** — confirmation, `--dry-run`, or an explicit documented authority.
  Ungated → BLOCKER.
- Tracker comments follow ONE-comment-per-run (`.claude/rules/reports.md` §0).
- Ticket status transitions only via `qa-lead-orchestrator` (`.claude/rules/agents.md`).
- No `merge_pull_request` / auto-merge anywhere → BLOCKER if present.
- Files written go to one of the ten report categories or to a declared owner path; anything else
  → MAJOR (`.claude/rules/reports.md` §1).

## D8 — Delegation & concurrency

- Each dispatched agent exists and has the tools the brief needs.
- Browser lanes: no two parallel agents share a lane; ≤ 3 concurrent browser agents; lane per
  `.claude/rules/agents.md` §Parallel Execution.
- A brief never tells a subagent to prefer a doc over the artifact it edits.
- No two writers on one suite CSV / one disposable fixture set; a verifier never sits beside its own
  doer.
- The brief carries every fact the subagent needs (a subagent cannot see the parent's context).

## D9 — Product grounding

- Claims about how the platform/storefront behaves are sourced (`{DOC}` via `/vc-docs`, `{BL}`,
  `{OBSERVED}`, `{SPEC}`) or cited to a knowledge file. An unsourced behavioural claim that a step
  acts on → MAJOR.
- Exact UI strings/labels cited as `{DOC}` → MINOR (they are `{OBSERVED}`).

## D10 — Integration & contracts

- Callers found in SKILL.md Step 2 still match this prompt's name, arguments and outputs.
- The skill is listed in `.claude/skills/README.md` and, if user-facing, `.claude/ROUTING.md`.
- A `.claude/` ↔ `plugins/vc-fix/` pair: divergence is reported, not judged, except for the
  self-diagnostics containment files (must be identical in intent, changed together).
- Output artifacts other flows consume (`summary.json`, a DIAG file, a CSV) keep their schema.

---

## Grep pack (Step 1)

Run over the target files only. Each hit is a *candidate* — confirm it before it becomes a finding.

```bash
T="<target files>"
grep -nE '\b(feedback|reference|project)_[a-z0-9_]{3,}' $T                       # D5 memory slugs
grep -nE '\b[0-9]{2,} (suites|test cases|cases|agents|skills|commands|selection groups)\b' $T  # D3 counts
grep -nE 'https?://[A-Za-z0-9.-]+\.(azurewebsites\.net|virtocommerce\.(com|cloud)|govirto\.com)' $T  # D4 hosts
grep -nE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' $T       # D4 GUIDs
grep -nE 'reports/tickets/Sprint[0-9]' $T                                         # D4 evidence paths
grep -nE -- '--secrets.*\{\{|\{\{[A-Z_]*PASSWORD\}\}.*(browser_type|fill)' $T      # D4 secrets
grep -nE 'merge_pull_request|gh pr merge|auto-?merge' $T                          # D7
grep -nE '~/\.claude|settings\.local\.json|[A-Z]:\\\\|/Users/' $T                  # D5 per-user paths
```

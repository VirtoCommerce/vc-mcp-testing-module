---
name: prompt-review
description: "Review, heal and improve THIS repo's own prompt files — skills (SKILL.md + supporting files), commands and agent definitions under .claude/ and plugins/*/. Three passes: REVIEW (read-only, 10 dimensions: triggering, budget/tiering, single-source-of-truth, no-hardcode, portability, step executability, write safety, delegation, product grounding, integration), HEAL (--fix: mechanical repairs + move-down-a-tier, re-gated by context:check) and IMPROVE (--improve: description/trigger tuning + behaviour evidence from real runs, evals, /vc-self-check). Findings go to chat, never to a report file. Not for test cases (/qa-review-tests), oracles (/qa-review-oracles) or product code (/code-review)."
argument-hint: "<skill|command|agent name | path | changed | all> [--fix] [--improve] [--dry-run]"
disable-model-invocation: true
---

# /prompt-review — Review, heal and improve our skills, commands and agents

A skill, command or agent file is **code that an LLM executes**. It rots in the same ways code does:
a cited path moves, a count goes stale, a rule gets restated in three places and drifts, a step
stops being executable, a description stops triggering. This skill applies one method to every
prompt file in the repo and, on request, repairs what it finds.

**Three passes, each opt-in beyond the first:**

| Pass | Flag | Writes? | Output |
|---|---|---|---|
| **REVIEW** | *(default)* | nothing | findings table + verdict in chat |
| **HEAL** | `--fix` | the target's prompt files only | diff + re-run gates |
| **IMPROVE** | `--improve` | description / steps, after evidence | proposal, then edit on confirmation |

`--dry-run` with `--fix`/`--improve` prints the planned edits and writes nothing.

## Usage
```
/prompt-review qa-triage-results               # one skill (resolves .claude/skills/<name>/)
/prompt-review qa-regression                   # a command (.claude/commands/<name>.md)
/prompt-review ui-ux-expert                    # an agent (.claude/agents/<name>.md)
/prompt-review plugins/vc-fix/skills/qa-defect # an explicit path (plugin copy)
/prompt-review changed                         # every prompt file touched on this branch vs main
/prompt-review all                             # every prompt file — triage-only, see Step 1
/prompt-review qa-hotfix --fix                 # review + heal
/prompt-review vc-docs --improve               # review + trigger/behaviour tuning
```

## Supporting files — read the one the step needs, when it needs it

| File | Read at |
|---|---|
| [`review-dimensions.md`](review-dimensions.md) | Step 3: the 10 dimensions, their checks and severities |
| [`healing-playbook.md`](healing-playbook.md) | Step 4 (`--fix`): one recipe per finding type, what is safe to auto-apply |
| [`improvement-loop.md`](improvement-loop.md) | Step 5 (`--improve`): trigger tuning, evidence sources, evals |

The normative rules this skill enforces are **cited, not restated** — they live in `CLAUDE.md`
§Where the rules live (tiers, BUDGET-004, memory slugs), `.claude/rules/test-data.md` §GOLDEN RULE,
`.claude/rules/agents.md` §Agent Delegation and the `context:check` linter
(`scripts/maintenance/lint-claude-docs.mjs`). If one of them and this skill disagree, they win.

## Step 0 — Resolve the target

1. **Name → files.** Look up, in order: `.claude/skills/<name>/`, `.claude/commands/<name>.md`,
   `.claude/agents/<name>.md`, then the same under `plugins/*/`. A name can hit several (a command
   shell + its skill; a `.claude/` copy + a `plugins/vc-fix/` copy). **Review them as one unit** —
   the command/skill split and the copies are part of what is under review.
2. **`changed`** → `git diff --name-only origin/main...HEAD` filtered to `.claude/{skills,commands,agents}/**`
   and `plugins/*/{skills,commands,agents}/**`.
3. **Two copies of one name** (`.claude/skills/<name>` and `plugins/vc-fix/skills/<name>`): they diverge
   **by design** — the plugin copy is self-contained (`CLAUDE.md` §Project Overview). Never
   "sync" them wholesale. Report the divergence, and for `--fix` **ask which copy** is in scope
   unless the user named a path. Exception: the self-diagnostics containment files MUST change
   together in one commit — a one-sided change there is a security regression (`CLAUDE.md`
   §Project Overview, *Self-diagnostics*).
4. **Ownership check.** If another session or PR is currently editing the target, stop and say so.
   One writer per prompt file per change, same doctrine as suites (`.claude/rules/regression.md`).

## Step 1 — Collect facts deterministically (one batch, before reading prose)

Run these together; they are cheap and they keep the review from re-deriving what a script knows.

```bash
npm run -s context:report > "${TMPDIR:-/tmp}/prompt-review-context.json"  # budgets, prompt baseline, DOC-00x findings
git log --oneline -n 15 -- <target paths>              # churn + recent intent
wc -c <target files>                                    # size vs the 19,000-char BUDGET-004 cap
```

From that JSON extract only the target's rows: `prompts.over[]` (with `allowed`),
`promptBaseline[<file>]`, `findings[]` whose `file` is in the target, and `skillsOver[]`.

Also grep the target for the patterns in `review-dimensions.md` §Grep pack (memory slugs,
transcribed counts, hardcoded hosts/GUIDs, `{{VAR}}` in browser secrets, dated `Sprint..` paths).

**`all` mode is triage-only:** produce one row per file (size, over-cap, DOC findings, grep hits),
sorted worst-first, and stop. Do **not** deep-review or heal 80+ files in one pass — recommend
the top 3–5 for individual `/prompt-review <name>` runs.

## Step 2 — Read the target whole

Read `SKILL.md` / the command / the agent in full, then list its supporting files and read **only
the ones a step cites**. Note its frontmatter (`name`, `description`, `argument-hint`,
`disable-model-invocation`, `allowed-tools`, `model`), its steps, every file/script/§ it cites, and
every outward-facing write it performs.

Find its **callers and callees**: `grep -rn "<name>" .claude plugins ci scripts --include=*.md --include=*.ts --include=*.mjs --include=*.json`.
A skill invoked by name from `/qa-test-lifecycle` or a CI runner cannot be renamed or have its
arguments changed without updating that caller.

## Step 3 — Review against the 10 dimensions

Apply every dimension in [`review-dimensions.md`](review-dimensions.md). Each finding gets:
`ID · dimension · severity (BLOCKER | MAJOR | MINOR | NIT) · file:line · what · why it matters · fix`.

Rules for findings:
- **Evidence or it is not a finding.** Quote the line, name the missing path, show the count. A
  "could be clearer" without a concrete failure scenario is a NIT at most.
- **A failure scenario per BLOCKER/MAJOR**: *which* run of this prompt goes wrong, and how.
- **Do not flag house style that the repo applies everywhere** unless it breaks a rule cited above.
- **Product-behaviour claims** inside the prompt are checked via `/vc-docs` before you call them
  wrong (`CLAUDE.md` §Essential Rules → *Product context*); a mismatch is reported, not "fixed" by
  preferring the doc (`.claude/rules/agents.md` — a doc is authoritative for MECHANISM, not SURFACE).

**Verdict:** `HEALTHY` (no BLOCKER/MAJOR) · `NEEDS HEALING` (MAJOR, all mechanically fixable) ·
`NEEDS REDESIGN` (a BLOCKER, or a MAJOR that needs a human decision).

Print the findings table + verdict in chat. **No report file** — prompt reviews are not one of the
ten report categories (`.claude/rules/reports.md` §1). Stop here unless `--fix` / `--improve`.

## Step 4 — HEAL (`--fix`)

Follow [`healing-playbook.md`](healing-playbook.md). Summary of the contract:

1. **Auto-apply only the SAFE class** — repairs that cannot change what the prompt does: repoint a
   dangling path or `§` citation, replace a transcribed count with the command that prints it,
   replace a hardcoded URL/ID with its `{{VAR}}` / `@td()`, fix frontmatter shape, promote a claim
   that lives only behind a memory slug into the topical knowledge file.
2. **Move down a tier** to get under BUDGET-004: cut detail from the loaded-whole file into a
   supporting file the step reads on demand, and leave a one-line pointer. Moving is safe; deleting
   a rule is not.
3. **Everything else is a PROPOSAL** — reordering steps, changing a gate, a write, a delegation, an
   argument, a name, or anything a caller depends on. Show the diff and ask before applying.
4. **Never raise a budget or a baseline.** If the file shrank below the cap, delete its entry via
   `npm run context:check:baseline` (it can only record a shrink).
5. **Never** edit a regression suite CSV, a knowledge file's product claims, or another repo from
   here — hand those to their owners (`/qa-review-tests --fix`, `/qa-review-oracles`).

**Gate after healing** (all must pass before you report done):
```bash
npm run context:check          # budgets + DOC-002/003/004/006 ratchets
npm run qa-test:doclint        # only if the target is /qa-test or its skill dir
```
If the target has code beside it (`*.mjs`/`*.ts` in the skill dir), also run its tests and
`npx tsc --noEmit -p ci/tsconfig.json`. Re-read your own diff adversarially: did any edit change
behaviour that was not in the SAFE class?

Plugin files (`plugins/*/`): note in the summary that a released plugin change needs a version bump
+ tag per `docs/release-process.md` — do **not** bump it yourself unless asked.

## Step 5 — IMPROVE (`--improve`)

Follow [`improvement-loop.md`](improvement-loop.md): gather **behaviour evidence** first (real
transcripts, `/vc-self-check` DIAG findings, `/qa-triage-results` test-defect patterns, the git log
of fixes to this prompt), then tune the `description` for triggering and fix the steps the evidence
shows agents stumbling on. For measured before/after, run evals with `anthropic-skills:skill-creator`
(or `claude plugin eval` for plugin skills). **No evidence ⇒ no behavioural edit** — say what
evidence would be needed instead.

## Step 6 — Close out

Report in chat, ≤ 40 lines: target, verdict, findings count by severity, what was healed (files +
chars before→after), what is proposed and awaiting a decision, gates run and their result. If files
changed, suggest a commit message; commit/push only if the user asked.

## Rules

- Read-only by default. `--fix` writes only the target's prompt files + the knowledge file a
  promoted claim moves into + the prompt-size baseline (shrink only).
- Never delete a rule to save space — move it down a tier.
- Never rename a skill/command/agent or change its arguments without updating every caller found in
  Step 2, and never without asking.
- Counts are never transcribed into a prompt — cite the script (`CLAUDE.md` §Where the rules live).
- This skill reviews itself too: `/prompt-review prompt-review`.

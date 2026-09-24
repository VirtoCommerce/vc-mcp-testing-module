# Improvement loop — `/prompt-review --improve`

Supporting file for [`SKILL.md`](SKILL.md) Step 5. REVIEW and HEAL judge the prompt as text.
IMPROVE judges it by **what agents actually did when they ran it**, and changes only what that
evidence supports.

## 1. Gather behaviour evidence (read-only, batch these)

| Source | What it tells you | How |
|---|---|---|
| Git history of the prompt | Which steps keep getting patched: a step fixed 3× is a design problem, not 3 typos | `git log -p --follow -- <file>` · look for repeated hunks and "fix"/"stop"/"never" commit subjects |
| `docs/decisions/*.md` | Incidents already attributed to this prompt | `grep -n "<name>" docs/decisions/*.md` |
| `/vc-self-check` DIAG output | Degraded/broken spans, struggle sub-signals, silent-suspect runs (vc-fix skills) | Run it, or read an existing local DIAG report; oracle: `.claude/knowledge/diagnostics/skill-expectations.md` |
| `/qa-triage-results` test-defect buckets | Prompts that author cases producing bad steps/assertions/stale data | The triage summary for recent runs |
| PR review threads | Reviewer corrections that recur on output this prompt produced | GitHub MCP `search_pull_requests` / `pull_request_read` on this repo |
| The user | The run that prompted this review | Ask for the transcript/session and what went wrong |

**No evidence ⇒ no behavioural edit.** Report "no behavioural signal found" and list what would
count (e.g. "one transcript where Step 3 was skipped").

## 2. Diagnose — map each symptom to a cause in the prompt

| Symptom in the evidence | Usual cause in the prompt | Improvement |
|---|---|---|
| Skill did not trigger / wrong skill triggered | `description` vague or overlaps a neighbour | Rewrite `description`: task verbs + trigger phrases users actually type + an explicit *not for X (use Y)* |
| Agent skipped a step | Step buried in prose, or conditional without a clear condition | Make it a numbered step with an explicit trigger; move the prose around it down a tier |
| Agent asked the user something the repo answers | The prompt does not say where the answer lives | Add the pointer (file / command) at that step |
| Agent re-derived a fact a script prints | No deterministic collect step | Add a batched collect step (see `SKILL.md` Step 1 for the shape) |
| Output shape varied run to run | No output template / stop condition | Add a minimal template and a length cap |
| Agent over-ran budget / context | Loaded-whole file too large, or it reads every supporting file | H11 in `healing-playbook.md`; make each supporting-file read conditional |
| Unsafe or surprising write | Missing gate | H13 — always PROPOSE |
| Same correction from reviewers repeatedly | A rule the prompt does not state, or states after the step that needs it | Put the rule **at** the step, citing its owner |

Prefer the **smallest** change that removes the observed failure. Adding a rule is not free — every
line of a loaded-whole file is paid on every run.

## 3. Measure before/after (when the change is behavioural)

- **Skills:** `anthropic-skills:skill-creator` — draft 3–5 realistic prompts (including one that
  should **not** trigger the skill), run the old and new versions, compare outputs and trigger rate.
- **Plugin skills (`plugins/*/`):** `claude plugin eval` suites / `/skill-doctor` report.
- **Commands / agents:** replay the failing scenario from the evidence on the new version (dry-run
  or a non-prod env), and one known-good scenario to catch regressions.

Record the before/after in the close-out summary (chat), not in a file.

## 4. Apply

Every IMPROVE edit is `PROPOSE` class (`healing-playbook.md`): show the diff with the evidence line
it answers, apply on confirmation, then run the HEAL gates (`npm run context:check`, …). A
description rewrite also needs a check that the new trigger phrases do not steal a neighbour's
requests — grep the other skills' descriptions for the same phrases.

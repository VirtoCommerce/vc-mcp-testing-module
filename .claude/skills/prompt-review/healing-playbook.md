# Healing playbook — `/prompt-review --fix`

Supporting file for [`SKILL.md`](SKILL.md) Step 4. One recipe per finding type. The column that
matters is **Class**: `SAFE` recipes are auto-applied; `PROPOSE` recipes are shown as a diff and
applied only after the user confirms.

**The test for SAFE:** *could an agent executing the prompt behave differently after this edit?*
If yes, or if you are unsure, it is `PROPOSE`.

| # | Finding (dimension) | Recipe | Class |
|---|---|---|---|
| H1 | Dangling path / `§` heading (D6) | Find where the target moved (`git log --follow --diff-filter=R -- <old>`, `grep -rn '^## <heading>'`) and repoint. If it was deleted with no successor, PROPOSE removing the citation. | SAFE |
| H2 | Missing `npm run` script (D6) | Find the renamed script in `package.json`; repoint. None → PROPOSE. | SAFE |
| H3 | Transcribed count (D3) | Replace the number with the command that prints it (`npm run suites:lint`, `ls … \| wc -l`). | SAFE |
| H4 | Restated rule, identical to owner (D3) | Replace with a one-line pointer to the owner + the `§`. | SAFE |
| H5 | Restated rule, **drifted** from owner (D3) | Decide which side is right first — that is a product/process decision. PROPOSE the pointer and flag the drift. | PROPOSE |
| H6 | Hardcoded URL/host (D4) | Replace with the env var (`FRONT_URL`, `BACK_URL`, …) or `{{VAR}}` that already carries it; if none exists, PROPOSE adding one (`.claude/knowledge/execution/test-data-authoring.md` §When you must add a hardcoded value). | SAFE if the var exists |
| H7 | Literal secret (D4) | Remove it; replace with the bare key name / `{{VAR}}`. Tell the user the value must be **rotated** — it is in git history. | SAFE + escalate |
| H8 | Memory slug carrying a claim (D5) | State the claim in full in the topical `.claude/knowledge/**` file (or in the prompt if it is prompt-local), cite that path, keep the slug only as trailing provenance. Do not invent the claim — if you cannot recover it from the repo, PROPOSE and ask the slug's author. | SAFE if recoverable |
| H9 | Frontmatter drift (D1) | Align `name` to the directory, `argument-hint` to `## Usage`, add the `[Category]` tag. | SAFE |
| H10 | `disable-model-invocation` wrong (D1) | Changes when the skill runs. | PROPOSE |
| H11 | Over BUDGET-004 (D2) | **Move down a tier** — see below. | SAFE when it is a pure move |
| H12 | Step not executable (D6) — missing output/stop/fallback | Draft the missing piece from how callers use the output. | PROPOSE |
| H13 | Ungated outward write (D7) | Add a confirmation / `--dry-run` gate. | PROPOSE (but always raise it) |
| H14 | Delegation defect (D8) — lane clash, missing tool, doc-first brief | Fix the brief. | PROPOSE |
| H15 | Caller mismatch (D10) | Fix the caller or the prompt — whichever is newer is usually right; check `git log`. | PROPOSE |
| H16 | Missing README / ROUTING entry (D10) | Add the row, matching neighbours. | SAFE |

## H11 — Moving down a tier, step by step

The goal is a loaded-whole file that holds the **spine** — steps, gates, stop conditions, the
pointers — and supporting files that hold everything only some runs need.

1. **Measure.** `wc -c` the file; list its `##`/`###` sections with their char sizes
   (`awk '/^#{2,3} /{if(h)print n"\t"h; h=$0; n=0} {n+=length($0)+1} END{print n"\t"h}' FILE | sort -rn`).
2. **Pick candidates**, largest first, that are *conditional*: a mode/flag branch, an error
   recovery, a report template, a worked example, a schema, a rationale/history paragraph (history
   goes to `docs/decisions/`, which is never loaded).
3. **Move verbatim** into a supporting file in the same skill directory (commands: into the backing
   skill's directory). Keep the heading text so existing `§` citations can be repointed.
4. **Leave a pointer** at the original spot: one line naming the file + `§` and **when** to read it
   ("On `--verify`, read `verify-mode.md` §Protocol").
5. **Repoint citations** to the moved heading: `grep -rn '<file>.md.*§<heading>' .claude plugins`.
6. **Re-measure and gate:** `npm run context:check`. If the file is now under 19,000 chars, run
   `npm run context:check:baseline` to delete its baseline entry; if still over, the baseline entry
   shrinks by the same command. Never hand-edit the number.

A move must not reword. Rewording during a move hides behaviour changes inside a diff that is
supposed to be a relocation — do the move in one edit and any rewording (as a PROPOSE) in another.

## After healing

- `npm run context:check` green (and `npm run qa-test:doclint` for `/qa-test`).
- Diff re-read: every hunk is either a SAFE recipe above or a confirmed PROPOSE.
- Plugin paths touched → note the version bump + tag is owed (`docs/release-process.md`).
- `.claude/` ↔ `plugins/vc-fix/` self-diagnostics containment files touched → both changed in the
  same commit.

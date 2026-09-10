# Promoting the cases a `/qa-test` run authored — the procedure, not a `/qa-test` step

**`/qa-test` no longer promotes. Its `5g` step was REMOVED 2026-09-10** — cases it authors are appended
as `Draft` at Step 3, executed live at Step 4 (C1), and **left at `Draft`** when the run ends.
[`/qa-test-lifecycle`](../../commands/qa-test-lifecycle.md) Phase 6P is the only promoter, for these cases
exactly as for handoff, re-promotion and legacy sources.

**Why it moved.** The flip needs a *human decision on a corpus-wide artifact*, and it was sitting at the
tail of a ticket run as a hard-STOP verifier gate that fired after the close-out had already been
delivered — so it could neither block anything nor be skipped cleanly, and it added a fourth verifier
dispatch to a run whose verdict was already published. Promotion is not part of answering *did this ticket
pass*; it is part of maintaining the regression corpus, which is what `/qa-test-lifecycle` is for.
**Nothing about the mechanism changed** — this file is still the procedure, and the gate below is still the
gate. Only the caller did.

## The procedure — run by `/qa-test-lifecycle` 6P against a completed `RUN_ID`

**Promote per `RUN_ID`, `--ids`-scoped to the cases that run actually executed.** `tc:promote` reads
`Draft` and writes `Automated` and can **never re-promote**, so a premature flip is irreversible and would
ground `{OBSERVED}` in a build that was wrong. For a `/qa-test --iterate` run, that means the FINAL round's
evidence: only the last round describes the code a human is being asked to ship.

The cases are in the suite as `Draft`, grounded and promotable only once a run has executed them live via
the automated runner.

1. **Harvest:** `/qa-review-tests file <target-suite.csv> --verify --fix` — every assertion this run observed
   live is rewritten `{HYPOTHESIS}` / unconfirmed-`{SPEC}` → `{OBSERVED}`; a **refuted** behaviour surfaces
   as ENV-008, never `{OBSERVED}`.
2. **Resolve each remaining `{HYPOTHESIS}`** with the observed value; one that stayed genuinely unknown is
   reworded as a question and keeps its case at `Draft` — never invent a value.
3. **Re-derive eligibility** (the same G10 the promoter uses): 0 GRD-001 Blocker/High, 0 ENV-008, green
   `td:validate`, every assertion grounded, executed with evidence.
4. **Ask to promote, then flip in place — via the deterministic promoter, never by hand-editing the cell.**
   `npm run tc:promote -- <RUN_ID> --suite <ID> --stamp <ticket-key>` prints the per-case decision, then
   `tc:promote:apply` writes it (`.claude/knowledge/execution/regression-promotion.md` §Post-Run Promotion; core
   `scripts/test-cases/promote-cases.ts`). It re-derives the same G10 as step 3 by linting each row **at its
   target status**, refuses a flaky or non-PASS case with a `PR-*` reason code, and edits only the changed
   fields — the hand path renormalised quoting and could promote on a PASS nobody could re-derive. It writes
   `Automated` only; a case verified via the **manual checklist** (no automated-runner verdict) is still
   `Reviewed`/`Manual` by hand. **Revert (remove) a non-promotable row** so the durable suite doesn't carry
   an ungrounded case that would keep running — **except** a case that failed on a real IN-SCOPE bug, which
   stays `Draft` with a documented reason (valid coverage flagging the open defect). The
   `Promoted: <ticket-key> (YYYY-MM-DD)` `References` stamp is applied by the promoter (appended; never
   clobbering a `Synced:`/`Audited:` stamp). Then `npm run suites:sync && npm run suites:lint`; re-run
   `suites:review -- <target-suite.csv> --fail-on=High` (an append that introduced a new Blocker/Critical is
   reverted).
5. **Record the split** in `summary.json.promotion` (`automated`/`reviewed`/`blocked`/`reverted`).

**Gate (1 round):** every `Automated`/`Reviewed` upgrade traces to a real artifact from this run;
every surviving `{HYPOTHESIS}` is resolved or reworded; `suites:lint` green. A fresh `qa-lead` verifier
**re-runs `suites:review`** on the target suite and, for a sample of upgraded assertions, **re-opens the
run evidence** grounding each `{OBSERVED}`. REJECT any `{OBSERVED}` with no traceable artifact, any
`{HYPOTHESIS}` cleared by an invented value, any case promoted while still carrying a Blocker/Critical →
revert the append → fix → re-verify once → STOP.

**Reverting an append is a row-level edit.** Remove the appended rows with the same surgical discipline
the promoter writes with (locate each record by its own raw text, delete only those bytes, re-parse and
field-compare the survivors), then `suites:sync`. For a baseline to diff against, read
`git show HEAD:<path>` into the scratchpad.

An ungrounded `{OBSERVED}` is worse than a `Draft` case: it puts a fabricated expectation into permanent
coverage. **The author never self-certifies this** — only `qa-lead-orchestrator` or the user promotes.

`/qa-test-lifecycle` Phase 6P remains the promoter for handoff, re-promotion, and non-`/qa-test` sources.

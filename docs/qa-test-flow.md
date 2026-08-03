# `/qa-test` — Test Flow

Sequence of the `/qa-test VCST-XXXX` pipeline: **Gather Context · Story · Test Model → Plan →
Write·Review·Provision → Execute → Explore → Report**. Story analysis is a sub-part of Step 1 (`1d`), not
a step of its own. Canonical spec:
[`.claude/commands/qa-test.md`](../.claude/commands/qa-test.md).

### Diagram 1 — the `/qa-test` run (Steps 1–6)

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-monospace, SFMono-Regular, Menlo, monospace','background':'#eef4f6','primaryColor':'#0d7d8a','primaryBorderColor':'#0a5f6a','primaryTextColor':'#ffffff','lineColor':'#5b6b7a','textColor':'#2b3a45','actorBkg':'#0d7d8a','actorBorder':'#0a5f6a','actorTextColor':'#ffffff','actorLineColor':'#a9c4c8','signalColor':'#54687a','signalTextColor':'#2b3a45','noteBkgColor':'#d3e8ea','noteBorderColor':'#0d7d8a','noteTextColor':'#0e2a2e','sequenceNumberColor':'#ffffff','labelBoxBkgColor':'#e2ecef','labelBoxBorderColor':'#9fb6bd','labelTextColor':'#2b3a45','loopTextColor':'#0a5f6a','activationBkgColor':'#bfe0e3','activationBorderColor':'#0d7d8a'}}}%%
sequenceDiagram
    autonumber
    actor User
    participant Orch as /qa-test
    participant TR as Tracker
    participant BA1 as ba-system-analyzer
    participant BA2 as ba-story-writer
    participant TMS as test-mgmt-specialist
    participant RT as /qa-review-tests
    participant TDE as test-data-engineer
    participant EX as Execution agents
    participant REG as /qa-regression
    participant SB as qa-testing-expert
    participant AI as App Insights

    User->>Orch: /qa-test VCST-XXXX

    note over Orch,BA1: Step 1 · sub-parts 1a-1e (each consumes the prior)
    note over Orch: 1a · Fetch, then classify
    Orch->>TR: Fetch ticket (type, priority, ACs, PR diff)
    Orch->>Orch: Classify TYPE (drives the 1c gate)
    note over Orch: 1b · Pre-flight, resolve SPRINT, dedup (all sprints)
    note over Orch,BA1: 1c · Gather context (gated)
    alt New feature / P0-P1 / cross-layer / unclear
        Orch->>BA1: Gather context (read-only)
        BA1-->>Orch: surface, flows, risk (VC-*), docs grounding
    else P2/P3 single-layer bug/tweak
        Orch->>Orch: Gather context inline
    end
    note over Orch,BA2: 1d · Review the story (advisory)
    opt Ticket has ACs
        Orch->>BA2: Review ACs vs PR diff (no writes)
        BA2-->>Orch: AC scorecard, gap-ACs, AC-vs-impl
    end
    Orch->>Orch: 1e · Build TEST MODEL (AC table = a field of it)

    note over Orch: Step 2 · Plan — enrich the model
    Orch->>Orch: Load BL, ECL, E2E scenarios (+ VirtoOZ docs if inline)

    note over Orch,TDE: Step 3 · Write, Review, Provision
    Orch->>TMS: Hand off Test Model
    alt New feature / Story
        TMS->>TMS: Author new cases/scenarios (A)
    else Bug / enhancement
        TMS->>TMS: Map existing + gap-author (A)
    end
    TMS->>TMS: Checklist (B) + regression selection (C)
    TMS->>RT: Review + auto-fix new cases (--fix)
    RT-->>TMS: Fixed cases (or flag unshippable)
    opt Cases need un-fixtured data
        TMS->>TDE: generate + seed data
        TDE-->>TMS: seeded, green td:validate
    end
    TMS-->>Orch: Artifacts A + B + C + aliases

    note over Orch,REG: Step 4 · Execute (2 tracks, one 3-browser budget)
    Orch->>TR: Transition to in-testing (Jira, unconfirmed - precondition)
    Orch->>EX: Ticket cases + checklist + data (NO suite IDs)
    Orch->>REG: Artifact C as its own run (suite IDs)
    EX-->>Orch: Pass/fail, evidence, bugs
    REG-->>Orch: RUN_ID + pass rate (feeds the release gate)

    note over Orch,SB: Step 5 · Explore (SBTM)
    Orch->>SB: Charter (probe risk areas first)
    SB-->>Orch: Findings (bug/question/observation/risk)

    note over Orch,AI: Step 6a-6c · Correlate, reconcile, validate
    opt App Insights configured
        Orch->>AI: Query window, dedup (label, not filter), triage
        AI-->>Orch: Correlated signals
    end
    Orch->>Orch: 6b reconcile ACs live (from working context) + 6c evidence checks

    note over Orch,TR: Step 6d-6f · Triage, then verdict, then file
    Orch->>Orch: 6d classify + provenance + severity + dedup (files nothing)
    Orch->>Orch: 6e verdict (keyed off 6d provenance)
    opt Confirmed non-duplicate bugs
        Orch->>TR: 6f file via /qa-bug (confirm, with Fix Routing)
    end
    Orch->>TR: TESTED (pass) / REOPEN (fail)
    Orch-->>User: Verdict + report + next steps
```

### Diagram 2 — after the verdict (Steps 6h / 6i)

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-monospace, SFMono-Regular, Menlo, monospace','background':'#eef4f6','primaryColor':'#0d7d8a','primaryBorderColor':'#0a5f6a','primaryTextColor':'#ffffff','lineColor':'#5b6b7a','textColor':'#2b3a45','actorBkg':'#0d7d8a','actorBorder':'#0a5f6a','actorTextColor':'#ffffff','actorLineColor':'#a9c4c8','signalColor':'#54687a','signalTextColor':'#2b3a45','noteBkgColor':'#d3e8ea','noteBorderColor':'#0d7d8a','noteTextColor':'#0e2a2e','sequenceNumberColor':'#ffffff','labelBoxBkgColor':'#e2ecef','labelBoxBorderColor':'#9fb6bd','labelTextColor':'#2b3a45','loopTextColor':'#0a5f6a','activationBkgColor':'#bfe0e3','activationBorderColor':'#0d7d8a'}}}%%
sequenceDiagram
    autonumber
    actor User
    participant Orch as /qa-test verdict
    participant Gate as Feature Release Gate
    participant Fix as /qa-fix + dev team
    participant VF as /qa-verify-fix
    participant TLC as /qa-test-lifecycle
    participant TR as Tracker

    alt PASS / PASS WITH NOTES
        Orch->>Gate: 6h Feed verdict + regression pass rate + release criteria
        Gate-->>User: GO / CONDITIONAL GO / NO-GO
    else FAIL, REOPEN  (pointer, not auto-trigger)
        Orch-->>User: 6i Next step = /qa-fix
        User->>Fix: /qa-fix VCST-XXXX (G0-G7, no auto-merge)
        Fix-->>User: PR, human review, merge, deploy
        User->>VF: /qa-verify-fix VCST-XXXX
        VF->>VF: RED (pre-fix) to GREEN (fixed) x3 + regression
        VF-->>TR: TESTED, then DONE
    else BLOCKED
        Orch-->>User: Resolve env/data/dependency, re-run /qa-test
    end
    opt Step 3 authored new cases (new_cases_authored > 0)
        Orch-->>User: 6i Promote run-scoped cases, else they never run again
        User->>TLC: /qa-test-lifecycle VCST-XXXX
        TLC-->>TLC: Fold keepers into regression/suites + test-suites.json
    end
```

## Decision gates encoded in the flow

- **Step 1 ordering** — `1a`–`1e` are sequential dependencies, not a menu: the fetch (`1a`) must precede
  the type gate, the BA delegation, the dedup glob and the story review; `{SPRINT}` is resolved in `1b`
  *before* the duplicate check that globs it (and the check spans **all** sprints, not just the current).
- **Step 1c delegation gate** — `ba-system-analyzer` runs only when the ticket type/priority/scope warrant
  it (New feature / P0–P1 / cross-layer / ≥2 domains / critical revenue flow / unclear surface); otherwise
  context is gathered inline.
- **Step 2 docs gate** — the VirtoOZ docs query is skipped when the BA already returned docs grounding.
- **Step 3 test-quality gate** — newly authored cases pass `/qa-review-tests --fix` (11 dimensions)
  before they reach execution; test data is seeded (green `td:validate`) before hand-off.
- **Step 4 execution split** — ticket cases go to the specialist agents; **Artifact C runs as its own
  `/qa-regression <ids>` run**, never inside a ticket agent's prompt (one-agent-per-suite + the 3-lane
  pool + the long-runner cap). Both tracks share the max-3-browser budget; if they don't fit, ticket cases
  go first because they own the verdict.
- **Step 4 tracker gate** — Jira-only in-testing transition, deliberately unconfirmed (precondition for
  the Step 6f close); the test-window start anchors the Step 6a App Insights correlation.
- **Step 6 order** — `6d` triage runs **before** `6e` verdict, because PASS/FAIL are expressed in terms of
  a finding's provenance, which only exists once triage assigns it. `6d` files nothing; `6f` files.
- **Step 6d triage gate** — every finding is classified (real bug / test-defect / by-design), given a
  **provenance** relative to the ticket (**PRE-EXISTING** → link, don't re-file · **IN-SCOPE** → fails
  this ticket · **OUT-OF-SCOPE incidental** → own ticket, doesn't fail this one), given a severity, and
  **deduped across all sprints + the tracker** before a bug is filed via `/qa-bug`; a test-defect routes
  to `/qa-review-tests --fix`, never a ticket. Only an in-scope P0/P1 (or an out-of-scope P0 revenue
  break) fails the verdict.
- **Step 6i loop (pointer, not auto-trigger)** — FAIL/REOPEN → `/qa-fix` → human merge/deploy →
  `/qa-verify-fix` (RED→GREEN re-test) → TESTED/DONE; BLOCKED → resolve → re-run `/qa-test`; new cases
  authored → `/qa-test-lifecycle` to promote them out of the run-scoped ticket folder. `/qa-test` states
  the next command and stops; it never fixes.

## Quality gates that apply to a story

The gates are **layered** — the story run produces a verdict, and the **Feature Release Gate** turns that
verdict (plus the team-level release criteria) into the global **GO / NO-GO**:

| Layer | Gate | Verdict | Where |
|-------|------|---------|-------|
| Test artifacts | `/qa-review-tests` 11-dimension quality gate (enforced in Step 3 via `--fix`) | per-dimension | [`skills/qa-review-tests`](../.claude/skills/qa-review-tests/) |
| The story run | Step 6c evidence checks + Step 6d triage + Step 6e verdict — every AC condition carries PASS evidence, all reconciled SATISFIED-live, all `BL-*` verified, no **in-scope** P0/P1 bug, exploratory clean, no correlated App-Insights REAL_BUG | PASS / PASS WITH NOTES / FAIL / BLOCKED | [`commands/qa-test.md`](../.claude/commands/qa-test.md) §6c–6e |
| **Feature release (team go/no-go)** | **Feature Release Gate** — consumes the story verdict + open-bug ledger + change-scoped regression + NFRs + smoke. Owned by `qa-lead-orchestrator`. *"Can we release this feature?"* | **GO / CONDITIONAL GO / NO-GO** | [`skills/qa-metrics/quality-gates.md`](../.claude/skills/qa-metrics/quality-gates.md) **§1a** |
| Release (folds many features) | Smoke / Sprint Release / Full Release / Hotfix gates | PASS·FAIL / APPROVED·CONDITIONS·BLOCKED | [`skills/qa-metrics/quality-gates.md`](../.claude/skills/qa-metrics/quality-gates.md) |
| Bug auto-fix (if the story spawns a fix) | G0–G7 auto-fix ladder | open PR | [`.claude/rules/quality-gates.md`](../.claude/rules/quality-gates.md) |

**The feature go/no-go in one line:** a `/qa-test` **PASS**/**PASS WITH NOTES** feeds a **GO** only if
0 open P0, P1s deferred-with-acceptance, change-scoped regression ≥95%, NFRs clean, and smoke PASS all
hold; any P0 bug / unmet AC / `BL-*` violation / regression <93% / new security finding, or a `/qa-test`
FAIL/BLOCKED, is a **NO-GO**.

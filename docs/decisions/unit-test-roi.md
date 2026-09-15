# Unit-test ROI — why the corpus grew, what was measured, and what to cut

**Date:** 2026-09-15 · **Status:** policy changed; 95 redundant tests deleted on mutation evidence

Never loaded by an agent. This is the measured rationale behind the FOURTH RULE in
`.claude/rules/test-data.md` and §7a in `knowledge/execution/test-data-authoring.md`.

---

## The question

`scripts/unit/` holds 142 files, 37,374 lines, 2,986 tests — against 78,653 lines of non-test script,
in a repo whose product is prompts and CSVs. The complaint that prompted this: *"why do we write so
many useless unit tests?"* The premise deserved measuring rather than agreeing with.

## Why the volume exists — three mandates, one of them earned

| Source | What it said | Verdict |
|---|---|---|
| `.claude/agents/test-data-engineer.md` §Step 3 + Judge checklist | *"Write unit tests… no shortcuts"* + a binary box *"Ships unit tests in `scripts/unit/`; `npm test` green"*, closing with *"Any unchecked box → revise, don't ship."* | **The volume driver.** Unconditional: no risk, size or ROI gate, applied to spec modules that are largely declarative fixture data. A binary box is satisfied by volume |
| `.claude/knowledge/execution/quality-gates.md` G2 | reproduce-as-red-test per bug fix (`/dotnet-unit-test`, `/vue-unit-test`) | **Earned.** It has a trivial-skip hatch and its own hard-won rule that a green test of the wrong property is worse than no test (`docs/decisions/autofix-proof-medium.md`) |
| `.claude/agents/ba-story-writer.md` DoD template | *"Unit tests written and passing (≥ 80% coverage for new code)"* | **Cargo cult.** A ratio with no source, in a repo that measures coverage nowhere |

The counterweight existed and was opt-in: `.claude/commands/code-review-full.md` Agent 6 already asks
*"is the coverage proportionate to the risk?"* and flags *"coverage for coverage's sake on low-risk
code"* — but it is a slash command someone must invoke, while the mandate sits in an agent definition
re-paid on every dispatch. And nothing ran the suite in CI until `unit-tests.yml` (VCST-5774), so a
useless test cost nothing to keep and nothing to notice.

## What was measured

`npm run td:mutation-check` (new, `scripts/maintenance/td-mutation-check.mjs`) perturbs a spec module
one edit at a time and runs both that domain's unit tests and its `td:validate:<domain>` guard against
each mutation. 20 domains, 169 mutations, all specs restored byte-identical:

```
both (unit test duplicates the guard): 52
unit-only (the only line of defence):  56
guard-only (guard owns it):            19
NEITHER (nothing catches it):          42
```

**The split is real and it is not where the volume assumed it was.**

- **Data literals → duplication.** Flipping declared fixture values (`catalog-edge`
  `linkedIntoStoreCatalog`, `keepEmpty`; `variation-stock` quantity; `orders` seed-prefix; `rbac`
  `isAdministrator`) was caught by **both** artifacts. The unit test added nothing: the drift guard
  calls the same `validateFixtureShape()` and adds alias-registry, GUID-leak and URL-shape checks on
  top.
- **Derivation logic → irreplaceable.** Semantic mutations of `missions-specs.mjs` builders
  (`windowDates` offset sign flip, open-ended `null → date`, `buildGoalNode` leaking a raw currency
  intent into the body) were caught **only** by the unit test; `td:validate:missions` missed all three.
- **42 mutations were caught by nothing at all** — a larger finding than the duplication, and the one
  worth acting on first. Recorded as B-47.

## The cut: 95 tests deleted, on evidence, with two safeguards

The obvious move — delete the spec unit tests, keep the guards — is right in outline and dangerous in
detail. Two static classifiers were written to separate the categories mechanically and **both were
wrong in both directions**: one flagged `teardown-membership-status.test.mjs` as worthless when it
guards a real silent-leak regression in `deleteUserByEmail`; the other scored `ui-step-parser.test.ts`
at 99% mirror when it is a genuine parser suite. Neither drove the cut.

What drove it is `npm run td:test-attribution` (`scripts/maintenance/td-test-attribution.mjs`), which
attributes every mutation to the individual test(s) that caught it and grades each test:

- **KEEP** — caught something the guard missed. Irreplaceable.
- **DELETE** — caught things, all of which the guard also caught. Duplication.
- **UNPROVEN** — the mutation set never reached it. **Never cut.** Absence of evidence is not evidence
  of absence; the operators are a sample, not a proof.

The asymmetry is deliberate: a wrong KEEP costs bytes, a wrong DELETE removes the only detector of a
silent seeding bug.

**Two safeguards, both of which changed the answer — each caught a real over-deletion:**

1. **KEEP is dominant across domains.** Test files are shared between domains whose guards differ —
   `loyalty-missions-specs.test.mjs` is attributed under both `missions` and `org-loyalty`. The test
   *"MSN_EXPIRED is the ONLY fixture outside its window"* came back **DELETE under `missions` and KEEP
   under `org-loyalty`**. A single domain in which a test is the only detector is enough to keep it.
   **Spared 33 tests.**
2. **The synthetic-input blind spot.** A drift guard only ever calls a validator with committed *good*
   data. A test that feeds it a **deliberately bad** input — `validateSeoShape({...SEO_PRODUCT,
   pageTitle: same, metaDescription: same})` — exercises rejection logic the guard never reaches, so a
   DELETE verdict for it is an artefact of which lines the sample happened to mutate. Found by reading
   the diff, not by any tool. **Spared a further 33 tests**, among them
   *"THE ORIGINAL DEFECT: prose promises global recency but no column enforces it"* — a named
   regression pin that the first pass would have removed.

128 candidates → **95 deleted**, 875 lines, across 18 files.

## Proof that nothing was lost

The same sweep, same sampling, before and after. Deleting a redundant test must move its mutations
from `both` to `guard-only` and leave `unit-only` untouched:

| | before | after | |
|---|---|---|---|
| both (unit test duplicates the guard) | 52 | **31** | −21 |
| **unit-only (the only detector)** | **56** | **56** | **unchanged** |
| guard-only | 19 | **40** | +21 |
| neither (nothing catches it) | 42 | 42 | unchanged |

`both` fell by exactly what `guard-only` gained, and **`unit-only` did not move**: no unique detection
capability was removed. `npm test` 2,986 → 2,891, all green.

## What changed

1. **`test-data-engineer.md` §Step 3** — *"Write unit tests"* → *"Unit-test the DERIVATION, never the
   DECLARATION"*, with the two categories named and the measurement cited. A pure-declaration spec
   module now gets **no test file**, and that is a pass rather than a gap.
2. **Its Judge checklist box** — the binary *"ships unit tests"* is replaced by *"every unit test
   shipped would fail for a reason nobody intended"*, proven with `td:mutation-check`, not asserted.
3. **`ba-story-writer.md`** — the ≥80% coverage DoD line is gone.
4. **`.claude/rules/test-data.md`** — FOURTH RULE, citing §7a rather than restating it.
5. **`gates.yml` runs `td:validate:all`** — the 22 per-domain drift guards ran in **no workflow**
   before this. That is what makes rule 1 safe: once authors stop unit-testing declared data, the
   guard is the only thing covering it, so it has to run. It also surfaced B-46 immediately — a guard
   red on a clean checkout from tracked state, unheard because nothing ran it.

## How to do the cut, per domain

```
npm run td:mutation-check -- <domain> --max 30
```

- `BOTH` → that coverage is duplicated; the corresponding assertions in the unit test can go.
- `UNIT ONLY` → keep, it is the only defence.
- `NEITHER` → **the real finding.** Add the check to `validate-<domain>-data.mjs`, not to the unit test.

Run it before and after: the `UNIT ONLY` count must not fall, and the `NEITHER` count should.

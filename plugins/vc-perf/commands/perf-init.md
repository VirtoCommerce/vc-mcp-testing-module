---
description: Onboard vc-perf onto a deployment — reuse vc-fix's /project-init, then add the perf block to project-profile.json and install perf prerequisites.
argument-hint: "[env-name]"
disable-model-invocation: true
---

# perf-init

Thin onboarding **on top of vc-fix**. vc-perf declares a dependency on vc-fix, so `/project-init`
and `project-profile.json` already exist — this command REUSES them and adds only the perf-specific
config. Do NOT duplicate vc-fix's onboarding, tracker/host/auth questions, or profile machinery.

## Steps

1. **Ensure the base profile exists.** If `project-profile.json` is absent, run vc-fix's
   `/project-init` first (it collects env name, tracker, code host, auth → writes the profile +
   `.env.<env>` + `.mcp.json`). vc-perf reuses that verbatim — the repo UUID / tracker / contribution
   mode the perf PR needs already live there (`repos.client[]`, `tracker`).

2. **Install perf prerequisites** (detect-then-install, per layer — mirror vc-fix's project-init
   prerequisite step; do not bundle binaries):
   - **L3** (universal): `dotnet tool install -g dotnet-counters dotnet-trace dotnet-gcdump`.
   - **L2** (only if load testing): the `k6` binary, or the `grafana/k6` container.
   - **L1** (only if the project extends an XAPI module that has a benchmark engine — Cart/Order
     today): .NET 10 SDK + the project's benchmark runner projects.
   - **L0 companion lenses (optional, soft prerequisite).** The generic .NET perf lenses live in a
     *different* marketplace, so vc-perf does not hard-depend on them. Detect whether `dotnet-diag`
     (`analyzing-dotnet-performance`) and `dotnet-data` (`optimizing-ef-core-queries`) are installed;
     if not, print the commands to add them and let the operator opt in — do not force:
     `/plugin marketplace add VirtoCommerce/dotnet-agent-skills` (confirm the exact source) then
     `/plugin install dotnet-diag@... dotnet-data@...`. The VC-specific L0 list
     (`knowledge/vc-perf-antipatterns.md`) ships with this plugin and needs nothing installed.

3. **Add the `perf` block to `project-profile.json`** — additive deepMerge, never rewrite the
   vc-fix profile. Ask only what is perf-specific and not already derivable:
   - how the backend runs locally → `perf.aspireHostPath` (Aspire) or `perf.backendUrl` (plain URL)
   - the platform process name for trace attribution → `perf.platformProcess` (default `VirtoCommerce.Platform.Web`)
   - which XAPI modules the project extends (L1 candidates) → `perf.benchmark.xapiTargets` + `runnerDirs`
   - load-test fixtures (a buyable product / org / config ids) — discover from the live catalog where
     possible, don't hardcode → `perf.loadtest.fixtures`
   See `project-profile.example.json` for the block shape.

4. **Verify** — print the resolved `perf` block and the detected toolchain (which layers are runnable
   given the installed prerequisites). Do not proceed to a run.

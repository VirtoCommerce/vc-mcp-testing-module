---
name: perf-loadtest
description: Run the L2 k6 load harness against the live Aspire-hosted backend and produce a summary + optional dotnet-counters CSV. Use to answer "how does the running system behave under load" — throughput, p95 latency, GC pressure — as opposed to L1 (BenchmarkDotNet, code-level) or L3 (dotnet-trace, attribution).
---

# perf-loadtest — L2 of the three-layer performance loop

The middle layer of the loop (**L1 bench → L2 load → L3 diagnose**, see skill `virto-perf-loop`
for the router and cross-layer discipline). L2 drives the real backend with k6 and answers "how
does the system behave under load" — throughput, p95 latency, error rate, GC counters — as
opposed to L1's mocked-I/O code-level verdict or L3's WHY-attribution.

## Running it

```bash
${CLAUDE_PLUGIN_ROOT}/skills/perf-loadtest/loadtests/run.sh smoke    # 1 VU × 3 iterations — liveness
${CLAUDE_PLUGIN_ROOT}/skills/perf-loadtest/loadtests/run.sh steady   # ramp + hold
```

Target the backend at `perf.backendUrl` from `project-profile.json` (pass it as `BASE_URL`, the
harness's own env knob — k6 has no direct file-read access to the profile):

```bash
BASE_URL="$(jq -r .perf.backendUrl project-profile.json)" \
  ${CLAUDE_PLUGIN_ROOT}/skills/perf-loadtest/loadtests/run.sh steady
```

Full knob list, prerequisites (k6 binary, credentials, `dotnet-counters`), the user-pool mechanism
for multi-user concurrency, and orchestration gotchas: `loadtests/README.md`.

## Scenarios and queries ship as standard vc-frontend examples — adapt per project

Everything under `loadtests/scenarios/` and `loadtests/queries/` scripts the **standard
vc-frontend** GraphQL operations (`getFullCart`, `addItemsCart`, `createOrderFromCart`). If your
client project overrides the storefront schema, the shipped documents may not match it exactly —
re-resolve them against your own frontend before relying on the numbers. To adapt this harness for
your project:

1. Keep `lib/auth.js` and `lib/gql.js` (transport — generic).
2. Replace `queries/*.graphql` with your project's storefront-exact documents if they differ from
   the standard ones.
3. Replace (or add) `scenarios/*.js` with your project's iteration shape.
4. Set `STORE_ID` (backs `config.js`'s `STORE.storeId`) from `perf.storeId`.

## Role in the loop

Use L2 to answer "how does N/RATE affect latency/GC on the real stack?" — for "did my code
change regress?" use L1 (`virto-perf-benchmark`); for "who is responsible?" run L3
(`virto-perf-trace` skill / `perftools/`) under an L2 scenario driving load.

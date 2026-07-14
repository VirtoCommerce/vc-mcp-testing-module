# loadtests — L2 walking skeleton (k6, T0 tier)

The missing middle of the perf loop (**bench → load → diagnose → optimize**): a k6 load
harness against the local Aspire-hosted backend. **T0 tier**: k6 binary + `dotnet-counters`,
file-first artifacts, no Grafana/TSDB — the consumer of the results is an agent, not a dashboard.

The scenarios and queries here script the **standard vc-frontend** storefront GraphQL operations
(`getFullCart`, `addItemsCart`, `createOrderFromCart` — see `../queries/`). They are examples to
adapt: if your client project overrides the storefront schema, re-resolve these documents against
your own frontend before using them for load testing.

## Prerequisites

- Backend up via Aspire (`cd ../../aspire-host && aspire run`), GraphQL at `https://localhost:8090/graphql`.
- k6 binary on PATH (or point `K6` at it). Single Go binary, no Node.
- Credentials: `PERF_API_USER` / `PERF_API_PASSWORD` env vars (required).
- Optional: `dotnet-counters` (`dotnet tool install -g dotnet-counters`) for backend CPU/GC/threadpool capture.

## Run

```bash
loadtests/run.sh smoke    # 1 VU × 3 iterations — liveness + first numbers
loadtests/run.sh steady   # open-model ramp 0→RATE/s over 10s, hold 120s (HOLD to stretch)

SCENARIO=cart-read-loop loadtests/run.sh steady   # read-path subject (see «Scenarios»)
```

Knobs (env): `SCENARIO` (scenario basename under `scenarios/`, default `cart-order-loop`;
non-default scenarios write to `results/<scenario>/<profile>/`) ·
`NO_COUNTERS=1` (skip the dotnet-counters sidecar — REQUIRED when `dotnet-trace` will attach to
the backend pid during the load window; EventPipe is single-consumer) ·
`HOLD` (steady hold duration, default `120s` — long holds host sequential L3 captures inside one
run so all captures share identical knobs by construction) ·
`ITEMS` (items per iteration, default 5) · `RATE` (steady arrivals/s, default 5) ·
`PRODUCT_IDS` (comma-separated product ids cycled across items) / `PRODUCT_ID` / `PRODUCT_FILTER`
(else setup discovers the first buyable non-configurable product) ·
`DISTINCT_PRODUCTS` (cart-read-loop only; 0 = all items share one product — max duplication,
best case for per-product memoization; N = discover up to N distinct buyable products and cycle
them across items — the realistic-mix band; setup logs how many were actually found) ·
`SKIP_ORDER=0` (enable the `createOrderFromCart` leg — see «Order leg» below) · `BASE_URL` ·
`STORE_ID` (your store id) · `USER_POOL` (multi-user concurrency, see below) ·
`SEED_PASSWORD` / `SEED_EMAIL_FORMAT`.

## User pool (multi-user concurrency)

A single-user run serializes on one cart (the aggregate cache + per-user lock), so it cannot
surface GC-pressure/contention on the save path. `USER_POOL>0` fans the load across N distinct
seeded users — each VU picks one by `__VU`, so N carts hit the per-user save path concurrently.

Seeding a pool of login-capable users is project-specific (there is no standard storefront
endpoint for this) — adapt to whatever seeding mechanism your project provides, then point
`SEED_EMAIL_FORMAT` / `SEED_PASSWORD` at the seeded accounts:

```bash
USER_POOL=50 RATE=20 loadtests/run.sh steady
```

> **Claude Code sandbox note:** k6 (a Go binary) gets `connection refused` dialing
> `127.0.0.1` from inside the CC bash sandbox while `curl` succeeds — run `run.sh` with the
> sandbox disabled.

## Scenarios

| Scenario (`SCENARIO=`) | Iteration shape | Measures |
|---|---|---|
| `cart-order-loop` (default) | add items → read → (optional) order, per iteration | mutation path (per-user lock, save path) |
| `cart-read-loop` | carts built ONCE in `setup()` (`ITEMS` = cart size, one cart per pool user), measured loop is a pure `getFullCart`; carts are not cleaned up (no standard cart-removal op) | read path (aggregate cache, GraphQL projection); `ITEMS` is the cart-size band knob (5/50/200) |

## What one iteration does (cart-order-loop)

Default (`SKIP_ORDER=1`, the walking skeleton): `addItemsCart` (ITEMS items in one call) →
`getFullCart`.

`SKIP_ORDER=0`: the same, plus `createOrderFromCart` on the resulting cart. Whether an
otherwise-empty/default cart already satisfies your store's checkout validation rules is
project-specific — verify before relying on this leg for a real number.

Every measured operation uses the **standard vc-frontend** GraphQL document (`../queries/`, with
fragments inlined for k6 since it sends one document per request). Product discovery (both
scenarios) uses a minimal, non-storefront setup query — see `setup()`.

## Measurement discipline

- HTTP 200 with a GraphQL `errors` body **counts as failure** (`gql()` checks both).
- Per-operation latency via `http_req_duration{name:<op>}` sub-metrics; thresholds are loose
  skeleton ceilings — tighten after a baseline.
- Token acquired **once** in `setup()`, reused across VUs.
- Artifacts land in `results/<profile>/<stamp>-<sha>.summary.json` (+ `.counters.csv` when
  `dotnet-counters` is available) — commit SHA in the name so runs compare like-with-like.
- **Co-location caveat:** k6 + backend + DB on one machine → relative comparisons only, no
  absolute CPU claims. State the topology with every number.
- L2 is noisy: compare distributions across repeated runs, never single p95s.

## Orchestration gotchas (cost real time once, 2026-07-09)

- **`VAR=x && cmd > "$VAR" &` backgrounds the WHOLE `&&` chain** — including the variable
  assignments, which then never reach the parent shell (empty `$VAR` downstream). Assign
  variables on their own lines first; background only the command (`ENV=x cmd &`).
- **`pgrep -f 'k6 run'` matches the orchestrating shell's own command line** (the script text
  contains the words) — a "wait for k6 to exit" loop deadlocks on itself. Use `pgrep -x k6`.
- **`kill $!` on a backgrounded wrapper does not kill its k6 child** — the run keeps loading
  the backend after the wrapper dies. Kill the process group or `pkill -x k6`.

## Not yet built (next increments)

- Full-surface **smoke sweep** over the operation catalog — the skeleton scenarios cover
  the Class-A representative, the order terminal flow, and the read-path subject.
- Mutation × read **interleave** profile (the `CartProducts` race probe).
- `USER_POOL` read band — N distinct cached aggregates (memory-footprint axis of the aggregate
  cache); `cart-read-loop` supports the pool, the band run hasn't been done.
- DB seed/reset step between runs — currently no cleanup between runs; plan DB hygiene
  separately for your project.

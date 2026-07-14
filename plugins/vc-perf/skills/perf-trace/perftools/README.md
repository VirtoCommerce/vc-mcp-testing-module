# perftools — L3 diagnostic layer (profiling and attribution)

L3 of the three-layer performance toolchain:

| Layer | Where | Question it answers |
|---|---|---|
| L1 | `benchmarks/` (BenchmarkDotNet, I/O mocked) | Did the code-level allocation/time envelope regress? |
| L2 | `loadtests/` (k6, full real stack) | How does the running system behave under scripted load? |
| **L3** | **this folder** + `dotnet-counters` / `dotnet-trace` | **WHY — which code is responsible for what L2 observed?** |

L3 runs against the live backend while an L2 scenario drives traffic. Worked example (cart
`addItem` build-up, N=100): `docs/research/2026-07-08-l3-allocation-attribution-cart-recalc.md`.

## Setup

```bash
dotnet tool install -g dotnet-counters dotnet-trace dotnet-gcdump
```

Find the backend pid: `dotnet-counters ps` (look for `VirtoCommerce.Platform.Web`).

## Which tool for which question

| Question | Tool / capture | Read with |
|---|---|---|
| Allocation churn (traffic) — who allocates? | `dotnet-trace collect -p <pid> --profile gc-verbose` | `allocparse` |
| On-CPU time — who burns CPU? | `dotnet-trace collect -p <pid> --profile dotnet-sampled-thread-time` | `cpuparse` |
| Wall-time in DB / EF commands | `dotnet-trace collect -p <pid> --profile database`, or OTel spans in Aspire dashboard | PerfView / manual |
| Leak / resident footprint | `dotnet-gcdump collect -p <pid>` before/after, diff | `dotnet-gcdump report`, PerfView |
| GC behaviour, gen sizes, LOH | `dotnet-counters monitor -p <pid> System.Runtime` (`gc.collections`, `gc.last_collection.heap.size`, `gc.pause.time`, `gc.heap.total_allocated`, `process.memory.working_set`) | live / CSV |

Axes are independent: heavy allocation churn can coexist with flat latency (gen0 is cheap
single-user) and zero footprint growth. Measure the axis your hypothesis is actually about.

## Gotchas (each cost real time once)

- **EventPipe is single-consumer per profile session in practice**: stop `dotnet-counters`
  before starting `dotnet-trace` on the same pid, or the trace fails to attach.
- `dotnet-counters monitor` may hang its teardown for ~minutes after the load stops (ignores
  SIGINT). Run it in the background with `--duration`, harvest the CSV when the k6 summary is
  written, then `pkill` the leftover.
- The CPU profile is `dotnet-sampled-thread-time`. `--profile cpu-sampling` / `thread-time`
  are `dotnet-trace collect-linux` (kernel perf) profiles and are rejected by plain `collect`.
- `GCAllocationTick` samples ~1 event per 100KB allocated per heap — magnitudes are
  representative, not exact. Fine for shares and A/B comparison, not for absolute byte counts.
- `dotnet-trace convert --format speedscope` on a `gc-verbose` trace yields 0 samples — the
  converter only reads CPU SampleProfiler events. That is why these parsers exist.
- Thread-stack sampling counts **on-CPU** time only. An async request awaiting a DB round-trip
  occupies no thread, so DB wall-time is invisible to `cpuparse` — a request can be 2–3% of
  samples while dominating latency. For wall-time use the `database` profile or OTel spans.

## Why custom parsers (and not an existing tool)

Existing tooling fully covers **capture** — that is what `dotnet-trace` / `dotnet-counters` /
`dotnet-gcdump` are used for above. The gap is **programmatic analysis** of non-CPU events,
cross-platform, in text form (the consumer of a baseline↔fix comparison is a diff / an agent,
not a pair of eyes on a GUI):

| Tool | Why it doesn't cover this |
|---|---|
| `dotnet-trace convert --format speedscope` | Converts **only** CPU SampleProfiler events — a `gc-verbose` trace yields 0 samples (verified) |
| `dotnet-trace report topN` | CPU top-functions only; no allocation-by-type/stack, no filtering |
| PerfView | Has the right views (GC Heap Alloc Stacks, Thread Time) but is Windows-only GUI — not scriptable, not cross-platform |
| dotMemory / dotTrace / VS Profiler | GUI, licensed, not scriptable into a measure→fix→re-measure loop |
| `dotnet-gcdump` | Different axis: resident heap snapshots (footprint/leak), not allocation-traffic attribution |
| `dotnet-counters` | Aggregates only ("how much"), no stacks ("who") |

The parsers are ~100 lines each on top of `Microsoft.Diagnostics.Tracing.TraceEvent` — the
official Microsoft library PerfView itself is built on; this is the documented, supported path
for custom trace analysis, not hand-rolled format parsing. They add two views no stock tool has:

- **Responsible caller** — first non-BCL frame walking up the stack (otherwise the top is all
  `System.Private.CoreLib!Dictionary...` instead of `EntityFrameworkCore!ChangeDetector...`);
- **ACTIVE view** (cpuparse) — filters idle threadpool waits and background pollers, without
  which request-path code drowns (it was 2.6% of raw samples in the worked example).

**Visual tools remain fully usable on top of the same captures.** The `.nettrace` files are
standard: open them in PerfView or Visual Studio on Windows, or `dotnet-trace convert --format
speedscope` a CPU trace for [speedscope.app](https://www.speedscope.app/). The parsers replace
nothing — they make the same data consumable headless and diffable.

## Parsers

Standalone .NET 10 **file-based apps** (single `.cs`, no `.csproj`/`obj`/`bin`; not in your
module's `.sln`), each pinning `Microsoft.Diagnostics.Tracing.TraceEvent` via a `#:package`
directive at the top of the file. Each takes a `.nettrace` file and writes a text report to stdout;
the first run also materialises a `.etlx` next to the trace (stack resolution). Cross-platform
(Linux/WSL/Windows) — run with `dotnet run <file>.cs`.

```bash
# Allocation attribution: by type, leaf frame, first non-BCL caller, module;
# optional comma-separated method substrings print a representative full stack each.
dotnet run perftools/allocparse.cs -- /path/to/alloc.nettrace 25 "LocalDetectChanges,PropertyValidator..ctor"

# On-CPU attribution: leaf / responsible-caller views, plus an ACTIVE view that filters
# idle threadpool waits and background pollers (Hangfire, OTel, Redis, AppInsights).
dotnet run perftools/cpuparse.cs -- /path/to/cpu.nettrace 25

# DB command attribution (from a `--profile database` capture): SQL shape counts, optional `inspect`.
dotnet run perftools/dbparse.cs -- /path/to/db.nettrace
```

The BCL-module and idle/background filter lists live at the top of each parser `.cs` — extend
them when a new background subsystem shows up in traces.

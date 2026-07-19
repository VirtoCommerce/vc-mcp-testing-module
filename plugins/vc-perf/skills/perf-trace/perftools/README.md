# perftools — L3 diagnostic layer (profiling and attribution)

L3 of the three-layer performance toolchain:

| Layer | Where | Question it answers |
|---|---|---|
| L1 | `benchmarks/` (BenchmarkDotNet, I/O mocked) | Did the code-level allocation/time envelope regress? |
| L2 | `loadtests/` (k6, full real stack) | How does the running system behave under scripted load? |
| **L3** | **this folder** + `dotnet-counters` / `dotnet-trace` | **WHY — which code is responsible for what L2 observed?** |

L3 runs against the live backend while an L2 scenario drives traffic.

## Setup

```bash
dotnet tool install -g dotnet-counters dotnet-trace dotnet-gcdump
```

Find the backend process — the real app host, not a `dotnet run`/watch launcher: `dotnet-counters ps`
(or `dotnet-trace ps`) and pick the app binary (`PLATFORM_PROCESS` from your profile, default
`VirtoCommerce.Platform.Web`). On Git Bash where `pgrep` is absent, `dotnet-counters ps | grep` works.

## Agentic run from a sandboxed agent session (e.g. Claude Code)

The whole loop can run from inside a sandboxed agent session — no host terminal. Use `l3-capture.sh`
(wraps the recipe + gotchas — it must be in your allowlist, see the wrapper bullet) or the raw
`dotnet … collect` command (always covered by `dotnet:*`). Outside a sandbox the wrapper degrades
gracefully: the socket route is Linux-only, and when no `/tmp` socket exists (Windows uses named
pipes) it falls back to plain `dotnet-trace collect -p <pid>` — so the same command line works from
a host terminal on any OS. Rules that cost real time to learn:

- **NEVER disable the sandbox** for a dotnet-trace call (`dangerouslyDisableSandbox: true` in Claude
  Code) — counter-intuitively it makes AF_UNIX `socket()` fail EPERM (worse, not better). Run normally.
- **Invoke via the `dotnet` host, not bare `dotnet-trace`.** The agent's exec allowlist (Claude Code:
  `sandbox.excludedCommands` — `dotnet:*`, `dotnet-trace:*`) runs the command OUTSIDE the seccomp that
  otherwise blocks the AF_UNIX/epoll syscalls .NET's `Socket` ctor needs (a bare sandboxed
  `dotnet-trace` fails `SocketException(13)`). If `dotnet-trace:*` isn't allow-listed, call the DLL
  through the host: `dotnet $(find ~/.dotnet/tools/.store/dotnet-trace -name dotnet-trace.dll -path '*/tools/*'|head -1) collect ...`
- **If you use the `l3-capture.sh` wrapper, allow-list it too** (`bash …/l3-capture.sh:*`, mirroring
  `run.sh`). The agent matches `excludedCommands` on the TOP-LEVEL command and descendants inherit the
  jail — an un-allow-listed wrapper runs inside seccomp and re-jails its child `dotnet`, reproducing the
  EPERM this section prevents. Can't add it? Run the raw `dotnet "$DLL" collect …` line directly (it
  matches `dotnet:*`).
- **Use `--diagnostic-port <socket>,connect`, not `-p <pid>`.** A sandboxed session is in its own PID
  namespace, so `-p` (and `dotnet-trace ps`) can't see the host process. The diagnostic socket is
  visible in the shared `/tmp` (`/tmp/dotnet-diagnostic-<pid>-*-socket`) — the pid is embedded in the
  filename, which is what `l3-capture.sh` takes as its first arg.
- **The pid is the REAL app host, not a launcher.** A `dotnet run`/watch host — or an orchestrator like
  Aspire that runs `dotnet run --build` — shows a launcher pid whose trace is idle MSBuild/CLI frames.
  Find the app by tracing candidate sockets ~5s each: the app's trace is tens of MB (~hundreds of
  threads) with VirtoCommerce/Kestrel/Hangfire frames; the launcher's is small with MSBuild frames.
- **`-o` must be ABSOLUTE** — `$TMPDIR` is empty in the excluded environment, so a relative/`$TMPDIR`
  path resolves at `/` → permission denied. Point it at a writable results dir.

```bash
# CPU/thread capture under an L2 load window (100s) — wrapper (needs `bash …/l3-capture.sh:*` allow-listed):
bash ${CLAUDE_PLUGIN_ROOT}/skills/perf-trace/perftools/l3-capture.sh \
  <APP_PID> dotnet-sampled-thread-time 00:01:40 /abs/path/to/results/trace.nettrace
# …or the raw line, always covered by dotnet:* (no extra allow-listing):
dotnet $(find ~/.dotnet/tools/.store/dotnet-trace -name dotnet-trace.dll -path '*/tools/*'|head -1) \
  collect --diagnostic-port /tmp/dotnet-diagnostic-<APP_PID>-<disamb>-socket,connect \
  --profile dotnet-sampled-thread-time --duration 00:01:40 -o /abs/path/to/results/trace.nettrace
# then parse (file-based app; `dotnet run` is excluded too):
dotnet run ${CLAUDE_PLUGIN_ROOT}/skills/perf-trace/perftools/cpuparse.cs /abs/path/to/results/trace.nettrace 40 > out.txt
```

L2 (k6) needs no special handling: the `run.sh` invocation is in the allowlist, so it dials the backend
fine — just run it (no sandbox-disable).

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

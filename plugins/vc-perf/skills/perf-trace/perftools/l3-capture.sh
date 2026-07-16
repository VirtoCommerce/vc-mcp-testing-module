#!/usr/bin/env bash
# Agentic L3 trace capture against the running backend from inside a SANDBOXED AGENT session
# (e.g. Claude Code) — no host terminal needed. See perftools/README.md → "Agentic run".
#
# Usage:
#   l3-capture.sh <backend-pid> <profile> <duration> <output-abs-path>
#
#   backend-pid   The REAL application host pid — NOT a `dotnet run`/watch launcher (or an
#                 orchestrator like Aspire running `dotnet run --build`), whose trace is idle
#                 MSBuild/CLI frames. Find the app pid by tracing each diagnostic socket in the
#                 restart cohort ~5s: the APP's trace is tens of MB (~hundreds of threads:
#                 Kestrel + threadpool) with VirtoCommerce/Kestrel frames; a launcher's is small
#                 with MSBuild frames. The app pid is stable until the next backend restart.
#   profile       dotnet-sampled-thread-time (CPU/thread) | gc-verbose (alloc) | gc-collect (cheap)
#   duration      HH:MM:SS (e.g. 00:01:40)
#   output        ABSOLUTE writable path ending in .nettrace (relative/$TMPDIR fails — see below)
#
# WHY THE INDIRECTION (do not "simplify"):
#   - `dotnet-trace collect -p <pid>` fails from a sandboxed agent session: the session is in its
#     own PID namespace, so the host pid is invisible. Use `--diagnostic-port <socket>,connect`
#     (no pid lookup) instead — the socket is visible in the shared /tmp.
#   - A bare `dotnet-trace` runs INSIDE the sandbox seccomp, which blocks the AF_UNIX/epoll
#     syscalls .NET's Socket ctor needs -> SocketException(13). Invoke the dotnet-trace DLL
#     through the `dotnet` host so the top-level command matches the agent's exec allowlist
#     (Claude Code: `sandbox.excludedCommands` — `dotnet:*`) and runs OUTSIDE the seccomp. This
#     script works only if it (or `dotnet-trace`) is itself in the allowlist so its child `dotnet`
#     inherits the exclusion; otherwise run the final `dotnet "$DLL" collect ...` line directly.
#   - Disabling the sandbox does NOT help — it makes AF_UNIX EPERM (worse). Never do it.
#   - $TMPDIR is EMPTY for excluded commands, so a relative/$TMPDIR output lands at `/` -> denied.
#     An absolute path is required (point it at a writable results dir).
set -euo pipefail

PID="${1:?backend app pid required (the real Kestrel host, not a dotnet run/watch launcher)}"
PROFILE="${2:-dotnet-sampled-thread-time}"
DURATION="${3:-00:01:40}"
OUT="${4:?absolute output path required}"

case "$OUT" in
    /*) : ;;
    *) echo "l3-capture: output must be an ABSOLUTE path (excluded env has empty TMPDIR)"; exit 2 ;;
esac

# `|| true` so a no-match doesn't trip `set -e`/`pipefail` before the friendly guard below fires.
DLL=$(find "$HOME/.dotnet/tools/.store/dotnet-trace" -name dotnet-trace.dll -path '*/tools/*' 2>/dev/null | head -1) || true
[ -n "$DLL" ] || { echo "l3-capture: dotnet-trace.dll not found (dotnet tool install -g dotnet-trace)"; exit 3; }

SOCK=$(ls -t /tmp/dotnet-diagnostic-"${PID}"-*-socket 2>/dev/null | head -1) || true
[ -n "$SOCK" ] || { echo "l3-capture: no diagnostic socket for pid $PID (wrong pid? check the backend)"; exit 4; }

echo "l3-capture: pid=$PID sock=$SOCK profile=$PROFILE duration=$DURATION out=$OUT"
exec dotnet "$DLL" collect --diagnostic-port "${SOCK},connect" --profile "$PROFILE" --duration "$DURATION" -o "$OUT"

#!/usr/bin/env bash
# T0 runner (L2 note §11.1): k6 + dotnet-counters, file-first artifacts.
# Usage: loadtests/run.sh [smoke|steady]
# Env knobs forwarded to the scenario: BASE_URL, ITEMS, RATE, PRODUCT_ID,
# PRODUCT_FILTER, SKIP_ORDER. SCENARIO picks the scenario file (basename under
# scenarios/, default cart-order-loop). Credentials: PERF_API_USER / PERF_API_PASSWORD
# (fallback: ~/.secrets/claude.env). No secrets are printed or passed via argv.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
PROFILE="${1:-smoke}"
BASE_URL="${BASE_URL:-https://localhost:8090}"
SCENARIO="${SCENARIO:-cart-order-loop}"
SCENARIO_FILE="$DIR/scenarios/$SCENARIO.js"
if [ ! -f "$SCENARIO_FILE" ]; then
    echo "scenario not found: $SCENARIO_FILE" >&2
    exit 1
fi

K6="${K6:-$HOME/dev/virto/.tools/k6}"
if [ ! -x "$K6" ]; then
    K6=$(command -v k6 || true)
fi
if [ -z "$K6" ]; then
    echo "k6 not found — install to ~/dev/virto/.tools/k6 or PATH" >&2
    exit 1
fi

if [ -z "${PERF_API_USER:-}" ] || [ -z "${PERF_API_PASSWORD:-}" ]; then
    if [ -f "$HOME/.secrets/claude.env" ]; then
        . "$HOME/.secrets/claude.env"
    fi
fi
: "${PERF_API_USER:?PERF_API_USER not set (env or ~/.secrets/claude.env)}"
: "${PERF_API_PASSWORD:?PERF_API_PASSWORD not set (env or ~/.secrets/claude.env)}"
export PERF_API_USER PERF_API_PASSWORD

SHA=$(git -C "$DIR/.." rev-parse --short HEAD)
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/results/$PROFILE"
if [ "$SCENARIO" != "cart-order-loop" ]; then
    OUT="$DIR/results/$SCENARIO/$PROFILE"
fi
mkdir -p "$OUT"
SUMMARY="$OUT/$STAMP-$SHA.summary.json"

# EventPipe sidecar on the backend pid (optional). Match the app binary, not the
# `dotnet run` wrapper that carries the same name.
BACKEND_PID=$(pgrep -f 'bin/[^ ]*/VirtoCommerce.Platform.Web' | head -1 || true)

# EventPipe is single-consumer per pid: at most ONE of {dotnet-trace, dotnet-counters}
# may attach. TRACE=1 (alloc attribution) wins and forces the counters sidecar off.
TRACE_PID=""
TRACE_FILE=""
COUNTERS_PID=""
COUNTERS_CSV=""

if [ "${TRACE:-0}" = "1" ] && [ -n "$BACKEND_PID" ] && command -v dotnet-trace >/dev/null 2>&1; then
    TRACE_FILE="$OUT/$STAMP-$SHA.alloc.nettrace"
    # gc-verbose surfaces GCAllocationTick (sampled ~every 100 KB) with type names +
    # stacks — the input for allocation-by-caller attribution. --duration caps an
    # orphaned capture; the EXIT trap stops it as soon as k6 finishes.
    dotnet-trace collect -p "$BACKEND_PID" --profile gc-verbose -o "$TRACE_FILE" \
        --duration 00:00:10:00 >/dev/null 2>&1 &
    TRACE_PID=$!
    echo "dotnet-trace (gc-verbose) collecting from pid $BACKEND_PID → $TRACE_FILE"
elif [ "${NO_COUNTERS:-0}" != "1" ] && [ -n "$BACKEND_PID" ] && command -v dotnet-counters >/dev/null 2>&1; then
    COUNTERS_CSV="$OUT/$STAMP-$SHA.counters.csv"
    # --duration caps the capture so an externally-killed runner can't orphan it.
    dotnet-counters collect -p "$BACKEND_PID" --format csv -o "$COUNTERS_CSV" \
        --counters System.Runtime --duration 00:00:10:00 >/dev/null 2>&1 &
    COUNTERS_PID=$!
    echo "dotnet-counters collecting from pid $BACKEND_PID → $COUNTERS_CSV"
else
    echo "note: EventPipe sidecar skipped (TRACE off + NO_COUNTERS, or pid/tool not found) — k6 summary only"
fi

stop_sidecars() {
    if [ -n "$TRACE_PID" ]; then
        kill -INT "$TRACE_PID" 2>/dev/null || true
        wait "$TRACE_PID" 2>/dev/null || true
    fi
    if [ -n "$COUNTERS_PID" ]; then
        kill -INT "$COUNTERS_PID" 2>/dev/null || true
        wait "$COUNTERS_PID" 2>/dev/null || true
    fi
}
trap stop_sidecars EXIT

echo "k6 run: scenario=$SCENARIO profile=$PROFILE sha=$SHA base=$BASE_URL"
"$K6" run \
    -e PROFILE="$PROFILE" \
    -e BASE_URL="$BASE_URL" \
    -e SUMMARY_PATH="$SUMMARY" \
    "$SCENARIO_FILE"
K6_EXIT=$?

stop_sidecars
trap - EXIT

echo "artifacts:"
echo "  $SUMMARY"
if [ -n "$COUNTERS_CSV" ] && [ -f "$COUNTERS_CSV" ]; then
    echo "  $COUNTERS_CSV"
fi
if [ -n "$TRACE_FILE" ] && [ -f "$TRACE_FILE" ]; then
    echo "  $TRACE_FILE"
fi

exit $K6_EXIT

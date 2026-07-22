#!/usr/bin/env bash
# T0 runner: k6 + dotnet-counters, file-first artifacts.
# Usage: loadtests/run.sh [smoke|steady]
# Env knobs forwarded to the scenario: BASE_URL, ITEMS, RATE, PRODUCT_ID, PRODUCT_IDS,
# PRODUCT_FILTER, DISTINCT_PRODUCTS, SKIP_ORDER, STORE_ID. USER_POOL, SEED_PASSWORD,
# SEED_EMAIL_FORMAT configure the multi-user seeding pool (see README.md). SCENARIO picks
# the scenario file (basename under scenarios/, default cart-order-loop). PLATFORM_PROCESS
# names the backend host binary for the EventPipe sidecar (default
# VirtoCommerce.Platform.Web; feed from profile perf.platformProcess). Credentials:
# PERF_API_USER / PERF_API_PASSWORD (required env). No secrets are printed or passed via argv.
# Other knobs: K6 (k6 binary path, default `k6` on PATH); PAYLOAD_DIR (a consumer scenarios/+queries/
# dir to run instead of the bundled ones, see below); RESULTS_DIR (artifact base dir — set to a
# workspace path so artifacts survive plugin updates, see below).
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
PROFILE="${1:-smoke}"
BASE_URL="${BASE_URL:-https://localhost:8090}"
SCENARIO="${SCENARIO:-cart-order-loop}"

# PAYLOAD_DIR lets a consumer project supply its own scenarios/ (+ optional queries/)
# while reusing this plugin's stable transport (lib/) and config.js. Empty/unset keeps
# today's behaviour unchanged: run the plugin's own bundled scenarios from $DIR.
RUN_DIR="$DIR"
if [ -n "${PAYLOAD_DIR:-}" ]; then
    if [ ! -d "$PAYLOAD_DIR" ]; then
        echo "PAYLOAD_DIR not found: $PAYLOAD_DIR" >&2
        exit 1
    fi
    if [ ! -d "$PAYLOAD_DIR/scenarios" ]; then
        echo "PAYLOAD_DIR has no scenarios/: $PAYLOAD_DIR" >&2
        exit 1
    fi
    RUN_DIR="$(mktemp -d)"
    trap 'rm -rf "$RUN_DIR"' EXIT
    cp -r "$DIR/lib" "$RUN_DIR/"
    cp "$DIR/config.js" "$RUN_DIR/"
    cp -r "$PAYLOAD_DIR/scenarios" "$RUN_DIR/"
    if [ -d "$PAYLOAD_DIR/queries" ]; then
        cp -r "$PAYLOAD_DIR/queries" "$RUN_DIR/"
    elif [ -d "$DIR/queries" ]; then
        cp -r "$DIR/queries" "$RUN_DIR/"
    fi
fi

SCENARIO_FILE="$RUN_DIR/scenarios/$SCENARIO.js"
if [ ! -f "$SCENARIO_FILE" ]; then
    echo "scenario not found: $SCENARIO_FILE" >&2
    exit 1
fi

K6="${K6:-k6}"
if ! command -v "$K6" >/dev/null 2>&1 && [ ! -x "$K6" ]; then
    echo "k6 not found — set K6 to the binary path or add k6 to PATH" >&2
    exit 1
fi

: "${PERF_API_USER:?PERF_API_USER not set}"
: "${PERF_API_PASSWORD:?PERF_API_PASSWORD not set}"
export PERF_API_USER PERF_API_PASSWORD

# Artifact stamp: the revision of the code UNDER TEST — the consumer repo you invoke this from
# (cwd), not the plugin install dir. Non-git cwd (or no git) degrades to "nogit", never aborts.
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
STAMP=$(date +%Y%m%d-%H%M%S)
# RESULTS_DIR is the base directory for artifacts. Default keeps today's behaviour ($DIR/results),
# but $DIR is inside the plugin INSTALL dir (a managed marketplace/cache clone) — results there are
# ephemeral (wiped on plugin update) and pollute a repo you don't own. Set RESULTS_DIR to a path in
# the consumer workspace (e.g. RESULTS_DIR="$PWD/.vc-perf/results", gitignored) to keep artifacts.
RESULTS_DIR="${RESULTS_DIR:-$DIR/results}"
OUT="$RESULTS_DIR/$PROFILE"
if [ "$SCENARIO" != "cart-order-loop" ]; then
    OUT="$RESULTS_DIR/$SCENARIO/$PROFILE"
fi
mkdir -p "$OUT"
SUMMARY="$OUT/$STAMP-$SHA.summary.json"

# EventPipe sidecar on the backend pid (optional). Match the app binary, not the
# `dotnet run` wrapper that carries the same name. Process name defaults to the VC host
# binary; override via PLATFORM_PROCESS (fed from profile perf.platformProcess) for
# projects that rename the host.
PLATFORM_PROCESS="${PLATFORM_PROCESS:-VirtoCommerce.Platform.Web}"
if command -v pgrep >/dev/null 2>&1; then
    BACKEND_PID=$(pgrep -f "bin/[^ ]*/${PLATFORM_PROCESS}" | head -1 || true)
else
    # Windows/Git Bash has no pgrep — fall back to the dotnet-counters process list.
    BACKEND_PID=$(dotnet-counters ps 2>/dev/null | grep -F "$PLATFORM_PROCESS" | awk '{print $1}' | head -1 || true)
fi

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
    # Folds in the PAYLOAD_DIR ephemeral run-dir cleanup — this trap replaces the one set
    # right after mktemp, so RUN_DIR removal has to live here too, not just at mktemp time.
    if [ "$RUN_DIR" != "$DIR" ]; then
        rm -rf "$RUN_DIR"
    fi
}
trap stop_sidecars EXIT

echo "k6 run: scenario=$SCENARIO profile=$PROFILE sha=$SHA base=$BASE_URL"
# A k6 threshold breach exits non-zero — a valid verdict, not a script failure. Suspend
# `set -e` around the run so the artifact printout and exit-code propagation below still happen.
set +e
"$K6" run \
    -e PROFILE="$PROFILE" \
    -e BASE_URL="$BASE_URL" \
    -e SUMMARY_PATH="$SUMMARY" \
    "$SCENARIO_FILE"
K6_EXIT=$?
set -e

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

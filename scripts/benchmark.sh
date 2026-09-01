#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Measure a running Decision Theatre server, and open the report.
#
# The one implementation behind three doors — `dt benchmark`, `make benchmark`
# and `nix run .#benchmark` all end up here, so there is one answer to "how do
# I benchmark this" and one place to change it.
#
#   ./scripts/benchmark.sh                        measure localhost, open the PDF
#   ./scripts/benchmark.sh --quick                skip the load phase
#   ./scripts/benchmark.sh --target https://...   measure something else
#   ./scripts/benchmark.sh --no-open              write the PDF, do not open it
#
# POINTING IT AT SOMETHING THAT IS NOT LOCALHOST
#
#   ./scripts/benchmark.sh --target https://africanlandscapefutures.wits.ac.za
#
# works, and skips the load phase automatically because the target is not on
# this machine. The probe and latency phases still run: those are a couple of
# hundred ordinary requests, which is what a visitor does. --stress-remote
# opts back in to the load phase, and should be used with the knowledge that it
# will refuse or delay real users while it runs.
#
# Runs against a remote host are never compared with runs against localhost.
# The difference between them is mostly network, and reading that as a
# performance change is how a benchmark starts producing confident nonsense.
#
# Anything else is passed through to scripts/dtbench.py, which is a plain
# Python program with no dependencies and can always be run directly.
#
# THE LOAD PHASE SATURATES THE SERVER ON PURPOSE
#
# It pushes past what the server can serve, because finding the ceiling is the
# point. Against an instance with load shedding configured it will cause real
# users to be refused while it runs. --quick is the one to use against
# something anyone is using.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET="${DT_BENCH_TARGET:-http://127.0.0.1:8080}"
LABEL="${DT_BENCH_LABEL:-}"
OPEN=1
QUICK=0
PASSTHROUGH=()

while [ $# -gt 0 ]; do
    case "$1" in
        --target)   TARGET="$2"; shift 2 ;;
        --target=*) TARGET="${1#*=}"; shift ;;
        --label)    LABEL="$2"; shift 2 ;;
        --label=*)  LABEL="${1#*=}"; shift ;;
        --quick)    QUICK=1; shift ;;
        --no-open)  OPEN=0; shift ;;
        -h | --help)
            sed -n '5,40p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) PASSTHROUGH+=("$1"); shift ;;
    esac
done

# Run from the project root so benchmarks/ resolves to the tracked location
# rather than wherever the caller happened to be standing.
cd "$PROJECT_ROOT"

if ! command -v python3 >/dev/null 2>&1; then
    echo "benchmark: python3 not found. Enter the development shell first:" >&2
    echo "  nix develop" >&2
    exit 2
fi

# Fail early and clearly. Without this the probe phase reports twenty-two
# broken scenarios, which reads as a catastrophically broken server rather
# than as nothing listening on the port.
if ! curl -fsS --max-time 5 "${TARGET}/api/health" >/dev/null 2>&1; then
    echo "benchmark: nothing answering at ${TARGET}/api/health" >&2
    echo "" >&2
    echo "Start a server first:" >&2
    echo "  dt run          the desktop application" >&2
    echo "  dt run-server   headless, for a browser" >&2
    echo "" >&2
    echo "Or point somewhere else:  dt benchmark --target https://your-instance" >&2
    exit 2
fi

ARGS=(run --target "$TARGET" --pdf)
[ -n "$LABEL" ] && ARGS+=(--label "$LABEL")
[ "$OPEN" -eq 1 ] && ARGS+=(--open)

# --quick keeps the probe and latency phases and drops the load ramp to a
# single client for a second, which is the cheapest thing the schema will
# accept while still recording a row.
[ "$QUICK" -eq 1 ] && ARGS+=(--concurrency 1 --duration 1 --samples 10)

exec python3 scripts/dtbench.py "${ARGS[@]}" ${PASSTHROUGH+"${PASSTHROUGH[@]}"}

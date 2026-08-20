#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# vet-check.sh — go vet over the module.
#
# WHY THIS IS A HOOK AND NOT A CI STEP
#
# golangci-lint subsumes go vet. Its govet linter runs the same analyser
# passes, and .golangci.yml leaves the set at the default, which is everything
# go vet registers. That was established rather than assumed: every one of the
# 35 analysers `go tool vet help` lists is accepted by golangci-lint's govet,
# and against a file written to trip twelve of them — printf, copylocks,
# lostcancel, unusedresult, unreachable, bools, slog, waitgroup, timeformat,
# testinggoroutine, appends, stdmethods — `golangci-lint run` reported all
# twelve, with the same wording, each tagged with the analyser that found it.
#
# So CI does not run go vet, and should not: the lint-go job would spend a
# minute proving something golangci-lint has already proved. **Do not add a
# `go vet` step to a workflow.** If you think one is missing, run the
# comparison above again rather than adding it.
#
# What this script is for is the pre-commit hook, where golangci-lint at five
# minutes is far too slow to run on every commit. go vet is the fast subset
# that catches the same class of mistake before it is committed, and having it
# here rather than inline in .pre-commit-config.yaml means the hook and
# `dt vet` cannot drift apart.
#
# Usage:
#   ./scripts/vet-check.sh          vet the module; exit non-zero on a finding
#   ./scripts/vet-check.sh --github the same, annotating the CI run
#
# Needs cgo and webkit, like every Go command in this repository, so run it
# inside `nix develop`.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export CHECK_PROJECT_ROOT

# shellcheck source=lib-check.sh
. "$SCRIPT_DIR/lib-check.sh"

cd "$CHECK_PROJECT_ROOT"

case "${1:-}" in
    --github) export CHECK_ANNOTATE=1 ;;
    -h | --help)
        sed -n '4,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    "") ;;
    *)
        echo "vet-check: unknown argument: $1" >&2
        exit 2
        ;;
esac

check_require go -- "$0" "$@"

# webkit-compat.sh prints nothing and exits 0 when the 4.0 alias already
# resolves, so this is safe to run unconditionally and makes the script work on
# a machine where only webkit2gtk-4.1 is installed — which is all of them.
if [ -x "$SCRIPT_DIR/webkit-compat.sh" ]; then
    eval "$("$SCRIPT_DIR/webkit-compat.sh")"
fi

output="$(go vet ./... 2>&1)" && status=0 || status=$?

if [ "$status" -eq 0 ]; then
    echo "vet-check: go vet ./... is clean"
    exit 0
fi

printf '%s\n' "$output" >&2

# go vet writes "file:line:col: message"; turn each into an annotation on that
# file so the finding appears in the diff rather than only in the log.
while IFS= read -r line; do
    case "$line" in
        *.go:[0-9]*)
            file="${line%%:*}"
            check_annotate error "go vet: ${line#*: }" "$file"
            ;;
    esac
done <<< "$output"

echo >&2
echo "vet-check: go vet reported problems. Fix them, or run 'dt lint' for the" >&2
echo "           full analysis CI performs." >&2
exit "$status"

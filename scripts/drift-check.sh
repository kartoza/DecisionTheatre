#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# drift-check.sh — has the data contract drifted away from the code?
#
# internal/datacheck/spec.go declares what a valid data directory contains:
# which GeoPackage tables exist, which files the runtime opens, what the
# tileset is called. The application's own loaders are written against that
# declaration, and `decision-theatre check-data` reports against it. So the
# moment somebody adds a table to a query, or renames a file the server opens,
# without editing the spec, every deployment's data check goes on reporting
# that the directory is fine while the application cannot read it.
#
# TestSpecCovers* in internal/datacheck/spec_test.go reads the SQL and the file
# opens back out of the sources and fails when the spec no longer covers them.
# It is the fastest test in the repository with the widest blast radius, which
# is why it runs on commit rather than waiting for the suite.
#
# WHERE THIS RUNS
#
# The pre-commit hook, `dt check-drift`, and CI — where it is already covered
# by the test-go job's `go test ./...`, which necessarily includes it. There is
# deliberately no separate CI step: it would need the same apt install and the
# same webkit shim as the full suite, so it would cost minutes to save seconds.
# The value of this script is that the hook and `dt check-drift` name one
# command instead of two people remembering the same `-run` pattern.
#
# Usage:
#   ./scripts/drift-check.sh            run the contract tests
#   ./scripts/drift-check.sh --github   the same, annotating the CI run
#
# Needs cgo and webkit, like every Go command here, so run it inside
# `nix develop`.
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
        echo "drift-check: unknown argument: $1" >&2
        exit 2
        ;;
esac

check_require go -- "$0" "$@"

if [ -x "$SCRIPT_DIR/webkit-compat.sh" ]; then
    eval "$("$SCRIPT_DIR/webkit-compat.sh")"
fi

status=0
output="$(go test ./internal/datacheck/ -run 'TestSpec' 2>&1)" || status=$?

if [ "$status" -eq 0 ]; then
    echo "drift-check: the data contract still matches the code"
    exit 0
fi

printf '%s\n' "$output" >&2

check_annotate error \
    "The data contract in internal/datacheck/spec.go no longer matches the code. Update the spec, or the check-data report will keep calling a directory valid that the application cannot read." \
    "internal/datacheck/spec.go"

{
    echo
    echo "drift-check: internal/datacheck/spec.go and the code disagree."
    echo
    echo "The spec is what 'decision-theatre check-data' reports against. If the"
    echo "code is right, update the spec; if the spec is right, the code has"
    echo "started reading something nobody declared."
    echo
} >&2

exit "$status"

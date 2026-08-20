#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# gofmt-check.sh — is every Go file in this repository formatted?
#
# Formatting drift is the cheapest possible defect to prevent and one of the
# more expensive to notice: it turns up as unrelated hunks in someone else's
# diff, and reviewers stop reading. This is the gate that stops it reaching
# review, and it is the same script in CI and on a developer machine so the two
# cannot disagree about what "formatted" means.
#
# `gofmt -s`, matching `make fmt`. Without -s the two commands would differ in
# one direction: `make fmt` would simplify a composite literal and this check
# would not, so a formatted tree could still fail elsewhere.
#
# Usage:
#   ./scripts/gofmt-check.sh            report; exit 1 if anything is unformatted
#   ./scripts/gofmt-check.sh --fix      rewrite the offending files instead
#   ./scripts/gofmt-check.sh --github   report, and annotate the CI run
#
# Runs in about a second. It needs nothing but gofmt — no cgo, no webkit, no
# module download — which is why CI runs it before anything slow.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

mode="check"
case "${1:-}" in
    --fix) mode="fix" ;;
    --github) mode="github" ;;
    -h | --help)
        sed -n '4,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    "") ;;
    *)
        echo "gofmt-check: unknown argument: $1" >&2
        exit 2
        ;;
esac

# Tracked files plus anything new that is not gitignored, so a file added in the
# working tree is checked before it is committed rather than after it is pushed.
#
# internal/webview_go/ is vendored upstream code and .golangci.yml excludes it
# for the same reason; reformatting it would only make the next update conflict.
mapfile -t files < <(
    git ls-files --cached --others --exclude-standard -z -- '*.go' \
        | tr '\0' '\n' \
        | grep -v '^internal/webview_go/' \
        | grep -v '^\.go/' \
        || true
)

if [ ${#files[@]} -eq 0 ]; then
    echo "gofmt-check: no Go files to check"
    exit 0
fi

if [ "$mode" = "fix" ]; then
    gofmt -s -l -w "${files[@]}"
    exit 0
fi

unformatted="$(gofmt -s -l "${files[@]}")"

if [ -z "$unformatted" ]; then
    echo "gofmt-check: ${#files[@]} Go files, all formatted"
    exit 0
fi

count="$(printf '%s\n' "$unformatted" | wc -l | tr -d ' ')"

if [ "$mode" = "github" ]; then
    while IFS= read -r f; do
        echo "::error file=$f::$f is not gofmt -s formatted. Run 'dt fmt' and commit the result."
    done <<<"$unformatted"
fi

{
    echo
    echo "gofmt-check: $count file(s) are not formatted:"
    while IFS= read -r f; do
        printf '  %s\n' "$f"
    done <<<"$unformatted"
    echo
    echo "Fix them with:"
    echo "    dt fmt          (or: make fmt, or: ./scripts/gofmt-check.sh --fix)"
    echo
    echo "To see what would change:"
    printf '    gofmt -s -d %s\n' "$(printf '%s\n' "$unformatted" | head -1)"
    echo
} >&2

exit 1

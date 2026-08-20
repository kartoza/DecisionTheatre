#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# nix-check.sh — nixpkgs-fmt over the nix sources.
#
# flake.nix is the definition of what this project builds and what every
# contributor's shell contains, and it is edited by hand more often than
# anything else outside the Go sources. Formatting drift there is the same
# problem as formatting drift in Go — unrelated hunks in someone else's diff —
# except that flake.nix is one long file that several branches touch at once,
# so the noise lands directly on top of the merges most likely to conflict.
#
# The formatter comes from the flake itself, which is a pleasing circularity
# but also the point: nixpkgs-fmt 1.3.0 is pinned in devShells.tooling, so the
# hook, CI and a developer machine cannot disagree about what formatted means.
#
# Usage:
#   ./scripts/nix-check.sh            report; exit non-zero if anything drifted
#   ./scripts/nix-check.sh --fix      reformat in place
#   ./scripts/nix-check.sh --github   report, annotating the CI run
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export CHECK_PROJECT_ROOT

# shellcheck source=lib-check.sh
. "$SCRIPT_DIR/lib-check.sh"

cd "$CHECK_PROJECT_ROOT"

mode="check"
case "${1:-}" in
    --fix) mode="fix" ;;
    --github) export CHECK_ANNOTATE=1 ;;
    -h | --help)
        sed -n '4,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    "") ;;
    *)
        echo "nix-check: unknown argument: $1" >&2
        exit 2
        ;;
esac

mapfile -t files < <(check_files '*.nix')

if [ "${#files[@]}" -eq 0 ]; then
    echo "nix-check: no nix files to check"
    exit 0
fi

check_require nixpkgs-fmt -- "$0" "$@"

if [ "$mode" = "fix" ]; then
    nixpkgs-fmt "${files[@]}" > /dev/null
    echo "nix-check: formatted ${#files[@]} nix file(s)"
    exit 0
fi

# --check reports the count on stderr and exits non-zero, but does not name the
# files, so ask it file by file. There is one nix file in this repository; even
# at ten this costs nothing.
drifted=()
for f in "${files[@]}"; do
    nixpkgs-fmt --check "$f" > /dev/null 2>&1 || drifted+=("$f")
done

if [ "${#drifted[@]}" -eq 0 ]; then
    echo "nix-check: ${#files[@]} nix file(s), all formatted"
    exit 0
fi

for f in "${drifted[@]}"; do
    check_annotate error "$f is not nixpkgs-fmt formatted. Run 'dt check-nix -- --fix' and commit the result." "$f"
done

{
    echo
    echo "nix-check: ${#drifted[@]} nix file(s) are not formatted:"
    printf '  %s\n' "${drifted[@]}"
    echo
    echo "Fix them with:"
    echo "    dt check-nix -- --fix   (or: ./scripts/nix-check.sh --fix)"
    echo
    echo "To see what would change:"
    printf '    nixpkgs-fmt < %s | diff -u %s -\n' "${drifted[0]}" "${drifted[0]}"
    echo
} >&2

exit 1

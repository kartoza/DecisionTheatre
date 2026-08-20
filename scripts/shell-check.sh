#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# shell-check.sh — shellcheck over every shell script in the repository.
#
# A great deal of this project is shell: the build, the packaging, the data
# pipeline, the release, and the checks themselves. None of it is compiled and
# none of it is type-checked, so shellcheck is the only thing standing between
# an unquoted expansion and a build that deletes the wrong directory.
#
# The file list is derived rather than configured — every tracked file with a
# .sh extension or a shell shebang — so a new script is covered the moment it
# is written, including the ones outside scripts/ that a hard-coded path list
# would have missed: devbin/dt, packaging/appimage/AppRun, the two files in
# resources/ and packaging/macos/create-dmg.sh.
#
# --severity=warning matches the settings this project has always used: info
# and style findings are advice, warnings are usually defects.
#
# The tool itself comes from the flake — see check_require in lib-check.sh —
# so the hook, CI and a developer machine all run the same version over the
# same files, with no binary downloaded from anywhere.
#
# Usage:
#   ./scripts/shell-check.sh            check; exit non-zero on a finding
#   ./scripts/shell-check.sh --github   the same, annotating the CI run
#   ./scripts/shell-check.sh --list     print the files that would be checked
#
# There is no --fix: shellcheck's suggestions need a human to accept them.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export CHECK_PROJECT_ROOT

# shellcheck source=lib-check.sh
. "$SCRIPT_DIR/lib-check.sh"

cd "$CHECK_PROJECT_ROOT"

mode="check"
case "${1:-}" in
    --github) export CHECK_ANNOTATE=1 ;;
    --list) mode="list" ;;
    -h | --help)
        sed -n '4,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    "") ;;
    *)
        echo "shell-check: unknown argument: $1" >&2
        exit 2
        ;;
esac

# A shell script is one named .sh or .bash, or one whose first line is a shell
# shebang. The second half is what catches scripts/dt, devbin/dt and AppRun,
# none of which have an extension.
shell_files() {
    local f
    while IFS= read -r f; do
        [ -f "$f" ] || continue
        case "$f" in
            *.sh | *.bash)
                printf '%s\n' "$f"
                continue
                ;;
        esac
        if head -c 128 "$f" 2> /dev/null | head -1 | grep -qE '^#!.*[ /](ba)?sh([[:space:]]|$)'; then
            printf '%s\n' "$f"
        fi
    done < <(check_files)
}

mapfile -t files < <(shell_files)

if [ "$mode" = "list" ]; then
    printf '%s\n' "${files[@]}"
    exit 0
fi

if [ "${#files[@]}" -eq 0 ]; then
    echo "shell-check: no shell scripts found"
    exit 0
fi

check_require shellcheck -- "$0" "$@"

output="$(shellcheck --severity=warning --external-sources "${files[@]}" 2>&1)" && status=0 || status=$?

if [ "$status" -eq 0 ]; then
    echo "shell-check: ${#files[@]} shell scripts, no warnings"
    exit 0
fi

printf '%s\n' "$output" >&2

# The default output format reports "In <file> line <n>:" above each finding,
# with the SC code on the line beginning "  ^--". Pair them up so each finding
# becomes an annotation against its own file.
file="" line=""
while IFS= read -r out; do
    case "$out" in
        "In "*" line "*)
            file="${out#In }"
            file="${file%% line *}"
            line="${out##* line }"
            line="${line%:}"
            ;;
        *"^--"*"SC"*)
            check_annotate error "shellcheck ${out#*^-- }" "$file"
            ;;
    esac
done <<< "$output"

echo >&2
echo "shell-check: shellcheck reported warnings. Each one names the SC code —" >&2
echo "             https://www.shellcheck.net/wiki/SC<code> explains it and" >&2
echo "             gives the fix." >&2
exit "$status"

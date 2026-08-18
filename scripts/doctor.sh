#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# doctor.sh — is this checkout healthy?
#
# One command that answers "why isn't this working", grouped by the thing that
# could be wrong. It reports; it never changes anything. Each finding names the
# command that fixes it.
#
# Usage:
#   ./scripts/doctor.sh          # everything except the slow deep checks
#   ./scripts/doctor.sh --deep   # additionally recompute the real nix hashes
#
# Exit codes:
#   0  no errors (warnings may still be present)
#   1  something is wrong that will bite you
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib-ui.sh
. "$SCRIPT_DIR/lib-ui.sh"

cd "$PROJECT_ROOT"

DEEP=0
case "${1:-}" in
    --deep) DEEP=1 ;;
    -h | --help)
        sed -n '4,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    "") ;;
    *)
        echo "Unknown option: $1 (try --help)" >&2
        exit 2
        ;;
esac

ui_title "Decision Theatre — doctor" "$PROJECT_ROOT"

# -----------------------------------------------------------------------------
# Toolchain
# -----------------------------------------------------------------------------
ui_group "TOOLCHAIN"

if [ -n "${IN_NIX_SHELL:-}" ] || [ -n "${DT_PROJECT_ROOT:-}" ]; then
    ui_ok "nix develop" "you are inside the development shell"
else
    ui_warn "nix develop" "you do not appear to be in the development shell" \
        "run 'nix develop' (or 'direnv allow') so the pinned toolchain is on PATH"
fi

# devbin must be on PATH, or `dt` does not exist. It was a shell function once,
# which meant it was missing for anyone entering through direnv — `use flake`
# carries back the environment, not the shell state.
if command -v dt >/dev/null 2>&1; then
    ui_ok "dt" "$(command -v dt)"
else
    ui_warn "dt" "not on PATH — the task runner is unavailable" \
        "run 'direnv allow', or 'nix develop', or add ./devbin to PATH"
fi

# A locale that glibc cannot load makes it fall back to "C", and GTK and WebKit
# then disagree about what a decimal point means. That is not cosmetic: it made
# the desktop window lay out at a million times scale and hung the machine.
check_locale() {
    local want="${LC_ALL:-${LANG:-}}"
    if [ -z "$want" ] || [ "$want" = "C" ] || [ "$want" = "POSIX" ]; then
        ui_ok "locale" "${want:-unset} — no locale data needed"
        return
    fi

    # Compare on the normalised name: locale -a prints en_GB.utf8 for en_GB.UTF-8.
    local normalised
    normalised="$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]' | sed 's/-//g')"
    if locale -a 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed 's/-//g' \
        | grep -qx "$normalised"; then
        ui_ok "locale" "$want is available"
    else
        ui_err "locale" "$want is set but not installed — glibc falls back to C" \
            "this made the desktop window lay out at 10^6 scale; enter 'nix develop' (it sets LOCALE_ARCHIVE), or add the locale to your system"
    fi
}

check_locale

# Each tool, and what stops working without it.
check_tool() {
    local tool="$1" why="$2" required="${3:-required}"
    if command -v "$tool" >/dev/null 2>&1; then
        ui_ok "$tool" "$(command -v "$tool")"
    elif [ "$required" = "required" ]; then
        ui_err "$tool" "not on PATH — $why"
    else
        ui_warn "$tool" "not on PATH — $why"
    fi
}

check_tool go "the backend cannot be built"
check_tool node "the frontend cannot be built"
check_tool mkdocs "the documentation cannot be built"
check_tool nix "reproducible builds are unavailable"
check_tool jq "the flake lock-step check cannot read its own lock file"
check_tool golangci-lint "linting is unavailable" optional
check_tool air "hot reload is unavailable" optional
check_tool shellcheck "shell scripts cannot be linted" optional

ui_blank

# -----------------------------------------------------------------------------
# Flake / manifest lock step — the thing that breaks other people's builds
# -----------------------------------------------------------------------------
ui_group "FLAKE LOCK STEP"

lock_args=(--check)
[ "$DEEP" -eq 1 ] && lock_args=(--verify)

# Run the real check and fold its tally into ours, rather than restating its
# logic here. Its output is indented under this group.
lock_output="$("$SCRIPT_DIR/sync-flake.sh" "${lock_args[@]}" 2>&1)" && lock_status=0 || lock_status=$?

if [ "$lock_status" -eq 0 ]; then
    if [ "$DEEP" -eq 1 ]; then
        ui_ok "flake.nix" "hashes verified against the real manifests"
    else
        ui_ok "flake.nix" "in step with go.mod, go.sum and package-lock.json"
    fi
    ui_note "" "an importer of this flake will not hit a hash mismatch"
else
    ui_err "flake.nix" "out of step with the manifests — importers of this flake will fail" \
        "run 'make sync-flake', then commit flake.nix and nix/manifest-lock.json together"
    # Show the detail, indented, so the reason is visible without a second run.
    printf '%s\n' "$lock_output" | sed -n '/RECORDED HASHES/,/^$/p' | sed 's/^/    /'
fi

if [ "$DEEP" -eq 0 ]; then
    ui_note "deep check" "run 'make doctor-deep' to recompute the hashes for real"
fi

ui_blank

# -----------------------------------------------------------------------------
# Version consistency
# -----------------------------------------------------------------------------
ui_group "VERSIONS"

# scripts/version.sh owns how the declaration is stored; asking it rather than
# grepping flake.nix again keeps one reader of that file.
flake_version="$("$SCRIPT_DIR/version.sh" --declared 2>/dev/null || true)"
pkg_version="$(jq -r '.version // empty' frontend/package.json 2>/dev/null || true)"
lock_version="$(jq -r '.version // empty' frontend/package-lock.json 2>/dev/null || true)"
git_version="$("$SCRIPT_DIR/version.sh" 2>/dev/null || echo "unknown")"

if [ -z "$flake_version" ]; then
    ui_err "flake.nix" "no version attribute found"
else
    ui_ok "flake.nix" "$flake_version"
fi

for pair in "frontend/package.json:$pkg_version" "frontend/package-lock.json:$lock_version"; do
    file="${pair%%:*}"
    value="${pair#*:}"
    if [ -z "$value" ]; then
        ui_warn "$file" "no version field"
    elif [ "$value" = "$flake_version" ]; then
        ui_ok "$file" "$value"
    else
        ui_err "$file" "$value — disagrees with flake.nix ($flake_version)" \
            "the npm lockfile version feeds npmDepsHash; bump all of them together"
    fi
done

ui_note "build version" "$git_version"

# The declared version having no tag is why a local build and a nix build used
# to disagree, and it is invisible until someone compares two binaries.
if [ -n "$flake_version" ] && git rev-parse -q --verify "refs/tags/v$flake_version" > /dev/null 2>&1; then
    ui_ok "tag v$flake_version" "exists"
elif [ -n "$flake_version" ]; then
    ui_warn "tag v$flake_version" "does not exist yet" \
        "the declared version has not been released; builds report it with a git suffix"
fi

# The CHANGELOG should have a section for the version being declared.
if [ -f CHANGELOG.md ]; then
    if grep -qE "^## \[${flake_version}\]" CHANGELOG.md; then
        ui_ok "CHANGELOG.md" "has a section for $flake_version"
    else
        ui_warn "CHANGELOG.md" "has no '## [$flake_version]' section" \
            "cut a release section when bumping the version"
    fi
fi

ui_blank

# -----------------------------------------------------------------------------
# Build state
# -----------------------------------------------------------------------------
ui_group "BUILD STATE"

# is_stale mirrors scripts/lib-build.sh; sourcing it here would run its build
# logic, and doctor must never change anything.
newer_than() {
    local target="$1"
    shift
    [ -e "$target" ] || return 0
    local src
    for src in "$@"; do
        [ -e "$src" ] || continue
        [ -n "$(find "$src" -newer "$target" -print -quit 2>/dev/null)" ] && return 0
    done
    return 1
}

if [ ! -x bin/decision-theatre ]; then
    ui_note "bin/decision-theatre" "not built yet — 'make run' will build it"
else
    built="$(date -r bin/decision-theatre '+%Y-%m-%d %H:%M' 2>/dev/null || echo unknown)"
    if newer_than bin/decision-theatre main.go subcommands.go internal go.mod go.sum; then
        ui_warn "bin/decision-theatre" "stale (built $built)" \
            "'make run' rebuilds it; nothing launches a stale binary any more"
    else
        ui_ok "bin/decision-theatre" "current (built $built)"
    fi
fi

for pair in "internal/server/static:the embedded frontend" "internal/server/docs_site:the embedded docs"; do
    dir="${pair%%:*}"
    what="${pair#*:}"
    if [ -f "$dir/index.html" ]; then
        ui_ok "$dir" "present"
    else
        ui_note "$dir" "not built — $what is missing until you run 'make run'"
    fi
done

ui_blank

# -----------------------------------------------------------------------------
# Data directory
# -----------------------------------------------------------------------------
ui_group "DATA"

if [ ! -d data ]; then
    ui_warn "./data" "absent — the app will fall back to the per-user data directory" \
        "install a data pack, or see data-readme.md"
else
    if [ -f data/datapack.gpkg ]; then
        ui_ok "./data" "present with datapack.gpkg"
    else
        ui_warn "./data" "present but has no datapack.gpkg" "run 'make geopackage'"
    fi
    ui_note "detail" "run 'make check-data' for the full report"
fi

ui_blank

# -----------------------------------------------------------------------------
# Repository hygiene
# -----------------------------------------------------------------------------
ui_group "REPOSITORY"

if git rev-parse --git-dir >/dev/null 2>&1; then
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    ui_ok "branch" "$branch"

    # Nix only sees git-tracked files. An untracked file that the flake needs is
    # a build failure with a confusing message, so it is worth naming here.
    untracked_nix_inputs="$(git ls-files --others --exclude-standard -- \
        '*.go' '*.nix' 'scripts/*' 'frontend/src/*' 2>/dev/null | head -5)"
    if [ -n "$untracked_nix_inputs" ]; then
        ui_warn "untracked build inputs" "nix cannot see files git does not track" \
            "git add them, or the flake build fails: $(printf '%s ' $untracked_nix_inputs)"
    else
        ui_ok "build inputs" "everything the flake needs is tracked"
    fi

    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        ui_note "working tree" "has uncommitted changes"
    else
        ui_ok "working tree" "clean"
    fi

    if [ -f .pre-commit-config.yaml ]; then
        if [ -f .git/hooks/pre-commit ]; then
            ui_ok "pre-commit" "installed"
        else
            ui_warn "pre-commit" "configured but not installed" \
                "run 'make hooks' so the checks run before each commit"
        fi
    fi
else
    ui_warn "git" "this is not a git repository"
fi

# Conflict markers are cheap to look for and expensive to discover later.
conflicts="$(git grep -lE '^(<<<<<<< |>>>>>>> )' -- . 2>/dev/null | head -5 || true)"
if [ -n "$conflicts" ]; then
    ui_err "merge conflicts" "unresolved conflict markers are committed" \
        "$(printf '%s ' $conflicts)"
else
    ui_ok "merge conflicts" "no conflict markers in tracked files"
fi

ui_summary "fix the errors above, then run 'make doctor' again"

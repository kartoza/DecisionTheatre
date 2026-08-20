#!/usr/bin/env bash
# =============================================================================
# lib-check.sh — shared machinery for the QA check scripts. Sourced, not run.
#
# Every check in this project has exactly one implementation, in scripts/, and
# that one implementation is what the pre-commit hooks run, what CI runs, and
# what `dt <check>` and the neovim bindings run. This file holds the two pieces
# all of them need, so the checks themselves stay short enough to read.
#
# Provides:
#   check_require   make a tool available, from the flake if it is not on PATH
#   check_annotate  emit a GitHub Actions annotation, when running in CI
#   check_files     the repository's files of a given kind, from git
#
# The contract every check script keeps:
#   * no arguments      run the check, exit non-zero if it fails
#   * --fix             repair what can be repaired, where that means anything
#   * --github          force CI annotations on (they are automatic in CI)
#   * --help            what it checks and why
# =============================================================================

# --- CI annotations ----------------------------------------------------------
#
# GitHub sets GITHUB_ACTIONS=true, which is all the detection this needs, so a
# step added to a workflow gets annotations without anyone remembering a flag.
# --github forces them on for testing the output locally.
CHECK_ANNOTATE="${CHECK_ANNOTATE:-}"
if [ -z "$CHECK_ANNOTATE" ] && [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    CHECK_ANNOTATE=1
fi

# check_annotate LEVEL MESSAGE [FILE]
#
# LEVEL is error, warning or notice. With a FILE the annotation lands on that
# file in the pull request's diff; without one it appears against the job.
# Silent outside CI, so a check script can call it unconditionally.
check_annotate() {
    [ -n "$CHECK_ANNOTATE" ] || return 0
    local level="$1" message="$2" file="${3:-}"
    # An annotation is one line. Newlines in a message would silently truncate
    # it, so they become the literal escape GitHub renders as a line break.
    message="${message//$'\n'/%0A}"
    if [ -n "$file" ]; then
        printf '::%s file=%s::%s\n' "$level" "$file" "$message"
    else
        printf '::%s::%s\n' "$level" "$message"
    fi
}

# --- Tools -------------------------------------------------------------------

# check_require TOOL... -- COMMAND...
#
# Ensures every named TOOL is on PATH. If any is missing, re-executes COMMAND —
# which is always the calling script and its own arguments — inside
# `nix develop .#tooling`, the shell that defines what the checks are allowed
# to depend on.
#
# This is why a contributor never has to install shellcheck, gitleaks or
# nixpkgs-fmt, and why CI does not download any of them: the flake is the one
# place that says which version of each tool this project checks with. Fetching
# a security scanner over curl in a job that could have taken it from the flake
# is precisely the supply-chain hole a secret scan exists to close.
#
# Costs about half a second with a warm store, and nothing at all when the
# tools are already on PATH — which they are inside `nix develop`.
#
# Usage, from a check script:
#     . "$SCRIPT_DIR/lib-check.sh"
#     check_require shellcheck -- "$0" "$@"
check_require() {
    local tools=() cmd=() past_sep=0 a
    for a in "$@"; do
        if [ "$past_sep" -eq 0 ] && [ "$a" = "--" ]; then
            past_sep=1
            continue
        fi
        if [ "$past_sep" -eq 0 ]; then tools+=("$a"); else cmd+=("$a"); fi
    done

    local missing=()
    for a in "${tools[@]}"; do
        command -v "$a" > /dev/null 2>&1 || missing+=("$a")
    done
    [ "${#missing[@]}" -eq 0 ] && return 0

    local me
    me="$(basename "${cmd[0]:-check}")"

    # Already inside the tooling shell and still missing: the flake is wrong,
    # and saying so is more useful than a bare "command not found".
    if [ -n "${CHECK_IN_TOOLING_SHELL:-}" ]; then
        echo "$me: ${missing[*]} not present in 'nix develop .#tooling'" >&2
        echo "$me: add it to devShells.tooling in flake.nix" >&2
        exit 127
    fi

    if ! command -v nix > /dev/null 2>&1; then
        echo "$me: needs ${missing[*]}, which is not installed" >&2
        echo "$me: this project provides it — run inside 'nix develop', or" >&2
        echo "$me: install nix so the checks can fetch their own tools" >&2
        exit 127
    fi

    echo "$me: ${missing[*]} not on PATH — running inside nix develop .#tooling" >&2
    export CHECK_IN_TOOLING_SHELL=1
    exec nix --extra-experimental-features 'nix-command flakes' \
        develop "${CHECK_PROJECT_ROOT}#tooling" --command bash "${cmd[@]}"
}

# --- Files -------------------------------------------------------------------

# check_files PATTERN...
#
# Tracked files plus anything new that is not gitignored, matching the given
# pathspecs. Anything new is included deliberately: a file added in the working
# tree should be checked before it is committed, not after it is pushed.
check_files() {
    git ls-files --cached --others --exclude-standard -z -- "$@" \
        | tr '\0' '\n' \
        | grep -v '^$' || true
}

#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# secrets-check.sh — gitleaks over this repository.
#
# The repository ships a data directory, deployment configuration and packaging
# for four platforms, so a credential landing in a commit is not theoretical.
# Once one is pushed, rotating it is the only remedy — rewriting history does
# not help, because whatever mirrored the push already has it. That is why this
# runs before the commit as well as after the push.
#
# WHY THE FLAKE AND NOT A DOWNLOAD
#
# CI used to fetch a pinned gitleaks tarball over curl and untar it into /tmp.
# The reasoning behind it was sound as far as it went — the gitleaks *action*
# requires a paid licence for organisation repositories, so the CLI is the only
# option — but the conclusion was wrong: gitleaks is already in
# devShells.tooling, and a security scanner fetched over the network by the job
# that is meant to be checking the supply chain is the one dependency that must
# not arrive that way. It also drifted: CI pinned 8.21.2, the pre-commit hook
# pinned 8.21.2 separately, and the flake provides 8.30.0 — in which the
# `detect` and `protect` subcommands the old CI step used no longer exist.
#
# One source, one version, no download.
#
# TWO SCOPES, DELIBERATELY
#
#   (default)   the whole history. What CI runs: 288 commits in about three
#               seconds. A secret committed and then removed is still a secret.
#   --staged    what is about to be committed. What the pre-commit hook runs,
#               because scanning all of history on every commit would train
#               people to pass --no-verify.
#
# This is the one asymmetry between hook and CI in the check set, and it is
# intended: the hook is the fast guard on new work, CI is the authority on
# everything that has ever been in the tree.
#
# Usage:
#   ./scripts/secrets-check.sh            scan the full history
#   ./scripts/secrets-check.sh --staged   scan what is staged, for the hook
#   ./scripts/secrets-check.sh --github   full scan, annotating the CI run
#
# Findings are redacted: the log records that something matched and where, not
# the value, so a secret is not leaked a second time by the report of it.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export CHECK_PROJECT_ROOT

# shellcheck source=lib-check.sh
. "$SCRIPT_DIR/lib-check.sh"

cd "$CHECK_PROJECT_ROOT"

scope="history"
case "${1:-}" in
    --staged) scope="staged" ;;
    --github) export CHECK_ANNOTATE=1 ;;
    -h | --help)
        sed -n '4,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    "") ;;
    *)
        echo "secrets-check: unknown argument: $1" >&2
        exit 2
        ;;
esac

check_require gitleaks -- "$0" "$@"

args=(git --redact --no-banner)
[ "$scope" = "staged" ] && args+=(--staged)
args+=(.)

status=0
gitleaks "${args[@]}" || status=$?

if [ "$status" -eq 0 ]; then
    echo "secrets-check: no leaks found (scope: $scope)"
    exit 0
fi

check_annotate error \
    "gitleaks found a potential secret (scope: $scope). Rotate it — removing the commit is not enough once it has been pushed. If it is a false positive, add it to .gitleaksignore with a reason."

{
    echo
    echo "secrets-check: gitleaks reported a finding."
    echo
    echo "If it is real: rotate the credential first. Rewriting history does not"
    echo "un-leak it — anything that mirrored the push already has a copy."
    echo
    echo "If it is a false positive: add the fingerprint printed above to"
    echo ".gitleaksignore, on a line with a comment saying why."
    echo
} >&2

exit "$status"

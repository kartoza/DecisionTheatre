#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Single source of truth for the git revision of a local (non-nix) build.
#
# Companion to version.sh, and called from the same places, so a binary reports
# the same commit no matter which build path produced it. The value is stamped
# into main.commit with -X and reported by /api/info.
#
# It exists because of the benchmark tool. "Which commit was this measured
# against" has to be answered by the thing being measured, not by the machine
# doing the measuring: point the benchmark at production and the local
# checkout's HEAD is simply the wrong answer, and a wrong answer is worse than
# no answer because it looks usable. So the build stamps it and the server
# reports it.
#
# Output:
#
#   1311b8a4c2                 a clean checkout
#   1311b8a4c2-dirty           ... with uncommitted changes
#   unknown                    not a git checkout at all (a source tarball)
#
# Ten hex digits, not seven: seven collides in a repository this size sooner
# than people expect, and this string is meant to be looked up months later.
#
# The -dirty suffix is not decoration. A measurement taken against a working
# tree cannot be reproduced from the sha alone, and a benchmark history that
# quietly attributes uncommitted work to its parent commit will send someone
# bisecting toward a commit that never contained the change.
# =============================================================================

if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "unknown"
    exit 0
fi

sha="$(git rev-parse --short=10 HEAD 2>/dev/null || echo unknown)"

if [ "$sha" != "unknown" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "${sha}-dirty"
else
    echo "$sha"
fi

#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Single source of truth for the version string of a local (non-nix) build.
#
# Called by the Makefile and by every build/packaging script, so a binary
# reports the same version no matter which of them produced it.
#
# The declared version lives in flake.nix and nowhere else. This script reads it
# and appends git's position relative to the nearest tag, so a development build
# is identifiable without inventing a second place to state the release number:
#
#   0.4.0                  a clean checkout of the tag matching the declaration
#   0.4.0-115-g1311b8a     115 commits past the nearest tag
#   0.4.0-115-g1311b8a-dirty   ... with uncommitted changes
#   0.4.0                  not a git checkout at all (a source tarball)
#
# It used to report `git describe` alone, which named the nearest *tag*. With
# the declaration at 0.4.0 and the newest tag v0.2.2, every local build called
# itself 0.2.2-115-g1311b8a while `nix build` — which takes its version from
# flake.nix — called the same source 0.4.0. Two builds of one commit disagreed
# about which release they were.
#
#   version.sh              the full build version, as above
#   version.sh --declared   just the declared version, with no git suffix
#
# --declared exists so that nothing else has to know how flake.nix stores it;
# scripts/doctor.sh and deployments/Dockerfile ask for it rather than each
# growing their own grep.
#
# The leading "v" that a tag carries is stripped: main.go prints
# "Decision Theatre v%s", and the deb/rpm/msi manifests prefix their own "v"
# too, so carrying it in the string produced "vv0.2.1-...".
# =============================================================================

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

# The declaration. flake.nix is the one place the release number is written.
declared="$(sed -nE 's/^ *version = "([^"]+)";.*/\1/p' flake.nix | head -1)"

if [ -z "$declared" ]; then
    echo "version.sh: no version attribute found in flake.nix" >&2
    exit 1
fi

if [ "${1:-}" = "--declared" ]; then
    printf '%s\n' "${declared#v}"
    exit 0
fi

if [ $# -gt 0 ]; then
    echo "version.sh: unknown argument '$1' (expected --declared or nothing)" >&2
    exit 2
fi

declared="${declared#v}"

# Outside a git checkout — a source tarball, or a build context without .git —
# the declaration is all there is, and it is the right answer.
described="$(git describe --tags --always --dirty 2>/dev/null || true)"
if [ -z "$described" ]; then
    printf '%s\n' "$declared"
    exit 0
fi

# Replace whatever tag git named with the declared version, keeping the
# position suffix. `git describe` produces one of:
#
#   v0.2.2                     exactly at a tag
#   v0.2.2-115-g1311b8a        115 commits past it
#   1311b8a                    no tags reachable (--always fell back to a sha)
#   ...-dirty                  any of the above, with uncommitted changes
suffix=""
case "$described" in
    *-*-g*)
        # Everything from the commit count onwards.
        suffix="-$(printf '%s' "$described" | sed -E 's/^.*-([0-9]+-g[0-9a-f]+(-dirty)?)$/\1/')"
        ;;
    *-dirty)
        base="${described%-dirty}"
        # A bare sha with no tag behind it still deserves to be identifiable.
        case "$base" in
            *[!0-9.v]*) [ "$base" != "${base#v}" ] || suffix="-g$base" ;;
        esac
        suffix="${suffix}-dirty"
        ;;
    *)
        # A bare sha rather than a tag: no dots, and not the tag we expect.
        case "$described" in
            v*) ;;
            *.*) ;;
            *) suffix="-g$described" ;;
        esac
        ;;
esac

printf '%s%s\n' "$declared" "$suffix"

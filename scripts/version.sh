#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Single source of truth for the version string of a local (non-nix) build.
#
# Called by the Makefile and by every build/packaging script, so a binary
# reports the same version no matter which of them produced it.
#
# The leading "v" that `git describe` inherits from the tag is stripped here:
# main.go prints "Decision Theatre v%s", and the deb/rpm/msi manifests prefix
# their own "v" too, so carrying it in the string produced "vv0.2.1-...".
# Nix builds take their version from flake.nix, which is already bare.
# =============================================================================

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

version="$(git describe --tags --always --dirty 2>/dev/null || echo "dev")"

printf '%s\n' "${version#v}"

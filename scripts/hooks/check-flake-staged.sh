#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# check-flake-staged.sh — flake.nix and nix/manifest-lock.json move together.
#
# The lock file records which manifests each hash in flake.nix was computed
# from. Committing a hash change without the matching lock update leaves the
# record describing a hash that is no longer there, and the fast offline check
# then reports a conflict on somebody else's machine rather than yours.
#
# Only fires when the hashes themselves changed; ordinary edits to flake.nix
# are none of this hook's business.
# =============================================================================

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

staged="$(git diff --cached --name-only)"

printf '%s\n' "$staged" | grep -qx 'flake.nix' || exit 0

# Did a hash line actually change?
git diff --cached flake.nix | grep -qE '^[+-].*(vendorHash|npmDepsHash)' || exit 0

if printf '%s\n' "$staged" | grep -qx 'nix/manifest-lock.json'; then
    exit 0
fi

cat >&2 <<'MSG'

  flake.nix changes a fixed-output hash, but nix/manifest-lock.json is not staged.

  The lock file records which manifests each hash belongs to. Without it the
  offline lock-step check cannot tell a correct hash from a stale one, and a
  cold-store build of this flake may fail for whoever imports it.

  Fix:
      make sync-flake
      git add flake.nix nix/manifest-lock.json

MSG
exit 1

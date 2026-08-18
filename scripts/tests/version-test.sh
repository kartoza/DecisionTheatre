#!/usr/bin/env bash
set -uo pipefail

# =============================================================================
# version-test.sh — scripts/version.sh must always lead with the declared
# version, whatever git says.
#
# The bug this guards against: version.sh reported `git describe` alone, which
# names the nearest *tag*. flake.nix declared 0.4.0, the newest tag was v0.2.2,
# and so `make build` produced a binary calling itself 0.2.2-115-g1311b8a while
# `nix build` called the identical source 0.4.0.
#
# Each case builds a throwaway repository under a temp directory and runs the
# real script against it, so nothing here depends on the state of this checkout.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL="$SCRIPT_DIR/../version.sh"

passed=0
failed=0

fail() {
    printf '  FAIL  %s\n        expected: %s\n        got:      %s\n' "$1" "$2" "$3"
    failed=$((failed + 1))
}

ok() {
    printf '  ok    %s\n' "$1"
    passed=$((passed + 1))
}

# A fresh repository with the declared version and whatever history is asked for.
make_repo() {
    local dir="$1" declared="$2"
    mkdir -p "$dir/scripts"
    cp "$REAL" "$dir/scripts/version.sh"
    printf '{\n  outputs = { ... }: {\n    version = "%s";\n  };\n}\n' "$declared" > "$dir/flake.nix"
    git -C "$dir" init -q
    git -C "$dir" config user.email t@example.com
    git -C "$dir" config user.name Test
    git -C "$dir" add -A
    git -C "$dir" commit -qm "first"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- the declaration is what a clean tagged checkout reports -----------------
d="$TMP/tagged"
make_repo "$d" "0.4.0"
git -C "$d" tag v0.4.0
got="$("$d/scripts/version.sh")"
[ "$got" = "0.4.0" ] && ok "clean checkout of the matching tag" \
    || fail "clean checkout of the matching tag" "0.4.0" "$got"

# --- the declaration wins over an older tag ---------------------------------
# This is the actual bug: the tag says 0.2.2, the declaration says 0.4.0.
d="$TMP/behind"
make_repo "$d" "0.4.0"
git -C "$d" tag v0.2.2
git -C "$d" commit -q --allow-empty -m second
git -C "$d" commit -q --allow-empty -m third
got="$("$d/scripts/version.sh")"
case "$got" in
    0.4.0-2-g*) ok "declaration leads, git position follows ($got)" ;;
    *) fail "declaration leads when the newest tag is older" "0.4.0-2-g<sha>" "$got" ;;
esac
case "$got" in
    *0.2.2*) fail "the stale tag must not appear" "no 0.2.2" "$got" ;;
    *) ok "the stale tag does not appear in the version" ;;
esac

# --- uncommitted changes are visible ----------------------------------------
d="$TMP/dirty"
make_repo "$d" "0.4.0"
git -C "$d" tag v0.4.0
echo "change" >> "$d/flake.nix.note"
git -C "$d" add -A
echo "more" >> "$d/flake.nix.note"
got="$("$d/scripts/version.sh")"
case "$got" in
    *-dirty) ok "a dirty tree is marked ($got)" ;;
    *) fail "a dirty tree is marked" "*-dirty" "$got" ;;
esac
case "$got" in
    0.4.0*) ok "a dirty tree still leads with the declaration" ;;
    *) fail "a dirty tree still leads with the declaration" "0.4.0*" "$got" ;;
esac

# --- no tags at all ---------------------------------------------------------
d="$TMP/untagged"
make_repo "$d" "0.4.0"
got="$("$d/scripts/version.sh")"
case "$got" in
    0.4.0-g*) ok "an untagged repository is identifiable ($got)" ;;
    *) fail "an untagged repository is identifiable" "0.4.0-g<sha>" "$got" ;;
esac

# --- not a git checkout at all (a source tarball) ---------------------------
d="$TMP/notgit"
make_repo "$d" "0.4.0"
rm -rf "$d/.git"
got="$("$d/scripts/version.sh")"
[ "$got" = "0.4.0" ] && ok "a source tarball reports the declaration" \
    || fail "a source tarball reports the declaration" "0.4.0" "$got"

# --- --declared ------------------------------------------------------------
d="$TMP/declared"
make_repo "$d" "1.2.3"
git -C "$d" commit -q --allow-empty -m second
got="$("$d/scripts/version.sh" --declared)"
[ "$got" = "1.2.3" ] && ok "--declared omits the git suffix" \
    || fail "--declared omits the git suffix" "1.2.3" "$got"

# --- a leading v in the declaration is stripped ------------------------------
d="$TMP/vprefix"
make_repo "$d" "v0.4.0"
got="$("$d/scripts/version.sh" --declared)"
[ "$got" = "0.4.0" ] && ok "a declared leading v is stripped" \
    || fail "a declared leading v is stripped" "0.4.0" "$got"

# --- failure modes are loud -------------------------------------------------
d="$TMP/noversion"
make_repo "$d" "0.4.0"
printf '{ outputs = { ... }: { }; }\n' > "$d/flake.nix"
if "$d/scripts/version.sh" > /dev/null 2>&1; then
    fail "a flake with no version attribute fails" "non-zero exit" "exit 0"
else
    ok "a flake with no version attribute fails loudly"
fi

d="$TMP/badarg"
make_repo "$d" "0.4.0"
"$d/scripts/version.sh" --nonsense > /dev/null 2>&1
[ "$?" = "2" ] && ok "an unknown argument exits 2" \
    || fail "an unknown argument exits 2" "2" "$?"

printf '\n  %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]

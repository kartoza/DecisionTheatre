#!/usr/bin/env bash
set -uo pipefail

# =============================================================================
# report-tables-test.sh — the SBOM and CVE tables that go into a pull request
# comment and a release note.
#
# These render attacker-relevant information for a human to act on, so silently
# producing an empty or wrong table is the failure that matters. Each case feeds
# known input and asserts on the rendered output.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SBOM="$SCRIPT_DIR/../sbom_table.py"
CVE="$SCRIPT_DIR/../cve_table.py"

passed=0
failed=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok()   { printf '  ok    %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf '  FAIL  %s\n        %s\n' "$1" "$2"; failed=$((failed + 1)); }

check() { # name, haystack, needle
    case "$2" in
        *"$3"*) ok "$1" ;;
        *) fail "$1" "expected to find: $3" ;;
    esac
}

refute() {
    case "$2" in
        *"$3"*) fail "$1" "did not expect to find: $3" ;;
        *) ok "$1" ;;
    esac
}

# --- SBOM ------------------------------------------------------------------
cat > "$TMP/sbom.json" <<'JSON'
{"artifacts":[
 {"name":"glibc","version":"2.40","type":"nix","licenses":[{"value":"LGPL-2.1-or-later"}]},
 {"name":"glibc","version":"2.40","type":"nix","licenses":[{"value":"LGPL-2.1-or-later"}]},
 {"name":"openssl","version":"3.3.2","type":"nix","licenses":["Apache-2.0"]},
 {"name":"decision-theatre","version":"0.4.0","type":"go-module","licenses":[]}
]}
JSON

out="$($SBOM "$TMP/sbom.json")"
check "counts distinct packages, not occurrences" "$out" "**3 distinct packages**"
check "groups by package type"                   "$out" "| nix | 2 |"
check "renders a licence from an object"         "$out" "LGPL-2.1-or-later"
check "renders a licence given as a string"      "$out" "Apache-2.0"
check "shows an em dash when none is declared"   "$out" "| decision-theatre | 0.4.0 | go-module | — |"

out="$($SBOM "$TMP/sbom.json" --limit 1)"
check "honours --limit"        "$out" "2 further packages omitted"
refute "omits beyond the limit" "$out" "| openssl |"

echo '{"artifacts":[]}' > "$TMP/empty.json"
out="$($SBOM "$TMP/empty.json")"
check "an empty SBOM still renders" "$out" "**0 distinct packages**"

# --- CVE -------------------------------------------------------------------
cat > "$TMP/cve.json" <<'JSON'
{"matches":[
 {"vulnerability":{"id":"CVE-2025-0001","severity":"Low","fix":{"versions":["1.2.4"]}},
  "artifact":{"name":"zlib","version":"1.2.3"}},
 {"vulnerability":{"id":"CVE-2025-0002","severity":"Critical","fix":{"versions":[]}},
  "artifact":{"name":"openssl","version":"3.0.0"}},
 {"vulnerability":{"id":"CVE-2025-0003","severity":"medium"},
  "artifact":{"name":"curl","version":"8.0.0"}}
]}
JSON

out="$($CVE "$TMP/cve.json")"
check "counts findings"                "$out" "**3 findings.**"
check "normalises a lowercase severity" "$out" "Medium | 1 |"
check "reports a fix version"           "$out" "1.2.4"
check "reports no fix as an em dash"    "$out" "| CVE-2025-0002 | openssl | 3.0.0 | — |"
check "carries the impact note"         "$out" "What this image exposes"

# Worst first: Critical must appear before Low in the rendered table.
crit="$(printf '%s\n' "$out" | grep -n "CVE-2025-0002" | head -1 | cut -d: -f1)"
low="$(printf '%s\n' "$out" | grep -n "CVE-2025-0001" | head -1 | cut -d: -f1)"
if [ -n "$crit" ] && [ -n "$low" ] && [ "$crit" -lt "$low" ]; then
    ok "orders findings worst first"
else
    fail "orders findings worst first" "Critical at line $crit, Low at line $low"
fi

echo '{"matches":[]}' > "$TMP/clean.json"
out="$($CVE "$TMP/clean.json")"
check "a clean scan says so plainly" "$out" "**No known vulnerabilities reported.**"
check "a clean scan still carries the impact note" "$out" "What this image exposes"

# --- failure modes ---------------------------------------------------------
"$SBOM" > /dev/null 2>&1
[ "$?" = "2" ] && ok "sbom_table exits 2 with no argument" \
    || fail "sbom_table exits 2 with no argument" "got $?"
"$CVE" > /dev/null 2>&1
[ "$?" = "2" ] && ok "cve_table exits 2 with no argument" \
    || fail "cve_table exits 2 with no argument" "got $?"

printf '\n  %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]

#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# sync-flake.sh — keep flake.nix in lock step with the Go and npm manifests.
#
# WHY THIS EXISTS
#
# flake.nix pins two fixed-output derivations:
#
#   vendorHash   the vendored Go module set, derived from go.mod and go.sum
#   npmDepsHash  the npm dependency tree, derived from frontend/package-lock.json
#
# A fixed-output derivation is only re-verified when its output path changes,
# and that path embeds the version. So a hash that has fallen behind its
# manifest can sit in the tree indefinitely: every local build reuses the store
# path that is already there and nothing revalidates it. It surfaces later, on
# a machine with a cold store — a fresh CI runner, or somebody importing this
# flake — as a hash mismatch, and their build fails through no fault of theirs.
#
# That is exactly what happened to vendorHash before 0.3.0.
#
# HOW THE CHECK WORKS
#
# Recomputing the real hashes needs a network round trip and, for Go, a build.
# Too slow for a pre-commit hook. So each recorded hash is stored alongside a
# SHA-256 of the manifests it was computed from, in nix/manifest-lock.json.
#
#   --check   (fast, offline)  recomputes those manifest digests and compares.
#                              Any change to go.sum or package-lock.json since
#                              the hash was last synced fails the check. It can
#                              produce a needless resync, never a false pass.
#
#   --verify  (slow, networked) additionally recomputes the true nix hashes and
#                              confirms the recorded ones are right. For CI.
#
#   (default) recomputes both hashes, writes them into flake.nix, and records
#                              the new manifest digests.
#
#   --adopt   records the hashes ALREADY in flake.nix as belonging to the
#             manifests as they stand, without recomputing them. Use this only
#             when you have independent evidence they are right — a successful
#             `nix build` from a cold store, or a green CI run — or on a machine
#             where a networked fixed-output derivation cannot be built.
#             It bootstraps the lock file; it cannot discover a wrong hash.
#
# Usage:
#   ./scripts/sync-flake.sh            # recompute and write
#   ./scripts/sync-flake.sh --check    # fast drift check, no network
#   ./scripts/sync-flake.sh --verify   # authoritative check, no writes
#   ./scripts/sync-flake.sh --adopt    # record what is already there
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib-ui.sh
. "$SCRIPT_DIR/lib-ui.sh"

cd "$PROJECT_ROOT"

FLAKE="$PROJECT_ROOT/flake.nix"
LOCK_FILE="$PROJECT_ROOT/nix/manifest-lock.json"

# The manifests each hash is derived from.
GO_MANIFESTS=(go.mod go.sum)
NPM_MANIFESTS=(frontend/package-lock.json)

NIX=(nix --extra-experimental-features "nix-command flakes")

mode="sync"
case "${1:-}" in
    --check) mode="check" ;;
    --verify) mode="verify" ;;
    --adopt) mode="adopt" ;;
    -h | --help)
        sed -n '4,54p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    "") ;;
    *)
        echo "Unknown option: $1 (try --help)" >&2
        exit 2
        ;;
esac

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

digest_of() {
    sha256sum "$1" | cut -d' ' -f1
}

# Reads the current value of a hash attribute out of flake.nix. Both
# npmDepsHash occurrences must agree; a disagreement is itself a fault.
hash_in_flake() {
    local attr="$1" values
    values="$(grep -oE "${attr} = \"[^\"]+\"" "$FLAKE" | sed -E 's/.*"(.*)"/\1/' | sort -u)"
    if [ -z "$values" ]; then
        echo "MISSING"
        return
    fi
    if [ "$(printf '%s\n' "$values" | wc -l)" -gt 1 ]; then
        echo "CONFLICT"
        return
    fi
    printf '%s' "$values"
}

# Writes a hash attribute back into flake.nix, every occurrence.
set_hash_in_flake() {
    local attr="$1" value="$2"
    # The value is a nix SRI hash, so it contains / and +. Use | as the
    # delimiter and escape any | that somehow appears.
    local escaped="${value//|/\\|}"
    sed -i -E "s|${attr} = \"[^\"]+\"|${attr} = \"${escaped}\"|g" "$FLAKE"
}

json_get() {
    local path="$1"
    [ -f "$LOCK_FILE" ] || { printf ''; return; }
    jq -r "$path // empty" "$LOCK_FILE" 2>/dev/null || printf ''
}

# -----------------------------------------------------------------------------
# Recomputing the real hashes
# -----------------------------------------------------------------------------

compute_npm_hash() {
    "${NIX[@]}" run nixpkgs#prefetch-npm-deps -- frontend/package-lock.json 2>/dev/null | tail -1
}

# Recomputing vendorHash means asking nix to build the vendor derivation with a
# deliberately wrong hash and reading the value it reports. flake.nix is edited
# in place to do that, and restored by the trap whatever happens.
FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
FLAKE_BACKUP=""

restore_flake() {
    if [ -n "$FLAKE_BACKUP" ] && [ -f "$FLAKE_BACKUP" ]; then
        cp "$FLAKE_BACKUP" "$FLAKE"
        rm -f "$FLAKE_BACKUP"
        FLAKE_BACKUP=""
    fi
}
trap restore_flake EXIT INT TERM

compute_vendor_hash() {
    local output got

    FLAKE_BACKUP="$(mktemp "${TMPDIR:-/tmp}/flake.nix.XXXXXX")"
    cp "$FLAKE" "$FLAKE_BACKUP"

    set_hash_in_flake vendorHash "$FAKE_HASH"

    # The build is expected to fail; the failure carries the correct hash.
    output="$("${NIX[@]}" build .#decision-theatre.goModules --no-link 2>&1 || true)"

    restore_flake

    got="$(printf '%s\n' "$output" | grep -oE 'got: +sha256-[A-Za-z0-9+/=]+' | head -1 | sed -E 's/.*(sha256-[A-Za-z0-9+/=]+)/\1/')"
    if [ -z "$got" ]; then
        # No mismatch reported: either the fake hash somehow built (impossible)
        # or nix failed for an unrelated reason. Report the current value so the
        # caller can decide, and surface the output.
        printf '%s' "UNKNOWN"
        printf '%s\n' "$output" >&2
        return
    fi
    printf '%s' "$got"
}

# -----------------------------------------------------------------------------
# check — fast, offline
# -----------------------------------------------------------------------------

check_group() {
    local name="$1" attr="$2"
    shift 2
    local manifests=("$@")

    local recorded_hash actual_hash
    recorded_hash="$(json_get ".${attr}.value")"
    actual_hash="$(hash_in_flake "$attr")"

    case "$actual_hash" in
        MISSING)
            ui_err "$attr" "not present in flake.nix"
            return
            ;;
        CONFLICT)
            ui_err "$attr" "occurrences in flake.nix disagree with each other" \
                "every occurrence must carry the same value; run 'make sync-flake'"
            return
            ;;
    esac

    if [ -z "$recorded_hash" ]; then
        ui_err "$attr" "never synced — nix/manifest-lock.json has no record of it" \
            "run 'make sync-flake' to record which manifests this hash belongs to"
        return
    fi

    if [ "$recorded_hash" != "$actual_hash" ]; then
        ui_err "$attr" "flake.nix was edited without resyncing" \
            "flake.nix has ${actual_hash}, the lock records ${recorded_hash}"
        return
    fi

    local drifted=()
    local m recorded_digest actual_digest
    for m in "${manifests[@]}"; do
        if [ ! -f "$m" ]; then
            ui_err "$m" "missing, but $attr is derived from it"
            continue
        fi
        recorded_digest="$(json_get ".${attr}.inputs[\"${m}\"]")"
        actual_digest="$(digest_of "$m")"
        if [ -z "$recorded_digest" ]; then
            drifted+=("$m (never recorded)")
        elif [ "$recorded_digest" != "$actual_digest" ]; then
            drifted+=("$m")
        fi
    done

    if [ ${#drifted[@]} -gt 0 ]; then
        ui_err "$name" "changed since $attr was computed: ${drifted[*]}" \
            "run 'make sync-flake' — otherwise a cold-store build of this flake fails"
        return
    fi

    ui_ok "$name" "$attr matches ${manifests[*]}"
}

do_check() {
    ui_title "Flake / manifest lock step" \
        "so that importing this flake never fails on a stale hash"
    ui_group "RECORDED HASHES"

    if [ ! -f "$LOCK_FILE" ]; then
        ui_err "nix/manifest-lock.json" "missing — nothing records what the hashes were computed from" \
            "run 'make sync-flake' to create it"
        ui_summary "the flake may not build from a cold store"
        return $?
    fi

    check_group "Go modules" vendorHash "${GO_MANIFESTS[@]}"
    check_group "npm packages" npmDepsHash "${NPM_MANIFESTS[@]}"

    ui_summary "run 'make sync-flake' to bring flake.nix back in step"
}

# -----------------------------------------------------------------------------
# verify — slow, authoritative
# -----------------------------------------------------------------------------

do_verify() {
    ui_title "Flake / manifest lock step (deep)" \
        "recomputing the real hashes; this needs the network"
    ui_group "RECORDED HASHES"

    local recorded actual

    recorded="$(hash_in_flake npmDepsHash)"
    actual="$(compute_npm_hash)"
    if [ -z "$actual" ]; then
        ui_err "npmDepsHash" "could not be recomputed" "is the network reachable?"
    elif [ "$recorded" = "$actual" ]; then
        ui_ok "npmDepsHash" "correct for frontend/package-lock.json"
    else
        ui_err "npmDepsHash" "is wrong — this flake cannot build from a cold store" \
            "flake.nix has ${recorded}, the lockfile needs ${actual}"
    fi

    recorded="$(hash_in_flake vendorHash)"
    actual="$(compute_vendor_hash)"
    if [ "$actual" = "UNKNOWN" ]; then
        ui_err "vendorHash" "could not be recomputed" "see the nix output above"
    elif [ "$recorded" = "$actual" ]; then
        ui_ok "vendorHash" "correct for go.mod and go.sum"
    else
        ui_err "vendorHash" "is wrong — this flake cannot build from a cold store" \
            "flake.nix has ${recorded}, go.sum needs ${actual}"
    fi

    ui_summary "run 'make sync-flake' to correct them"
}

# write_lock VENDOR_HASH NPM_HASH — record the hashes and the manifest digests
# they belong to. Both callers (sync and adopt) go through here so the file
# format is defined once.
write_lock() {
    local vendor_hash="$1" npm_hash="$2"
    local i m

    mkdir -p "$(dirname "$LOCK_FILE")"
    {
        printf '{\n'
        printf '  "_comment": "Written by scripts/sync-flake.sh. Records which manifests each fixed-output hash in flake.nix was computed from, so drift is caught offline and a cold-store build of this flake cannot fail on a stale hash. Do not edit by hand - run: make sync-flake",\n'
        printf '  "vendorHash": {\n'
        printf '    "value": "%s",\n' "$vendor_hash"
        printf '    "inputs": {\n'
        for i in "${!GO_MANIFESTS[@]}"; do
            m="${GO_MANIFESTS[$i]}"
            printf '      "%s": "%s"' "$m" "$(digest_of "$m")"
            [ "$i" -lt $((${#GO_MANIFESTS[@]} - 1)) ] && printf ','
            printf '\n'
        done
        printf '    }\n'
        printf '  },\n'
        printf '  "npmDepsHash": {\n'
        printf '    "value": "%s",\n' "$npm_hash"
        printf '    "inputs": {\n'
        for i in "${!NPM_MANIFESTS[@]}"; do
            m="${NPM_MANIFESTS[$i]}"
            printf '      "%s": "%s"' "$m" "$(digest_of "$m")"
            [ "$i" -lt $((${#NPM_MANIFESTS[@]} - 1)) ] && printf ','
            printf '\n'
        done
        printf '    }\n'
        printf '  }\n'
        printf '}\n'
    } > "$LOCK_FILE"
}

# -----------------------------------------------------------------------------
# adopt — record what is already in flake.nix
# -----------------------------------------------------------------------------

do_adopt() {
    ui_title "Adopting the hashes already in flake.nix" \
        "recording what they belong to, without recomputing them"
    ui_group "ADOPTING"

    local vendor_hash npm_hash
    vendor_hash="$(hash_in_flake vendorHash)"
    npm_hash="$(hash_in_flake npmDepsHash)"

    local bad=0
    local pair
    for pair in "vendorHash:$vendor_hash" "npmDepsHash:$npm_hash"; do
        case "${pair#*:}" in
            MISSING)  ui_err "${pair%%:*}" "not present in flake.nix"; bad=1 ;;
            CONFLICT) ui_err "${pair%%:*}" "occurrences in flake.nix disagree"; bad=1 ;;
        esac
    done
    [ "$bad" -eq 1 ] && { ui_summary; return 1; }

    ui_ok "vendorHash" "$vendor_hash"
    ui_ok "npmDepsHash" "$npm_hash"

    write_lock "$vendor_hash" "$npm_hash"
    ui_ok "nix/manifest-lock.json" "manifest digests recorded"

    ui_blank
    printf '  %sAdopted, not verified. These hashes are now treated as correct for the%s\n' "$UI_DIM" "$UI_RST"
    printf '  %smanifests as they stand; run "make verify-flake" to confirm that they are.%s\n\n' "$UI_DIM" "$UI_RST"
}

# -----------------------------------------------------------------------------
# sync — recompute and write
# -----------------------------------------------------------------------------

do_sync() {
    ui_title "Syncing flake.nix with the manifests" \
        "recomputing both fixed-output hashes; this needs the network"

    ui_group "RECOMPUTING"

    local npm_hash vendor_hash
    printf '    computing npmDepsHash from frontend/package-lock.json …\n'
    npm_hash="$(compute_npm_hash)"
    if [ -z "$npm_hash" ]; then
        ui_err "npmDepsHash" "could not be computed" "is the network reachable?"
        ui_summary
        return 1
    fi
    ui_ok "npmDepsHash" "$npm_hash"

    printf '    computing vendorHash from go.mod and go.sum …\n'
    vendor_hash="$(compute_vendor_hash)"
    if [ "$vendor_hash" = "UNKNOWN" ]; then
        ui_err "vendorHash" "could not be computed" "see the nix output above"
        ui_summary
        return 1
    fi
    ui_ok "vendorHash" "$vendor_hash"

    ui_blank
    ui_group "WRITING"

    set_hash_in_flake npmDepsHash "$npm_hash"
    set_hash_in_flake vendorHash "$vendor_hash"
    ui_ok "flake.nix" "both hashes written"

    write_lock "$vendor_hash" "$npm_hash"
    ui_ok "nix/manifest-lock.json" "manifest digests recorded"

    ui_blank
    printf '  %sCommit flake.nix and nix/manifest-lock.json together.%s\n\n' "$UI_DIM" "$UI_RST"
}

case "$mode" in
    check) do_check ;;
    verify) do_verify ;;
    adopt) do_adopt ;;
    sync) do_sync ;;
esac

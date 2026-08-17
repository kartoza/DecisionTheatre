#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# vendor-fonts.sh — refresh the committed typefaces from nixpkgs.
#
# The fonts are committed to the source tree rather than fetched at build or
# run time. The desktop application is offline by design: a request to a font
# CDN either fails or blocks first paint, and it announces every launch to a
# third party.
#
# Committing binaries is a real cost, so this script exists to make them
# reproducible rather than mysterious. Anyone can rerun it and get the same
# files, and the provenance is a nixpkgs attribute rather than a URL somebody
# pasted once.
#
# Usage:
#   ./scripts/vendor-fonts.sh          # refresh from the pinned nixpkgs
#   ./scripts/vendor-fonts.sh --check  # verify the committed files are current
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib-ui.sh
. "$SCRIPT_DIR/lib-ui.sh"

cd "$PROJECT_ROOT"

DEST="frontend/src/assets/fonts"
NIX=(nix --extra-experimental-features "nix-command flakes")

# nixpkgs attribute : file within the package : name to write
FONTS=(
    "inter:InterVariable.ttf:InterVariable"
    "inter:InterVariable-Italic.ttf:InterVariable-Italic"
    "source-sans:SourceSans3VF-Upright.ttf:SourceSans3VF-Upright"
    "source-sans:SourceSans3VF-Italic.ttf:SourceSans3VF-Italic"
)

check_only=0
case "${1:-}" in
    --check) check_only=1 ;;
    -h | --help)
        sed -n '4,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
esac

ui_title "Vendoring typefaces from nixpkgs" "$DEST"
ui_group "FONTS"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$DEST"

for spec in "${FONTS[@]}"; do
    attr="${spec%%:*}"
    rest="${spec#*:}"
    file="${rest%%:*}"
    out="${rest#*:}"

    store="$("${NIX[@]}" build "nixpkgs#${attr}" --no-link --print-out-paths 2>/dev/null || true)"
    if [ -z "$store" ]; then
        ui_err "$attr" "could not be built from nixpkgs"
        continue
    fi

    # Nix may be using a chroot store, in which case the reported path is
    # relative to that root rather than to /.
    src="$store/share/fonts/truetype/$file"
    if [ ! -f "$src" ]; then
        for root in "$HOME/.local/share/nix/root" ""; do
            if [ -f "$root$store/share/fonts/truetype/$file" ]; then
                src="$root$store/share/fonts/truetype/$file"
                break
            fi
        done
    fi
    if [ ! -f "$src" ]; then
        ui_err "$out" "not found inside $attr"
        continue
    fi

    cp "$src" "$tmp/$out.ttf"
    ("${NIX[@]}" shell nixpkgs#woff2 --command woff2_compress "$tmp/$out.ttf") >/dev/null 2>&1

    if [ ! -f "$tmp/$out.woff2" ]; then
        ui_err "$out" "woff2 conversion failed"
        continue
    fi

    if [ "$check_only" -eq 1 ]; then
        if cmp -s "$tmp/$out.woff2" "$DEST/$out.woff2"; then
            ui_ok "$out.woff2" "current"
        else
            ui_err "$out.woff2" "differs from nixpkgs $attr" "run 'make vendor-fonts'"
        fi
    else
        mv "$tmp/$out.woff2" "$DEST/$out.woff2"
        ui_ok "$out.woff2" "$(du -h "$DEST/$out.woff2" | cut -f1) from $attr"
    fi
done

ui_summary "run 'make vendor-fonts' to refresh them"

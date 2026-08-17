#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# webkit-compat.sh — make webkit2gtk-4.0 resolvable when only 4.1 is installed.
#
# github.com/webview/webview_go hardcodes its cgo directive as
#     #cgo linux ... pkg-config: gtk+-3.0 webkit2gtk-4.0
# with no build tag to select 4.1. Current distributions — Ubuntu 24.04 on the
# CI runners, and nixpkgs — ship only the 4.1 ABI, so pkg-config fails and every
# cgo-touching command dies with
#     could not import github.com/webview/webview_go
# That is what breaks `go build`, `go test ./...` and golangci-lint alike.
#
# This writes a 4.0 .pc file derived from the real 4.1 one, and a matching
# library symlink, then prints the environment needed to use them. The two ABIs
# are compatible for webview's purposes.
#
# Usage:
#   eval "$(./scripts/webkit-compat.sh)"    # export the settings into a shell
#   ./scripts/webkit-compat.sh --github-env # append them to $GITHUB_ENV in CI
#
# Prints nothing and exits 0 when 4.0 is already available, so it is safe to
# call unconditionally.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPAT_DIR="${WEBKIT_COMPAT_DIR:-$PROJECT_ROOT/.webkit-compat}"

mode="eval"
case "${1:-}" in
    --github-env) mode="github" ;;
    -h | --help)
        sed -n '4,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
esac

if pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
    exit 0
fi

if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    echo "webkit-compat: neither webkit2gtk-4.0 nor webkit2gtk-4.1 is installed" >&2
    echo "  Debian/Ubuntu: apt-get install libwebkit2gtk-4.1-dev" >&2
    echo "  Fedora:        dnf install webkit2gtk4.1-devel" >&2
    echo "  nix:           it is in the development shell" >&2
    exit 1
fi

mkdir -p "$COMPAT_DIR/pkgconfig" "$COMPAT_DIR/lib"

pc_dir="$(pkg-config --variable=pcfiledir webkit2gtk-4.1)"
lib_dir="$(pkg-config --variable=libdir webkit2gtk-4.1)"

sed 's/webkit2gtk-4\.1/webkit2gtk-4.0/g' \
    "$pc_dir/webkit2gtk-4.1.pc" > "$COMPAT_DIR/pkgconfig/webkit2gtk-4.0.pc"
sed -i 's/-lwebkit2gtk-4\.0/-lwebkit2gtk-4.1/g' "$COMPAT_DIR/pkgconfig/webkit2gtk-4.0.pc"

# The linker still needs a libwebkit2gtk-4.0.so to open if anything asks for
# one by that name; point it at the real 4.1 library.
if [ -e "$lib_dir/libwebkit2gtk-4.1.so" ]; then
    ln -sf "$lib_dir/libwebkit2gtk-4.1.so" "$COMPAT_DIR/lib/libwebkit2gtk-4.0.so"
fi

# nix's pkg-config wrapper reads PKG_CONFIG_PATH_FOR_TARGET, everything else
# reads PKG_CONFIG_PATH; set both so one script serves both worlds.
if [ "$mode" = "github" ]; then
    {
        echo "PKG_CONFIG_PATH=$COMPAT_DIR/pkgconfig:${PKG_CONFIG_PATH:-}"
        echo "PKG_CONFIG_PATH_FOR_TARGET=$COMPAT_DIR/pkgconfig:${PKG_CONFIG_PATH_FOR_TARGET:-}"
        echo "CGO_LDFLAGS=-L$COMPAT_DIR/lib ${CGO_LDFLAGS:-}"
        echo "CGO_ENABLED=1"
    } >> "${GITHUB_ENV:?--github-env needs GITHUB_ENV set}"
    echo "webkit-compat: wrote webkit2gtk-4.0 shim settings to GITHUB_ENV" >&2
else
    echo "export PKG_CONFIG_PATH=\"$COMPAT_DIR/pkgconfig:\${PKG_CONFIG_PATH:-}\""
    echo "export PKG_CONFIG_PATH_FOR_TARGET=\"$COMPAT_DIR/pkgconfig:\${PKG_CONFIG_PATH_FOR_TARGET:-}\""
    echo "export CGO_LDFLAGS=\"-L$COMPAT_DIR/lib \${CGO_LDFLAGS:-}\""
    echo "export CGO_ENABLED=1"
fi

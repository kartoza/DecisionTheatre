#!/usr/bin/env bash
set -euo pipefail

# Release script for Decision Theatre
# Builds reproducible packages using Nix and creates release artifacts
#
# Usage:
#   ./scripts/release.sh [--version VERSION] [--push]
#
# Produces dist/ artefacts:
#   - decision-theatre-linux-amd64-v{VERSION}.tar.gz
#   - decision-theatre-v{VERSION}.deb
#   - decision-theatre-v{VERSION}.rpm
#   - checksums-v{VERSION}.sha256

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION=""
PUSH=false

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --push)    PUSH=true;    shift ;;
        *)         echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

# Get version from flake.nix if not specified
if [ -z "$VERSION" ]; then
    VERSION=$(grep 'version = "' "$PROJECT_ROOT/flake.nix" | head -1 | sed 's/.*version = "\([^"]*\)".*/\1/')
fi

if [ -z "$VERSION" ]; then
    echo "ERROR: Could not determine version" >&2
    exit 1
fi

DIST_DIR="$PROJECT_ROOT/dist"
BINARY_NAME="decision-theatre"

echo "========================================"
echo "Building Decision Theatre v$VERSION"
echo "========================================"
echo ""

mkdir -p "$DIST_DIR"

# -------------------------------------------------------
# Build with Nix (reproducible, handles webkit compat)
# -------------------------------------------------------
echo "==> Building with Nix..."
nix build "$PROJECT_ROOT#decision-theatre" -o "$DIST_DIR/nix-result"

if [ ! -f "$DIST_DIR/nix-result/bin/$BINARY_NAME" ]; then
    echo "ERROR: Nix build failed - binary not found" >&2
    exit 1
fi

echo "  -> Build successful"
echo ""

# -------------------------------------------------------
# Create tar.gz archive
# -------------------------------------------------------
echo "==> Creating tar.gz archive..."
TARBALL="${BINARY_NAME}-linux-amd64-v${VERSION}.tar.gz"

# Clean up any old files with same name
rm -f "$DIST_DIR/$BINARY_NAME" "$DIST_DIR/$TARBALL"

# Copy the wrapped binary (the actual executable, not the wrapper script)
# Nix uses wrapGAppsHook which creates a wrapper script and .decision-theatre-wrapped
if [ -f "$DIST_DIR/nix-result/bin/.${BINARY_NAME}-wrapped" ]; then
    cp -L "$DIST_DIR/nix-result/bin/.${BINARY_NAME}-wrapped" "$DIST_DIR/$BINARY_NAME"
else
    cp -L "$DIST_DIR/nix-result/bin/$BINARY_NAME" "$DIST_DIR/"
fi

tar -czf "$DIST_DIR/$TARBALL" -C "$DIST_DIR" "$BINARY_NAME"
TARBALL_SIZE=$(du -h "$DIST_DIR/$TARBALL" | cut -f1)
echo "  -> $DIST_DIR/$TARBALL ($TARBALL_SIZE)"

# -------------------------------------------------------
# Build .deb and .rpm with nfpm
# -------------------------------------------------------
if command -v nfpm &>/dev/null; then
    echo "==> Building .deb and .rpm packages..."

    # Export version for nfpm
    export VERSION
    export GOARCH="amd64"

    (cd "$PROJECT_ROOT" && nfpm package -f packaging/nfpm.yaml --packager deb --target "$DIST_DIR/")
    (cd "$PROJECT_ROOT" && nfpm package -f packaging/nfpm.yaml --packager rpm --target "$DIST_DIR/")

    echo "  -> .deb and .rpm created"
else
    echo "  (nfpm not found - skipping .deb/.rpm)"
fi

# -------------------------------------------------------
# Generate checksums
# -------------------------------------------------------
echo "==> Generating checksums..."
(cd "$DIST_DIR" && sha256sum *.tar.gz *.deb *.rpm 2>/dev/null > "checksums-v${VERSION}.sha256" || true)
echo "  -> $DIST_DIR/checksums-v${VERSION}.sha256"

# Cleanup
rm -f "$DIST_DIR/$BINARY_NAME"

echo ""
echo "========================================"
echo "Release artifacts in $DIST_DIR:"
echo "========================================"
ls -lh "$DIST_DIR/"*v${VERSION}* 2>/dev/null || echo "  (none)"
echo ""

# -------------------------------------------------------
# Create GitHub release (if --push)
# -------------------------------------------------------
if [ "$PUSH" = true ]; then
    echo "==> Creating GitHub release..."

    # Check for uncommitted changes
    if [ -n "$(git status --porcelain)" ]; then
        echo "WARNING: Uncommitted changes detected. Commit first?" >&2
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi

    # Create and push tag
    if ! git rev-parse "v$VERSION" >/dev/null 2>&1; then
        git tag -a "v$VERSION" -m "Release v$VERSION"
        git push origin "v$VERSION"
    else
        echo "  Tag v$VERSION already exists"
    fi

    # Create GitHub release
    if command -v gh &>/dev/null; then
        gh release create "v$VERSION" \
            "$DIST_DIR/$TARBALL" \
            "$DIST_DIR"/*.deb \
            "$DIST_DIR"/*.rpm \
            "$DIST_DIR/checksums-v${VERSION}.sha256" \
            --title "v$VERSION" \
            --notes "Release v$VERSION

## Downloads
- **Linux (tar.gz)**: decision-theatre-linux-amd64-v${VERSION}.tar.gz
- **Debian/Ubuntu (.deb)**: decision-theatre_${VERSION}_amd64.deb
- **Fedora/RHEL (.rpm)**: decision-theatre-${VERSION}.x86_64.rpm

## Checksums
See checksums-v${VERSION}.sha256 for SHA256 verification."

        echo ""
        echo "Release created: https://github.com/kartoza/DecisionTheatre/releases/tag/v$VERSION"
    else
        echo "  (gh CLI not found - manual release required)"
        echo ""
        echo "To create release manually:"
        echo "  gh release create v$VERSION $DIST_DIR/*v${VERSION}* --title 'v$VERSION'"
    fi
else
    echo "To create a GitHub release, run:"
    echo "  git tag -a v$VERSION -m 'Release v$VERSION'"
    echo "  git push origin v$VERSION"
    echo "  gh release create v$VERSION $DIST_DIR/*v${VERSION}* --title 'v$VERSION'"
fi

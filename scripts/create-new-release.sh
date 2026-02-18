#!/usr/bin/env bash
set -euo pipefail

# Release script for Decision Theatre
# Builds native Linux packages and creates release artifacts
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

# Get version from git tags or VERSION file
if [ -z "$VERSION" ]; then
    if [ -f "$PROJECT_ROOT/VERSION" ]; then
        VERSION=$(cat "$PROJECT_ROOT/VERSION")
    else
        VERSION=$(git -C "$PROJECT_ROOT" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo "0.0.1")
    fi
fi

if [ -z "$VERSION" ]; then
    echo "ERROR: Could not determine version" >&2
    exit 1
fi

DIST_DIR="$PROJECT_ROOT/dist"
BINARY_NAME="decision-theatre"

# Detect host OS
UNAME_OUT="$(uname -s 2>/dev/null || echo "")"
IS_WINDOWS=false

case "$UNAME_OUT" in
    MINGW*|MSYS*|CYGWIN*)
        IS_WINDOWS=true
        ;;
esac

if [[ "${OS:-}" == "Windows_NT" ]]; then
    IS_WINDOWS=true
fi

if [ "$IS_WINDOWS" = true ]; then
    echo "Detected Windows host. Running Windows installer build..."
    bash "$PROJECT_ROOT/scripts/build-windows-installer.sh"
    echo "Windows installer build finished"
    exit 0
fi

echo "========================================"
echo "Building Decision Theatre v$VERSION"
echo "========================================"
echo ""

mkdir -p "$DIST_DIR"

# -------------------------------------------------------
# Build with native Go
# -------------------------------------------------------
echo "==> Building with Go..."

if ! command -v go &>/dev/null; then
    echo "ERROR: Go is not installed" >&2
    exit 1
fi

GOOS=linux GOARCH=amd64 CGO_ENABLED=1 go build \
    -o "$DIST_DIR/$BINARY_NAME" \
    -ldflags="-X 'main.Version=$VERSION' -X 'main.BuildTime=$(date -u +'%Y-%m-%dT%H:%M:%SZ')'" \
    "$PROJECT_ROOT/main.go"

if [ ! -f "$DIST_DIR/$BINARY_NAME" ]; then
    echo "ERROR: Go build failed - binary not found" >&2
    exit 1
fi

chmod +x "$DIST_DIR/$BINARY_NAME"
echo "  -> Build successful"
echo ""

# -------------------------------------------------------
# Create tar.gz archive
# -------------------------------------------------------
echo "==> Creating tar.gz archive..."
TARBALL="${BINARY_NAME}-linux-amd64-v${VERSION}.tar.gz"

# Clean up any old files with same name
rm -f "$DIST_DIR/$TARBALL"

tar -czf "$DIST_DIR/$TARBALL" -C "$DIST_DIR" "$BINARY_NAME"
TARBALL_SIZE=$(du -h "$DIST_DIR/$TARBALL" | cut -f1)
echo "  -> $DIST_DIR/$TARBALL ($TARBALL_SIZE)"

# -------------------------------------------------------
# Build .deb installer
# -------------------------------------------------------
echo "==> Building Debian installer..."
bash "$PROJECT_ROOT/scripts/build-debian-installer.sh"
echo "  -> Debian installer build finished"

# -------------------------------------------------------
# Generate checksums
# -------------------------------------------------------
echo "==> Generating checksums..."
(cd "$DIST_DIR" && sha256sum *.tar.gz *.deb *.rpm 2>/dev/null > "checksums-v${VERSION}.sha256" || true)
echo "  -> $DIST_DIR/checksums-v${VERSION}.sha256"

# -------------------------------------------------------
# Cleanup temporary binary from dist
# -------------------------------------------------------
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

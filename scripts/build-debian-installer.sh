#!/usr/bin/env bash
set -euo pipefail

# Build a Debian desktop package (.deb) for Decision Theatre.
# The package bundles the runtime shared libraries required by the binary,
# so it can run on systems without manually installing WebKitGTK and friends.
# Usage:
#   ./scripts/build-desktop-app.sh [--skip-frontend] [--skip-docs] [--version VERSION] [--arch amd64|arm64]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SKIP_FRONTEND=0
SKIP_DOCS=0
VERSION=""
ARCH=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-frontend) SKIP_FRONTEND=1; shift ;;
        --skip-docs)     SKIP_DOCS=1; shift ;;
        --version)       VERSION="$2"; shift 2 ;;
        --arch)          ARCH="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 [--skip-frontend] [--skip-docs] [--version VERSION] [--arch amd64|arm64]"
            exit 0
            ;;
        *)
            echo "Unknown arg: $1" >&2
            exit 1
            ;;
    esac
done

cd "$PROJECT_ROOT"

require_cmd() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: required command not found: $cmd" >&2
        exit 1
    fi
}

sanitize_deb_version() {
    local raw="$1"
    # Debian version must be [0-9A-Za-z.+:~\-]
    raw="${raw#v}"
    raw="$(echo "$raw" | sed 's/[^0-9A-Za-z.+:~-]/./g')"
    [ -n "$raw" ] || raw="0.0.0"
    printf "%s" "$raw"
}

resolve_deb_arch() {
    local requested="${1:-}"
    if [ -n "$requested" ]; then
        case "$requested" in
            amd64|arm64) printf "%s" "$requested" ;;
            *)
                echo "Error: unsupported arch '$requested' (use amd64 or arm64)" >&2
                exit 1
                ;;
        esac
        return 0
    fi

    if command -v dpkg >/dev/null 2>&1; then
        dpkg --print-architecture
        return 0
    fi

    case "$(go env GOARCH)" in
        amd64) echo "amd64" ;;
        arm64) echo "arm64" ;;
        *)
            echo "Error: could not determine Debian architecture" >&2
            exit 1
            ;;
    esac
}

copy_runtime_deps() {
    local binary="$1"
    local lib_dest="$2"

    mkdir -p "$lib_dest"

    local queue_file
    queue_file="$(mktemp)"
    local seen_file
    seen_file="$(mktemp)"

    echo "$binary" > "$queue_file"

    while IFS= read -r current; do
        [ -n "$current" ] || continue

        local deps
        deps="$(ldd "$current" | awk '
            /=>/ && $(NF-1) ~ /^\// { print $(NF-1) }
            /^[[:space:]]*\// { print $1 }
        ' | sort -u)"

        while IFS= read -r dep; do
            [ -n "$dep" ] || continue
            [ -f "$dep" ] || continue

            if grep -Fxq "$dep" "$seen_file"; then
                continue
            fi

            echo "$dep" >> "$seen_file"

            local dep_name
            dep_name="$(basename "$dep")"
            cp -L "$dep" "$lib_dest/$dep_name"

            # Queue newly copied shared objects for transitive dependency scan.
            case "$dep_name" in
                *.so|*.so.*)
                    echo "$lib_dest/$dep_name" >> "$queue_file"
                    ;;
            esac
        done <<< "$deps"
    done < "$queue_file"

    rm -f "$queue_file" "$seen_file"
}

copy_absolute_path_into_pkg() {
    local src_path="$1"
    local pkg_root="$2"

    [ -e "$src_path" ] || return 0

    local target_parent
    target_parent="$pkg_root$(dirname "$src_path")"
    mkdir -p "$target_parent"
    cp -a "$src_path" "$target_parent/"
}

bundle_webkit_runtime_assets() {
    local binary="$1"
    local pkg_root="$2"

    local webkit_libs
    webkit_libs="$(ldd "$binary" | awk '
        /libwebkit2gtk-[0-9]+\.[0-9]+\.so/ && $(NF-1) ~ /^\// { print $(NF-1) }
    ' | sort -u)"

    [ -n "$webkit_libs" ] || return 0

    while IFS= read -r lib; do
        [ -n "$lib" ] || continue
        [ -f "$lib" ] || continue

        local lib_dir
        lib_dir="$(dirname "$lib")"

        # Debian/Ubuntu layout
        if [ -d "$lib_dir/webkit2gtk-4.0" ]; then
            copy_absolute_path_into_pkg "$lib_dir/webkit2gtk-4.0" "$pkg_root"
        fi
        if [ -d "$lib_dir/webkit2gtk-4.1" ]; then
            copy_absolute_path_into_pkg "$lib_dir/webkit2gtk-4.1" "$pkg_root"
        fi

        # Some distros package helper processes under libexec.
        local prefix
        prefix="$(dirname "$lib_dir")"
        if [ -d "$prefix/libexec/webkit2gtk-4.0" ]; then
            copy_absolute_path_into_pkg "$prefix/libexec/webkit2gtk-4.0" "$pkg_root"
        fi
        if [ -d "$prefix/libexec/webkit2gtk-4.1" ]; then
            copy_absolute_path_into_pkg "$prefix/libexec/webkit2gtk-4.1" "$pkg_root"
        fi
    done <<< "$webkit_libs"
}

require_cmd go
require_cmd make
require_cmd dpkg-deb
require_cmd ldd

# Prevent host-machine absolute source paths from being embedded in the binary
# (e.g. in panic stack traces). Keep any existing GOFLAGS and append -trimpath.
if [[ " ${GOFLAGS:-} " != *" -trimpath "* ]]; then
    export GOFLAGS="${GOFLAGS:-} -trimpath"
fi

if [ "$SKIP_FRONTEND" -eq 0 ]; then
    echo "==> Building frontend..."
    make -C "$PROJECT_ROOT" build-frontend
fi

if [ "$SKIP_DOCS" -eq 0 ]; then
    echo "==> Building docs..."
    make -C "$PROJECT_ROOT" build-docs
fi

echo "==> Building desktop binary..."
"$PROJECT_ROOT/scripts/build-app.sh"

RAW_VERSION="${VERSION:-$(git -C "$PROJECT_ROOT" describe --tags --always --dirty 2>/dev/null || echo "dev")}" 
DEB_VERSION="$(sanitize_deb_version "$RAW_VERSION")"
DEB_ARCH="$(resolve_deb_arch "$ARCH")"

DIST_DIR="$PROJECT_ROOT/dist"
PKG_DIR="$DIST_DIR/deb-package"
PKG_ROOT="$PKG_DIR/root"
DEBIAN_DIR="$PKG_ROOT/DEBIAN"
APP_DIR="$PKG_ROOT/opt/decision-theatre"
APP_BIN_DIR="$APP_DIR/bin"
APP_LIB_DIR="$APP_DIR/lib"
APP_DATA_DIR="$APP_DIR/data"
USR_BIN_DIR="$PKG_ROOT/usr/bin"
DESKTOP_DIR="$PKG_ROOT/usr/share/applications"

mkdir -p "$DIST_DIR"
rm -rf "$PKG_DIR"
mkdir -p "$DEBIAN_DIR" "$APP_BIN_DIR" "$APP_LIB_DIR" "$APP_DATA_DIR" "$USR_BIN_DIR" "$DESKTOP_DIR"

echo "==> Bundling runtime dependencies..."
cp "$PROJECT_ROOT/bin/decision-theatre" "$APP_BIN_DIR/decision-theatre.real"
chmod 0755 "$APP_BIN_DIR/decision-theatre.real"

copy_runtime_deps "$APP_BIN_DIR/decision-theatre.real" "$APP_LIB_DIR"
bundle_webkit_runtime_assets "$APP_BIN_DIR/decision-theatre.real" "$PKG_ROOT"

if [ -d "$PROJECT_ROOT/data" ]; then
    echo "==> Creating empty data directory structure..."
    # Keep only directory tree; do not ship data files.
    while IFS= read -r src_dir; do
        rel_dir="${src_dir#"$PROJECT_ROOT/data"}"
        mkdir -p "$APP_DATA_DIR$rel_dir"
    done < <(find "$PROJECT_ROOT/data" -type d | sort)
fi

cat > "$USR_BIN_DIR/decision-theatre" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="/opt/decision-theatre"
export LD_LIBRARY_PATH="$APP_ROOT/lib:${LD_LIBRARY_PATH:-}"

HAS_DATA_DIR_ARG=0
for arg in "$@"; do
    case "$arg" in
        --data-dir|--data-dir=*)
            HAS_DATA_DIR_ARG=1
            break
            ;;
    esac
done

if [ "$HAS_DATA_DIR_ARG" -eq 0 ] && [ -d "$APP_ROOT/data" ]; then
    exec "$APP_ROOT/bin/decision-theatre.real" --data-dir "$APP_ROOT/data" "$@"
fi

exec "$APP_ROOT/bin/decision-theatre.real" "$@"
EOF
chmod 0755 "$USR_BIN_DIR/decision-theatre"

cp "$PROJECT_ROOT/packaging/decision-theatre.desktop" "$DESKTOP_DIR/decision-theatre.desktop"
chmod 0644 "$DESKTOP_DIR/decision-theatre.desktop"

cat > "$DEBIAN_DIR/control" <<EOF
Package: decision-theatre
Version: $DEB_VERSION
Section: science
Priority: optional
Architecture: $DEB_ARCH
Maintainer: Kartoza <info@kartoza.com>
Depends: libc6, libstdc++6, zlib1g
Description: Offline catchment data exploration with embedded AI
 Self-contained desktop package with bundled runtime libraries.
EOF

cat > "$DEBIAN_DIR/postinst" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
fi
exit 0
EOF
chmod 0755 "$DEBIAN_DIR/postinst"

cat > "$DEBIAN_DIR/postrm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
fi
exit 0
EOF
chmod 0755 "$DEBIAN_DIR/postrm"

DEB_FILE="$DIST_DIR/decision-theatre_${DEB_VERSION}_${DEB_ARCH}.deb"
echo "==> Building .deb package..."
dpkg-deb --build "$PKG_ROOT" "$DEB_FILE" >/dev/null

echo ""
echo "Desktop Debian package build complete: $DEB_FILE"

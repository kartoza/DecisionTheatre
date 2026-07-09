#!/usr/bin/env bash
set -euo pipefail

# Point the Decision Theatre downloads page at freshly built artefacts.
#
# The downloads page (frontend/src/components/DownloadPage.tsx) is served by
# reading internal/config.Settings from the local settings.json (the same
# file the desktop app writes to via config.SettingsDir()). This script
# updates that file so a locally-run app immediately offers the artefacts
# that were just built, without editing settings.json by hand.
#
# Usage:
#   ./scripts/update-download-config.sh [options]
#
# Options:
#   --executable-windows PATH
#   --executable-linux PATH
#   --executable-macos PATH
#   --datapack PATH
#
# Only the fields for flags actually passed are touched; everything else
# already in settings.json (e.g. data_pack_path from an installed data pack)
# is left as-is.

EXECUTABLE_WINDOWS=""
EXECUTABLE_LINUX=""
EXECUTABLE_MACOS=""
DATAPACK=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --executable-windows) EXECUTABLE_WINDOWS="$2"; shift 2 ;;
        --executable-linux)   EXECUTABLE_LINUX="$2"; shift 2 ;;
        --executable-macos)   EXECUTABLE_MACOS="$2"; shift 2 ;;
        --datapack)           DATAPACK="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 [--executable-windows PATH] [--executable-linux PATH] [--executable-macos PATH] [--datapack PATH]"
            exit 0
            ;;
        *)
            echo "Unknown arg: $1" >&2
            exit 1
            ;;
    esac
done

if [ -z "$EXECUTABLE_WINDOWS$EXECUTABLE_LINUX$EXECUTABLE_MACOS$DATAPACK" ]; then
    echo "Nothing to update (no paths given)." >&2
    exit 0
fi

# jq is used to merge fields into settings.json without clobbering unrelated
# keys. This is a convenience step, not a core part of packaging, so a
# missing jq should not fail the surrounding build script; we try to install
# it first and only fall back to skipping if that is not possible.
install_jq() {
    local sudo_cmd=""
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
        sudo_cmd="sudo"
    fi

    echo "jq not found; attempting to install it..." >&2
    case "$(uname -s)" in
        Darwin)
            command -v brew >/dev/null 2>&1 && brew install jq
            ;;
        *)
            if command -v apt-get >/dev/null 2>&1; then
                $sudo_cmd apt-get update -qq && $sudo_cmd apt-get install -y jq
            elif command -v dnf >/dev/null 2>&1; then
                $sudo_cmd dnf install -y jq
            elif command -v yum >/dev/null 2>&1; then
                $sudo_cmd yum install -y jq
            elif command -v pacman >/dev/null 2>&1; then
                $sudo_cmd pacman -Sy --noconfirm jq
            elif command -v apk >/dev/null 2>&1; then
                $sudo_cmd apk add jq
            fi
            ;;
    esac
}

if ! command -v jq >/dev/null 2>&1; then
    install_jq || true
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "WARNING: could not install jq; skipping downloads-page config update." >&2
    echo "  Install manually: sudo apt install jq (Debian/Ubuntu) or brew install jq (macOS)." >&2
    exit 0
fi

# Mirrors internal/config.SettingsDir(): os.UserConfigDir()/decision-theatre.
case "$(uname -s)" in
    Darwin)
        CONFIG_DIR="$HOME/Library/Application Support"
        ;;
    *)
        CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
        ;;
esac
SETTINGS_DIR="$CONFIG_DIR/decision-theatre"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"

mkdir -p "$SETTINGS_DIR"
[ -f "$SETTINGS_FILE" ] || echo '{}' > "$SETTINGS_FILE"

to_abs_path() {
    local path="$1"
    (cd "$(dirname "$path")" && printf '%s/%s' "$(pwd)" "$(basename "$path")")
}

JQ_ARGS=()
JQ_FILTER="."

add_field() {
    local field="$1"
    local value="$2"
    [ -z "$value" ] && return 0
    if [ ! -f "$value" ]; then
        echo "WARNING: $value does not exist; skipping $field." >&2
        return 0
    fi
    local abs
    abs="$(to_abs_path "$value")"
    JQ_ARGS+=(--arg "$field" "$abs")
    JQ_FILTER="$JQ_FILTER | .${field} = \$${field}"
}

add_field "executable_windows" "$EXECUTABLE_WINDOWS"
add_field "executable_linux" "$EXECUTABLE_LINUX"
add_field "executable_macos" "$EXECUTABLE_MACOS"
add_field "data_pack_download_path" "$DATAPACK"

if [ "${#JQ_ARGS[@]}" -eq 0 ]; then
    echo "Nothing valid to update." >&2
    exit 0
fi

TMP_FILE="$(mktemp)"
jq "${JQ_ARGS[@]}" "$JQ_FILTER" "$SETTINGS_FILE" > "$TMP_FILE"
mv "$TMP_FILE" "$SETTINGS_FILE"

echo "Updated downloads config: $SETTINGS_FILE"
jq -r '
  to_entries
  | map(select(.key | test("^(executable_|data_pack_download_path)")))
  | map("  \(.key) = \(.value)")
  | .[]
' "$SETTINGS_FILE"

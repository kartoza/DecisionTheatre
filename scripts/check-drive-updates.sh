#!/usr/bin/env bash
#
# check-drive-updates.sh — Check whether a Google Drive folder has any
# files that are new or differ from a local data directory.
#
# Usage:
#   ./scripts/check-drive-updates.sh <folder-id-or-url> [data-dir]
#
# Exit status:
#   0  No changes — every file in the Drive folder matches the local copy.
#   1  Changes found (or the comparison could not be completed) — treat
#      as "an update may be needed" so callers err on the side of fetching.
#
# Comparison is one-way (source -> destination): local files that do not
# exist in the Drive folder (e.g. generated datapack.gpkg, mbtiles) are
# ignored, since they are not part of the source data set.
#
# Requirements:
#   rclone, configured the same way as scripts/fetch-data.sh (see that
#   script for the one-time "gdrive" remote setup).
#
# Examples:
#   ./scripts/check-drive-updates.sh 1ABCdef_ghiJKLmnopQRSTuvwXYZ
#   ./scripts/check-drive-updates.sh "https://drive.google.com/drive/folders/1ABCdef_ghiJKLmnopQRSTuvwXYZ"
#

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
RESET='\033[0m'

info()    { echo -e "${GREEN}[INFO]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()     { error "$*"; exit 1; }

# ── Argument parsing ──────────────────────────────────────────────────────────

usage() {
    sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
}

[[ $# -lt 1 ]] && usage

FOLDER_ARG="$1"

# Resolve the repository root (one level above scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DATA_DIR="${2:-$REPO_ROOT/data}"

# ── Extract folder ID from URL or bare ID ─────────────────────────────────────

extract_folder_id() {
    local input="$1"
    if [[ "$input" =~ /folders/([a-zA-Z0-9_-]+) ]]; then
        echo "${BASH_REMATCH[1]}"
        return
    fi
    if [[ "$input" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo "$input"
        return
    fi
    die "Cannot parse a Google Drive folder ID from: $input"
}

FOLDER_ID="$(extract_folder_id "$FOLDER_ARG")"

# ── Pre-flight checks ─────────────────────────────────────────────────────────

if ! command -v rclone &>/dev/null; then
    die "rclone is not installed. See scripts/fetch-data.sh for setup instructions."
fi

RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive}"

if ! rclone listremotes 2>/dev/null | grep -q "^${RCLONE_REMOTE}:"; then
    die "No rclone remote named '${RCLONE_REMOTE}' found. See scripts/fetch-data.sh for setup instructions."
fi

mkdir -p "$DATA_DIR"

# ── Compare ────────────────────────────────────────────────────────────────────

info "Comparing Google Drive folder ${BOLD}${FOLDER_ID}${RESET} against ${BOLD}${DATA_DIR}${RESET}..."

# --one-way: only flag files that are new or changed on the Drive side.
# Local-only files (generated outputs like datapack.gpkg, mbtiles) are not
# part of the source data set and must not be treated as "drift".
if rclone check "${RCLONE_REMOTE}:" "$DATA_DIR" \
    --drive-root-folder-id "$FOLDER_ID" \
    --one-way \
    --bind 0.0.0.0; then
    info "No changes found."
    exit 0
fi

info "Changes found (or comparison failed) — treating as an update."
exit 1

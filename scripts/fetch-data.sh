#!/usr/bin/env bash
#
# fetch-data.sh — Download CSV data files from a Google Drive folder.
#
# Usage:
#   ./scripts/fetch-data.sh <folder-id-or-url> [data-dir]
#
# Arguments:
#   <folder-id-or-url>  Google Drive folder ID or shareable folder URL.
#                       Accepts a bare ID (1ABC...xyz) or a full URL
#                       (https://drive.google.com/drive/folders/1ABC...xyz).
#   [data-dir]          Destination directory. Defaults to ./data relative
#                       to the repository root.
#
# What it does:
#   Downloads every .csv file found directly in the given Drive folder into
#   <data-dir>. Existing files are overwritten only when the remote copy is
#   newer or has a different size (rclone --update behaviour).
#
# Requirements:
#   rclone — https://rclone.org/install/
#
#   rclone must have a remote called "gdrive" configured for Google Drive.
#   Run the one-time setup with:
#
#     rclone config
#
#   Choose "New remote", name it "gdrive", select "Google Drive" as the
#   storage type, and follow the OAuth prompts.
#   If the folder is shared with a service account, configure the remote
#   with --drive-service-account-file instead.
#
# Examples:
#   ./scripts/fetch-data.sh 1ABCdef_ghiJKLmnopQRSTuvwXYZ
#   ./scripts/fetch-data.sh "https://drive.google.com/drive/folders/1ABCdef_ghiJKLmnopQRSTuvwXYZ"
#   ./scripts/fetch-data.sh 1ABCdef_ghiJKLmnopQRSTuvwXYZ /path/to/custom/data
#

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

info()    { echo -e "${GREEN}[INFO]${RESET}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()     { error "$*"; exit 1; }

# ── Argument parsing ──────────────────────────────────────────────────────────

usage() {
    sed -n '3,34p' "$0" | sed 's/^# \{0,1\}//'
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
    # Handle full Google Drive URL:
    #   https://drive.google.com/drive/folders/<ID>
    #   https://drive.google.com/drive/u/0/folders/<ID>
    if [[ "$input" =~ /folders/([a-zA-Z0-9_-]+) ]]; then
        echo "${BASH_REMATCH[1]}"
        return
    fi
    # Bare ID — just alphanumeric plus _ and -
    if [[ "$input" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo "$input"
        return
    fi
    die "Cannot parse a Google Drive folder ID from: $input"
}

FOLDER_ID="$(extract_folder_id "$FOLDER_ARG")"

# ── Pre-flight checks ─────────────────────────────────────────────────────────

check_rclone() {
    if ! command -v rclone &>/dev/null; then
        error "rclone is not installed."
        echo
        echo -e "${BOLD}Install rclone:${RESET}"
        echo "  Linux/macOS:  curl https://rclone.org/install.sh | sudo bash"
        echo "  macOS (brew): brew install rclone"
        echo "  Windows:      https://rclone.org/downloads/"
        echo
        echo -e "${BOLD}Then configure a Google Drive remote named 'gdrive':${RESET}"
        echo "  rclone config"
        echo
        die "Install rclone and re-run this script."
    fi
}

RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive}"

check_remote() {
    if ! rclone listremotes 2>/dev/null | grep -q "^${RCLONE_REMOTE}:"; then
        error "No rclone remote named '${RCLONE_REMOTE}' found."
        echo
        echo "Configure one with:"
        echo "  rclone config"
        echo
        echo "Choose 'New remote', name it '${RCLONE_REMOTE}', select"
        echo "'Google Drive' as the storage type, and follow the OAuth prompts."
        echo
        echo "To use a different remote name, set the RCLONE_REMOTE environment"
        echo "variable before calling this script:"
        echo "  RCLONE_REMOTE=my-drive ./scripts/fetch-data.sh <folder-id>"
        echo
        die "Configure an rclone Google Drive remote and re-run."
    fi
}

# ── Download ──────────────────────────────────────────────────────────────────

download_csvs() {
    mkdir -p "$DATA_DIR"

    info "Fetching CSV files from Google Drive folder: ${BOLD}${FOLDER_ID}${RESET}"
    info "Destination: ${BOLD}${DATA_DIR}${RESET}"
    echo

    # Build the rclone source path.
    # --drive-root-folder-id pins rclone to the specific folder regardless of
    # where it lives in the Drive hierarchy, so no folder path is needed.
    local src="${RCLONE_REMOTE}:"

    rclone copy "$src" "$DATA_DIR" \
        --drive-root-folder-id "$FOLDER_ID" \
        --include "*.csv" \
        --no-traverse \
        --progress \
        --stats-one-line \
        --update \
        --transfers 4 \
        --checkers 8 \
        --retries 3 \
        --low-level-retries 10 \
        --timeout 5m

    echo
}

# ── Summary ───────────────────────────────────────────────────────────────────

print_summary() {
    local csv_files
    csv_files=$(find "$DATA_DIR" -maxdepth 1 -name "*.csv" | sort)

    if [[ -z "$csv_files" ]]; then
        warn "No CSV files found in ${DATA_DIR} after download."
        return
    fi

    info "CSV files in ${DATA_DIR}:"
    echo
    printf "  %-40s  %s\n" "FILE" "SIZE"
    printf "  %-40s  %s\n" "----" "----"
    while IFS= read -r f; do
        local name size
        name=$(basename "$f")
        size=$(du -h "$f" | cut -f1)
        printf "  %-40s  %s\n" "$name" "$size"
    done <<< "$csv_files"
    echo
    info "Done. Run ${BOLD}make geopackage${RESET} to build datapack.gpkg."
}

# ── Main ──────────────────────────────────────────────────────────────────────

check_rclone
check_remote
download_csvs
print_summary

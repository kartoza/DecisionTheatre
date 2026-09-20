#!/usr/bin/env bash
#
# fetch-data.sh — Download all data files from a Google Drive folder.
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
#   Downloads all files from the given Drive folder (and any subfolders)
#   into <data-dir>, preserving the folder structure. Every file is
#   re-downloaded and overwritten unconditionally, without checking
#   whether the remote copy has changed. Build inputs the Drive folder
#   mixes in alongside shipped content (catchments.gpkg, the scenario
#   CSVs, R scripts/) are then moved into datasources/ so <data-dir>
#   ends up holding only what the data pack actually ships.
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
SOURCE_DIR="$REPO_ROOT/datasources"

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

    info "Fetching all files from Google Drive folder: ${BOLD}${FOLDER_ID}${RESET}"
    info "Destination: ${BOLD}${DATA_DIR}${RESET}"
    echo

    # Build the rclone source path.
    # --drive-root-folder-id pins rclone to the specific folder regardless of
    # where it lives in the Drive hierarchy, so no folder path is needed.
    # rclone copy is recursive by default, so subfolders are mirrored.
    local src="${RCLONE_REMOTE}:"

    # --bind 0.0.0.0 pins outgoing connections to IPv4. Some hosts (e.g. ones
    # with only a Tailscale IPv6 address and no real IPv6 default route)
    # resolve googleapis.com to an AAAA record and fail with "network is
    # unreachable" instead of falling back to IPv4.
    #
    # --exclude sites/**, images/**: these directories are owned by root
    # (created by a container running as root against the bind-mounted data
    # dir), so rclone's chtimes on them fails with "operation not permitted"
    # when run as a regular user. They are large and not needed by this
    # pipeline, so skip them entirely rather than fetch and then fail.
    rclone copy "$src" "$DATA_DIR" \
        --drive-root-folder-id "$FOLDER_ID" \
        --progress \
        --stats-one-line \
        --ignore-times \
        --transfers 4 \
        --checkers 8 \
        --retries 3 \
        --low-level-retries 10 \
        --timeout 5m \
        --exclude "sites/**" \
        --exclude "images/**" \
        --bind 0.0.0.0

    echo
}

# ── Sort build inputs out of the data pack ─────────────────────────────────────

# The Drive folder mirrors the old flat data/ layout, where build inputs and
# shipped content sat side by side. Route the build inputs it's likely to
# contain into datasources/ so a re-run of this script can't undo the
# data/ vs datasources/ separation. Anything not matched here (datapack.gpkg,
# metadata.csv, the lookup CSVs, mbtiles/, walkthroughs/, demo/) is shipped
# content and stays in DATA_DIR untouched.
sort_build_inputs() {
    local moved=false

    if [[ -f "$DATA_DIR/catchments.gpkg" ]]; then
        mkdir -p "$SOURCE_DIR/catchments"
        mv "$DATA_DIR/catchments.gpkg" "$SOURCE_DIR/catchments/catchments.gpkg"
        moved=true
    fi

    local f
    for f in current.csv current_lower.csv current_upper.csv \
             reference.csv reference_lower.csv reference_upper.csv; do
        if [[ -f "$DATA_DIR/$f" ]]; then
            mkdir -p "$SOURCE_DIR/scenarios"
            mv "$DATA_DIR/$f" "$SOURCE_DIR/scenarios/$f"
            moved=true
        fi
    done

    if [[ -d "$DATA_DIR/R scripts" ]]; then
        mkdir -p "$SOURCE_DIR/r-analysis"
        mv "$DATA_DIR/R scripts"/* "$SOURCE_DIR/r-analysis/" 2>/dev/null || true
        rmdir "$DATA_DIR/R scripts" 2>/dev/null || true
        moved=true
    fi

    [[ "$moved" == true ]] && info "Moved build inputs from ${DATA_DIR} into ${SOURCE_DIR}"
}

# ── Summary ───────────────────────────────────────────────────────────────────

print_summary() {
    local all_files
    all_files=$(find "$DATA_DIR" -type f | sort)

    if [[ -z "$all_files" ]]; then
        warn "No files found in ${DATA_DIR} after download."
        return
    fi

    info "Files in ${DATA_DIR}:"
    echo
    printf "  %-50s  %s\n" "FILE" "SIZE"
    printf "  %-50s  %s\n" "----" "----"
    while IFS= read -r f; do
        local rel size
        rel="${f#$DATA_DIR/}"
        size=$(du -h "$f" | cut -f1)
        printf "  %-50s  %s\n" "$rel" "$size"
    done <<< "$all_files"
    echo
    info "Done. Run ${BOLD}make geopackage${RESET} to build datapack.gpkg."
}

# ── Main ──────────────────────────────────────────────────────────────────────

check_rclone
check_remote
download_csvs
sort_build_inputs
print_summary

#!/usr/bin/env bash
#
# scheduled-redeploy.sh — Pull latest code, refresh data from Google Drive,
# rebuild the datapack and cross-platform installers.
#
# Usage:
#   ./scripts/scheduled-redeploy.sh
#
# Intended to be run unattended from cron (installed via `crontab -e`,
# runs daily at 02:00). Not intended for interactive use during
# development — it stops the running deployment stack for the duration
# of the fetch.
#
# What it does:
#   1. Pulls the latest commit on the current branch.
#   2. Rebuilds the docker compose images (to pick up any pulled code
#      changes). Runs every time, regardless of whether the Drive data
#      has changed.
#   3. Checks the configured Google Drive folder for changes.
#      - If nothing has changed: brings the stack up (picking up any
#        image rebuilt in step 2, a no-op otherwise) and stops here —
#        no data fetch or rebuild.
#      - If changes are found: continues to step 4.
#   4. Stops the deployments docker compose stack.
#   5. Fetches fresh CSV source data from the configured Google Drive folder.
#   6. Restarts the deployments docker compose stack.
#   7. Rebuilds the distributable datapack.
#   8. Rebuilds the cross-platform desktop installers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOYMENTS_DIR="$PROJECT_ROOT/deployments"

# Google Drive folder that holds the source CSV files for the datapack.
DRIVE_FOLDER="https://drive.google.com/drive/folders/1yVrQ_jQUooAD8wi9oCEA-Go52mrsH36f"

echo "=== Scheduled redeploy started at $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="

echo "==> Pulling latest changes..."
cd "$PROJECT_ROOT"
git stash
git pull

echo "==> Rebuilding docker compose images..."
cd "$DEPLOYMENTS_DIR"
docker compose build

echo "==> Checking Google Drive folder for updates..."
cd "$PROJECT_ROOT"
if ./scripts/check-drive-updates.sh "$DRIVE_FOLDER"; then
    echo "==> No data changes found — skipping data refresh and rebuild."

    # up -d is idempotent: it only (re)creates containers whose image or
    # config actually changed, so this safely picks up a code-only rebuild
    # from step 2 above without needing to fetch new data.
    echo "==> Starting deployments stack..."
    cd "$DEPLOYMENTS_DIR"
    docker compose up -d
    docker compose ps
    echo "==> Deployments stack started."

    echo "=== Scheduled redeploy finished at $(date -u +"%Y-%m-%dT%H:%M:%SZ") (no-op) ==="
    exit 0
fi

echo "==> Stopping deployments stack..."
cd "$DEPLOYMENTS_DIR"
docker compose down

echo "==> Fetching latest data from Google Drive..."
cd "$PROJECT_ROOT"
make fetch-data FOLDER="$DRIVE_FOLDER"

echo "==> Starting deployments stack..."
cd "$DEPLOYMENTS_DIR"
docker compose up -d
docker compose ps
echo "==> Deployments stack started."

echo "==> Building datapack..."
cd "$PROJECT_ROOT"
make datapack

echo "==> Building cross-platform installers..."
./scripts/build-cross-docker.sh

echo "=== Scheduled redeploy finished at $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="

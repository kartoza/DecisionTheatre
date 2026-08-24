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
#   2. Pulls the latest app image from GHCR and rebuilds the builder image
#      (used by steps 7-8) from the pulled code. Runs every time, regardless
#      of whether the Drive data has changed.
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
#
# Steps 7 and 8 run inside the `builder` service (deployments/Dockerfile.builder)
# rather than on this host directly — it carries the Go/Node/mkdocs toolchain
# `make pack-data` and build-cross-docker.sh need, so this host only needs
# Docker. Their output lands in the decision-theatre-dist volume, which the
# app service also mounts (read-only) to serve it — never baked into an image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOYMENTS_DIR="$PROJECT_ROOT/deployments"

# Google Drive folder that holds the source CSV files for the datapack.
DRIVE_FOLDER="https://drive.google.com/drive/folders/1yVrQ_jQUooAD8wi9oCEA-Go52mrsH36f"

# App image pulled from GHCR rather than built locally. Exported so every
# `docker compose` invocation below picks it up: compose only builds the
# image named by DT_IMAGE when it is absent locally, so pulling it here is
# enough to make `docker compose up -d` use it as-is.
# https://github.com/kartoza/DecisionTheatre/pkgs/container/decisiontheatre
export DT_IMAGE="${DT_IMAGE:-ghcr.io/kartoza/decisiontheatre:latest}"

# Runs a command inside the builder service (docker-compose.yaml, "build"
# profile), which carries the toolchain make pack-data and
# build-cross-docker.sh need. Removed after it exits; nothing built inside it
# is kept except what it writes to the decision-theatre-dist volume.
run_builder() {
    (cd "$DEPLOYMENTS_DIR" && docker compose --profile build run --rm builder "$@")
}

echo "=== Scheduled redeploy started at $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="

echo "==> Pulling latest changes..."
cd "$PROJECT_ROOT"
git pull

echo "==> Pulling latest app image ($DT_IMAGE)..."
docker pull "$DT_IMAGE"

echo "==> Rebuilding builder image..."
cd "$DEPLOYMENTS_DIR"
docker compose --profile build build builder

echo "==> Checking Google Drive folder for updates..."
cd "$PROJECT_ROOT"
if ./scripts/check-drive-updates.sh "$DRIVE_FOLDER"; then
    echo "==> No data changes found — skipping data refresh and rebuild."

    # up -d is idempotent: it only (re)creates containers whose image or
    # config actually changed, so this safely picks up the image pulled in
    # step 2 above without needing to fetch new data.
    echo "==> Starting deployments stack..."
    cd "$DEPLOYMENTS_DIR"
    docker compose up -d
    docker compose ps
    echo "==> Deployments stack started."

    echo "==> Building cross-platform installers..."
    run_builder ./scripts/build-cross-docker.sh

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

echo "==> Checking the data directory and building the datapack..."
# pack-data checks the data directory first and refuses to build a pack that the
# application could not load. That is deliberate for an unattended job: a failed
# redeploy is recoverable, a silently broken pack served to users is not. Add
# ARGS="--force" here only if you would rather ship a known-broken pack.
run_builder make pack-data

echo "==> Building cross-platform installers..."
run_builder ./scripts/build-cross-docker.sh

echo "=== Scheduled redeploy finished at $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="

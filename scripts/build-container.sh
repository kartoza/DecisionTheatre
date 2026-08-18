#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# build-container.sh — build the deployment container image from the flake.
#
# The image contents are the runtime closure of the binary `nix build` already
# produces, so there is no second dependency list to fall out of step with the
# first. The hand-maintained Dockerfile had exactly that problem: it installed
# WebKit 4.0 while the flake, CI and the Debian packaging all target 4.1.
#
#   ./scripts/build-container.sh            build and load into docker
#   ./scripts/build-container.sh --no-load  build only; leaves ./result
#
# The result is a tarball, not a running container. Loading it is what makes
# `docker run decision-theatre:<version>` work.
# =============================================================================

LOAD=1
for arg in "$@"; do
    case "$arg" in
        --no-load) LOAD=0 ;;
        -h | --help)
            # Derived from the rules rather than a hardcoded line range, which
            # silently truncates the moment the header grows — see the same note
            # in scripts/run-app.sh.
            awk '/^# ={10,}$/ { rules++; next } rules == 1' "${BASH_SOURCE[0]}" |
                sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 2
            ;;
    esac
done

if ! command -v nix > /dev/null 2>&1; then
    echo "Error: nix is not installed — this image is built from the flake." >&2
    echo "  See https://nixos.org/download, or use deployments/Dockerfile." >&2
    exit 1
fi

# The repository's other nix entry points pass these too: a user whose
# nix.conf does not enable the experimental features should not have to edit it
# to build the project.
NIX_FLAGS=(--extra-experimental-features 'nix-command flakes')

echo "==> Building the image from the flake (this builds the frontend, docs and binary)"
nix "${NIX_FLAGS[@]}" build .#container --print-build-logs

tag="$(nix "${NIX_FLAGS[@]}" eval --raw .#container.imageTag)"
name="$(nix "${NIX_FLAGS[@]}" eval --raw .#container.imageName)"

if [ "$LOAD" = "0" ]; then
    echo "==> Built: ./result  ($name:$tag)"
    echo "    Load it with: docker load < result"
    exit 0
fi

if ! command -v docker > /dev/null 2>&1; then
    echo "Error: docker is not installed, so the image cannot be loaded." >&2
    echo "  The image itself was built: ./result" >&2
    exit 1
fi

echo "==> Loading into docker"
docker load < result

echo
echo "==> $name:$tag"
echo "    Run it:      docker run --rm -p 8080:8080 $name:$tag"
echo "    Compose:     DT_IMAGE=$name:$tag docker compose -f deployments/docker-compose.yaml up"

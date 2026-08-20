#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Decision Theatre — single source of truth for launching the desktop app.
#
# Every launch path calls this script, so they cannot drift apart:
#
#   nix run           -> a wrapper sets DT_BIN to the store binary, then execs
#                        this script (build already done by nix; launch policy
#                        comes from here)
#   make run          -> this script, building locally only what is stale
#   neovim <leader>pr -> `make run`, i.e. the same path again
#   ./scripts/run-app.sh -> from any plain shell inside `nix develop`
#
# The application has two run modes, and this script is where the choice is
# made for every entry point:
#
#   desktop  the standalone GTK/WebKit application — the server runs in-process
#            and an embedded WebView window opens onto it. The default.
#   server   the same server with no window, for a browser to connect to at
#            http://127.0.0.1:<port>. Reaching it from another machine needs
#            DT_BIND — the default is loopback because the API is
#            unauthenticated.
#
# Environment knobs (all optional):
#   DT_MODE          desktop (default) or server.
#   DT_BIN           Launch this binary; skips every build step entirely.
#   DT_PORT          HTTP port (default: the app's own default, 8080).
#   DT_BIND          Interface to listen on (default: 127.0.0.1). The API is
#                    unauthenticated, so 0.0.0.0 exposes it to your whole
#                    network — set it only when something in front controls
#                    access. Server mode on another machine needs it.
#   DT_DATA_DIR      Passed as --data-dir. Unset lets the app resolve it from
#                    saved settings, then ./data, then the per-user directory.
#   DT_RESOURCES_DIR Passed as --resources-dir.
#   DT_SKIP_BUILD=1  Never build; fail if the binary is missing.
#   DT_FORCE_BUILD=1 Rebuild frontend, docs and binary unconditionally.
#   DT_HEADLESS=1    Deprecated spelling of DT_MODE=server.
#   DT_WEBVIEW_DIAG=1  Same as --diag.
#   DT_MAPTILER_API_KEY  Satellite basemap and font-glyph proxy key (see
#                    internal/config.MapTilerAPIKey). Read directly by the
#                    binary, not turned into a flag — a flag value is visible
#                    to anyone who can run `ps` on the machine, which a key
#                    should not be.
#
# Those knobs can also be set per-machine in a gitignored .dt-env file in the
# project root — see .dt-env.example. Machine-specific choices belong there, not
# in this script, so that every launch path keeps behaving identically.
#
# Any extra arguments are passed through to the binary verbatim and therefore
# win over the environment knobs above (Go's flag package takes the last value).
#   ./scripts/run-app.sh --port 9090
#
# Options:
#   --desktop   Force desktop mode (same as DT_MODE=desktop).
#   --server    Force server mode (same as DT_MODE=server).
#   --diag      Print what the desktop window resolved its layout to — the
#               viewport, the media queries, the fonts and the geometry of the
#               elements involved. For diagnosing faults that appear only in
#               the window, where a browser cannot reproduce them.
# =============================================================================

usage() {
    # Print the comment block between the two ==== rules above. The range is
    # derived rather than hardcoded: it was '4,45p', and adding four lines to the
    # header silently truncated --help so the Options section stopped appearing.
    awk '/^# ={10,}$/ { rules++; next } rules == 1' "${BASH_SOURCE[0]}" |
        sed 's/^# \{0,1\}//'
}

# The knobs that .dt-env is allowed to set.
DT_VARS=(
    DT_MODE
    DT_BIN
    DT_PORT
    DT_BIND
    DT_DATA_DIR
    DT_RESOURCES_DIR
    DT_HEADLESS
    DT_SKIP_BUILD
    DT_FORCE_BUILD
    DT_MAPTILER_API_KEY
)

# Load per-machine defaults from .dt-env. Anything already present in the
# environment wins, so `DT_PORT=9090 make run` still overrides the file.
load_local_env() {
    local env_file="$1"
    [ -f "$env_file" ] || return 0

    local name preset
    for name in "${DT_VARS[@]}"; do
        [ -n "${!name+x}" ] && eval "__dt_preset_$name=\${$name}"
    done

    echo "==> Loading local overrides from $env_file"
    # shellcheck source=/dev/null
    . "$env_file"

    for name in "${DT_VARS[@]}"; do
        preset="__dt_preset_$name"
        [ -n "${!preset+x}" ] && eval "$name=\${$preset}"
    done

    # The loop above ends on a false test whenever the last knob was not preset,
    # which would make this function return 1 and trip `set -e` at the call site.
    return 0
}

# --desktop/--server are this script's own options and must not reach the
# binary, which knows only --headless. Everything else passes straight through.
PASSTHROUGH=()
MODE_FROM_ARGS=""

while [ $# -gt 0 ]; do
    case "$1" in
        -h | --help)
            usage
            exit 0
            ;;
        --desktop)
            MODE_FROM_ARGS="desktop"
            ;;
        --server)
            MODE_FROM_ARGS="server"
            ;;
        --diag)
            # Ask the desktop window to report what it actually resolved to.
            # Only meaningful in desktop mode; the browser has developer tools.
            export DT_WEBVIEW_DIAG=1
            ;;
        *)
            PASSTHROUGH+=("$1")
            ;;
    esac
    shift
done

# Anchored on the invoking directory so `nix run` picks up the same file as
# `make run` when both are launched from the project root.
load_local_env "$PWD/.dt-env"

# ----------------------------------------------------------------------------
# Resolve the run mode, most explicit source first.
# ----------------------------------------------------------------------------

if [ -n "$MODE_FROM_ARGS" ]; then
    DT_MODE="$MODE_FROM_ARGS"
elif [ "${DT_HEADLESS:-}" = "1" ]; then
    # Kept working because .dt-env files, CI jobs and muscle memory still use it.
    DT_MODE="${DT_MODE:-server}"
fi

DT_MODE="${DT_MODE:-desktop}"

case "$DT_MODE" in
    desktop | server) ;;
    *)
        echo "Error: DT_MODE must be 'desktop' or 'server', got '$DT_MODE'" >&2
        exit 1
        ;;
esac

# -----------------------------------------------------------------------------
# Locate the binary to launch
#
# The staleness checks and build steps live in scripts/lib-build.sh, shared with
# check-data.sh and pack-data.sh, so "how do I get a current binary" has one
# answer for every tool in the project.
# -----------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${DT_BIN:-}" ]; then
    # Local build: run from the project root so relative paths resolve.
    cd "$SCRIPT_DIR/.."
fi

# shellcheck source=lib-build.sh
. "$SCRIPT_DIR/lib-build.sh"

dt_resolve_binary "$(cd "$SCRIPT_DIR/.." && pwd)" || exit 1
BIN="$DT_RESOLVED_BIN"

# -----------------------------------------------------------------------------
# Launch policy — identical for every entry point
# -----------------------------------------------------------------------------

ARGS=()

[ -n "${DT_PORT:-}" ] && ARGS+=(--port "$DT_PORT")
[ -n "${DT_BIND:-}" ] && ARGS+=(--bind "$DT_BIND")
[ -n "${DT_DATA_DIR:-}" ] && ARGS+=(--data-dir "$DT_DATA_DIR")
[ -n "${DT_RESOURCES_DIR:-}" ] && ARGS+=(--resources-dir "$DT_RESOURCES_DIR")
[ "$DT_MODE" = "server" ] && ARGS+=(--headless)

# Not a flag (see the comment on DT_MAPTILER_API_KEY above) — exported instead
# so the exec'd binary picks it up via os.Getenv. `. "$env_file"` above sets
# shell variables, not exported ones, so this is the step that actually makes
# a value from .dt-env reach the process; a value already in the real
# environment was exported by whatever set it and needs nothing here.
[ -n "${DT_MAPTILER_API_KEY:-}" ] && export DT_MAPTILER_API_KEY

# Caller arguments last so they override anything derived from the environment.
ARGS+=("${PASSTHROUGH[@]}")

if [ "$DT_MODE" = "server" ]; then
    echo "==> Launching Decision Theatre (server mode — connect with a browser)"
else
    echo "==> Launching Decision Theatre (desktop mode)"
fi

exec "$BIN" "${ARGS[@]}"

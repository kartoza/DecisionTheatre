#!/usr/bin/env bash
# =============================================================================
# Shared build logic. Sourced, not executed.
#
# Everything that needs a decision-theatre binary — run-app.sh, check-data.sh,
# pack-data.sh — gets it from here, so "is the binary stale, and how do I
# rebuild it" is answered in exactly one place.
#
# Provides:
#   dt_resolve_binary   Sets DT_RESOLVED_BIN to a usable binary, building the
#                       frontend, docs and Go binary only where stale.
#
# Honours DT_BIN (use this binary, never build), DT_SKIP_BUILD and
# DT_FORCE_BUILD; see run-app.sh for what each means.
# =============================================================================

# dt_is_stale TARGET SOURCE... -> true when TARGET is missing, or when any
# SOURCE is newer than it. Sources that do not exist are ignored so the checks
# stay valid on a partial checkout.
dt_is_stale() {
    local target="$1"
    shift

    [ "${DT_FORCE_BUILD:-}" = "1" ] && return 0
    [ -e "$target" ] || return 0

    local src
    for src in "$@"; do
        [ -e "$src" ] || continue
        if [ -n "$(find "$src" -newer "$target" -print -quit 2>/dev/null)" ]; then
            return 0
        fi
    done
    return 1
}

# dt_resolve_binary PROJECT_ROOT
#
# Sets DT_RESOLVED_BIN. Builds whatever is stale unless DT_BIN or
# DT_SKIP_BUILD says otherwise.
dt_resolve_binary() {
    local project_root="$1"

    if [ -n "${DT_BIN:-}" ]; then
        if [ ! -x "$DT_BIN" ]; then
            echo "Error: DT_BIN is not an executable: $DT_BIN" >&2
            return 1
        fi
        # shellcheck disable=SC2034  # this is the function's output, read by callers
        DT_RESOLVED_BIN="$DT_BIN"
        return 0
    fi

    local bin="$project_root/bin/decision-theatre"
    local frontend_dir="$project_root/frontend"
    local static_dir="$project_root/internal/server/static"
    local docs_site_dir="$project_root/internal/server/docs_site"

    if [ "${DT_SKIP_BUILD:-}" = "1" ]; then
        if [ ! -x "$bin" ]; then
            echo "Error: $bin not found and DT_SKIP_BUILD=1 is set." >&2
            echo "Run 'make app' first, or unset DT_SKIP_BUILD." >&2
            return 1
        fi
        # shellcheck disable=SC2034  # this is the function's output, read by callers
        DT_RESOLVED_BIN="$bin"
        return 0
    fi

    # The embedded assets are inputs to the Go build, so build them first and
    # let the binary check pick up the resulting change.
    if dt_is_stale "$static_dir/index.html" \
        "$frontend_dir/src" \
        "$frontend_dir/index.html" \
        "$frontend_dir/package.json" \
        "$frontend_dir/package-lock.json" \
        "$frontend_dir/vite.config.ts" \
        "$frontend_dir/tsconfig.json"; then

        # `npm ci` wipes and reinstalls node_modules, so only run it when the
        # lockfile has actually moved ahead of the installed tree.
        if dt_is_stale "$frontend_dir/node_modules/.package-lock.json" \
            "$frontend_dir/package-lock.json"; then
            echo "==> Installing frontend dependencies (npm ci)"
            (cd "$frontend_dir" && npm ci)
        fi

        echo "==> Building frontend"
        (cd "$frontend_dir" && npm run build)

        rm -rf "$static_dir"
        mkdir -p "$static_dir"
        cp -r "$frontend_dir/dist/." "$static_dir/"
    fi

    if dt_is_stale "$docs_site_dir/index.html" \
        "$project_root/docs" \
        "$project_root/mkdocs.yml"; then
        echo "==> Building documentation site"
        mkdocs build -d "$docs_site_dir"
    fi

    if dt_is_stale "$bin" \
        "$project_root/main.go" \
        "$project_root/subcommands.go" \
        "$project_root/internal" \
        "$project_root/go.mod" \
        "$project_root/go.sum"; then
        echo "==> Building decision-theatre"
        # build-app.sh owns the webkit2gtk-4.0 vs 4.1 compatibility shim, so
        # the binary is compiled identically here, by `make app`, and by the
        # packaging scripts.
        "$project_root/scripts/build-app.sh"
    fi

    # shellcheck disable=SC2034  # this is the function's output, read by callers
    DT_RESOLVED_BIN="$bin"
    return 0
}

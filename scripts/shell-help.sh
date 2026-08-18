#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# shell-help.sh — the command table for Decision Theatre.
#
# The single source of truth for "what can I type here". Rendered on entry to
# `nix develop`, by `dt` at any time, and by `make help`, so those three can
# never list different commands.
#
# Two views, because they answer different questions:
#
#   dt            an overview that fits on one screen — which groups exist and
#                 what is in each. What you want when orienting.
#   dt <group>    the detail for one group, a description per command. What you
#                 want when you know roughly where you are going.
#
# To add a command, add one line to COMMANDS below. Nothing else needs editing.
#
# SIGPIPE is left at its default disposition, so piping into `head` or `less`
# ends quietly rather than reporting a write error. The Makefile tolerates the
# resulting exit status; see its help target.
# =============================================================================

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Character counting — ${#var} and `wc -m` alike — only counts characters in a
# UTF-8 locale. LANG may name one that is not actually installed, and bash then
# silently falls back to counting bytes: the group icons are three bytes and one
# column, so every right-aligned field drifts by two per icon. Detect that and
# correct it, rather than trusting the environment.
if [ "$(printf '\u2744' | wc -m 2>/dev/null)" != "1" ]; then
    export LC_ALL=C.UTF-8
fi

# GROUP|COMMAND|DESCRIPTION. Groups appear in the order first mentioned.
COMMANDS=(
    "RUN|dt run|Desktop app in its own window — builds whatever is stale"
    "RUN|dt serve|Web server only; open http://localhost:8080 in a browser"
    "RUN|dt run --port 9090|Extra arguments are passed through to the binary"
    "RUN|nix run|Desktop app from a reproducible build"
    "RUN|nix run .#serve|Web server from a reproducible build"
    "RUN|<leader>pr / ps|The same two from inside neovim"

    "DEVELOP|dt dev-all|Go hot-reload + Vite HMR — open http://localhost:5173"
    "DEVELOP|dt dev-backend|Go backend only, auto-rebuilding on :8080"
    "DEVELOP|dt dev-frontend|Vite dev server only, HMR on :5173"

    "BUILD|dt app|Frontend, docs and binary — everything needed to run"
    "BUILD|dt build-frontend|Frontend only, into the embed directory"
    "BUILD|dt build-docs|Documentation site only, into the embed directory"
    "BUILD|dt clean|Remove build artifacts"
    "BUILD|nix build|Full reproducible build to ./result"
    "BUILD|dt container|Deployment container image, built from the flake"

    "TEST|dt test|Go tests with race detector and coverage"
    "TEST|dt test-frontend|Frontend tests (vitest)"
    "TEST|dt test-all|Both suites"
    "TEST|nix flake check|Every check, in a sandbox"

    "DIAGNOSE|dt run --diag|Report what the desktop window resolved its layout to"
    "DIAGNOSE|dt doctor|Is this checkout healthy? Reports; changes nothing"
    "DIAGNOSE|dt protect-branch|Require the CI checks before anything reaches main"
    "DIAGNOSE|dt doctor-deep|The same, plus recomputing the real nix hashes"
    "DIAGNOSE|dt check-data|Check ./data and summarise every file in it"
    "DIAGNOSE|dt lint|golangci-lint over the Go sources"
    "DIAGNOSE|dt fmt|gofmt the Go sources in place"
    "DIAGNOSE|dt check|fmt, then lint, then test"
    "DIAGNOSE|dt info|Versions of the binary and the toolchain"

    "FLAKE|dt check-flake|Is flake.nix in step with the manifests? Instant"
    "FLAKE|dt sync-flake|Recompute the nix hashes after changing a dependency"
    "FLAKE|dt verify-flake|Authoritative; recomputes the hashes for real"
    "FLAKE|dt hooks|Install the git hooks that enforce this on commit"
    "FLAKE|dt vendor-fonts|Refresh the committed typefaces from nixpkgs"

    "DATA|dt fetch-data FOLDER=..|Download source CSVs from a Google Drive folder"
    "DATA|dt geopackage|Build data/datapack.gpkg from the source CSVs"
    "DATA|dt pack-data|Check the data, then build a distributable .zip"
    "DATA|dt pack-data --force|Build the pack even when the check fails"
    "DATA|dt list-datapack|Contents and checksum of the last pack built"

    "DOCS|dt docs|Build the documentation site"
    "DOCS|dt docs-serve|Live-reloading preview on http://localhost:8000"

    "RELEASE|dt packages|Release packages for every platform buildable here"
    "RELEASE|dt packages-linux|Linux .tar.gz, .deb, .rpm"
    "RELEASE|dt packages-windows|Windows .zip and .msi"
    "RELEASE|dt release|Full release build, with the tagging instructions"
)

# An icon per group. These are plain Unicode symbols rather than emoji: emoji
# are double-width, and a terminal that renders them at a different width from
# the one lipgloss assumes tears the card grid apart. These are all single-width
# and present in any font with decent symbol coverage — including the snowflake,
# which is nix's own mark and belongs on the FLAKE card.
#
# Set DT_HELP_ICONS=0 if your font renders any of them as a missing glyph.
declare -A GROUP_ICON=(
    [RUN]="▶"
    [DEVELOP]="↻"
    [BUILD]="⚙"
    [TEST]="✓"
    [DIAGNOSE]="✚"
    [FLAKE]="❄"
    [DATA]="▦"
    [DOCS]="✎"
    [RELEASE]="↑"
)

# Yields "<icon> " or, when icons are off, nothing at all — so disabling them
# does not leave an empty column behind.
icon_for() {
    [ "${DT_HELP_ICONS:-1}" = "0" ] && return 0
    printf '%s ' "${GROUP_ICON[$1]:-•}"
}

# One line per group, shown beneath the group name.
declare -A GROUP_BLURB=(
    [RUN]="start the app"
    [DEVELOP]="hot reload"
    [BUILD]="make artefacts"
    [TEST]="prove it works"
    [DIAGNOSE]="what is wrong?"
    [FLAKE]="stay importable"
    [DATA]="the data pack"
    [DOCS]="the doc site"
    [RELEASE]="ship it"
)

# -----------------------------------------------------------------------------
# Presentation
# -----------------------------------------------------------------------------

if [ -t 1 ]; then
    B=$'\033[1m'
    D=$'\033[38;5;244m'
    C=$'\033[38;5;80m'
    G=$'\033[38;5;114m'
    Y=$'\033[38;5;180m'
    R=$'\033[0m'
else
    B='' D='' C='' G='' Y='' R=''
fi

width="${COLUMNS:-0}"
if [ "$width" -lt 40 ]; then
    width="$(tput cols 2>/dev/null || echo 80)"
fi
[ "$width" -lt 62 ] && width=62
[ "$width" -gt 100 ] && width=100

PAD="  "
INNER=$((width - 2))

rule() { printf '%s%s%s%s\n' "$PAD" "$D" "$(printf '─%.0s' $(seq 1 "$INNER"))" "$R"; }

groups_in_order() {
    local seen="" g entry
    for entry in "${COMMANDS[@]}"; do
        g="${entry%%|*}"
        case " $seen " in *" $g "*) continue ;; esac
        seen="$seen $g"
        printf '%s\n' "$g"
    done
}

commands_in_group() {
    local want="$1" entry rest
    for entry in "${COMMANDS[@]}"; do
        [ "${entry%%|*}" = "$want" ] || continue
        rest="${entry#*|}"
        printf '%s\n' "${rest%%|*}"
    done
}

# group_matches GROUP FILTER — case-insensitive substring; any word matches.
group_matches() {
    local g word
    g="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
    [ -z "$2" ] && return 0
    for word in $2; do
        case "$g" in *"$word"*) return 0 ;; esac
    done
    return 1
}



# -----------------------------------------------------------------------------
# Header metadata
#
# Cheap to gather — a grep and two git calls — because this runs on every shell
# entry. Nothing here may fail: a checkout without git, or a flake.nix that has
# moved on, degrades to a blank field rather than an error.
# -----------------------------------------------------------------------------

meta_version() {
    local v
    v="$(grep -oE '^ *version = "[^"]+";' "$PROJECT_ROOT/flake.nix" 2>/dev/null \
        | head -1 | sed -E 's/.*"(.*)".*/\1/')"
    [ -n "$v" ] && printf 'v%s' "$v"
}

meta_branch() {
    local b dirty
    b="$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)" || return 0
    [ -z "$b" ] && return 0
    # A trailing asterisk for a dirty tree, the way a shell prompt would.
    dirty=""
    [ -n "$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null | head -1)" ] && dirty="*"
    # Long branch names are the norm here; keep the header to one line.
    if [ "${#b}" -gt 28 ]; then
        b="${b:0:27}…"
    fi
    printf '%s%s' "$b" "$dirty"
}

# dwidth TEXT — printable columns, not bytes. ${#var} counts bytes, and the
# group icons and the ellipsis are multi-byte single-column glyphs, so every
# right-alignment in this file goes through here.
dwidth() {
    local s
    s="$(printf '%s' "$1" | sed $'s/\033\\[[0-9;]*m//g')"
    printf '%s' "${#s}"
}

# header_line LEFT RIGHT WIDTH LEFT_COLOUR RIGHT_COLOUR
#
# LEFT flush left, RIGHT flush right, within WIDTH columns. The gap is measured
# from the plain text and the colour applied afterwards: ANSI escapes are bytes,
# and ${#var} counts bytes, so styling first would throw the arithmetic out.
# lipgloss measures printable width, so the escapes are safe to hand to gum.
header_line() {
    local left="$1" right="$2" w="$3" lc="$4" rc="$5" gap
    gap=$((w - $(dwidth "$left") - $(dwidth "$right")))
    [ "$gap" -lt 1 ] && gap=1
    printf '%s%s%s%*s%s%s%s' "$lc" "$left" "$R" "$gap" "" "$rc" "$right" "$R"
}

# -----------------------------------------------------------------------------
# Overview, gum edition
#
# gum is in the development shell, so this is the normal path. Everything falls
# back to the plain renderer below when gum is absent — `make help` from outside
# the shell, and CI, both hit that.
# -----------------------------------------------------------------------------

have_gum() { command -v gum >/dev/null 2>&1 && [ -t 1 ]; }

# Cards are laid out in a grid. Three columns need a wide terminal; below that
# the layout steps down rather than squeezing text into unreadable slivers.
grid_columns() {
    if [ "$width" -ge 100 ]; then printf '3'
    elif [ "$width" -ge 68 ]; then printf '2'
    else printf '1'; fi
}

render_overview_gum() {
    local cols card_w
    cols="$(grid_columns)"
    # Each card carries a one-column margin either side, so a column of the
    # grid costs card_w + 2. Borders and padding take four more from the text.
    card_w=$(( INNER / cols - 2 ))
    local text_w=$((card_w - 4))

    # Build every card's wrapped body first, so a row's cards can be given a
    # common height and line up along the bottom.
    local -a titles=() bodies=() heights=()
    local g chips cmd short body h
    while IFS= read -r g; do
        chips=""
        while IFS= read -r cmd; do
            case "$cmd" in "dt "*) ;; *) continue ;; esac
            short="${cmd#dt }"
            case "$short" in *" "*) continue ;; esac
            chips="${chips}${chips:+ · }${short}"
        done < <(commands_in_group "$g")

        body="$(printf '%s\n' "$chips" | fold -s -w "$text_w")"
        h=$(( $(printf '%s\n' "$body" | wc -l) + 2 ))   # + title + blurb

        titles+=("$g")
        bodies+=("$body")
        heights+=("$h")
    done < <(groups_in_order)

    local i n row_max j card rowcards=() rows=() row
    n=${#titles[@]}
    i=0
    while [ "$i" -lt "$n" ]; do
        # Tallest card in this row wins, so the row is rectangular.
        row_max=0
        for ((j = i; j < i + cols && j < n; j++)); do
            [ "${heights[$j]}" -gt "$row_max" ] && row_max="${heights[$j]}"
        done

        rowcards=()
        for ((j = i; j < i + cols && j < n; j++)); do
            card="$(gum style --border rounded --border-foreground 238 \
                --width "$card_w" --height "$row_max" --padding "0 1" --margin "0 1" \
                "$(gum style --foreground 80 --bold "$(icon_for "${titles[$j]}") ${titles[$j]}")" \
                "$(gum style --foreground 114 "${bodies[$j]}")" \
                "$(gum style --foreground 244 --italic "${GROUP_BLURB[${titles[$j]}]:-}")")"
            rowcards+=("$card")
        done

        rows+=("$(gum join --horizontal --align top "${rowcards[@]}" | sed 's/^/ /')")

        i=$((i + cols))
    done

    # The header spans exactly what the grid turned out to be. Measured rather
    # than computed: card_w is an integer division, so the arithmetic drifts by
    # a column or two depending on how many columns fit.
    local grid_w=0 len
    for row in "${rows[@]}"; do
        len="$(printf '%s\n' "$row" | head -1 | sed $'s/\033\\[[0-9;]*m//g' | awk '{print length($0)}')"
        [ "${len:-0}" -gt "$grid_w" ] && grid_w="$len"
    done

    # gum's --width excludes the margin and the border, which together add five
    # columns to the rendered line. Subtracting them here makes the header end
    # exactly where the last card does, at every column count.
    local head_box=$((grid_w - 5))
    local head_text=$((head_box - 4))

    gum style --border rounded --border-foreground 238 --padding "0 2" --margin "1 2" \
        --width "$head_box" \
        "$(header_line "Decision Theatre" "$(meta_version)" "$head_text" "$B$C" "$Y")" \
        "$(header_line "development shell" "$(meta_branch)" "$head_text" "$D" "$D")"

    printf '%s\n' "${rows[@]}"

    gum style --margin "1 2" --foreground 244 \
        "$(printf 'dt %s for detail   ·   dt %s to run   ·   = make <task> = <leader>p' \
            "$(gum style --foreground 180 '<group>')" \
            "$(gum style --foreground 180 '<task>')")"
}

# -----------------------------------------------------------------------------
# Overview — the whole project on one screen (plain fallback)
# -----------------------------------------------------------------------------

render_overview() {
    # The icon is one display column plus a space. ${#var} counts bytes, and
    # these glyphs are multi-byte, so the width is stated rather than measured.
    local icon_w=2
    [ "${DT_HELP_ICONS:-1}" = "0" ] && icon_w=0

    # Longest group name is DIAGNOSE at eight, plus a two-column gap.
    local label_w=10
    local indent=$((icon_w + label_w))
    local chip_w=$((INNER - indent))

    printf '\n'
    printf '%s%sDecision Theatre%s %s· development shell%s\n' "$PAD" "$B$C" "$R" "$D" "$R"
    rule
    printf '\n'

    local g chips cmd short line first
    while IFS= read -r g; do
        chips=""
        while IFS= read -r cmd; do
            # Only dt tasks become chips; the nix and neovim spellings are
            # detail rather than orientation, and argument examples belong in
            # the detail view too.
            case "$cmd" in "dt "*) ;; *) continue ;; esac
            short="${cmd#dt }"
            case "$short" in *" "*) continue ;; esac
            chips="${chips}${chips:+ · }${short}"
        done < <(commands_in_group "$g")

        printf '%s%s%s%-*s%s' "$PAD" "$B$C" "$(icon_for "$g")" "$label_w" "$g" "$R"

        first=1
        while IFS= read -r line; do
            if [ "$first" -eq 1 ]; then
                printf '%s%s%s\n' "$G" "$line" "$R"
                first=0
            else
                printf '%s%*s%s%s%s\n' "$PAD" "$indent" "" "$G" "$line" "$R"
            fi
        done < <(printf '%s\n' "$chips" | fold -s -w "$chip_w")

        printf '%s%*s%s%s%s\n\n' "$PAD" "$indent" "" "$D" "${GROUP_BLURB[$g]:-}" "$R"
    done < <(groups_in_order)

    rule
    printf '%s%sdt %s<group>%s%s for detail   ·   %sdt <task>%s%s to run   ·   = make <task> = <leader>p%s\n' \
        "$PAD" "$D" "$R$Y" "$R" "$D" "$R$Y" "$R" "$D" "$R"
    printf '\n'
}


# -----------------------------------------------------------------------------
# Detail, gum edition
#
# The same visual language as the overview: rounded panels, the group's icon and
# colour, the blurb flush right. A different look here would make the two views
# feel like different programs.
# -----------------------------------------------------------------------------

render_detail_gum() {
    local filter="$1" matched=0
    local panel_w=$((INNER - 2))
    local text_w=$((panel_w - 2))

    # Widest command among the groups being shown, so every row lines up.
    local cmd_w=0 entry g cmd n
    for entry in "${COMMANDS[@]}"; do
        g="${entry%%|*}"
        group_matches "$g" "$filter" || continue
        cmd="${entry#*|}"
        cmd="${cmd%%|*}"
        n=${#cmd}
        [ "$n" -gt "$cmd_w" ] && cmd_w=$n
    done
    [ "$cmd_w" -gt 28 ] && cmd_w=28

    local desc_w=$((text_w - cmd_w - 2))
    [ "$desc_w" -lt 20 ] && desc_w=20

    local current="" desc lines=() first line
    local -a groups_shown=()

    flush_panel() {
        [ ${#lines[@]} -eq 0 ] && return 0
        gum style --border rounded --border-foreground 238 \
            --width "$panel_w" --padding "0 1" --margin "0 2" "${lines[@]}"
        lines=()
    }

    printf '\n'

    for entry in "${COMMANDS[@]}"; do
        g="${entry%%|*}"
        group_matches "$g" "$filter" || continue
        matched=1

        cmd="${entry#*|}"
        desc="${cmd#*|}"
        cmd="${cmd%%|*}"

        if [ "$g" != "$current" ]; then
            flush_panel
            [ -n "$current" ] && printf '\n'
            # The heading opens the group's own panel: icon and name left, blurb
            # right, then a rule. One box per group rather than two butted
            # together, which read as a single broken one.
            lines+=("$(header_line "$(icon_for "$g")$g" "${GROUP_BLURB[$g]:-}" "$text_w" "$B$C" "$D")")
            lines+=("$(printf '%s%s%s' "$D" "$(printf '─%.0s' $(seq 1 "$text_w"))" "$R")")
            current="$g"
            groups_shown+=("$g")
        fi

        first=1
        while IFS= read -r line; do
            if [ "$first" -eq 1 ]; then
                lines+=("$(printf '%s%-*s%s  %s%s%s' "$G" "$cmd_w" "$cmd" "$R" "$D" "$line" "$R")")
                first=0
            else
                lines+=("$(printf '%*s  %s%s%s' "$cmd_w" "" "$D" "$line" "$R")")
            fi
        done < <(printf '%s\n' "$desc" | fold -s -w "$desc_w")
    done

    flush_panel

    if [ "$matched" -eq 0 ]; then
        gum style --border rounded --border-foreground 238 --width "$panel_w" \
            --padding "0 1" --margin "0 2" \
            "$(printf '%sNo group matches %s%s%s' "$D" "$Y" "$filter" "$R")" \
            "$(printf '%sGroups: %s%s%s' "$D" "$G" "$(groups_in_order | tr '\n' ' ')" "$R")"
        printf '\n'
        return
    fi

    gum style --margin "1 2" --foreground 244 "dt for the overview"
}

# -----------------------------------------------------------------------------
# Detail — one or more groups (plain fallback)
# -----------------------------------------------------------------------------

render_detail() {
    local filter="$1" matched=0
    local cmd_w=0 entry g cmd n desc first line

    for entry in "${COMMANDS[@]}"; do
        g="${entry%%|*}"
        group_matches "$g" "$filter" || continue
        cmd="${entry#*|}"
        cmd="${cmd%%|*}"
        n=${#cmd}
        [ "$n" -gt "$cmd_w" ] && cmd_w=$n
    done
    [ "$cmd_w" -gt 28 ] && cmd_w=28

    local desc_w=$((INNER - 2 - cmd_w - 2))
    [ "$desc_w" -lt 20 ] && desc_w=20

    printf '\n'

    local current=""
    for entry in "${COMMANDS[@]}"; do
        g="${entry%%|*}"
        group_matches "$g" "$filter" || continue
        matched=1

        cmd="${entry#*|}"
        desc="${cmd#*|}"
        cmd="${cmd%%|*}"

        if [ "$g" != "$current" ]; then
            [ -n "$current" ] && printf '\n'
            printf '%s%s%s%s%s  %s%s%s\n\n' \
                "$PAD" "$B$C" "$(icon_for "$g")" "$g" "$R" "$D" "${GROUP_BLURB[$g]:-}" "$R"
            current="$g"
        fi

        printf '%s  %s%-*s%s  ' "$PAD" "$G" "$cmd_w" "$cmd" "$R"
        first=1
        while IFS= read -r line; do
            if [ "$first" -eq 1 ]; then
                printf '%s%s%s\n' "$D" "$line" "$R"
                first=0
            else
                printf '%s  %*s  %s%s%s\n' "$PAD" "$cmd_w" "" "$D" "$line" "$R"
            fi
        done < <(printf '%s\n' "$desc" | fold -s -w "$desc_w")
    done

    if [ "$matched" -eq 0 ]; then
        printf '%s%sNo group matches %s%s%s.%s\n' "$PAD" "$D" "$Y" "$filter" "$D" "$R"
        printf '%s%sGroups: %s%s%s\n\n' "$PAD" "$D" "$G" "$(groups_in_order | tr '\n' ' ')" "$R"
        return
    fi

    printf '\n%s%sdt for the overview%s\n\n' "$PAD" "$D" "$R"
}

# -----------------------------------------------------------------------------

# --markdown emits the same table as markdown, for the documentation to include.
# The docs are generated from this list rather than restating it, so a command
# added here appears in dt, in make help and on the website from one edit.
if [ "${1:-}" = "--markdown" ]; then
    shift
    md_filter="$(printf '%s ' "$@" | tr '[:upper:]' '[:lower:]' | sed 's/ *$//')"
    while IFS= read -r g; do
        group_matches "$g" "$md_filter" || continue
        icon="$(icon_for "$g")"
        printf '### %s%s\n\n' "$icon" "$g"
        printf '%s\n\n' "${GROUP_BLURB[$g]:-}"
        printf '| Command | What it does |\n|---|---|\n'
        for entry in "${COMMANDS[@]}"; do
            [ "${entry%%|*}" = "$g" ] || continue
            rest="${entry#*|}"
            cmd="${rest%%|*}"
            desc="${rest#*|}"
            # Escape the pipe that would otherwise split the markdown cell, and
            # wrap the command as code.
            printf '| `%s` | %s |\n' "${cmd//|/\\|}" "${desc//|/\\|}"
        done
        printf '\n'
    done < <(groups_in_order)
    exit 0
fi

# --groups lists the group names, one per line, for scripts/dt to dispatch on.
# Keeping the list here means dt cannot invent a group the table does not have.
if [ "${1:-}" = "--groups" ]; then
    groups_in_order | tr '[:upper:]' '[:lower:]'
    exit 0
fi

if [ $# -eq 0 ]; then
    if have_gum; then
        render_overview_gum
    else
        render_overview
    fi
else
    filter="$(printf '%s ' "$@" | tr '[:upper:]' '[:lower:]' | sed 's/ *$//')"
    if have_gum; then
        render_detail_gum "$filter"
    else
        render_detail "$filter"
    fi
fi

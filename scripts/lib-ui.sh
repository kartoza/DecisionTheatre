#!/usr/bin/env bash
# =============================================================================
# lib-ui.sh — shared terminal output. Sourced, not executed.
#
# Every developer-facing script in scripts/ reports through these, so a report
# from doctor, sync-flake or the help table looks like it came from the same
# program — because it did. Colour disappears when stdout is not a terminal, so
# the same output is readable in a pipe, a file or a CI log.
#
# Provides: ui_ok, ui_warn, ui_err, ui_note, ui_group, ui_rule, ui_title,
#           ui_summary, and the counters UI_ERRORS / UI_WARNINGS.
# =============================================================================

if [ -t 1 ]; then
    UI_BOLD=$'\033[1m'
    UI_DIM=$'\033[2m'
    UI_RED=$'\033[0;31m'
    UI_GREEN=$'\033[0;32m'
    UI_YELLOW=$'\033[0;33m'
    UI_CYAN=$'\033[0;36m'
    UI_RST=$'\033[0m'
else
    UI_BOLD='' UI_DIM='' UI_RED='' UI_GREEN='' UI_YELLOW='' UI_CYAN='' UI_RST=''
fi

UI_ERRORS=0
UI_WARNINGS=0

# Label column width, so messages line up down a whole report.
UI_LABEL_WIDTH="${UI_LABEL_WIDTH:-26}"

ui_width() {
    local w="${COLUMNS:-0}"
    if [ "$w" -lt 40 ]; then
        w="$(tput cols 2>/dev/null || echo 80)"
    fi
    [ "$w" -lt 60 ] && w=60
    [ "$w" -gt 110 ] && w=110
    printf '%s' "$w"
}

ui_title() {
    printf '\n  %s%s%s%s\n' "$UI_BOLD" "$UI_CYAN" "$1" "$UI_RST"
    [ $# -gt 1 ] && printf '  %s%s%s\n' "$UI_DIM" "$2" "$UI_RST"
    printf '\n'
}

ui_rule() {
    local w len
    w="$(ui_width)"
    len=$((w - 2))
    printf '  %s%s%s\n' "$UI_DIM" "$(printf '─%.0s' $(seq 1 "$len"))" "$UI_RST"
}

ui_group() {
    printf '  %s%s%s%s\n' "$UI_BOLD" "$UI_CYAN" "$1" "$UI_RST"
    ui_rule
}

# ui_line SYMBOL LABEL MESSAGE [DETAIL]
ui_line() {
    local symbol="$1" label="$2" message="$3" detail="${4:-}"
    printf '    %s %-*s  %s\n' "$symbol" "$UI_LABEL_WIDTH" "$label" "$message"
    if [ -n "$detail" ]; then
        printf '      %*s%s%s%s\n' "$UI_LABEL_WIDTH" "" "$UI_DIM" "$detail" "$UI_RST"
    fi
}

ui_ok() { ui_line "${UI_GREEN}✓${UI_RST}" "$1" "$2" "${3:-}"; }

ui_warn() {
    ui_line "${UI_YELLOW}!${UI_RST}" "$1" "$2" "${3:-}"
    UI_WARNINGS=$((UI_WARNINGS + 1))
}

ui_err() {
    ui_line "${UI_RED}✗${UI_RST}" "$1" "$2" "${3:-}"
    UI_ERRORS=$((UI_ERRORS + 1))
}

# A continuation line under the finding above it. Never counted.
ui_note() { ui_line "${UI_DIM}·${UI_RST}" "$1" "$2" "${3:-}"; }

ui_blank() { printf '\n'; }

# ui_summary [HINT] — prints the tally and returns 1 when anything errored, so
# a script can end with `ui_summary; exit $?`.
ui_summary() {
    local hint="${1:-}" summary
    if [ "$UI_ERRORS" -gt 0 ]; then
        summary="${UI_RED}${UI_ERRORS} error"
        [ "$UI_ERRORS" -ne 1 ] && summary="${summary}s"
        summary="${summary}${UI_RST}"
    else
        summary="${UI_GREEN}no errors${UI_RST}"
    fi
    if [ "$UI_WARNINGS" -gt 0 ]; then
        summary="${summary}${UI_DIM} · ${UI_RST}${UI_YELLOW}${UI_WARNINGS} warning"
        [ "$UI_WARNINGS" -ne 1 ] && summary="${summary}s"
        summary="${summary}${UI_RST}"
    fi

    printf '\n  %s\n' "$summary"
    if [ "$UI_ERRORS" -gt 0 ] && [ -n "$hint" ]; then
        printf '  %s%s%s\n' "$UI_DIM" "$hint" "$UI_RST"
    fi
    printf '\n'

    [ "$UI_ERRORS" -eq 0 ]
}

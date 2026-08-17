#!/usr/bin/env bash
# =============================================================================
# dev-shell.sh — everything `nix develop` sets up. Sourced, not executed.
#
# The flake's shellHook does nothing but source this file, so the development
# environment is ordinary shell in an ordinary file: editable without touching
# nix, reviewable as shell, and testable by sourcing it in a plain bash.
#
# It sets the Go environment, puts devbin/ on PATH, defines the shortcuts, and renders
# the command table once on entry.
# =============================================================================

# Project root. Set by the caller when known; otherwise this file's own
# location, which survives the user cd-ing elsewhere afterwards.
if [ -z "${DT_PROJECT_ROOT:-}" ]; then
    DT_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
export DT_PROJECT_ROOT

export EDITOR="${EDITOR:-nvim}"

# Keep the Go module cache inside the project rather than in $HOME, so a
# checkout is self-contained and removing it reclaims everything.
export GOPATH="$DT_PROJECT_ROOT/.go"
export GOCACHE="$DT_PROJECT_ROOT/.go/cache"
export GOMODCACHE="$DT_PROJECT_ROOT/.go/pkg/mod"
export PATH="$GOPATH/bin:$PATH"

# The webview bindings are cgo.
export CGO_ENABLED=1

# -----------------------------------------------------------------------------
# The task runner and the command table
#
# `dt` is an executable in devbin/, not a shell function. A function would only
# exist for someone who ran `nix develop` interactively: this repository is
# normally entered through direnv, and direnv's `use flake` carries back the
# environment, not the shell state, so a function defined here would silently
# not be there. Putting a directory on PATH works for direnv, for
# `nix develop`, for a subshell, and for `which dt`.
# -----------------------------------------------------------------------------

case ":$PATH:" in
    *":$DT_PROJECT_ROOT/devbin:"*) ;;
    *) export PATH="$DT_PROJECT_ROOT/devbin:$PATH" ;;
esac

# -----------------------------------------------------------------------------
# Shortcuts. Each one is listed in the SHORTCUTS group of shell-help.sh; add
# both together or the table stops telling the truth.
#
# These are aliases, so unlike dt they exist only for someone who ran
# `nix develop` interactively — direnv carries back the environment, not the
# shell state. That is a fair trade for two-letter conveniences; anything that
# has to work everywhere belongs in devbin/ as an executable.
# -----------------------------------------------------------------------------

alias ll='eza -la'
alias la='eza -a'
alias ls='eza'
alias cat='bat --plain'

# Deliberately 'make run' and not 'go run .': a bare go run would launch with
# whatever stale frontend happens to be embedded in the tree.
alias gor='dt run'
alias got='go test -v ./...'
alias gob='dt build-backend'
alias gom='go mod tidy'
alias gol='golangci-lint run'

alias gs='git status'
alias ga='git add'
alias gc='git commit'
alias gl='git log --oneline -10'
alias gd='git diff'

# -----------------------------------------------------------------------------
# Greeting — the same table `dt` prints, so there is only ever one of them.
# -----------------------------------------------------------------------------

"$DT_PROJECT_ROOT/scripts/shell-help.sh"

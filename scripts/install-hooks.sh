#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# install-hooks.sh — install the git hooks.
#
# Uses `pre-commit` when it is available, since .pre-commit-config.yaml is the
# real configuration. Falls back to a plain hook that runs the same checks, so
# a contributor without pre-commit installed still cannot commit a flake that
# has fallen out of step with the manifests.
#
# Idempotent: safe to run repeatedly. Never overwrites a hook it did not write
# without saying so.
#
# Usage: ./scripts/install-hooks.sh
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib-ui.sh
. "$SCRIPT_DIR/lib-ui.sh"

cd "$PROJECT_ROOT"

HOOK_DIR="$(git rev-parse --git-path hooks 2>/dev/null || echo .git/hooks)"
HOOK="$HOOK_DIR/pre-commit"
MARKER="# managed by scripts/install-hooks.sh"

ui_title "Installing git hooks" "$HOOK"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
    ui_err "git" "not a git repository"
    ui_summary
    exit 1
fi

mkdir -p "$HOOK_DIR"

if command -v pre-commit >/dev/null 2>&1; then
    pre-commit install --install-hooks >/dev/null
    ui_ok "pre-commit" "installed from .pre-commit-config.yaml"
    ui_note "" "run 'pre-commit run --all-files' to check the whole tree"
    ui_summary
    exit 0
fi

ui_warn "pre-commit" "not installed — falling back to a plain git hook" \
    "the fallback runs the same critical checks, but not the full suite"

if [ -e "$HOOK" ] && ! grep -qF "$MARKER" "$HOOK"; then
    ui_err "$HOOK" "already exists and was not written by this script" \
        "back it up and re-run, or chain scripts/hooks/pre-commit from it"
    ui_summary
    exit 1
fi

cat > "$HOOK" <<'HOOK_BODY'
#!/usr/bin/env bash
# managed by scripts/install-hooks.sh — re-run 'make hooks' to update
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
exec "$root/scripts/hooks/pre-commit"
HOOK_BODY

chmod +x "$HOOK"
ui_ok "$HOOK" "installed"
ui_note "" "it runs scripts/hooks/pre-commit, which is tracked and reviewable"

ui_summary

#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# protect-branch.sh — require the checks to pass before anything reaches main.
#
# WHY
#
# Pull requests have been merged with failing checks. Every guard this
# repository has — the tests, the linters, the secret scan, the flake lock-step
# check — is advisory until GitHub refuses the merge button, and a check nobody
# has to satisfy is a check that rots.
#
# WHAT IT SETS
#
#   required status checks   every job that runs on a pull request, derived from
#                            the workflow files rather than typed here, so the
#                            list cannot silently diverge from what CI runs
#   strict                   the branch must be up to date before merging, so a
#                            green PR cannot be merged into a main that has since
#                            moved and break it
#   enforce_admins           administrators too. Without this the setting is a
#                            suggestion, and it was administrators doing the
#                            merging
#   pull request required    changes reach main through a pull request. Zero
#                            approvals are required by default: on a team this
#                            size demanding a second pair of eyes would block
#                            the only person available. Use --require-review N
#                            to raise it
#   conversation resolution  review threads must be resolved
#   no force pushes          and no branch deletion
#
# Usage:
#   ./scripts/protect-branch.sh --show            what is configured now
#   ./scripts/protect-branch.sh --dry-run         what would be applied
#   ./scripts/protect-branch.sh                   apply it
#   ./scripts/protect-branch.sh --require-review 1
#   ./scripts/protect-branch.sh --branch develop
#   ./scripts/protect-branch.sh --no-strict      apply without up-to-dateness
#   ./scripts/protect-branch.sh --strict         the default, stated explicitly
#
# WHY --no-strict EXISTS
#
# Strict means a branch must be up to date with main before it can merge. With
# several green pull requests waiting, merging the first makes every other one
# out of date, so each merge needs a round of "update branch" and a full CI run
# before the next can go. Five ready pull requests become five sequential CI
# cycles.
#
# --no-strict turns off only that up-to-dateness requirement, for the length of
# a batch merge. Every check is still required and still has to have passed; the
# only thing dropped is the demand that it passed against the newest main. That
# is a real, small risk — two changes can each be green alone and broken
# together — so it belongs to a deliberate batch with main checked afterwards,
# never as a standing setting. Restore it with --strict, or by running this
# script with no arguments at all.
#
# Needs an authenticated `gh` with admin rights on the repository.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib-ui.sh
. "$SCRIPT_DIR/lib-ui.sh"

cd "$PROJECT_ROOT"

BRANCH="main"
REVIEWS=0
MODE="apply"
# The safe value is the default: a run with no arguments restores strictness,
# which is what the batch-merge caller relies on to put it back.
STRICT="true"

while [ $# -gt 0 ]; do
    case "$1" in
        --show) MODE="show" ;;
        --dry-run) MODE="dry-run" ;;
        --no-strict) STRICT="false" ;;
        --strict) STRICT="true" ;;
        --branch)
            BRANCH="${2:?--branch needs a name}"
            shift
            ;;
        --require-review)
            REVIEWS="${2:?--require-review needs a number}"
            shift
            ;;
        -h | --help)
            # Derived from the rules rather than a hardcoded range: this was
            # '4,44p', and the paragraph added above would have silently cut the
            # end off --help. The same lesson as scripts/run-app.sh.
            awk '/^# ={10,}$/ { rules++; next } rules == 1' "${BASH_SOURCE[0]}" |
                sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1 (try --help)" >&2
            exit 2
            ;;
    esac
    shift
done

REPO="$(git config --get remote.origin.url 2>/dev/null |
    sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
if [ -z "$REPO" ]; then
    ui_err "remote" "could not determine the GitHub repository from origin"
    exit 2
fi

# -----------------------------------------------------------------------------
# The checks to require, read from the workflows
#
# A job is required when its workflow runs on pull_request and the job is not
# gated to a branch or event that a pull request cannot satisfy — "Publish to
# GitHub Pages" only runs on a push to main, so requiring it would leave every
# pull request waiting for a check that never starts.
# -----------------------------------------------------------------------------
required_checks() {
    python3 - <<'PY'
import glob, yaml

for path in sorted(glob.glob('.github/workflows/*.yml')):
    doc = yaml.safe_load(open(path)) or {}
    # PyYAML reads the bare word `on` as the boolean True.
    triggers = doc.get('on', doc.get(True)) or {}
    if isinstance(triggers, str):
        triggers = {triggers: None}
    if 'pull_request' not in triggers:
        continue

    for job_id, job in (doc.get('jobs') or {}).items():
        condition = str(job.get('if') or '')
        if 'github.ref' in condition or 'event_name' in condition:
            continue
        print(job.get('name') or job_id)
PY
}

mapfile -t CHECKS < <(required_checks)

if [ "${#CHECKS[@]}" -eq 0 ]; then
    ui_err "workflows" "found no pull-request jobs to require"
    exit 2
fi

# -----------------------------------------------------------------------------

ui_title "Branch protection" "$REPO · $BRANCH"

if [ "$MODE" = "show" ]; then
    ui_group "CURRENT"
    if ! out="$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>&1)"; then
        case "$out" in
            *"Branch not protected"*) ui_err "$BRANCH" "not protected — anything can be merged" ;;
            *"gh auth login"* | *"authentication"*) ui_err "gh" "not authenticated; run: gh auth login" ;;
            *) ui_err "gh api" "$(printf '%s' "$out" | head -1)" ;;
        esac
        ui_summary "run this script with no arguments to apply protection"
        exit 1
    fi
    printf '%s\n' "$out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
rsc = d.get("required_status_checks") or {}
print("    strict (branch up to date):", rsc.get("strict"))
print("    enforce on admins        :", (d.get("enforce_admins") or {}).get("enabled"))
pr = d.get("required_pull_request_reviews")
print("    pull request required    :", bool(pr),
      ("approvals=%s" % pr.get("required_approving_review_count")) if pr else "")
print("    conversation resolution  :", (d.get("required_conversation_resolution") or {}).get("enabled"))
print("    force pushes allowed     :", (d.get("allow_force_pushes") or {}).get("enabled"))
print("    required checks:")
for c in sorted(rsc.get("contexts") or []):
    print("      -", c)
'
    printf '\n'
    exit 0
fi

ui_group "WILL REQUIRE"
for c in "${CHECKS[@]}"; do
    ui_ok "$c" "must pass"
done
if [ "$STRICT" = "true" ]; then
    ui_note "strict" "the branch must be up to date with $BRANCH before merging"
else
    ui_warn "strict" "OFF — checks are still required, up-to-dateness is not" \
        "for a batch merge only; re-run without --no-strict to restore it"
fi
ui_note "admins" "included — the setting is meaningless otherwise"
ui_note "approvals" "$REVIEWS"

# GitHub wants the contexts as a JSON array.
CONTEXTS_JSON="$(printf '%s\n' "${CHECKS[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')"

PAYLOAD="$(python3 -c '
import json, sys
contexts = json.loads(sys.argv[1])
reviews = int(sys.argv[2])
strict = sys.argv[3] == "true"
print(json.dumps({
    "required_status_checks": {"strict": strict, "contexts": contexts},
    "enforce_admins": True,
    "required_pull_request_reviews": {
        "required_approving_review_count": reviews,
        "dismiss_stale_reviews": True,
        "require_code_owner_reviews": False,
    },
    "required_conversation_resolution": True,
    "restrictions": None,
    "allow_force_pushes": False,
    "allow_deletions": False,
}))' "$CONTEXTS_JSON" "$REVIEWS" "$STRICT")"

if [ "$MODE" = "dry-run" ]; then
    ui_blank
    ui_group "PAYLOAD"
    printf '%s\n' "$PAYLOAD" | python3 -m json.tool | sed 's/^/    /'
    ui_blank
    printf '  %sDRY RUN — nothing changed. Re-run without --dry-run to apply.%s\n\n' \
        "$UI_DIM" "$UI_RST"
    exit 0
fi

ui_blank
ui_group "APPLYING"

if ! command -v gh >/dev/null 2>&1; then
    ui_err "gh" "not installed"
    ui_summary
    exit 2
fi

if out="$(printf '%s' "$PAYLOAD" |
    gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" --input - 2>&1)"; then
    ui_ok "$BRANCH" "protected"
    ui_note "" "verify with: ./scripts/protect-branch.sh --show"
else
    ui_err "gh api" "$(printf '%s' "$out" | head -3)"
    case "$out" in
        *"Not Found"* | *"admin"*)
            ui_note "" "this needs admin rights on $REPO"
            ;;
        *"gh auth login"* | *authentication*)
            ui_note "" "run: gh auth login"
            ;;
    esac
fi

ui_summary

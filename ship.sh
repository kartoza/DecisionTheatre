#!/usr/bin/env bash
#
# ship.sh — push the branch, open the PR, cut the release.
#
# Run it yourself: this sandbox has no authenticated gh and no ssh askpass.
#
#   ./ship.sh pr        push the current branch and open its pull request
#   ./ship.sh release   tag the current version and create the GitHub release
#
# Both are safe to re-run. The PR step skips if one is already open; the
# release step stops if the tag already exists rather than moving it.

set -euo pipefail

REPO="kartoza/DecisionTheatre"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
VERSION="$(sed -n 's/.*version = "\(.*\)";/\1/p' flake.nix | head -1)"
TAG="v${VERSION}"

case "${1:-}" in

pr)
    # One body file per branch. Named after the branch so a stacked branch does
    # not open its PR with the body of the one underneath it.
    case "$BRANCH" in
        unshakeable)
            BODY="pr-body-unshakeable.md"
            TITLE="feat: keep the server up under load, and measure that it does"
            ;;
        feat/flat-dial-experiment)
            BODY="pr-body-flat-dial.md"
            TITLE="feat: flat chart view, scale fixes and UI cleanup"
            ;;
        *)
            BODY="pr-body-${BRANCH##*/}.md"
            # Falls back to the last commit subject, which is right for a
            # single-commit branch and wrong for a stacked one. Add a case
            # above rather than letting it guess.
            TITLE="$(git log -1 --format=%s)"
            ;;
    esac
    [ -f "$BODY" ] || { echo "no $BODY for branch $BRANCH"; exit 1; }

    git push -u origin "$BRANCH"

    if gh pr view "$BRANCH" --repo "$REPO" >/dev/null 2>&1; then
        echo "PR already open, updating its body"
        gh pr edit "$BRANCH" --repo "$REPO" --body-file "$BODY"
    else
        gh pr create --repo "$REPO" \
            --base main --head "$BRANCH" \
            --title "$TITLE" \
            --body-file "$BODY"
    fi
    gh pr view "$BRANCH" --repo "$REPO" --web
    ;;

release)
    # Releases come off main, after the PR has merged.
    [ "$BRANCH" = "main" ] || { echo "on $BRANCH, not main — merge the PR first"; exit 1; }

    if git rev-parse "$TAG" >/dev/null 2>&1; then
        echo "$TAG already exists — bump the version in flake.nix first"
        exit 1
    fi

    git pull --ff-only
    git tag -a "$TAG" -m "$TAG"
    git push origin "$TAG"

    # The changelog's Unreleased section is the release notes. Everything from
    # the first heading to the next version heading, minus the heading itself.
    NOTES="$(mktemp)"
    awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > "$NOTES"

    gh release create "$TAG" --repo "$REPO" \
        --title "$TAG" \
        --notes-file "$NOTES"

    rm -f "$NOTES"
    echo "CI builds the packages and attaches them to $TAG."
    gh release view "$TAG" --repo "$REPO" --web
    ;;

*)
    echo "usage: ./ship.sh [pr|release]"
    exit 1
    ;;
esac

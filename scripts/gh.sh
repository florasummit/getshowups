#!/usr/bin/env bash
# Runs the GitHub CLI with the GitHub credential git already uses (macOS keychain via `git credential`),
# for this one process only. Nothing is printed, written to disk, or added to gh's own config, and no new
# credential is created (never run `gh auth login` for this repo's automation).
#
#   scripts/gh.sh pr create --base main --head <branch> --title "…" --body-file <file>
#   scripts/gh.sh pr checks <n> --watch        scripts/gh.sh run view <id> --log-failed
#
# Needs a fine-grained token on florasummit/getshowups with: Contents R/W, Pull requests R/W, Actions read,
# Metadata read (see "GitHub automation" in CLAUDE.md). Merging stays a human-approved step.
set -euo pipefail
command -v gh >/dev/null || { echo "gh is not installed (brew install gh)" >&2; exit 127; }
token=$(printf 'protocol=https\nhost=github.com\n\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | sed -n 's/^password=//p')
[ -n "$token" ] || { echo "No GitHub credential in git's credential helper" >&2; exit 1; }
GH_TOKEN="$token" GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_REPO=florasummit/getshowups exec gh "$@"

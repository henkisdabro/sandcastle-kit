#!/bin/bash
# Blocks what damages the .git shared by every sandbox of a run. Not a security boundary (sh -c,
# scripts and other tools get past a command-string match): it stops accidents. The check on the
# host is what protects the repo.
#
# Mounted read-only at /etc/claude-code with managed-settings.json, which Claude Code reads above
# user and project settings, so a branch's own .claude/settings.json cannot switch it off. Assumes
# bash and jq, both in the base image.
INPUT=$(cat)
CMD=$(jq -r '.tool_input.command // empty' <<<"$INPUT")
FILE=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")
CWD=$(jq -r '.cwd // empty' <<<"$INPUT")
deny() { echo "BLOCKED: $1. It would damage the .git that other agents share. Continue the ticket without it; do not retry." >&2; exit 2; }

# The shared dir of the hook's own cwd, so a package's own .git/ (node_modules) is never matched.
COMMON=$(git -C "${CWD:-.}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
if [ -n "$FILE" ] && [ -n "$COMMON" ]; then
  case "$FILE" in "$COMMON"/*) deny "writing inside the shared .git";; esac
fi
[ -z "$CMD" ] && exit 0

# `git` only at a command position, then global options, then the subcommand: grepping for
# `git ... gc` anywhere blocked ordinary commit messages that mention the word.
GIT='(^|[;&|(`])[[:space:]]*(sudo[[:space:]]+)?git([[:space:]]+(-C[[:space:]]+[^[:space:]]+|-c[[:space:]]+[^[:space:]]+|--[a-z-]+(=[^[:space:]]+)?))*[[:space:]]+'
grep -qE "${GIT}(update-ref|gc|prune|push)([[:space:]]|\$)" <<<"$CMD" && deny "git update-ref, gc, prune or push"
grep -qE "${GIT}reflog[[:space:]]+expire" <<<"$CMD" && deny "git reflog expire"
grep -qE "${GIT}worktree[[:space:]]+(prune|repair)" <<<"$CMD" && deny "git worktree prune or repair (git worktree remove --force is allowed)"
grep -qE "${GIT}branch[[:space:]].*(-[a-zA-Z]*[dDf]|--delete|--force)[[:space:]].*agent/" <<<"$CMD" && deny "deleting or moving an agent branch"
if [ -n "$COMMON" ] && grep -qE '(^|[;&|(`])[[:space:]]*(rm|mv)[[:space:]]' <<<"$CMD" && grep -qF "$COMMON/" <<<"$CMD"; then deny "rm or mv inside the shared .git"; fi
exit 0

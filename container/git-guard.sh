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
# The match is on the command string, so a heredoc, commit message or comment body that only quotes
# a refused command is refused too. The second sentence tells the agent how to carry such text
# (a file), so it does not have to go against "do not retry" to find out. A refused file write has
# no text to move, so it passes a second argument to leave the sentence out. A third is a hint line
# naming the allowed way to do the same thing.
deny() {
  echo "BLOCKED: $1. It would damage the .git that other agents share. Continue the ticket without it; do not retry." >&2
  [ -z "$3" ] || echo "$3" >&2
  [ -n "$2" ] || echo "If this command only quotes that text (a heredoc, a commit message, a comment body) and does not run it, write the text to a file and pass the file instead: --body-file <file>, -F <file>, git commit -F <file>." >&2
  exit 2
}

# The shared dir of the hook's own cwd, so a package's own .git/ (node_modules) is never matched.
COMMON=$(git -C "${CWD:-.}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
# The shared dir of the dir Claude Code started in (CLAUDE_PROJECT_DIR, set for every hook). The cwd
# moves with a `cd`: inside a scratch repository COMMON is the scratch's own dir, and from a dir in no
# repository it is empty, so a rule that only looked at COMMON let the project's .git through.
PROJECT_COMMON=
[ -z "$CLAUDE_PROJECT_DIR" ] || PROJECT_COMMON=$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
if [ -n "$FILE" ]; then
  for dir in "$COMMON" "$PROJECT_COMMON"; do
    [ -z "$dir" ] || case "$FILE" in "$dir"/*) deny "writing inside the shared .git" file;; esac
  done
fi
[ -z "$CMD" ] && exit 0

# `git` only at a command position, then global options, then the subcommand: grepping for
# `git ... gc` anywhere blocked ordinary commit messages that mention the word.
# The branch rule's flag and ref stay inside the one command (no `;`, `&`, `|` or backtick between
# them): `.*` ran into a later `git merge --no-ff`, whose `-ff` looked like `-f`.
# Variable assignments may precede `git` (`FOO=1 git push`): without them in the pattern, any prefix
# put the command past every rule here.
GIT='(^|[;&|(`])[[:space:]]*(sudo[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*git([[:space:]]+(-C[[:space:]]+[^[:space:]]+|-c[[:space:]]+[^[:space:]]+|--[a-z-]+(=[^[:space:]]+)?))*[[:space:]]+'

# update-ref, gc, prune and stash act on the repository git resolves, so one run with `git -C <path>` in a
# scratch repository elsewhere (a reviewer's throwaway under the temp dir) damages nothing here. Allowed
# only when every `-C` resolves to a common dir other than the shared one: a worktree of the shared repo
# resolves to it and stays refused. A command with no `-C` acts in the hook's cwd, so a leading `cd x &&`
# is not parsed and stays refused, as does a path git cannot resolve ($VAR, ~) and `--git-dir`.
# Only an absolute `-C` counts: git resolves a relative one from the shell's cwd at run time, which a
# `cd <workspace> &&` earlier in the line moves away from the cwd the hook was given. A GIT_DIR-style
# variable anywhere in the line points git at a repository the `-C` check never sees.
# push is refused everywhere: its danger is the destination, and a scratch repo's remote can be the shared .git.
# The shared dir here is the one of the dir Claude Code started in (CLAUDE_PROJECT_DIR), not COMMON: the
# shell's cwd moves with a `cd`, and from inside the scratch repo COMMON is the scratch's own dir, so a
# `-C` back into the project would pass. Without it the shared dir is unknown and these stay refused.
scratch_only() {
  local words w args=() pending= sub
  grep -qE 'GIT_(DIR|COMMON_DIR|WORK_TREE)=' <<<"$CMD" && return 1
  sub=$(sed -E 's/^[;&|(`[:space:]]*(sudo[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*git[[:space:]]+//' <<<"$1")
  set -f; read -r -a words <<<"$sub"; set +f
  unset 'words[${#words[@]}-1]'
  for w in "${words[@]}"; do
    if [ -n "$pending" ]; then
      # Agents quote paths as a habit, and a plain quoted literal is the same path. One holding $ or a
      # backtick keeps its quotes, so git cannot resolve it and the command stays refused.
      case "$w" in \"*\"|\'*\') [[ "$w" == *[\$\`]* ]] || w=${w:1:${#w}-2};; esac
      if [ "$pending" = C ]; then
        [ "${w:0:1}" = / ] || return 1
        args+=("$w")
      fi
      pending=
      continue
    fi
    case "$w" in
      -C) pending=C;;
      -c) pending=c;;
      --git-dir*|--work-tree*) return 1;;
    esac
  done
  [ ${#args[@]} -gt 0 ] && [ -n "$PROJECT_COMMON" ] || return 1
  local target cargs=() a
  for a in "${args[@]}"; do cargs+=(-C "$a"); done
  target=$(git "${cargs[@]}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -n "$target" ] && [ "$target" != "$PROJECT_COMMON" ]
}
while IFS= read -r m; do
  scratch_only "$m" || deny "git update-ref, gc or prune" "" "It is allowed in a scratch repository elsewhere, run as git -C <absolute path> <command> with the path outside this project (build one under the temp dir)."
done < <(grep -oE "${GIT}(update-ref|gc|prune)([[:space:]]|\$)" <<<"$CMD")
# refs/stash lives in the shared .git, so every worktree of a run sees one stash list: a pop can apply
# another agent's change. list and show only read it.
while IFS= read -r m; do
  grep -qE 'stash[[:space:]]+(list|show)[[:space:]]*$' <<<"$m" && continue
  scratch_only "$(sed -E 's/stash[[:space:]]+[^[:space:]]+[[:space:]]*$/stash /' <<<"$m")" || deny "git stash" "" "The stash list is shared by every agent's worktree. To run a test without your change: git diff > /tmp/p && git checkout -- <files>, run it, then git apply /tmp/p."
done < <(grep -oE "${GIT}stash([[:space:]]+[^[:space:];&|]+)?([[:space:]]|\$)" <<<"$CMD")
grep -qE "${GIT}push([[:space:]]|\$)" <<<"$CMD" && deny "git push" "" "To test remote handling, build a bare origin under the temp dir and use git fetch, and use git -C <absolute path> for a scratch repository's own plumbing."
grep -qE "${GIT}reflog[[:space:]]+expire" <<<"$CMD" && deny "git reflog expire"
grep -qE "${GIT}worktree[[:space:]]+(prune|repair)" <<<"$CMD" && deny "git worktree prune or repair (git worktree remove --force is allowed)"
grep -qE "${GIT}branch[[:space:]]([^;&|\`]*[[:space:]])?(-[a-zA-Z]*[dDf]|--delete|--force)[[:space:]][^;&|\`]*agent/" <<<"$CMD" && deny "deleting or moving an agent branch"
if grep -qE '(^|[;&|(`])[[:space:]]*(rm|mv)[[:space:]]' <<<"$CMD"; then
  for dir in "$COMMON" "$PROJECT_COMMON"; do
    [ -z "$dir" ] || ! grep -qF "$dir/" <<<"$CMD" || deny "rm or mv inside the shared .git"
  done
fi
exit 0

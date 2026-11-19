#!/bin/bash
# Blocks what damages the .git shared by every sandbox of a run. Not a security boundary (a script
# file or another tool gets past any reading of a command line): it stops accidents. The check on
# the host is what protects the repo.
#
# Mounted read-only at /etc/claude-code with managed-settings.json, which Claude Code reads above
# user and project settings, so a branch's own .claude/settings.json cannot switch it off. Assumes
# bash, jq and git, all in the base image. Runs in the container, but the tests run it on the host
# too, so it keeps to bash 3.2 and does without GNU-only tools.
#
# It reads a command the way the shell would - split into simple commands, words unquoted, wrappers
# such as env or sudo stripped, git's global options parsed against git's own list, aliases expanded
# - and only then decides. A regex over the raw string let `git --git-dir .git gc`, `git "gc"` and
# `env git gc` through. What it cannot read in a real command it refuses: a guess there allows.
INPUT=$(cat)
CMD=$(jq -r '.tool_input.command // empty' <<<"$INPUT")
FILE=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")
CWD=$(jq -r '.cwd // empty' <<<"$INPUT")
[ -n "$CWD" ] || CWD=$PWD

# Every refusal carries a stable [git-guard:<code>] that the tests assert; the wording stays as it
# was, so an agent's habits still match. Quoted text is read too,
# so a heredoc, commit message or comment body that only quotes
# a refused command is refused too. The second sentence tells the agent how to carry such text (a
# file). A refused file write has no text to move, so it passes "file" to leave that out. The last
# argument is a hint naming the allowed way.
deny() {
  echo "BLOCKED: $1. It would damage the .git that other agents share. Continue the ticket without it; do not retry. [git-guard:$2]" >&2
  [ -z "$4" ] || echo "$4" >&2
  [ -n "$3" ] || echo "If this command only quotes that text (a heredoc, a commit message, a comment body) and does not run it, write the text to a file and pass the file instead: --body-file <file>, -F <file>, git commit -F <file>." >&2
  exit 2
}
unreadable() {
  echo "BLOCKED: the guard cannot read this git command ($1). [git-guard:${2:-unreadable}]" >&2
  echo "Write it plainly: git, then only git's own global options (-C <path>, -c <name>=<value>, --no-pager, ...), then the subcommand, with every quote closed and no variable or \$(...) where an option or the subcommand goes." >&2
  exit 2
}

# Resolves `..` and symlinks the way `realpath -m` does, components that do not exist included, so a
# path through a symlink or up out of the worktree is compared where it lands. In bash, since macOS,
# where the tests also run it, has no `realpath -m`.
norm() {
  local p=$1 out='' c rest hops=0 t
  [ "${p:0:1}" = / ] || p=$CWD/$p
  rest=$p
  while [ -n "$rest" ]; do
    c=${rest%%/*}
    if [ "$c" = "$rest" ]; then rest=; else rest=${rest#*/}; fi
    case $c in
      ''|.) continue;;
      ..) out=${out%/*}; continue;;
    esac
    if [ -L "$out/$c" ] && [ $((hops += 1)) -le 40 ]; then
      t=$(readlink "$out/$c")
      [ "${t:0:1}" != / ] || out=
      rest=$t${rest:+/$rest}
    else
      out=$out/$c
    fi
  done
  echo "${out:-/}"
}

# The shared dir of the hook's own cwd, so a package's own .git/ (node_modules) is never matched.
COMMON=$(git -C "$CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
[ -z "$COMMON" ] || COMMON=$(norm "$COMMON")
# The shared dir of the dir Claude Code started in (CLAUDE_PROJECT_DIR, set for every hook). The cwd
# moves with a `cd`: inside a scratch repository COMMON is the scratch's own dir, and from a dir in no
# repository it is empty, so a rule that only looked at COMMON let the project's .git through.
PROJECT_COMMON=
[ -z "$CLAUDE_PROJECT_DIR" ] || PROJECT_COMMON=$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
[ -z "$PROJECT_COMMON" ] || PROJECT_COMMON=$(norm "$PROJECT_COMMON")
in_shared() {
  local p dir
  p=$(norm "$1")
  for dir in "$COMMON" "$PROJECT_COMMON"; do
    [ -n "$dir" ] || continue
    case $p in "$dir"|"$dir"/*) return 0;; esac
  done
  return 1
}
if [ -n "$FILE" ] && in_shared "$FILE"; then deny "writing inside the shared .git" shared-git-write file; fi
[ -z "$CMD" ] && exit 0

# The tokeniser. It reads one command line into TOK (words, quotes removed; SEP stands between simple
# commands, at ; & | ( ) and newlines), TEXP (1 where a word holds a $ or `...` expansion, whose value
# the guard cannot know), and SUBS with SUBM: text to read again as commands of its own, with the
# mode to read it in. That text is a $(...) or `...` body (code), a heredoc line (it may feed a
# shell), and every quoted string: a quoted string is read as prose, so its first command is skipped
# (`-m "git push guidance"`), unless it follows -c, eval or env -S, where it is code. UNTERM is 1
# when a quote never closes. Globals, overwritten by every call: callers copy what they keep.
SEP=$'\x1f'
NL=$'\n'
# Bytes, not characters: ${s:i:1} in a UTF-8 locale scans from the start every time, which made a
# long heredoc take seconds. Every character the tokeniser looks for is ASCII.
LC_ALL=C
tokenise() {
  local s=$1 parent=$2 i=0 n=${#1} c w='' wq=0 we=0 skip=0 j d body delims=() dashes=() k line rest mode
  TOK=() TEXP=() SUBS=() SUBM=() UNTERM=0
  sub_mode() {
    mode=nested
    [ -n "$w" ] || [ ${#TOK[@]} = 0 ] || case ${TOK[${#TOK[@]}-1]} in -c|eval|-S|--split-string) mode=line;; esac
  }
  flush() {
    if [ -n "$w" ] || [ $wq = 1 ]; then
      if [ $skip = 1 ]; then skip=0; else TOK+=("$w"); TEXP+=("$we"); fi
    fi
    w='' wq=0 we=0
  }
  sep() { flush; skip=0; TOK+=("$SEP"); TEXP+=(0); }
  while [ $i -lt $n ]; do
    c=${s:i:1}
    case $c in
      ' '|$'\t') flush; i=$((i + 1));;
      "$NL")
        sep; i=$((i + 1))
        # A heredoc's body starts on the line after its << and runs to the delimiter line.
        for k in "${!delims[@]}"; do
          while [ $i -lt $n ]; do
            rest=${s:i}; line=${rest%%"$NL"*}
            if [ "$line" = "$rest" ]; then i=$n; else i=$((i + ${#line} + 1)); fi
            [ "${dashes[k]}" = 1 ] && while [ "${line:0:1}" = $'\t' ]; do line=${line:1}; done
            [ "$line" = "${delims[k]}" ] && break
            SUBS+=("$line"); SUBM+=(line)
          done
        done
        delims=() dashes=();;
      \\)
        if [ "${s:i+1:1}" != "$NL" ]; then w+=${s:i+1:1}; wq=1; fi
        i=$((i + 2));;
      \')
        rest=${s:i+1}
        if [[ $rest == *\'* ]]; then body=${rest%%\'*}; i=$((i + ${#body} + 2))
        else UNTERM=1; body=${rest%%"$NL"*}; i=$((i + ${#body} + 1)); fi
        sub_mode; SUBS+=("$body"); SUBM+=("$mode")
        w+=$body; wq=1;;
      \")
        body='' j=$((i + 1))
        while [ $j -lt $n ]; do
          d=${s:j:1}
          if [ "$d" = '"' ]; then break; fi
          if [ "$d" = \\ ]; then
            case ${s:j+1:1} in
              \$|\`|\"|\\) body+=${s:j+1:1}; j=$((j + 2)); continue;;
              "$NL") j=$((j + 2)); continue;;
            esac
          fi
          case $d in \$|\`) we=1;; esac
          body+=$d; j=$((j + 1))
        done
        if [ $j -ge $n ]; then UNTERM=1; body=${body%%"$NL"*}; i=$((i + ${#body} + 1)); else i=$((j + 1)); fi
        sub_mode; SUBS+=("$body"); SUBM+=("$mode")
        w+=$body; wq=1;;
      \$|\`)
        if [ "$c" = \` ] || [ "${s:i+1:1}" = '(' ]; then
          # A command substitution: its body runs as code, and its output becomes part of this word.
          if [ "$c" = \` ]; then
            rest=${s:i+1}
            if [[ $rest == *\`* ]]; then body=${rest%%\`*}; i=$((i + ${#body} + 2)); else UNTERM=1; body=$rest; i=$n; fi
          else
            d=1 j=$((i + 2))
            while [ $j -lt $n ] && [ $d -gt 0 ]; do
              case ${s:j:1} in '(') d=$((d + 1));; ')') d=$((d - 1));; esac
              j=$((j + 1))
            done
            [ $d = 0 ] || UNTERM=1
            body=${s:i+2:j-i-3}; i=$j
          fi
          if [ "$parent" = strict ]; then SUBM+=(strict); else SUBM+=(line); fi
          SUBS+=("$body")
          w+='$'; we=1
        elif [ "${s:i+1:1}" = '{' ]; then
          rest=${s:i}; body=${rest%%\}*}
          w+=$body; we=1; i=$((i + ${#body} + 1))
        else
          w+='$'; we=1; i=$((i + 1))
        fi;;
      '#')
        if [ -z "$w" ] && [ $wq = 0 ]; then
          rest=${s:i}; line=${rest%%"$NL"*}; i=$((i + ${#line}))
        else w+=$c; i=$((i + 1)); fi;;
      ';'|'|'|'('|')') sep; i=$((i + 1));;
      '&')
        if [ "${s:i+1:1}" = '>' ]; then flush; i=$((i + 1)); else sep; i=$((i + 1)); fi;;
      '<'|'>')
        # A redirection: the fd number before it and the target after it are not arguments.
        if [ $wq = 0 ] && [[ $w =~ ^[0-9]+$ ]]; then w=; fi
        flush
        if [ "${s:i:2}" = '<<' ] && [ "${s:i+2:1}" != '<' ]; then
          i=$((i + 2)); d=0
          [ "${s:i:1}" = - ] && { d=1; i=$((i + 1)); }
          while [ "${s:i:1}" = ' ' ] || [ "${s:i:1}" = $'\t' ]; do i=$((i + 1)); done
          body=
          while [ $i -lt $n ]; do
            c=${s:i:1}
            case $c in ' '|$'\t'|"$NL"|';'|'&'|'|'|'<'|'>'|'('|')') break;; \'|\"|\\) ;; *) body+=$c;; esac
            i=$((i + 1))
          done
          delims+=("$body"); dashes+=("$d")
        else
          while [ $i -lt $n ]; do
            case ${s:i:1} in '<'|'>'|'&'|'|') i=$((i + 1));; *) break;; esac
          done
          [ "${s:i:1}" = '(' ] || skip=1
        fi;;
      *) w+=$c; i=$((i + 1));;
    esac
  done
  flush
}

# Reads a command line: strict for the command the agent runs (and the code inside it), where
# anything unreadable refuses; line and nested for text it only carries (heredoc lines, quoted
# strings), where the rules for what git does still apply but an unknown word is taken as prose.
analyse() {
  local mode=$2 depth=$3 toks texp subs subm t seg=() segx=() first=1
  [ "$depth" -le 8 ] || return 0
  # Text with no git, rm or mv word in it cannot meet a rule; most heredoc and message lines are prose.
  [[ $1 =~ (^|[^[:alnum:]_.-])(git|rm|mv)([^[:alnum:]_.-]|$) ]] || return 0
  tokenise "$1" "$mode"
  if [ $UNTERM = 1 ] && [ "$mode" = strict ] && [[ $1 =~ (^|[^[:alnum:]_.-])git([^[:alnum:]_.-]|$) ]]; then
    unreadable "a quote that is never closed"
  fi
  toks=("${TOK[@]}" "$SEP") texp=("${TEXP[@]}" 0) subs=("${SUBS[@]}") subm=("${SUBM[@]}")
  for t in "${!toks[@]}"; do
    if [ "${toks[t]}" = "$SEP" ]; then
      if [ ${#seg[@]} -gt 0 ] && { [ "$mode" != nested ] || [ $first = 0 ]; }; then simple; fi
      first=0 seg=() segx=()
    else
      seg+=("${toks[t]}"); segx+=("${texp[t]}")
    fi
  done
  for t in "${!subs[@]}"; do analyse "${subs[t]}" "${subm[t]}" $((depth + 1)); done
}

# One simple command (seg, segx): strip what only runs the next word - assignments, sudo, env,
# command, exec, nice, time, timeout, xargs, nohup and shell keywords - then judge git, rm and mv.
simple() {
  local w=("${seg[@]}") x=("${segx[@]}") n=${#seg[@]} i=0 c o
  while [ $i -lt $n ]; do
    c=${w[i]}
    if [[ $c =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then i=$((i + 1)); continue; fi
    case $c in
      '!'|'{'|'}'|if|then|else|elif|do|while|until|nohup|builtin) i=$((i + 1));;
      sudo|env|command|exec|nice|time|timeout|xargs)
        i=$((i + 1))
        while [ $i -lt $n ] && [ "${w[i]:0:1}" = - ]; do
          o=${w[i]}
          case $c:$o in
            command:-v|command:-V) return 0;;
            *:--) i=$((i + 1)); break;;
            sudo:-[ugpCDrtUhT]|env:-[uCS]|env:--unset|env:--chdir|env:--split-string|exec:-a|nice:-n|timeout:-[sk]|timeout:--signal|timeout:--kill-after|xargs:-[ILnPsEda]) i=$((i + 2));;
            *) i=$((i + 1));;
          esac
        done
        [ "$c" != timeout ] || i=$((i + 1));;
      *) break;;
    esac
  done
  [ $i -lt $n ] && [ "${x[i]}" = 0 ] || return 0
  GA=("${w[@]:i+1}") GX=("${x[@]:i+1}")
  case ${w[i]##*/} in
    git) git_cmd 0;;
    rm|mv)
      for o in "${!GA[@]}"; do
        [ "${GX[o]}" = 1 ] || [ "${GA[o]:0:1}" = - ] || ! in_shared "${GA[o]}" || deny "rm or mv inside the shared .git" shared-git-rm
      done;;
  esac
}

# update-ref, gc, prune and the rest act on the repository git resolves, so one run with `git -C <path>` in a
# scratch repository elsewhere (a reviewer's throwaway under the temp dir) damages nothing here. Allowed
# only when every `-C` resolves to a common dir other than the shared one: a worktree of the shared repo
# resolves to it and stays refused. A command with no `-C` acts in the hook's cwd, so a leading `cd x &&`
# is not parsed and stays refused, as does a path git cannot resolve ($VAR, ~), --git-dir and --work-tree.
# Only an absolute `-C` counts: git resolves a relative one from the shell's cwd at run time, which a
# `cd <workspace> &&` earlier in the line moves away from the cwd the hook was given. A GIT_DIR-style
# variable anywhere in the line points git at a repository the `-C` check never sees.
# The shared dir here is the one of the dir Claude Code started in (CLAUDE_PROJECT_DIR), not COMMON: the
# shell's cwd moves with a `cd`, and from inside the scratch repo COMMON is the scratch's own dir, so a
# `-C` back into the project would pass. Without it the shared dir is unknown and these stay refused.
# What every refusal that scratch_ok made says about how to pass it: the rule reads the command string
# before it runs, so a repository the same command creates, or a path in a variable, cannot resolve yet.
SCRATCH_HOW="Create the scratch repository in an earlier command, then use git -C /literal/absolute/path <command> (no variable, no path created in the same command)."
PLUMBING_HOW="It is allowed in a scratch repository elsewhere, run as git -C <absolute path> <command> with the path outside this project (build one under the temp dir). $SCRATCH_HOW"
scratch_ok() {
  local p cargs=() target
  [ $gitdir = 0 ] && [ ${#cpaths[@]} -gt 0 ] && [ -n "$PROJECT_COMMON" ] || return 1
  grep -qE 'GIT_(DIR|COMMON_DIR|WORK_TREE)=' <<<"$CMD" && return 1
  for p in "${cpaths[@]}"; do
    [ "${p:0:1}" = / ] || return 1
    cargs+=(-C "$p")
  done
  target=$(git "${cargs[@]}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -n "$target" ] && [ "$(norm "$target")" != "$PROJECT_COMMON" ]
}

KNOWN=
is_command() {
  [ -n "$KNOWN" ] || KNOWN=$NL$(git --list-cmds=builtins,main,others 2>/dev/null)$NL
  [[ $KNOWN == *"$NL$1$NL"* ]]
}
alias_key() {
  local k
  k=$(tr '[:upper:]' '[:lower:]' <<<"$1")
  case $k in alias.*) deny "git -c alias.*" alias "" "An alias set on the command line hides which command runs. Run the command itself.";; esac
}

# git's arguments in GA (expansion flags in GX), $1 the alias depth. Global options are read against
# git's own list with their arity; an option not on it, or a variable where the subcommand goes, is
# refused in a strict reading. Then the subcommand is classed.
git_cmd() {
  local depth=$1 a=("${GA[@]}") x=("${GX[@]}") n=${#GA[@]} i=0 o sub rest cpaths=() gitdir=0 v t tx
  while [ $i -lt $n ]; do
    o=${a[i]}
    if [ "${x[i]}" = 1 ]; then
      [ "$mode" = strict ] || return 0
      unreadable "a variable or \$(...) where git's options or subcommand go"
    fi
    case $o in
      -C) v=${a[i+1]}; [ "${x[i+1]}" != 1 ] || v=; cpaths+=("$v"); i=$((i + 2));;
      -C?*) cpaths+=("${o#-C}"); i=$((i + 1));;
      -c|--config-env) alias_key "${a[i+1]}"; i=$((i + 2));;
      --config-env=*) alias_key "${o#*=}"; i=$((i + 1));;
      --git-dir|--work-tree) gitdir=1; i=$((i + 2));;
      --git-dir=*|--work-tree=*|--bare) gitdir=1; i=$((i + 1));;
      --namespace|--attr-source) i=$((i + 2));;
      --namespace=*|--attr-source=*|--exec-path=*|--super-prefix=*|-p|-P|--paginate|--no-pager|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-advice) i=$((i + 1));;
      # These print and stop: no subcommand runs.
      --exec-path|--version|-v|-h|--help|--html-path|--man-path|--info-path|--list-cmds=*) return 0;;
      -*)
        [ "$mode" = strict ] || { i=$((i + 1)); continue; }
        unreadable "git's global option $o is not one the guard knows";;
      *) break;;
    esac
  done
  [ $i -lt $n ] || return 0
  sub=${a[i]} rest=("${a[@]:i+1}")
  case $sub in
    update-ref|gc|prune) scratch_ok || deny "git update-ref, gc or prune" shared-repo "" "$PLUMBING_HOW";;
    repack|pack-refs|maintenance) scratch_ok || deny "git $sub" shared-repo "" "$PLUMBING_HOW";;
    symbolic-ref)
      # One name only reads it (git symbolic-ref --short HEAD); a second name or -d writes.
      t=0
      for v in "${rest[@]}"; do case $v in -d|--delete) t=2;; -*) ;; *) t=$((t + 1));; esac; done
      [ $t -lt 2 ] || scratch_ok || deny "git symbolic-ref" shared-repo "" "$PLUMBING_HOW";;
    replace)
      # refs/replace/ lives in the shared .git and changes what every agent's git reads. The host
      # ignores it when it checks a branch, so it hides nothing there; it only misleads the others.
      case " ${rest[*]} " in "  "|*" -l "*|*" --list "*) ;; *)
        scratch_ok || deny "git replace" replace "" "Replace refs change what every agent's git reads, and the host ignores them when it checks a branch. A scratch repository under the temp dir, outside this project, may: git -C <absolute path> replace. $SCRATCH_HOW";;
      esac;;
    # refs/stash lives in the shared .git, so every worktree of a run sees one stash list: a pop can apply
    # another agent's change. list and show only read it.
    stash)
      case ${rest[0]} in list|show) ;; *)
        scratch_ok || deny "git stash" stash "" "The stash list is shared by every agent's worktree. To run a test without your change: git diff HEAD -- <files> > /tmp/p && git checkout HEAD -- <files>, run it, then git apply /tmp/p. A scratch repository under the temp dir, outside this project, may stash: git -C <absolute path> stash. $SCRATCH_HOW";;
      esac;;
    # push is refused everywhere: its danger is the destination, and a scratch repo's remote can be the shared .git.
    push) deny "git push" push "" "To test remote handling, build a bare origin under the temp dir and use git fetch, and use git -C <absolute path> for a scratch repository's own plumbing.";;
    reflog) [ "${rest[0]}" != expire ] || deny "git reflog expire" reflog-expire;;
    worktree)
      case ${rest[0]} in
        prune|repair) deny "git worktree prune or repair (git worktree remove --force is allowed)" worktree-prune;;
        # worktree add writes a record, with the container's path, into the shared .git; a pass killed before
        # its cleanup leaves it there. In a scratch repository's own .git it harms nothing.
        add) scratch_ok || deny "git worktree add in the shared repository" worktree-add "" "To compare against the base, read it: git show <base>:<path>, or git archive <base> | tar -x -C <temp dir>. A scratch repository under the temp dir takes git -C <absolute path> worktree add. $SCRATCH_HOW";;
      esac;;
    branch)
      # A flag that deletes, forces, moves or copies (bundled -fm too, and git's abbreviations of the long
      # ones), with an agent/ branch named in the same command.
      t=0 v=0
      for o in "${rest[@]}"; do
        case $o in
          --) ;;
          --*)
            o=${o#--}; o=${o%%=*}
            [ -z "$o" ] || [[ ! :delete:force:move:copy: == *:"$o"* ]] || t=1;;
          -*) case $o in *[dDfmMcC]*) t=1;; esac;;
          *agent/*) v=1;;
        esac
      done
      [ $t = 0 ] || [ $v = 0 ] || deny "deleting or moving an agent branch" agent-branch;;
    *)
      is_command "$sub" && return 0
      # An alias runs only where no command of that name exists. It is read from the config git would
      # read, at the hook's cwd, and judged as what it expands to.
      if ! v=$(git -C "$CWD" config --get "alias.$sub" 2>/dev/null); then
        [ "$mode" = strict ] || return 0
        unreadable "git $sub is neither a git command nor an alias set before this command"
      fi
      case $v in '!'*) deny "git $sub, a shell alias" alias "" "A shell alias runs a command the guard cannot read. Run the command itself.";; esac
      [ "$depth" -lt 5 ] || unreadable "aliases nested more than five deep" alias
      tokenise "$v" line
      t=() tx=()
      for o in "${TOK[@]}"; do [ "$o" != "$SEP" ] || break; t+=("$o"); tx+=(0); done
      GA=("${a[@]:0:i}" "${t[@]}" "${rest[@]}") GX=("${x[@]:0:i}" "${tx[@]}" "${x[@]:i+1}")
      git_cmd $((depth + 1));;
  esac
}

analyse "$CMD" strict 0
exit 0

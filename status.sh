#!/usr/bin/env bash
# Live view of a Sandcastle run. Sandcastle ships no UI - this reads the
# artefacts it does leave behind: log files, worktrees, branches, containers.
#
#   sandcastle status               refresh every 10s, from a project root
#   sandcastle status 0             print once and exit
#   sandcastle status 10 collapse   trim the merged/idle tail to fit
#
# The CLI sets SANDCASTLE_PROJECT, SANDCASTLE_NAME, SANDCASTLE_LABEL and
# SANDCASTLE_BASE from the project's .sandcastle/config.ts.
#
# The frame is built in memory and written in ONE go, so a refresh replaces
# the screen instead of repainting it row by row. Each row is measured in
# visible characters, never bytes: padding a string that already holds escape
# codes, or one holding a multi-byte glyph, is what used to skew the columns.
set -uo pipefail
cd "${SANDCASTLE_PROJECT:-$PWD}/.sandcastle" || exit 1
LABEL="${SANDCASTLE_LABEL:-ready-for-agent}"

export LC_ALL="${LC_ALL:-en_US.UTF-8}"

INTERVAL="${1:-10}"
SHOW_ALL="${2:-all}"   # "collapse" trims the merged/idle tail to fit the screen
BASE="${SANDCASTLE_BASE:-$(git rev-parse --abbrev-ref HEAD)}"
# docker reports CPU against ONE core, so 1399% is ~14 cores, not 14x the box.
# Shown as cores so it can be read against the host straight away.
NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 1)"

# macOS (BSD) and Linux (GNU) spell these differently; try BSD, then GNU.
mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
utc_to_epoch() { date -j -u -f '%Y-%m-%dT%H:%M:%S' "$1" '+%s' 2>/dev/null || date -u -d "$1" '+%s' 2>/dev/null || echo 0; }
epoch_fmt() { date -r "$1" "$2" 2>/dev/null || date -d "@$1" "$2" 2>/dev/null; }

bold=$'\e[1m'; off=$'\e[0m'
rule=$'\e[38;5;238m'      # frame lines
mute=$'\e[38;5;244m'      # activity text, legend
head=$'\e[38;5;250m'      # column headings, numbers
accent=$'\e[38;5;81m'     # base branch, clock
grn=$'\e[38;5;77m'        # merged
sea=$'\e[38;5;72m'        # shipped by rebase, branch never merged
ylw=$'\e[38;5;221m'       # working
cyn=$'\e[38;5;80m'        # waiting
blu=$'\e[38;5;111m'       # queued, not started
gry=$'\e[38;5;242m'       # nothing there
hot=$'\e[38;5;209m'       # a container working hard

# Pad on the PLAIN string, then colour it. Glyphs live outside the padded
# field because bash printf pads by bytes and they are multi-byte.
pad() { printf '%-*s' "$2" "$1"; }

# The one place the widths are declared. ACTIVITY takes whatever is left.
W_ISSUE=6; W_STATE=10; W_AGE=5; W_COMMITS=7; W_CPU=6; W_MEM=7
W_FIXED=$(( W_ISSUE + W_STATE + W_AGE + W_COMMITS + W_CPU + W_MEM + 8 ))

# macOS ships bash 3.2, which has neither associative arrays nor mapfile, and
# this script has to run under whatever bash the pane's PATH finds first.
# It runs on Linux too: the date/stat differences are in the helpers above. So
# the container stats are kept as "issue|cpu|mem" lines and looked up by hand.
STATS=""
S_CPU=""; S_MEM=""; S_HOT=""

stat_for() {
  local sn sc sm sh
  S_CPU=""; S_MEM=""; S_HOT=""
  [ -z "$STATS" ] && return 0
  while IFS='|' read -r sn sc sm sh; do
    if [ "$sn" = "$1" ]; then S_CPU="$sc"; S_MEM="$sm"; S_HOT="$sh"; return 0; fi
  done <<EOF
$STATS
EOF
  return 0
}

# Map running containers back to their issue. The container name is a bare
# UUID, so the only thing tying it to an issue is the worktree it mounts.
load_container_stats() {
  STATS=""
  local id name src n cpu mem hot map="" nids=0
  local -a ids=()
  while read -r id; do
    [ -n "$id" ] && { ids[nids]="$id"; nids=$((nids+1)); }
  done < <(docker ps -q --filter 'name=sandcastle-' 2>/dev/null)
  [ "$nids" -eq 0 ] && return 0

  # The container name is a bare UUID with no labels, so the only thing tying
  # it to an issue is the worktree it bind-mounts - and only a worktree of
  # THIS project: another project's run can have the same issue number.
  while read -r name src; do
    [ -z "$name" ] && continue
    n=$(printf '%s\n' $src | grep -F "$PWD/worktrees/agent-issue-" \
          | sed -nE 's#.*/worktrees/agent-issue-([0-9]+(-[a-z]+)*).*#\1#p' | head -1)
    [ -n "$n" ] && map="${map}${name#/}|${n}
"
  done < <(docker inspect "${ids[@]}" \
             --format '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null)

  while IFS='|' read -r name cpu mem; do
    [ -z "$name" ] && continue
    n=$(printf '%s' "$map" | awk -F'|' -v k="$name" '$1==k{print $2; exit}')
    [ -z "$n" ] && continue
    # "275.8MiB / 11.73GiB" -> "276M"
    mem=$(printf '%s' "${mem%%/*}" \
          | awk '{v=$1; sub(/iB$/,"",v);
                  u=substr(v,length(v),1); q=substr(v,1,length(v)-1);
                  printf "%.0f%s", q, u}')
    # "1399.02%" -> "14.0c", flagged hot past 80% of the host's cores.
    cpu=$(printf '%s' "$cpu" \
          | awk -v ncpu="$NCPU" '{p=$0; sub(/%$/,"",p); c=p/100;
                                  printf "%.1fc|%d", c, (c >= ncpu*0.8 ? 1 : 0)}')
    hot="${cpu##*|}"; cpu="${cpu%%|*}"
    STATS="${STATS}${n}|${cpu}|${mem}|${hot}
"
  done < <(docker stats --no-stream \
             --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' "${ids[@]}" 2>/dev/null)
  return 0
}

# The queue is every open `ready-for-agent` issue: the orchestrator removes
# the label when it merges, so the label means "queued or in flight". An issue
# has no log until its sandbox starts, so without this the queue is invisible.
# gh is a network call, so it is cached and re-read at most once a minute.
# It is called from the refresh loop, never from render: render runs in a
# $(...) subshell, where the cache timestamp is thrown away on every frame.
#
# The same call reads each queued issue's body for `Blocked by #N` /
# `Depends on #N` (the orchestrator's pattern, burndown.ts), so an issue held
# back by an open dependency shows as blocked before, between and outside
# runs - not only while the run that decided it is live. QUEUE_DEPS holds
# "issue|#dep, #dep" lines for the dependencies still open, and QUEUE_UPDATED
# "issue|epoch" lines for when each issue last changed.
QUEUE=""; QUEUE_DEPS=""; QUEUE_UPDATED=""; QUEUE_AT=0; QUEUE_RUN=""
load_queue() {
  local t run json n d deps on state known=""
  t=$(date +%s)
  # A run rewrites run.json when it starts and when it exits, having closed
  # what it landed: refetch then, rather than show a stale queue for a minute.
  run=$(mtime_of logs/run.json)
  [ $(( t - QUEUE_AT )) -lt 60 ] && [ "$run" = "$QUEUE_RUN" ] && return 0
  QUEUE_AT="$t"; QUEUE_RUN="$run"; QUEUE_DEPS=""
  json=$(gh issue list --label "$LABEL" --state open --limit 100 --json number,body,updatedAt 2>/dev/null) || { QUEUE=""; QUEUE_UPDATED=""; return 0; }
  QUEUE=$(jq -r '.[].number' <<<"$json" 2>/dev/null | sort -n)
  QUEUE_UPDATED=$(jq -r '.[] | select(.updatedAt) | "\(.number)|\(.updatedAt | fromdateiso8601)"' <<<"$json" 2>/dev/null)
  while IFS='|' read -r n deps; do
    [ -z "$deps" ] && continue
    on=""
    for d in $deps; do
      # A queued dependency is open by definition; any other is asked once per
      # refresh. One that cannot be read counts as open, as in the orchestrator.
      if in_queue "$d"; then
        state=open
      else
        state=$(printf '%s\n' "$known" | awk -F'|' -v k="$d" '$1==k{print $2; exit}')
        if [ -z "$state" ]; then
          state=$(gh api "repos/{owner}/{repo}/issues/$d" --jq .state 2>/dev/null) || state=unreadable
          known="${known}${d}|${state}
"
        fi
      fi
      [ "$state" = closed ] || on="${on}${on:+, }#${d}"
    done
    [ -n "$on" ] && QUEUE_DEPS="${QUEUE_DEPS}${n}|${on}
"
  done < <(jq -r '.[] | "\(.number)|\([(.body // "") | scan("(?i)(?:blocked by|depends on):?\\s+#(\\d+)")[0] | tonumber] | unique | join(" "))"' <<<"$json" 2>/dev/null)
  return 0
}
in_queue() { grep -qx "$1" <<<"$QUEUE"; }

# The orchestrator writes logs/run.json: which one, since when, which models,
# and on a clean exit when it finished. A pid that is gone without a
# finishedAt is a run that was killed.
# Machine-wide slots (pool.ts): one lock file per slot, holding its owner's
# pid. Counts live ones only; the limits come from the CLI.
pool_line() {
  local dir="${XDG_CACHE_HOME:-$HOME/.cache}/sandcastle-kit/slots" pool used f pid out=""
  for pool in sandboxes gates; do
    used=0
    for f in "$dir/$pool"-*.lock; do
      [ -f "$f" ] || continue
      pid=$(cut -d' ' -f1 "$f")
      kill -0 "$pid" 2>/dev/null && used=$((used+1))
    done
    case "$pool" in sandboxes) lim="${SANDCASTLE_MAX_SANDBOXES:-6}";; gates) lim="${SANDCASTLE_MAX_GATES:-2}";; esac
    out="${out}${out:+ · }${pool} ${used}/${lim}"
  done
  printf '%s' "$out"
}

# Whether the recorded run is alive (RUN_LIVE=1), and while it is, its
# "issue|#dep, #dep" lines from run.json's `waiting`.
WAITING=""; RUN_LIVE=0
load_waiting() {
  WAITING=""; RUN_LIVE=0
  local f=logs/run.json pid
  [ -f "$f" ] || return 0
  pid=$(jq -r 'if .finishedAt then empty else (.pid // empty) end' "$f" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0
  RUN_LIVE=1
  WAITING=$(jq -r '(.waiting // [])[] | "\(.issue)|\([.on[] | "#\(.)"] | join(", "))"' "$f" 2>/dev/null)
  return 0
}
# A merged issue that is open and labelled again was re-queued after its
# merge - or it only looks that way: landing merges before it closes the
# issue, and GitHub's labelled-issue listing can trail a close by a while
# after the run has ended. Only a change to the issue after the merge commit
# the orchestrator wrote counts. With no such merge commit (rebased, or merged
# by hand) the listing is taken at its word.
requeued() {
  local updated merged
  merged=$(git log "$BASE" -1 --format=%ct --fixed-strings --grep="Merge agent/issue-$1 (closes #$1)" 2>/dev/null)
  [ -z "$merged" ] && return 0
  updated=$(printf '%s\n' "$QUEUE_UPDATED" | awk -F'|' -v k="$1" '$1==k{print $2; exit}')
  [ -n "$updated" ] && [ "$updated" -gt "$merged" ]
}

# What an issue waits for: the live run's own decision first - it will not
# start the issue this run even if the dependency closes meanwhile - then the
# issue body's open dependencies. Empty when nothing holds it back.
blocked_on() {
  local on
  on=$(printf '%s\n' "$WAITING" | awk -F'|' -v k="$1" '$1==k{print $2; exit}')
  [ -z "$on" ] && on=$(printf '%s\n' "$QUEUE_DEPS" | awk -F'|' -v k="$1" '$1==k{print $2; exit}')
  printf '%s' "$on"
}

label() { printf '%s%s%s %s│%s ' "$accent" "$(pad "$1" 7)" "$off" "$rule" "$off"; }

run_line() {
  local f=logs/run.json orch pid started finished code models
  [ -f "$f" ] || { printf '%s' "${mute}no run recorded yet${off}"; return 0; }
  # A unit separator, not a tab: read collapses runs of whitespace IFS, so an
  # empty finishedAt would shift every later field.
  IFS=$'\x1f' read -r orch pid started finished code models < <(jq -r \
    '[.orchestrator, (.pid|tostring), .startedAt, (.finishedAt // ""), (.exitCode // "" | tostring), .models] | join("\u001f")' "$f")
  started=$(epoch_fmt "$(utc_to_epoch "${started%%.*}")" '+%d %b %H:%M')
  if [ -n "$finished" ]; then
    printf '%s' "${mute}last one from ${started}, ended (exit ${code})${off}"
  elif kill -0 "$pid" 2>/dev/null; then
    printf '%s' "${ylw}running${off} ${mute}since ${started}${off}"
  else
    printf '%s' "${hot}killed${off} ${mute}from ${started}, no clean exit${off}"
  fi
}

models_line() {
  [ -f logs/run.json ] || return 0
  jq -r '.models // empty' logs/run.json 2>/dev/null
}

render() {
  local now issues n phase log age commits state glyph colour activity activity_note rendered
  local merged_list cols rows w_act line prio cpu mem cpu_col budget shown hidden
  local c_work=0 c_stand=0 c_merged=0 c_idle=0 c_queue=0 mtime q quiet act_col on qstate qglyph qtext live_wt kept_wt models
  local -a out=()
  local n_out=0

  # render runs inside $(...) piped to awk, so stdout is not the terminal and
  # tput falls back to 80x24. The loop reads the real size from /dev/tty.
  cols="${TERM_COLS:-${COLUMNS:-}}"
  [[ "$cols" =~ ^[0-9]+$ ]] || cols=$(tput cols 2>/dev/null || echo 100)
  [ "$cols" -lt 60 ] && cols=60
  rows="${TERM_ROWS:-}"
  [[ "$rows" =~ ^[0-9]+$ ]] || rows=$(tput lines 2>/dev/null || echo 40)
  w_act=$(( cols - W_FIXED ))

  now=$(date +%H:%M:%S)
  load_container_stats
  load_waiting
  merged_list=$(git branch --merged "$BASE" --list 'agent/issue-*' 2>/dev/null)

  line="${rule}$(printf "%${cols}s" '' | tr ' ' '─')${off}"

  # Keyed by the branch slug, not the bare number: step D of the mobile pass
  # runs on agent/issue-1086-closeout while agent/issue-1086 is long merged, and
  # keying both on 1086 hid the live sandbox under the merged row.
  issues=$(ls logs/agent-issue-*.log 2>/dev/null \
    | sed -nE 's#.*agent-issue-([0-9]+(-[a-z]+)*)-(impl|review|repair)-.*#\1#p' | sort -u)

  # Queued issues with no log yet get a row of their own.
  for q in $QUEUE; do
    grep -qx "$q" <<<"$issues" && continue
    # Held back by an open dependency, not waiting for a sandbox.
    on=$(blocked_on "$q")
    if [ -n "$on" ]; then
      qstate="blocked"; qglyph="◌"; qtext="waiting for $on to close"
    else
      qstate="queued"; qglyph="○"; qtext="waiting for a sandbox"
    fi
    rendered=$(printf '%s%s%s %s%s %s%s %s%s%s %s%s%s %s%s%s %s%s%s %s%s%s' \
      "$head" "$(pad "#$q" $W_ISSUE)" "$off" \
      "$blu" "$qglyph" "$(pad "$qstate" $W_STATE)" "$off" \
      "$gry" "$(pad - $W_AGE)" "$off" \
      "$gry" "$(pad - $W_COMMITS)" "$off" \
      "$gry" "$(pad - $W_CPU)" "$off" \
      "$gry" "$(pad - $W_MEM)" "$off" \
      "$mute" "$qtext" "$off")
    out[n_out]="2	0	$q	$rendered"; n_out=$((n_out+1)); c_queue=$((c_queue+1))
  done

  for n in $issues; do
    log=$(ls -t logs/agent-issue-"$n"-impl-*.log logs/agent-issue-"$n"-review-*.log logs/agent-issue-"$n"-repair-*.log 2>/dev/null | head -1)
    [ -z "$log" ] && continue
    case "$log" in *-review-codex-*) phase="codex";; *-review-*) phase="review";; *-repair-*) phase="repair";; *) phase="impl";; esac

    mtime=$(mtime_of "$log")
    age=$(( $(date +%s) - mtime ))
    if   [ "$age" -lt 60 ]; then age="${age}s"
    elif [ "$age" -lt 3600 ]; then age="$((age/60))m"
    else age="$((age/3600))h"; fi

    commits=$(git rev-list --count "${BASE}..agent/issue-$n" 2>/dev/null || echo 0)

    # Order matters: a branch with no commits yet is trivially "merged",
    # so an in-flight worktree has to win over the merged check.
    stat_for "$n"
    quiet=0; act_col="$mute"; activity_note=""
    # A worktree is live work only while a container holds it or its run is
    # alive. Sandcastle keeps a closed sandbox's worktree when it has
    # uncommitted files (a setup step's lockfile, say); that one is shown by
    # its branch's state, with a note, not as working forever.
    live_wt=0; kept_wt=0
    if [ -d "worktrees/agent-issue-$n" ]; then
      if [ -n "$S_CPU" ] || [ "$RUN_LIVE" = 1 ]; then live_wt=1; else kept_wt=1; fi
    fi
    if [ "$live_wt" = 1 ] && [ -z "$S_CPU" ] && [ $(( $(date +%s) - mtime )) -ge 1800 ]; then
      # A worktree with no container and a log quiet for 30 minutes is a run
      # that died or was killed, not one in flight.
      state="stalled"; glyph='!'; colour="$hot"; prio=1; c_stand=$((c_stand+1))
    elif [ "$live_wt" = 1 ]; then
      state="$phase"; glyph='●'; colour="$ylw"; prio=0; c_work=$((c_work+1))
      quiet=$(( $(date +%s) - mtime ))
    elif ! git show-ref -q --verify "refs/heads/agent/issue-$n"; then
      state="no branch"; glyph='·'; colour="$gry"; prio=4; c_idle=$((c_idle+1))
    elif [ "$commits" -gt 0 ] && ! git cherry "$BASE" "agent/issue-$n" 2>/dev/null | grep -q '^+'; then
      # Every commit has an equivalent patch already on the base. The
      # orchestrator rebased instead of merging, so --merged cannot see it:
      # the work SHIPPED and the branch is a duplicate, not pending work.
      state="shipped"; glyph='✓'; colour="$sea"; prio=3; c_merged=$((c_merged+1))
    elif [ "$commits" -gt 0 ]; then
      state="waiting"; glyph='◆'; colour="$cyn"; prio=1; c_stand=$((c_stand+1))
    elif grep -q "agent/issue-${n}$" <<<"$merged_list"; then
      state="merged"; glyph='✓'; colour="$grn"; prio=3; c_merged=$((c_merged+1))
    else
      state="no commits"; glyph='·'; colour="$gry"; prio=4; c_idle=$((c_idle+1))
    fi
    # Back on the queue after an earlier run: it is queued, not done.
    if [ "$prio" -ge 3 ] && in_queue "$n" && requeued "$n"; then
      case "$prio" in 3) c_merged=$((c_merged-1));; 4) c_idle=$((c_idle-1));; esac
      state="queued"; glyph='○'; colour="$blu"; prio=2; c_queue=$((c_queue+1))
      on=$(blocked_on "$n")
      if [ -n "$on" ]; then
        state="blocked"; glyph='◌'
        activity_note="waiting for $on to close"
      fi
    fi

    cpu="$S_CPU"; mem="$S_MEM"
    # Colour the CPU figure only when it is high enough to be worth noticing.
    cpu_col="$head"
    if [ -z "$cpu" ]; then
      cpu="-"; mem="-"; cpu_col="$gry"
    elif [ "$S_HOT" = "1" ]; then
      cpu_col="$hot"
    fi

    # Last line that says something: a tool call or a sentence, not framing.
    # Then make it readable - the raw line is agent transcript, not a status.
    activity=$(grep -avE '^\s*$|^(Agent|Run|Capturing|Collecting|Syncing|Context)' "$log" 2>/dev/null \
      | tail -1 \
      | sed -E \
        -e 's#^<promise>COMPLETE</promise>$#agent finished#' \
        -e 's#^<promise>.*</promise>$#agent reported back#' \
        -e 's#^No commits to sync out.*#nothing to sync out#' \
        -e 's#^Bash\((.*)#$ \1#' \
        -e 's#^(Read|Edit|Write|Grep|Glob)\((.*)#\1 \2#' \
        -e 's#\)$##' \
        -e 's#^[-*|>[:space:]]+##' \
        -e 's#\*\*##g' -e 's#`##g' \
        -e 's#[[:space:]]+# #g' -e 's#^ ##' \
      | cut -c1-"$w_act")
    [ "$kept_wt" = 1 ] && activity=$(printf 'worktree kept (uncommitted files) - %s' "$activity" | cut -c1-"$w_act")
    [ -n "$activity_note" ] && activity=$(printf '%s' "$activity_note" | cut -c1-"$w_act")
    # A live sandbox whose log has been silent for ten minutes may be thinking
    # or may be hung; either way it is worth a look before the 30-minute
    # stalled mark or the agent's own idle timeout.
    if [ "$quiet" -ge 600 ]; then
      activity=$(printf 'quiet %sm - %s' "$((quiet/60))" "$activity" | cut -c1-"$w_act")
      act_col="$hot"
    fi
    # A spent Max plan allowance makes the orchestrator report a trust-dialog
    # error or `exited with code 1`; the real cause is only in the log tail.
    # Only on an unfinished row: a merged branch's old log keeps the line.
    if [ "$prio" -le 1 ] && tail -5 "$log" 2>/dev/null | grep -qiE "out of usage credits|usage limit|limit reached"; then
      activity="USAGE LIMIT REACHED - $phase model"
      glyph='!'; colour="$hot"
    fi
    # A suffixed branch shows its number in ISSUE and its suffix here.
    [ "$n" != "${n%%-*}" ] && activity=$(printf '[%s] %s' "${n#*-}" "$activity" | cut -c1-"$w_act")

    rendered=$(printf '%s%s%s %s%s %s%s %s%s%s %s%s%s %s%s%s %s%s%s %s%s%s' \
      "$head" "$(pad "#${n%%-*}" $W_ISSUE)" "$off" \
      "$colour" "$glyph" "$(pad "$state" $W_STATE)" "$off" \
      "$head" "$(pad "$age" $W_AGE)" "$off" \
      "$head" "$(pad "$commits" $W_COMMITS)" "$off" \
      "$cpu_col" "$(pad "$cpu" $W_CPU)" "$off" \
      "$head" "$(pad "$mem" $W_MEM)" "$off" \
      "$act_col" "$activity" "$off")
    out[n_out]="$prio	$mtime	$n	$rendered"; n_out=$((n_out+1))
  done

  printf '%s\n' "$line"
  printf '%s\n' " ${bold}Sandcastle${off} ${head}${SANDCASTLE_NAME:-}${off}  ${rule}│${off}  base ${accent}${BASE}${off}  ${rule}│${off}  ${ylw}${c_work} working${off} · ${cyn}${c_stand} waiting${off} · ${blu}${c_queue} queued${off} · ${grn}${c_merged} done${off} · ${gry}${c_idle} idle${off}  ${rule}│${off}  ${accent}${now}${off}"
  # Label, then a dim pipe, then the value: the label column reads as the
  # row's title at a glance.
  printf '%s\n' " $(label run)$(run_line)"
  models=$(models_line)
  [ -n "$models" ] && printf '%s\n' " $(label models)${mute}${models}${off}"
  printf '%s\n' " $(label machine)${mute}$(pool_line)${off}"
  printf '%s\n' "$line"
  printf '%s%s %s %s %s %s %s %s%s\n' "$head" \
    "$(pad ISSUE $W_ISSUE)" "  $(pad STATE $W_STATE)" "$(pad AGE $W_AGE)" \
    "$(pad COMMITS $W_COMMITS)" "$(pad CPU $W_CPU)" "$(pad MEM $W_MEM)" ACTIVITY "$off"

  if [ "$n_out" -eq 0 ]; then
    printf '%s\n' " ${mute}(no runs yet)${off}"
  else
    # Working, waiting, then queued - everything not finished - and within a
    # group the most recent log first. The merged and idle tail is what makes
    # the list outgrow the screen, so it gets cut, oldest first.
    # Frame overhead is 10 rows: rule, title, run, models, machine, rule,
    # headings, rule, legend, note. Every other row is a table row, and the
    # "+N hidden" line only takes one when something is actually hidden.
    budget=$(( rows - 10 )); shown=0; hidden=0
    [ "$SHOW_ALL" = "all" ] && budget="$n_out"
    [ "$budget" -lt 3 ] && budget=3
    [ "$n_out" -gt "$budget" ] && budget=$(( budget - 1 ))
    while IFS=$'\t' read -r prio mtime n rendered; do
      if [ "$shown" -lt "$budget" ]; then
        printf '%s\n' "$rendered"; shown=$((shown+1))
      else
        hidden=$((hidden+1))
      fi
    done < <(printf '%s\n' "${out[@]}" | sort -t$'\t' -k1,1n -k2,2nr -k3,3n)
    [ "$hidden" -gt 0 ] && printf '%s\n' " ${gry}+${hidden} more hidden to fit the pane (oldest finished first)${off}"
  fi

  printf '%s\n' "$line"
  printf '%s\n' " ${ylw}● working${off}  ${cyn}◆ waiting${off}  ${hot}! stalled${off}  ${blu}○ queued  ◌ blocked${off}  ${grn}✓ merged${off}  ${sea}✓ shipped (rebased)${off}  ${gry}· idle${off}"
  printf '%s\n' " ${mute}◆ finished, not merged: dry run or red gate · age = since last log write · CPU in cores of ${NCPU}${off}"
}

if [ "$INTERVAL" = "0" ]; then load_queue; render; exit 0; fi

# Alternate screen + hidden cursor, restored on exit. INT and TERM must exit
# explicitly: a handler that only restores the screen returns into the loop,
# which leaves Ctrl-C unable to stop the script at all.
restore() { printf '\e[?25h\e[?1049l'; }
trap restore EXIT
trap 'restore; exit 130' INT TERM
printf '\e[?1049h\e[?25l\e[2J'

# Redraw straight away on a pane resize instead of waiting out the interval.
SLEEP_PID=""
trap '[ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null' WINCH

while true; do
  size=$(stty size </dev/tty 2>/dev/null)
  TERM_ROWS="${size%% *}"; TERM_COLS="${size##* }"
  export TERM_ROWS TERM_COLS
  load_queue
  # Build the whole frame first, then write it in a single call. \e[K clears
  # each line's remainder and \e[J the rows below, so nothing has to be
  # blanked first - no flash, and no visible row-by-row repaint.
  # stderr is swallowed: a stray warning printed mid-frame lands wherever the
  # cursor happens to be and corrupts the screen.
  frame=$(render 2>>"${STATUS_ERRLOG:-/dev/null}" | awk '{printf "%s\033[K\n", $0}')
  printf '\e[H%s\e[J' "$frame"
  sleep "$INTERVAL" & SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null
done

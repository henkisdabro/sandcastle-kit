#!/usr/bin/env bash
# Live view of a Sandcastle run. Sandcastle ships no UI - this reads the
# artefacts it does leave behind: log files, worktrees, branches, containers.
#
#   sandcastle status               refresh every 10s, from a project root; every
#                                   frame fits the pane, the overflow summarised
#   sandcastle status 0             print once and exit, every row
#   sandcastle status 10 all        refresh, every row even past the pane
#
# The CLI sets SANDCASTLE_PROJECT, SANDCASTLE_NAME and SANDCASTLE_BASE from
# the project's .sandcastle/config.ts.
#
# The frame is built in memory and written in ONE go, so a refresh replaces
# the screen instead of repainting it row by row. Each row is measured in
# visible characters, never bytes: padding a string that already holds escape
# codes, or one holding a multi-byte glyph, is what used to skew the columns.
set -uo pipefail
# Every record the view reads is parsed with jq. Without it each read failed
# silently and the view showed an empty queue and no runs. `--version` rather
# than `command -v`: a jq that is on PATH but does not run is as good as none.
jq --version >/dev/null 2>&1 || { echo "status needs jq (apt install jq / brew install jq)" >&2; exit 1; }
cd "${SANDCASTLE_PROJECT:-$PWD}/.sandcastle" || exit 1

# Widths are counted in characters, which bash does only in a UTF-8 locale:
# under C every box-drawing character counted three and the grid came apart.
# The view writes UTF-8 whatever the locale, so it measures in one too.
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;;
  *) LC_ALL=$(locale -a 2>/dev/null | grep -iE '^(c|en_US)\.utf-?8$' | head -1); export LC_ALL="${LC_ALL:-en_US.UTF-8}";;
esac

INTERVAL="${1:-10}"
# A live frame taller than its pane scrolls its own top - the header and the
# working rows - out of sight. So the refreshing view fits the pane unless
# asked for "all"; a one-off snapshot (0) prints everything.
if [ "$INTERVAL" = "0" ]; then SHOW_ALL="${2:-all}"; else SHOW_ALL="${2:-collapse}"; fi
BASE="${SANDCASTLE_BASE:-$(git rev-parse --abbrev-ref HEAD)}"
# docker reports CPU against ONE core, so 1399% is ~14 cores, not 14x the box.
# Shown as cores so it can be read against the host straight away.
NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 1)"

# macOS (BSD) and Linux (GNU) spell these differently; try BSD, then GNU.
mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
utc_to_epoch() { date -j -u -f '%Y-%m-%dT%H:%M:%S' "$1" '+%s' 2>/dev/null || date -u -d "$1" '+%s' 2>/dev/null || echo 0; }
epoch_fmt() { date -r "$1" "$2" 2>/dev/null || date -d "@$1" "$2" 2>/dev/null; }

# "Sand": the frame in dark, muted browns and its text in lighter sand, so the
# state colours, which carry meaning, stand out against it. 24-bit where the terminal says it
# has it (COLORTERM); the 256-colour palette has almost no dark browns, so
# elsewhere the nearest of its colours.
if [ "${COLORTERM:-}" = truecolor ] || [ "${COLORTERM:-}" = 24bit ]; then
  sand() { printf '\e[38;2;%sm' "$1"; }
else
  sand() { printf '\e[38;5;%sm' "$2"; }
fi
bold=$'\e[1m'; off=$'\e[0m'
rule=$(sand '74;58;42' 58)       # frame lines: wet sand
mute=$(sand '146;124;94' 137)    # activity text, labels
head=$(sand '205;184;148' 180)   # column headings, numbers: dry sand
accent=$(sand '192;164;120' 180)  # base branch, clock, stage
wht=$(sand '232;214;180' 223)    # ticket ids
grn=$'\e[38;5;77m'        # merged
ylw=$'\e[38;5;221m'       # working
cyn=$'\e[38;5;80m'        # ready to land
blu=$'\e[38;5;111m'       # queued, not started
gry=$(sand '94;78;60' 95)        # nothing there: damp sand
hot=$'\e[38;5;203m'       # needs you; a container working hard (red, clear of the sand)
# The logo: dry sand at the top, wet sand at the base, specks of shell.
moon=$(sand '232;214;180' 223); dusk=$(sand '205;184;148' 180); night=$(sand '160;134;98' 137); deep=$(sand '112;92;66' 95); star=$(sand '74;58;42' 58)
# No colour when NO_COLOR is set (non-empty, no-color.org) or stdout is not a
# terminal. Top level on purpose: the live loop calls render inside $(...),
# where stdout is always a pipe, so the check there would always strip colour.
if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then bold=''; off=''; rule=''; mute=''; head=''; accent=''; wht=''; grn=''; ylw=''; cyn=''; blu=''; gry=''; hot=''; moon=''; dusk=''; night=''; deep=''; star=''; fi
# Inside Herdr each ticket links to its latest log (OSC 8). With the kit's Herdr plugin
# linked, Ctrl-click opens that log in a popup; without it, Herdr does nothing with the
# click. No links elsewhere or into a pipe. SANDCASTLE_LINKS=1 or 0 overrides (the tests).
LINKS="${SANDCASTLE_LINKS:-}"
if [ -z "$LINKS" ]; then if [ "${HERDR_ENV:-}" = 1 ] && [ -t 1 ]; then LINKS=1; else LINKS=0; fi; fi

# Visible width, and a cut to a width, of a string holding colour codes. The
# terminal's own clipping (line wrap is off) cut the header mid-word in a
# narrow pane; this cuts at the width with an ellipsis instead. Pure bash, as
# neither macOS awk nor mawk counts multi-byte characters.
shopt -s extglob
ESC=$'\e'
# A hyperlink's opener or closer (OSC 8, ended by ESC \) has no width of its own.
ST=$'\e\\'
# $1 without its colour codes and link markers, into VS. Plain prefix and suffix cuts,
# no extglob: macOS's bash 3.2 matched `*([0-9;])`-style patterns so slowly that one
# frame of a 191-column pane took 12 seconds, and the plugin's popup gets that bash
# whenever Herdr's PATH puts /usr/bin first.
vstrip() {
  local s="$1" r p; VS=""
  while [[ $s == *"$ESC"* ]]; do
    VS="$VS${s%%"$ESC"*}"; s="${s#*"$ESC"}"
    if [[ $s == "]8;"* ]]; then
      s="${s#*"$ST"}"
    elif [[ $s == "["* ]]; then
      r="${s:1}"; p="${r%%[!0-9;]*}"
      if [ "${r:${#p}:1}" = m ]; then s="${r:$(( ${#p} + 1 ))}"; else VS="$VS$ESC"; fi
    else
      VS="$VS$ESC"
    fi
  done
  VS="$VS$s"
}
vis() { vstrip "$1"; printf '%s' "${#VS}"; }
fit() {
  local s="$1" w="$2" out="" n=0 esc
  if [ "$(vis "$s")" -le "$w" ]; then printf '%s' "$s"; return 0; fi
  while [ -n "$s" ] && [ "$n" -lt $(( w - 1 )) ]; do
    if [ "${s:0:2}" = "${ESC}]" ]; then
      # A link's URL can hold an "m"; it ends at ESC \, not at the first m.
      esc="${s%%"$ST"*}$ST"; out="${out}${esc}"; s="${s:${#esc}}"
    elif [ "${s:0:1}" = "$ESC" ]; then
      esc="${s%%m*}m"; out="${out}${esc}"; s="${s:${#esc}}"
    else
      out="${out}${s:0:1}"; s="${s:1}"; n=$((n+1))
    fi
  done
  # A cut through a link's text would leave it open over the rest of the line.
  case "$out" in *"${ESC}]8"*) out="${out}${ESC}]8;;${ST}";; esac
  printf '%s…%s' "$out" "$off"
}

# ---------------------------------------------------------------------------
# The grid. The whole view is one window: every band is split into cells that
# span the pane, and the rules between bands join the bars above and below.
# The helpers return in REPLY rather than print, so a frame of a few hundred
# cells costs no subshell per cell.

# Visible width into VN, as vis gives it, without a subshell.
vlen() { vstrip "$1"; VN=${#VS}; }
# A coloured string aligned in $2 columns (l, c or r), cut with … when longer.
align() {
  local s="$1" w="$2" l
  [ "$w" -le 0 ] && { REPLY=""; return 0; }
  vlen "$s"
  if [ "$VN" -gt "$w" ]; then REPLY=$(fit "$s" "$w"); return 0; fi
  case "${3:-l}" in
    r) printf -v REPLY '%*s%s' $(( w - VN )) '' "$s";;
    c) l=$(( (w - VN) / 2 )); printf -v REPLY '%*s%s%*s' "$l" '' "$s" $(( w - VN - l )) '';;
    *) printf -v REPLY '%s%*s' "$s" $(( w - VN )) '';;
  esac
}
# $1 repeated $2 times. Not `tr`: GNU tr maps bytes, so a multi-byte glyph
# came out as a bare e2 per column on Linux. Bash substitution is byte-safe.
rep() { local p; printf -v p '%*s' "$2" ''; REPLY="${p// /$1}"; }
# Split $1 columns by the weights that follow into OW (each cell's width).
# Cumulative rounding spreads the remainder over the cells.
split_w() {
  local total=$1 sum=0 w i=0 cum=0 prev=0 at; shift
  for w in "$@"; do sum=$(( sum + w )); done
  OW=()
  for w in "$@"; do cum=$(( cum + w )); at=$(( (total * cum * 2 + sum) / (sum * 2) )); OW[i]=$(( at - prev )); prev=$at; i=$((i+1)); done
}
# The same across the window: its width less the n+1 bars of n cells.
split_cols() { split_w $(( WIN - $# - 1 )) "$@"; }
# One row of cells - OW widths, CELL contents, AL alignments - into REPLY.
cells_line() {
  local i out="${rule}│${off}"
  for (( i=0; i<${#OW[@]}; i++ )); do
    align "${CELL[i]:-}" $(( OW[i] - 2 )) "${AL[i]:-l}"
    out="${out} ${REPLY} ${rule}│${off}"
  done
  REPLY="$out"
}
# The inner bar positions of the current OW, computed once per band.
bars_of() { local p=0 i; BARS=""; for (( i=0; i<${#OW[@]}-1; i++ )); do p=$(( p + OW[i] + 1 )); BARS="$BARS $p"; done; BARS="${BARS# }"; }
# A rule across the window whose joints meet the bars above ($4) and below
# ($5): $1 left end, $2 right end, $3 fill (─ or ═). Into REPLY.
junction() {
  local f="$3" up=" $4 " dn=" $5 " i out="" a b x y z
  if [ "$f" = ═ ]; then x='╪'; y='╧'; z='╤'; else x='┼'; y='┴'; z='┬'; fi
  for (( i=1; i<WIN-1; i++ )); do
    a=0; b=0; [[ "$up" == *" $i "* ]] && a=1; [[ "$dn" == *" $i "* ]] && b=1
    if [ $a = 1 ] && [ $b = 1 ]; then out="$out$x"
    elif [ $a = 1 ]; then out="$out$y"
    elif [ $b = 1 ]; then out="$out$z"
    else out="$out$f"; fi
  done
  REPLY="${rule}$1${out}$2${off}"
}
# A muted key in a 10-column field, then its value.
kvl() { local k="$1"; printf -v k '%-10s' "$k"; REPLY="${mute}${k}${off}$2"; }
# A slot gauge, █████░ 5/6; only the count past a dozen slots.
gauge() {
  local g=""
  if [ "$2" -le 12 ] 2>/dev/null; then rep █ "$1"; g="${ylw}${REPLY}"; rep ░ $(( $2 - $1 )); g="${g}${rule}${REPLY}${off} "; fi
  REPLY="${g}${head}$1/$2${off}"
}
# The frame being built: each line appended and counted, written in one go.
put() { BUF="${BUF}$1
"; BUF_N=$((BUF_N+1)); }
# Items joined by " · " into as few lines of $1 columns as they fit, into the
# WRAPPED array: the note's last clause was cut off in a narrow pane.
wrap_items() {
  local w="$1" sep="${gry} · ${off}" line="" item; shift
  WRAPPED=()
  for item in "$@"; do
    vlen "$line$sep$item"
    if [ -z "$line" ]; then line="$item"
    elif [ "$VN" -le "$w" ]; then line="$line$sep$item"
    else WRAPPED[${#WRAPPED[@]}]="$line"; line="$item"; fi
  done
  [ -n "$line" ] && WRAPPED[${#WRAPPED[@]}]="$line"
  return 0
}

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
  local id name line n cpu mem hot map="" nids=0
  local -a ids=()
  while read -r id; do
    [ -n "$id" ] && { ids[nids]="$id"; nids=$((nids+1)); }
  done < <(docker ps -q --filter 'name=sandcastle-' 2>/dev/null)
  [ "$nids" -eq 0 ] && return 0

  # The container name is a bare UUID with no labels, so the only thing tying
  # it to an issue is the worktree it bind-mounts - and only a worktree of
  # THIS project: another project's run can have the same issue number.
  # "|" between the fields, not a space: a project path with a space in it
  # split into pieces that matched no worktree, and its rows lost their stats.
  while IFS= read -r line; do
    name="${line%%|*}"
    [ -z "$name" ] && continue
    n=$(printf '%s\n' "${line#*|}" | tr '|' '\n' | grep -F "$PWD/worktrees/agent-issue-" \
          | sed -nE 's#.*/worktrees/agent-issue-([a-z0-9][a-z0-9-]*).*#\1#p' | head -1)
    [ -n "$n" ] && map="${map}${name#/}|${n}
"
  done < <(docker inspect "${ids[@]}" \
             --format '{{.Name}}{{range .Mounts}}|{{.Source}}{{end}}' 2>/dev/null)

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
# Why the queue could not be read, or empty. A signed-out gh or a stale token
# used to blank the queue with no word, which read as "nothing is queued".
QUEUE_ERR=""
load_queue() {
  local t run json errf
  t=$(date +%s)
  # A run rewrites run.json when it starts and when it exits, having closed
  # what it landed: refetch then, rather than show a stale queue for a minute.
  run=$(mtime_of logs/run.json)
  [ $(( t - QUEUE_AT )) -lt 60 ] && [ "$run" = "$QUEUE_RUN" ] && return 0
  QUEUE_AT="$t"; QUEUE_RUN="$run"; QUEUE_DEPS=""; QUEUE_ERR=""
  # The kit reads whichever tracker the project uses, and resolves each
  # ticket's blockers the way a run does (GitHub, Linear, ticket files).
  # stderr goes to a file, not into the JSON: a warning on a good read must not
  # spoil it, and on a failed one it is the reason to show.
  errf=$(mktemp "${TMPDIR:-/tmp}/sandcastle-status.XXXXXX" 2>/dev/null) || errf=/dev/null
  if json=$("${SANDCASTLE_BIN:-sandcastle}" queue --json 2>"$errf"); then
    if jq -e 'type == "array"' <<<"$json" >/dev/null 2>&1; then
      QUEUE=$(jq -r '.[].id' <<<"$json" 2>/dev/null | sort -V)
      QUEUE_UPDATED=$(jq -r '.[] | select(.updated) | "\(.id)|\(.updated)"' <<<"$json" 2>/dev/null)
      QUEUE_DEPS=$(jq -r '.[] | select(.blockedOn | length > 0) | "\(.id)|\(.blockedOn | join(", "))"' <<<"$json" 2>/dev/null)
      [ "$errf" = /dev/null ] || rm -f "$errf"
      return 0
    fi
    QUEUE_ERR="the queue was not a list of tickets"
  else
    # The first line that says something; control characters out, so an
    # escape code in a message cannot move the cursor mid-frame.
    QUEUE_ERR=$(tr -d '\000-\010\013-\037' <"$errf" 2>/dev/null | grep -m1 '[^[:space:]]')
    [ -n "$QUEUE_ERR" ] || QUEUE_ERR="sandcastle queue failed"
  fi
  QUEUE=""; QUEUE_UPDATED=""
  [ "$errf" = /dev/null ] || rm -f "$errf"
  return 0
}
in_queue() { grep -qx "$1" <<<"$QUEUE"; }
# The .jsonl sidecars (each pass's raw agent stream) are deliberately not matched here or by any log glob below.
# Ticket ids from log names, one per line. A log is agent-issue-<id>-<phase>-<id>.log
# (phase impl, review, review-codex, repair, or gates - the orchestrator's gate output):
# the id appears twice, and the repeat tells a ticket called "code-review-01" from the
# phase "review". Logs of hand-suffixed branches (agent-issue-12-closeout-impl-12)
# fall back to the first phase word. (BSD sed has no back-references in -E; awk does it.)
log_ids() {
  awk '{ f=$0; sub(/^.*\//, "", f); if (f !~ /^agent-issue-/) next
    s=substr(f, 13); sub(/\.log$/, "", s); n=length(s); found=""
    for (i=1; i<n; i++) { rest=substr(s, i+1)
      if (rest ~ /^-(impl|review-codex|review|repair|gates)-/) { t=rest; sub(/^-(impl|review-codex|review|repair|gates)-/, "", t)
        if (t == substr(s, 1, i)) { found=substr(s, 1, i); break } } }
    if (found == "" && match(s, /-(impl|review|repair|gates)-/)) found=substr(s, 1, RSTART-1)
    if (found != "") print found }'
}
# A ticket as a person names it: "#12", a suffixed branch "#12" (its suffix is
# shown apart), or a slug such as "checkout-03" as it is.
legacy_id() { [[ "$1" =~ ^[0-9]+(-[a-z]+)*$ ]]; }
disp() { if legacy_id "$1"; then printf '#%s' "${1%%-*}"; else printf '%s' "$1"; fi; }

# Machine-wide slots (pool.ts): one lock file per slot, holding its owner's
# pid. Counts live ones only; the limits come from the CLI.
load_pool() {
  local dir="${XDG_CACHE_HOME:-$HOME/.cache}/sandcastle-kit/slots" pool used f pid
  for pool in sandboxes gates; do
    used=0
    for f in "$dir/$pool"-*.lock; do
      [ -f "$f" ] || continue
      pid=$(cut -d' ' -f1 "$f")
      kill -0 "$pid" 2>/dev/null && used=$((used+1))
    done
    case "$pool" in sandboxes) lim="${SANDCASTLE_MAX_SANDBOXES:-6}";; gates) lim="${SANDCASTLE_MAX_GATES:-2}";; esac
    printf -v "USED_$pool" '%s' "$used"; printf -v "LIM_$pool" '%s' "$lim"
  done
}

# The orchestrator writes logs/run.json: which run, since when, which models,
# and on a clean exit when it finished. A pid that is gone without a
# finishedAt is a run that was killed.
#
# While the run is alive, its `tickets` are the truth for every ticket it
# holds: each one's state, when it entered it, and a note (which gate, why it
# is red, what it waits for). Before that record the view inferred a state
# from branches, logs and label times, and a green branch waiting to land read
# as `queued` for over an hour. Inference is left for tickets outside the run,
# and for all of them once it ends - people merge and clean up after a run.
#   TICKETS  "id US state US since US started US order US note US requeued" lines
#   RECORD   1 while the live run keeps TICKETS (an older orchestrator does not)
# Older records: RUN_ISSUES, WAITING ("issue|#dep, #dep") and ACTIVE
# ("issue|phase|since") are what a run wrote before `tickets`.
US=$'\x1f'
WAITING=""; RUN_LIVE=0; RUN_ISSUES=""; RUN_STARTED=""; OUTCOMES=""; ACTIVE=""
TICKETS=""; TICKET_IDS=""; RECORD=0; TYPICAL=""; RUN_ETA=""; FREE=0; INRUN=0
load_run() {
  WAITING=""; RUN_LIVE=0; RUN_ISSUES=""; RUN_STARTED=""; OUTCOMES=""; ACTIVE=""
  TICKETS=""; TICKET_IDS=""; RECORD=0; TYPICAL=""; RUN_ETA=""; FREE=0; INRUN=0
  local f=logs/run.json pid
  # What each branch's last run decided: "slug|run|outcome" lines. A row
  # shows it, and one whose run is not the recorded run is a leftover.
  [ -f logs/outcomes.json ] && OUTCOMES=$(jq -r 'to_entries[] | "\(.key)|\(.value.run)|\(.value.outcome)"' logs/outcomes.json 2>/dev/null)
  [ -f "$f" ] || return 0
  RUN_STARTED=$(jq -r '.startedAt // empty' "$f" 2>/dev/null)
  pid=$(jq -r 'if .finishedAt then empty else (.pid // empty) end' "$f" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0
  RUN_LIVE=1
  RUN_ISSUES=$(jq -r '(.issues // [])[] | tostring' "$f" 2>/dev/null)
  WAITING=$(jq -r '(.waiting // [])[] | "\(.issue)|\([.on[] | tostring | if test("^[0-9]+$") then "#" + . else . end] | join(", "))"' "$f" 2>/dev/null)
  ACTIVE=$(jq -r '(.active // {}) | to_entries[] | "\(.key)|\(.value.phase)|\(.value.since)"' "$f" 2>/dev/null)
  TICKETS=$(jq -r '(.tickets // {}) | to_entries[] | [.key, (.value.state // ""), (.value.since // "" | tostring),
      (.value.started // "" | tostring), (.value.order // "" | tostring), (.value.note // ""), (.value.requeued // "")] | join("\u001f")' "$f" 2>/dev/null)
  if [ -n "$TICKETS" ]; then
    RECORD=1
    TICKET_IDS=$(printf '%s\n' "$TICKETS" | cut -d"$US" -f1 | sort -V)
  fi
  # `landing: "in-run"`: tickets land one by one as they go green, while others
  # still run, so there is no separate landing phase after the last of them.
  [ "$(jq -r '.landing // empty' "$f" 2>/dev/null)" = in-run ] && INRUN=1
  # Sandboxes the run has yet to fill: queued tickets that fit in them start
  # at once, so none of them is "behind" another. A ticket that is landing holds
  # no slot: its merge runs on the host, or in the landing worker's own box.
  FREE=$(jq -r '[((.concurrency // 1) - ([(.tickets // {})[] | select((.state // "") | IN("setup", "implement", "review", "cross-review", "gates", "repair"))] | length)), 0] | max' "$f" 2>/dev/null)
  [[ "$FREE" =~ ^[0-9]+$ ]] || FREE=0
  TYPICAL=$(jq -r '(.typical // {}) | to_entries[] | "\(.key)|\(.value)"' "$f" 2>/dev/null)
  # When landing should start: the queued tickets at a typical issue's length
  # each, the working ones at what is left of theirs (a minute at least), over
  # the sandboxes the run uses at once. Only once there is a typical issue -
  # from earlier runs, or this run's first finished one. A ticket that is
  # landing is neither queued nor working here, so with in-run landing the
  # figure is when the last pipeline ends: the run's end, not the start of a
  # landing phase (see run_cell).
  RUN_ETA=$(jq -r --argjson now "$(date +%s)" '
    (.typical.issue // null) as $t
    | if $t == null or (.stage // "") != "running" then empty else
      ([(.tickets // {})[] | select(.state == "queued")] | length) as $q
      | ([(.tickets // {})[] | select(.started != null and ((.state // "") | IN("setup", "implement", "review", "cross-review", "gates", "repair")))
          | ([$t - ($now - .started), 60] | max)] | add // 0) as $a
      | ($now + ($q * $t + $a) / ([(.concurrency // 1), 1] | max)) | floor end' "$f" 2>/dev/null)
  return 0
}
# "phase|since" for an issue an older live run is working on, or empty.
active_of() { printf '%s\n' "$ACTIVE" | awk -F'|' -v k="$1" '$1==k{print $2 "|" $3; exit}'; }
in_record() { [ "$RECORD" = 1 ] && grep -qx "$1" <<<"$TICKET_IDS"; }
ticket_of() { printf '%s\n' "$TICKETS" | awk -F"$US" -v k="$1" '$1==k{print; exit}'; }
# Seconds a step usually takes in this project (run.json's `typical`), or empty.
typical_of() { printf '%s\n' "$TYPICAL" | awk -F'|' -v k="$1" '$1==k{print $2; exit}'; }

# Seconds as the AGE column shows them.
ago() {
  # The frame's clock is read before run.json, so a state written in between is a second "ahead".
  if   [ "$1" -lt 1 ]; then printf '0s'
  elif [ "$1" -lt 60 ]; then printf '%ss' "$1"
  elif [ "$1" -lt 3600 ]; then printf '%sm' "$(( $1 / 60 ))"
  else printf '%sh' "$(( $1 / 3600 ))"; fi
}
# A run's length: "48m", "1h12m".
dur() {
  if [ "$1" -lt 3600 ]; then printf '%sm' "$(( $1 / 60 ))"
  else printf '%sh%02dm' "$(( $1 / 3600 ))" "$(( $1 % 3600 / 60 ))"; fi
}
# A merged issue that is open and labelled again was re-queued after its
# merge - or it only looks that way: landing merges before it closes the
# issue, and GitHub's labelled-issue listing can trail a close by a while
# after the run has ended. Only a change to the issue after the merge commit
# the orchestrator wrote counts. With no such merge commit (rebased, or merged
# by hand) the listing is taken at its word. Never asked about a ticket the
# live run holds: before landing no ticket has that merge commit, so every
# finished branch of the run read as re-queued.
requeued() {
  local updated merged
  merged=$(git log "$BASE" -1 --format=%ct --fixed-strings --grep="Merge agent/issue-$1 (closes $(disp "$1"))" 2>/dev/null)
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

# "run|outcome" for a branch slug, from OUTCOMES.
outcome_of() { printf '%s\n' "$OUTCOMES" | awk -F'|' -v k="$1" '$1==k{print $2 "|" $3; exit}'; }
# The row state for a recorded outcome, in the words the live view uses.
outcome_state() {
  case "$1" in
    "gate red"*) printf 'gate red';;
    "merge conflict"*) printf 'conflict';;
    "needs a human"*) printf 'held';;
    uncommitted*) printf 'uncommitted';;
    crashed*) printf 'crashed';;
    "failed to land"*|"not merged"*) printf 'not landed';;
    withdrawn*) printf 'withdrawn';;
    merged*) printf 'merged';;
    stopped*) printf 'stopped';;
    nochange) printf 'no change';;
    *) printf 'ready';;
  esac
}

# The one vocabulary: the table, the header, the Herdr panes and the report
# all use these words. Sets glyph, colour, prio (sort order) and grp (the
# header count and the overflow line).
style_of() {
  case "$1" in
    setup|impl|review|codex|gates|repair|landing) glyph='●'; colour="$ylw"; prio=0; grp=working;;
    stalled|orphaned|stopped|"gate red"|conflict|held|uncommitted|crashed|"not landed") glyph='!'; colour="$hot"; prio=1; grp="needs you";;
    ready|finished) glyph='>'; colour="$cyn"; prio=2; grp=ready;;
    queued|requeued) glyph='○'; colour="$blu"; prio=3; grp=queued;;
    blocked) glyph='~'; colour="$blu"; prio=4; grp=blocked;;
    merged) glyph='+'; colour="$grn"; prio=5; grp=merged;;
    "left over"|withdrawn) glyph='-'; colour="$gry"; prio=6; grp="left over";;
    *) glyph='·'; colour="$gry"; prio=6; grp=idle;;
  esac
}

# The agent log a recorded step writes (burndown.ts, herdr.ts).
log_phase() { case "$1" in implement) printf impl;; cross-review) printf review-codex;; *) printf '%s' "$1";; esac; }

# Last line of a log that says something: a tool call or a sentence, not
# framing. Then made readable - the raw line is agent transcript, not a status.
log_activity() {
  grep -avE '^\s*$|^(Agent|Run|Capturing|Collecting|Syncing|Context)' "$1" 2>/dev/null \
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
    | cut -c1-200
}

# CPU and memory columns from stat_for; the CPU figure is coloured only when
# it is high enough to be worth noticing.
cpu_cols() {
  cpu="$S_CPU"; mem="$S_MEM"; cpu_col="$head"
  if [ -z "$cpu" ]; then cpu="-"; mem="-"; cpu_col="$gry"
  elif [ "$S_HOT" = "1" ]; then cpu_col="$hot"; fi
}

# The run's state, its times and its tokens, as the run cell's three rows (RUNC).
run_cell() {
  local f=logs/run.json orch pid started finished code models stage dry tokens t0 eta eta_word
  RUNC=("" "" "")
  [ -f "$f" ] || { kvl state "${mute}no run recorded yet${off}"; RUNC[0]="$REPLY"; return 0; }
  # A unit separator, not a tab: read collapses runs of whitespace IFS, so an
  # empty finishedAt would shift every later field.
  IFS="$US" read -r orch pid started finished code models stage dry tokens < <(jq -r \
    '[.orchestrator, (.pid|tostring), .startedAt, (.finishedAt // ""), (.exitCode // "" | tostring), .models, (.stage // ""), (if .dryRun then "dry run" else "" end), (.tokens // "")] | join("\u001f")' "$f")
  t0=$(utc_to_epoch "${started%%.*}")
  # The date only when it is not today: the run cell has to fit 80 columns.
  if [ "$(epoch_fmt "$t0" +%F)" = "$(date +%F)" ]; then started=$(epoch_fmt "$t0" '+%H:%M'); else started=$(epoch_fmt "$t0" '+%d %b %H:%M'); fi
  # "running" is the stage between the start-up steps and landing; the run
  # cell already says running.
  [ "$stage" = running ] && stage=""
  if [ -n "$finished" ]; then
    kvl state "${mute}ended (exit ${code})${off}"; RUNC[0]="$REPLY"
    kvl started "${mute}${started}${off}"; RUNC[1]="$REPLY"
  elif kill -0 "$pid" 2>/dev/null; then
    # The stage says what a run is doing before its first sandbox exists -
    # image, preflight, base gates - and after its last: "landing 6/25".
    kvl state "${ylw}running${off}${dry:+ ${accent}${dry}${off}} ${mute}· $(dur $(( $(date +%s) - t0 )))${off}${stage:+ ${rule}·${off} ${accent}${stage}${off}}"; RUNC[0]="$REPLY"
    if [ -n "$RUN_ETA" ]; then
      eta_word=lands; [ "$INRUN" = 1 ] && eta_word=ends
      kvl "$eta_word" "${accent}~$(epoch_fmt "$RUN_ETA" '+%H:%M')${off} ${mute}· since ${started}${off}"
    else kvl since "${mute}${started}${off}"; fi
    RUNC[1]="$REPLY"
  else
    kvl state "${hot}killed${off} ${mute}· no clean exit${off}"; RUNC[0]="$REPLY"
    kvl started "${mute}${started}${off}"; RUNC[1]="$REPLY"
  fi
  kvl tokens "${tokens:-${gry}-${off}}"; RUNC[2]="$REPLY"
}

# The models a live run uses; otherwise the ones the next run would, from the
# project's config - the last run's read as the current setting.
models_line() {
  if [ "$RUN_LIVE" = 1 ]; then jq -r '.models // empty' logs/run.json 2>/dev/null
  elif [ -n "${SANDCASTLE_MODELS:-}" ]; then printf 'next run: %s' "$SANDCASTLE_MODELS"
  elif [ -f logs/run.json ]; then printf 'last run: %s' "$(jq -r '.models // empty' logs/run.json 2>/dev/null)"
  fi
}

# How many commits a merged ticket landed: once merged, its branch has none
# left over the base, and a 0 read as "merged nothing". Its merge commit's
# second parent says (a squash is the one commit); "-" when none is found.
landed_commits() {
  local p
  p=$(git log "$BASE" -1 --format=%P --fixed-strings --grep="Merge agent/issue-$1 (closes $(disp "$1"))" 2>/dev/null)
  case "$p" in
    *' '*) git rev-list --count "${p%% *}..${p#* }" 2>/dev/null || echo -;;
    ?*) echo 1;;
    *) echo -;;
  esac
}

# One row into the frame, counted in its group - or, while a live run keeps a
# record, as outside that run ($1 = 1), so the counts add up to the run.
emit() {
  local age_c="$age_col" cmt_c="$head" mem_c="$head"
  if [ "$state" = merged ] && { [ "$commits" = 0 ] || [ "$commits" = "-" ]; }; then commits=$(landed_commits "$n"); fi
  [ "$age" = "-" ] && age_c="$gry"
  [ "$commits" = "-" ] && cmt_c="$gry"
  [ "$mem" = "-" ] && mem_c="$gry"
  local id_cell="${bold}${wht}$(disp "$n")${off}" lf url
  if [ "$LINKS" = 1 ]; then
    lf=$(ls -t logs/agent-issue-"$n"-*-"$n".log 2>/dev/null | head -1)
    if [ -n "$lf" ]; then
      url="$PWD/$lf"; url="${url//\%/%25}"; url="${url// /%20}"; url="${url//\#/%23}"
      id_cell="${ESC}]8;;file://${url}${ST}${id_cell}${ESC}]8;;${ST}"
    fi
  fi
  CELL=("$id_cell" "${colour}${glyph} ${state}${off}" "${age_c}${age}${off}" "${cmt_c}${commits}${off}")
  [ "$wide" -ge 1 ] && CELL[4]="${cpu_col}${cpu}${off}"
  [ "$wide" = 2 ] && CELL[5]="${mem_c}${mem}${off}"
  CELL[${#TW[@]}-1]="${act_col}${activity}${off}"
  OW=("${TW[@]}"); AL=("${TAL[@]}")
  cells_line; rendered="$REPLY"
  out[n_out]="$prio	$key	$n	$grp	$rendered"; n_out=$((n_out+1))
  if [ "$1" = 1 ]; then c_out=$((c_out+1)); return 0; fi
  case "$grp" in
    working) c_work=$((c_work+1));;
    "needs you") c_attn=$((c_attn+1));;
    ready) c_ready=$((c_ready+1));;
    queued) c_queue=$((c_queue+1));;
    blocked) c_block=$((c_block+1));;
    merged) c_merged=$((c_merged+1));;
    "left over") c_left=$((c_left+1));;
    *) c_idle=$((c_idle+1));;
  esac
}

render() {
  local now now_s issues n phase log age commits state glyph colour activity activity_note rendered
  local merged_list cols rows prio cpu mem cpu_col budget hidden key wide WIN BUF BUF_N
  local c_work=0 c_attn=0 c_ready=0 c_queue=0 c_block=0 c_merged=0 c_idle=0 c_left=0 c_out=0
  local mtime q quiet act_col age_col on live_wt kept_wt models gate_wait
  local grp oc oc_run oc_text hidden_list group summary act since
  local tstate started order note typ pos upstream ahead unpushed=
  local -a out=() TW=() TAL=() OW=() CELL=() AL=() RUNC=() WRAPPED=()
  local n_out=0

  # render runs inside $(...) piped to awk, so stdout is not the terminal and
  # tput falls back to 80x24. The loop reads the real size from /dev/tty.
  cols="${TERM_COLS:-${COLUMNS:-}}"
  [[ "$cols" =~ ^[0-9]+$ ]] || cols=$(tput cols 2>/dev/null || echo 100)
  rows="${TERM_ROWS:-}"
  [[ "$rows" =~ ^[0-9]+$ ]] || rows=$(tput lines 2>/dev/null || echo 40)

  now=$(date +%H:%M:%S); now_s=$(date +%s)
  load_container_stats
  load_run
  merged_list=$(git branch --merged "$BASE" --list 'agent/issue-*' 2>/dev/null)

  # Keyed by the branch slug, not the bare number: a follow-up step can run
  # on agent/issue-12-closeout while agent/issue-12 is long merged, and
  # keying both on 12 hid the live sandbox under the merged row.
  issues=$(ls logs/agent-issue-*.log 2>/dev/null \
    | log_ids | sort -u)

  # The table's columns. The fixed ones grow with the pane (a share of it,
  # with a minimum each) and ACTIVITY takes the rest. The TICKET column fits
  # the longest ticket shown ("helpers-01" is longer than "#1234"), up to 16;
  # a longer one is cut to it. It is never narrower than its own heading
  # (6 characters).
  local id d longest=6 i sum=0 avail
  for id in $issues $QUEUE $TICKET_IDS; do d=$(disp "$id"); [ "${#d}" -gt "$longest" ] && longest=${#d}; done
  [ "$longest" -gt 16 ] && longest=16
  WIN="$cols"
  # In a narrow pane MEM gives its width to ACTIVITY, where the notes are:
  # at 80 columns every note was cut to 30 characters. Below 80, CPU does too.
  # wide: 2 with MEM, 1 with CPU only, 0 with neither.
  wide=2; [ "$cols" -lt 100 ] && wide=1; [ "$cols" -lt 80 ] && wide=0
  # STATE's minimum fits "! uncommitted", the longest state - but for the
  # narrowest panes, which cut it.
  local -a MIN=($(( longest + 2 )) 15 6 9 7 7) PCT=(6 9 5 6 6 6)
  [ "$wide" = 1 ] && { MIN=($(( longest + 2 )) 15 6 9 7); PCT=(6 9 5 6 6); }
  [ "$wide" = 0 ] && { MIN=($(( longest + 2 )) 12 6 9); PCT=(6 9 5 6); }
  avail=$(( cols - ${#MIN[@]} - 2 ))
  for (( i=0; i<${#MIN[@]}; i++ )); do
    TW[i]=$(( avail * PCT[i] / 100 )); [ "${TW[i]}" -lt "${MIN[i]}" ] && TW[i]=${MIN[i]}; sum=$(( sum + TW[i] ))
  done
  TW[${#MIN[@]}]=$(( avail - sum )); [ "${TW[${#MIN[@]}]}" -lt 10 ] && TW[${#MIN[@]}]=10
  # Every column but STATE and ACTIVITY is centred.
  TAL=(c l c c c c); TAL[${#MIN[@]}]=l

  # 1. The live run's tickets, as its record has them.
  for n in $TICKET_IDS; do
    IFS="$US" read -r _ tstate since started order note requeued <<<"$(ticket_of "$n")"
    case "$tstate" in implement) state=impl;; cross-review) state=codex;; red) state="gate red";; nochange) state="no change";; *) state="$tstate";; esac
    [[ "$since" =~ ^[0-9]+$ ]] || since="$now_s"
    age=$(ago $(( now_s - since ))); age_col="$head"; act_col="$mute"; activity="$note"; key="$since"
    commits=$(git rev-list --count "${BASE}..agent/issue-$n" 2>/dev/null || echo -)
    stat_for "$n"; cpu_cols
    case "$tstate" in
      setup) activity="${note:-setting up its sandbox}";;
      landing) activity="${note:-merging into $BASE}";;
      # Put back in the queue by the run (a landing that went red, say): it starts again on the next run.
      requeued) activity="${note:-for the next run}";;
      queued)
        # Next to start first: the run takes its queue in this order.
        pos=$(printf '%s\n' "$TICKETS" | awk -F"$US" -v o="${order:-0}" '$2=="queued" && $5+0 < o+0 {c++} END{print c+1}')
        key=$(( 1000000 - ${order:-0} )); age="-"
        if [ $(( pos - FREE )) -le 1 ]; then activity="next to start"; else activity="$(( pos - 1 - FREE )) ahead of it"; fi;;
      blocked) age="-";;
      implement|review|cross-review|repair|gates)
        log="logs/agent-issue-$n-$(log_phase "$tstate")-$n.log"
        if [ -f "$log" ]; then
          quiet=$(( now_s - $(mtime_of "$log") ))
          activity="${note:+$note - }$(log_activity "$log")"
          # A gate can be silent for minutes and still be working; only an
          # agent's silence is worth a flag.
          if [ "$tstate" != gates ]; then
            if [ -z "$S_CPU" ] && [ "$quiet" -ge 1800 ]; then
              # No container and a log quiet for 30 minutes: a sandbox that
              # died under a live run, not one in flight.
              state="stalled"; activity="no container, log quiet $(( quiet / 60 ))m - $activity"
            elif [ "$quiet" -ge 600 ]; then
              # Thinking or hung; either way worth a look before the
              # 30-minute mark or the agent's own idle timeout.
              activity="quiet $(( quiet / 60 ))m - $activity"; act_col="$hot"
            fi
          fi
        fi
        # Busy but healthy, or stuck: a step at twice its usual length says which to suspect.
        typ=$(typical_of "$tstate")
        if [[ "$typ" =~ ^[0-9]+$ ]] && [ "$typ" -gt 0 ] && [ $(( now_s - since )) -gt $(( typ * 2 )) ]; then
          age_col="$hot"; activity="usually $(ago "$typ") - $activity"
        fi;;
    esac
    # A ticket landing sent back keeps saying so through its second attempt.
    if [ -n "$requeued" ]; then
      case "$activity" in *"$requeued"*) ;; *) activity="$requeued${activity:+ - $activity}";; esac
    fi
    style_of "$state"
    # A spent plan allowance makes the orchestrator report a trust-dialog
    # error or `exited with code 1`; the real cause is only in the log tail.
    if [ "$grp" = working ] && [ -n "${log:-}" ] && [ -f "$log" ] && tail -5 "$log" 2>/dev/null | grep -qiE "out of usage credits|usage limit|limit reached"; then
      activity="USAGE LIMIT REACHED - $state model"; glyph='!'; colour="$hot"
    fi
    log=""
    emit 0
  done

  # 2. Queued tickets with no log yet and nothing in the record.
  for q in $QUEUE; do
    in_record "$q" && continue
    grep -qx "$q" <<<"$issues" && continue
    n="$q"; age="-"; commits="-"; cpu="-"; mem="-"; cpu_col="$gry"; age_col="$gry"; act_col="$mute"; key=0
    # Held back by an open dependency, not waiting for a sandbox.
    on=$(blocked_on "$q")
    if [ -n "$on" ]; then
      state="blocked"; activity="waits for $on to close"
    elif [ "$RUN_LIVE" = 1 ] && [ "$RECORD" = 0 ] && [ -n "$(active_of "$q")" ]; then
      # Claimed, before its first agent log: the sandbox is being set up.
      state="setup"; activity="in this run - setting up its sandbox"; key=1
    else
      # Only the live run's own issues wait for a sandbox. The rest of the
      # label reads as in flight otherwise, long after the run has ended.
      state="queued"
      if [ "$RUN_LIVE" = 0 ]; then activity="for the next run"
      elif [ "$RECORD" = 0 ] && grep -qx "$q" <<<"$RUN_ISSUES"; then activity="in this run - waiting for a sandbox"; key=1
      else activity="not in this run"; fi
    fi
    style_of "$state"
    emit "$RECORD"
  done

  # 3. Tickets with logs that the record does not hold: earlier runs', and
  # all of them once the run has ended. Their state is inferred.
  for n in $issues; do
    in_record "$n" && continue
    log=$(ls -t logs/agent-issue-"$n"-impl-*.log logs/agent-issue-"$n"-review-*.log logs/agent-issue-"$n"-repair-*.log logs/agent-issue-"$n"-gates-*.log 2>/dev/null | head -1)
    [ -z "$log" ] && continue
    case "$log" in *-review-codex-*) phase="codex";; *-review-*) phase="review";; *-repair-*) phase="repair";; *-gates-*) phase="gates";; *) phase="impl";; esac

    mtime=$(mtime_of "$log")
    # AGE is how long a working row has been at its phase, from an older
    # run's record; any other row's is how long since its log last changed.
    act=""; [ "$RUN_LIVE" = 1 ] && act=$(active_of "$n")
    if [ -n "$act" ]; then
      phase="${act%%|*}"; since="${act#*|}"
      case "$phase" in implement) phase="impl";; cross-review) phase="codex";; esac
      age=$(ago $(( now_s - since )))
    else
      age=$(ago $(( now_s - mtime )))
    fi
    key="$mtime"; age_col="$head"

    commits=$(git rev-list --count "${BASE}..agent/issue-$n" 2>/dev/null || echo 0)

    # Order matters: a branch with no commits yet is trivially "merged",
    # so an in-flight worktree has to win over the merged check.
    stat_for "$n"
    quiet=0; act_col="$mute"; activity_note=""
    # A worktree is live work only while a container holds it or its run is
    # alive. Sandcastle keeps a closed sandbox's worktree when it has
    # uncommitted files (a setup step's lockfile, say); that one is shown by
    # its branch's state, with a note, not as working forever.
    # A container with no live run is an orphan: its run was killed, and its
    # agent goes on spending with nobody to gate or land what it makes.
    live_wt=0; kept_wt=0; orphan=0
    if [ -d "worktrees/agent-issue-$n" ]; then
      if [ "$RUN_LIVE" = 1 ]; then live_wt=1; elif [ -n "$S_CPU" ]; then orphan=1; else kept_wt=1; fi
    fi
    if [ "$orphan" = 1 ]; then
      state="orphaned"; activity_note="its run is gone, its agent still works - sandcastle clean stops it"
    elif [ "$live_wt" = 1 ] && [ -z "$S_CPU" ] && [ $(( now_s - mtime )) -ge 1800 ]; then
      # A worktree with no container and a log quiet for 30 minutes is a run
      # that died or was killed, not one in flight.
      state="stalled"
    elif [ "$live_wt" = 1 ]; then
      state="$phase"
      [ "$phase" != gates ] && quiet=$(( now_s - mtime ))
    elif ! git show-ref -q --verify "refs/heads/agent/issue-$n"; then
      # A squash-landed branch is deleted at landing, so its subject on the base is the proof.
      if [ -n "$(git log "$BASE" -1 --format=%h --fixed-strings --grep="Merge agent/issue-$n (closes $(disp "$n"))" 2>/dev/null)" ]; then
        state="merged"; activity_note="squashed into $BASE"
      else
        state="no branch"
      fi
    elif [ "$commits" -gt 0 ] && ! git cherry "$BASE" "agent/issue-$n" 2>/dev/null | grep -q '^+'; then
      # Every commit has an equivalent patch already on the base. The
      # orchestrator rebased instead of merging, so --merged cannot see it:
      # the work landed and the branch is a duplicate, not pending work.
      state="merged"; activity_note="merged as an equal patch (rebased)"
    elif [ "$commits" -gt 0 ]; then
      # A finished branch left standing. Its run's outcome says why - a
      # sandbox's last log line ("nothing to sync out") does not. One left by
      # an earlier run is a leftover, not this run's work waiting on you.
      oc=$(outcome_of "$n"); oc_run="${oc%%|*}"; oc_text="${oc#*|}"
      if [ -n "$oc" ] && [ "$oc_run" = "$RUN_STARTED" ]; then
        state=$(outcome_state "$oc_text"); activity_note="$oc_text"
      elif [ "$RUN_LIVE" = 1 ] && grep -qx "$n" <<<"$RUN_ISSUES"; then
        # This run's branch under an older orchestrator, which records no
        # outcome until landing: finished, and landing decides the rest.
        state="finished"; activity_note="this run - landing decides it when the run ends"
      else
        state="left over"; activity_note="earlier run${oc_text:+: $oc_text} - sandcastle clean"
      fi
    elif oc=$(outcome_of "$n") && [ -n "$oc" ] && [ "${oc%%|*}" = "$RUN_STARTED" ]; then
      # No commits, but this run said what became of it: handed back, or
      # nothing to change. A branch with no commits is "merged" by git's
      # reckoning, and a question for a human read as done.
      state=$(outcome_state "${oc#*|}"); activity_note="${oc#*|}"
    elif grep -q "agent/issue-${n}$" <<<"$merged_list"; then
      state="merged"
    else
      state="no commits"
    fi
    style_of "$state"
    # Back on the queue after an earlier run: it is queued, not done. Never a
    # ticket of the live run - that run is handling it.
    if { [ "$grp" = merged ] || [ "$grp" = idle ] || [ "$grp" = "left over" ]; } && in_queue "$n" && requeued "$n" \
      && ! { [ "$RUN_LIVE" = 1 ] && grep -qx "$n" <<<"$RUN_ISSUES"; }; then
      state="queued"
      # Its old log's last line is history; say what happens next instead.
      if [ "$RUN_LIVE" = 1 ]; then activity_note="not in this run"; else activity_note="for the next run"; fi
      [ "$commits" -gt 0 ] && activity_note="$activity_note - on its earlier branch ($commits commit(s))"
      on=$(blocked_on "$n")
      if [ -n "$on" ]; then state="blocked"; activity_note="waits for $on to close"; fi
      style_of "$state"
    fi

    cpu_cols
    activity=$(log_activity "$log")
    [ "$kept_wt" = 1 ] && activity="worktree kept (uncommitted files) - $activity"
    [ -n "$activity_note" ] && activity="$activity_note"
    if [ "$quiet" -ge 600 ]; then
      activity="quiet $(( quiet / 60 ))m - $activity"
      act_col="$hot"
    fi
    # Only on an unfinished row: a merged branch's old log keeps the line.
    if [ "$prio" -le 1 ] && tail -5 "$log" 2>/dev/null | grep -qiE "out of usage credits|usage limit|limit reached"; then
      activity="USAGE LIMIT REACHED - $phase model"
      glyph='!'; colour="$hot"
    fi
    # A suffixed branch shows its number in TICKET and its suffix here.
    legacy_id "$n" && [ "$n" != "${n%%-*}" ] && activity="[${n#*-}] $activity"
    emit "$RECORD"
  done

  # Commits the base branch holds that its upstream lacks, by the last fetch:
  # closed tickets are merged locally, and a repo that deploys on push has
  # shipped nothing until they go out. No fetch here - no network.
  if upstream=$(git rev-parse --abbrev-ref "${BASE}@{upstream}" 2>/dev/null) && [ -n "$upstream" ]; then
    ahead=$(git rev-list --count "${upstream}..${BASE}" 2>/dev/null || echo 0)
    [ "$ahead" -gt 0 ] 2>/dev/null && unpushed=" ${hot}↑${ahead} unpushed${off}"
  fi
  # Tickets queued for a gates slot: gates are what the machine is busy with
  # while the table stands still.
  local gate_wait models mprefix part item i l hdr_n ftr_n tbars lbars up sep_line need used cost sep pp sorted
  local -a LG=() MAC=() MOD=() LEG=() NOTE=()
  gate_wait=$(printf '%s\n' "$TICKETS" | awk -F"$US" '$2=="gates" && $6 ~ /^waiting for/ {c++} END{print c+0}')
  run_cell
  load_pool
  gauge "$USED_sandboxes" "$LIM_sandboxes"; kvl sandboxes "$REPLY"; MAC[0]="$REPLY"
  gauge "$USED_gates" "$LIM_gates"; kvl gates "$REPLY"; MAC[1]="$REPLY"
  if [ "$gate_wait" -gt 0 ]; then kvl waiting "${hot}${gate_wait} for a gates slot${off}"; else kvl waiting "${gry}none${off}"; fi
  MAC[2]="$REPLY"
  # "implement X · review Y", one row each in the models cell.
  models=$(models_line); mprefix=""
  case "$models" in "next run: "*|"last run: "*) mprefix="${models%%: *}"; models="${models#*: }";; esac
  part="$models"; i=0
  while [ -n "$part" ] && [ "$i" -lt 3 ]; do
    item="${part%% · *}"
    case "$item" in *" "*) kvl "${item%% *}" "${head}${item#* }${off}";; *) kvl "$item" "";; esac
    MOD[i]="$REPLY"; i=$((i+1))
    case "$part" in *" · "*) part="${part#* · }";; *) part="";; esac
  done
  [ -n "$mprefix" ] && [ -n "${MOD[0]:-}" ] && MOD[0]="${MOD[0]} ${gry}(${mprefix})${off}"

  # The header, with the logo in 3 rows or, in a short pane, 1.
  build_header 3
  # The legend with each group's count (the counts band is gone), then the note.
  LEG=("${ylw}● working ${bold}${c_work}${off}" "${hot}! needs you ${bold}${c_attn}${off}" "${cyn}> ready to land ${bold}${c_ready}${off}" \
    "${blu}○ queued ${bold}${c_queue}${off}" "${blu}~ blocked ${bold}${c_block}${off}" "${grn}+ merged ${bold}${c_merged}${off}" \
    "${gry}- left over ${bold}${c_left}${off}" "${gry}· idle ${bold}${c_idle}${off}")
  NOTE=()
  [ "$c_out" -gt 0 ] && NOTE[0]="${blu}${c_out} not in this run${off}"
  NOTE[${#NOTE[@]}]="${gry}ready = gates green, waits for the landing worker${off}"
  NOTE[${#NOTE[@]}]="${gry}age = time in state (red: twice the usual)${off}"
  # Below 80 columns there is no CPU column to explain.
  [ "$wide" -ge 1 ] && NOTE[${#NOTE[@]}]="${gry}CPU in cores of ${NCPU}${off}"
  BUF=""; BUF_N=0
  # Cells as wide as their text needs, so "ready to land 3" is not cut at 80
  # columns: eight on one row from 130 columns, else rows of four, or of two
  # where four do not fit. A column is as wide as its widest item.
  local per=8 r c sumw
  [ "$cols" -lt 130 ] && per=4
  while :; do
    local -a LWT=(); sumw=0
    for (( c=0; c<per; c++ )); do
      LWT[c]=0
      for (( r=c; r<8; r+=per )); do vlen "${LEG[r]}"; [ "$VN" -gt "${LWT[c]}" ] && LWT[c]=$VN; done
      LWT[c]=$(( LWT[c] + 4 )); sumw=$(( sumw + LWT[c] ))
    done
    { [ "$per" -le 2 ] || [ $(( sumw + per + 1 )) -le "$WIN" ]; } && break
    per=$(( per / 2 ))
  done
  split_cols "${LWT[@]}"; bars_of; lbars="$BARS"
  AL=(c c c c c c c c)
  for (( r=0; r<8; r+=per )); do CELL=("${LEG[@]:r:per}"); cells_line; put "$REPLY"; done
  junction '├' '┤' '─' "$lbars" ""; put "$REPLY"
  split_cols 1; AL=(c)
  wrap_items $(( WIN - 4 )) "${NOTE[@]}"
  for l in "${WRAPPED[@]}"; do CELL=("$l"); cells_line; put "$REPLY"; done
  junction '└' '┘' '─' "" ""; put "$REPLY"
  FTR="$BUF"; ftr_n=$(( BUF_N + 1 ))   # and the double rule that opens it

  # A short pane: the logo folds to one row, so the table keeps some rows.
  if [ "$SHOW_ALL" != all ] && [ $(( rows - HDR_N - ftr_n - 1 )) -lt 5 ]; then build_header 1; fi
  hdr_n="$HDR_N"

  # The table body.
  BUF=""; BUF_N=0
  OW=("${TW[@]}"); bars_of; tbars="$BARS"
  junction '├' '┤' '─' "$tbars" "$tbars"; sep_line="$REPLY"
  up="$tbars"
  if [ "$n_out" -eq 0 ]; then
    # A project whose merged tickets' logs were archived has had runs; the run
    # cell above says how the last one ended.
    local empty="(no runs yet)"; [ -f logs/run.json ] && empty="(nothing to show)"
    CELL=(); CELL[${#TW[@]}-1]="${mute}${empty}${off}"; AL=("${TAL[@]}"); cells_line; put "$REPLY"
  else
    # Working, needing you, ready, queued, blocked, then merged and idle -
    # everything unfinished first - and within a group the most recent change
    # first (the queue: next to start first). The merged and idle tail is what
    # makes the list outgrow the screen, so it gets cut, oldest first.
    # The rows left are the pane less the header, the footer and the bottom
    # row, which stays free (see the loop). A light rule between groups takes
    # a row too, and the "+N not shown" cell two, only when something is hidden.
    budget=$(( rows - hdr_n - ftr_n - 1 )); hidden=0; hidden_list=""
    [ "$SHOW_ALL" = "all" ] && budget=1000000
    [ "$budget" -lt 3 ] && budget=3
    sorted=$(printf '%s\n' "${out[@]}" | sort -t$'\t' -k1,1n -k2,2nr -k3,3n)
    need=0; pp=""
    while IFS=$'\t' read -r prio key n group rendered; do
      need=$((need+1)); [ -n "$pp" ] && [ "$prio" != "$pp" ] && need=$((need+1)); pp="$prio"
    done <<<"$sorted"
    [ "$need" -gt "$budget" ] && budget=$(( budget - 2 ))
    used=0; pp=""
    while IFS=$'\t' read -r prio key n group rendered; do
      sep=0; [ -n "$pp" ] && [ "$prio" != "$pp" ] && sep=1
      cost=$(( 1 + sep ))
      if [ "$hidden" = 0 ] && [ $(( used + cost )) -le "$budget" ]; then
        [ "$sep" = 1 ] && put "$sep_line"
        put "$rendered"; used=$(( used + cost )); pp="$prio"
      else
        hidden=$((hidden+1)); hidden_list="${hidden_list}${group}|$(disp "$n")
"
      fi
    done <<<"$sorted"
    # What did not fit, by state, so a long queue is one line rather than a
    # screen of rows: "+33 queued (#101-#140) · 2 merged". A range only when
    # every id in the group is a number: ticket-file ids ("checkout-03") have
    # no order a range could mean, so the first few are named instead.
    if [ "$hidden" -gt 0 ]; then
      summary=$(printf '%s' "$hidden_list" | awk -F'|' 'NF==2 {
          g=$1; id=$2
          if (!(g in c)) { order[++k]=g; num[g]=1 }
          c[g]++
          if (c[g] <= 3) names[g]=names[g] (c[g] > 1 ? ", " : "") id
          if (id ~ /^#[0-9]+$/) { v=substr(id, 2)+0
            if (!(g in lo) || v < lo[g]) lo[g]=v; if (!(g in hi) || v > hi[g]) hi[g]=v }
          else num[g]=0 }
        END { for (i=1; i<=k; i++) { g=order[i]
          ids = num[g] ? "#" lo[g] (hi[g] != lo[g] ? "-#" hi[g] : "") : names[g] (c[g] > 3 ? ", …" : "")
          printf "%s%d %s (%s)", (i>1 ? " · " : ""), c[g], g, ids } }')
      junction '├' '┤' '─' "$tbars" ""; put "$REPLY"
      split_cols 1; AL=(l); CELL=("${gry}+${summary} not shown${off}"); cells_line; put "$REPLY"
      up=""
    fi
  fi
  junction '╞' '╡' '═' "$up" "$lbars"
  printf '%s%s%s\n%s' "$HDR" "$BUF" "$REPLY" "$FTR"
}

# The header bands into HDR (HDR_N lines): the logo cell, the run band, the
# models and the queue error when there are any, and the table's headings.
# $1: the logo's rows, 3 or 1. Reads render's locals.
build_header() {
  local l m=0 prev
  if [ "$1" = 3 ]; then
    LG=(" ${moon}▄ ▄ ▄${off} ${star}+${off}   ${bold}${moon}s a n d c a s t l e${off} ${night}- k i t${off}  ${star}·   +   ·${off}"
      " ${dusk}█████${off}     ${head}${SANDCASTLE_NAME:-}${off}"
      " ${deep}██▀██${off} ${star}·${off}   ${mute}base${off} ${accent}${BASE}${off}${unpushed}  ${rule}·${off}  ${accent}${now}${off}")
  else
    LG=("${moon}▄▄▄${off} ${bold}${moon}sandcastle-kit${off}  ${head}${SANDCASTLE_NAME:-}${off}  ${mute}base${off} ${accent}${BASE}${off}${unpushed}  ${rule}·${off}  ${accent}${now}${off}")
  fi
  # Every logo line padded to the widest, so centring keeps the castle's shape.
  for l in "${LG[@]}"; do vlen "$l"; [ "$VN" -gt "$m" ] && m=$VN; done
  for (( i=0; i<${#LG[@]}; i++ )); do align "${LG[i]}" "$m"; LG[i]="$REPLY"; done
  BUF=""; BUF_N=0
  if [ "$cols" -ge 170 ]; then
    # Wide: the logo, the run, the machine and the models side by side.
    split_cols 40 20 20 20; bars_of
    junction '┌' '┐' '─' "" "$BARS"; put "$REPLY"
    AL=(c l l l)
    for i in 0 1 2; do CELL=("${LG[i]:-}" "${RUNC[i]}" "${MAC[i]}" "${MOD[i]:-}"); cells_line; put "$REPLY"; done
  else
    split_cols 1; AL=(c)
    junction '┌' '┐' '─' "" ""; put "$REPLY"
    for l in "${LG[@]}"; do CELL=("$l"); cells_line; put "$REPLY"; done
    split_cols 1 1; AL=(l l); bars_of
    junction '├' '┤' '─' "" "$BARS"; put "$REPLY"
    for i in 0 1 2; do CELL=("${RUNC[i]}" "${MAC[i]}"); cells_line; put "$REPLY"; done
    if [ -n "$models" ]; then
      prev="$BARS"; split_cols 1; AL=(l)
      junction '├' '┤' '─' "$prev" ""; put "$REPLY"
      kvl models "${mute}${mprefix:+${mprefix}: }${models}${off}"; CELL=("$REPLY"); cells_line; put "$REPLY"
      BARS=""
    fi
  fi
  prev="$BARS"
  # An unreadable queue is not an empty one: say so, under the run band.
  if [ -n "$QUEUE_ERR" ]; then
    split_cols 1; AL=(l)
    junction '├' '┤' '─' "$prev" ""; put "$REPLY"
    CELL=("${mute}queue: could not read - ${QUEUE_ERR}${off}"); cells_line; put "$REPLY"
    prev=""
  fi
  # The table's headings, under a double rule.
  OW=("${TW[@]}"); bars_of
  junction '╞' '╡' '═' "$prev" "$BARS"; put "$REPLY"
  CELL=("${bold}${head}TICKET${off}" "${bold}${head}STATE${off}" "${bold}${head}AGE${off}" "${bold}${head}COMMITS${off}")
  [ "$wide" -ge 1 ] && CELL[4]="${bold}${head}CPU${off}"
  [ "$wide" = 2 ] && CELL[5]="${bold}${head}MEM${off}"
  CELL[${#TW[@]}-1]="${bold}${head}ACTIVITY${off}"
  AL=("${TAL[@]}"); cells_line; put "$REPLY"
  junction '├' '┤' '─' "$BARS" "$BARS"; put "$REPLY"
  HDR="$BUF"; HDR_N=$BUF_N
}

if [ "$INTERVAL" = "0" ]; then load_queue; render; exit 0; fi

# Alternate screen + hidden cursor, restored on exit. INT and TERM must exit
# explicitly: a handler that only restores the screen returns into the loop,
# which leaves Ctrl-C unable to stop the script at all.
# Line wrap off as well: a line wider than the pane would wrap onto a second
# row, and enough of them push the frame's top off the screen.
# The input side too, when there is a terminal: in cooked mode the kernel
# echoes every key at the cursor (on the frame's free bottom row) and keeps it
# queued for the shell once the view exits. So echo is off, input is
# unbuffered (-icanon, min 0 time 0: a read returns at once, empty or not) so it
# can be drained, and the wheel's alternate-scroll (?1007) is off so it does
# not arrive as arrow keys. isig stays on: Ctrl-C must still stop the view.
# A background view would be stopped by SIGTTIN/SIGTTOU on those tty calls, so
# both are ignored (the calls then fail and the view carries on as before).
# TTY_SAVED is set only while that mode is in force: Ctrl-C runs restore twice
# (the INT trap, then the EXIT trap its `exit` fires), and a drain of a tty
# back in canonical mode blocks until lines are typed, hanging the view.
TTY_SAVED=$( { stty -g </dev/tty; } 2>/dev/null) || TTY_SAVED=""
drain() { [ -n "$TTY_SAVED" ] && { dd if=/dev/tty of=/dev/null bs=1024 count=4; } 2>/dev/null; return 0; }
restore() {
  drain
  [ -n "$TTY_SAVED" ] && { stty "$TTY_SAVED" </dev/tty; } 2>/dev/null
  TTY_SAVED=""
  printf '\e[?1007h\e[?7h\e[?25h\e[?1049l'
}
trap restore EXIT
trap 'restore; exit 130' INT TERM
trap '' TTIN TTOU
if [ -n "$TTY_SAVED" ]; then { stty -echo -icanon min 0 time 0 </dev/tty; } 2>/dev/null || TTY_SAVED=""; fi
printf '\e[?1049h\e[?25l\e[?7l\e[?1007l\e[2J'

# Redraw on a pane resize instead of waiting out the interval. A render takes
# seconds (docker stats, git), and a resize that lands during one used to be
# lost: a shrunk pane then showed the old frame's tail, header scrolled off,
# until the next refresh. So the resize is remembered, the last frame's top is
# put back at the new height at once, and a fresh frame follows.
SLEEP_PID=""; RESIZED=0; frame=""
trap 'RESIZED=1; [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null' WINCH

while true; do
  # The pane's size from its terminal; without one (a test), the size given.
  if size=$( { stty size </dev/tty; } 2>/dev/null) && [ -n "$size" ]; then TERM_ROWS="${size%% *}"; TERM_COLS="${size##* }"; fi
  export TERM_ROWS TERM_COLS
  if [ "$RESIZED" = 1 ] && [ -n "$frame" ] && [[ "$TERM_ROWS" =~ ^[0-9]+$ ]]; then
    printf '\e[H%s\n\e[J' "$(printf '%s\n' "$frame" | head -n $(( TERM_ROWS - 1 )))"
  fi
  RESIZED=0
  drain
  load_queue
  # Build the whole frame first, then write it in a single call. \e[K clears
  # each line's remainder and \e[J the rows below, so nothing has to be
  # blanked first - no flash, and no visible row-by-row repaint.
  # With line wrap off, a line that fills the pane leaves the cursor ON its
  # last cell, and a \e[K there erased that cell: every full-width rule lost
  # its last character. So \e[K only after a shorter line, and the frame ends
  # in a newline on a row of its own (render keeps the bottom row free).
  # stderr is swallowed: a stray warning printed mid-frame lands wherever the
  # cursor happens to be and corrupts the screen.
  frame=$(render 2>>"${STATUS_ERRLOG:-/dev/null}" | while IFS= read -r l; do
    if [[ "$TERM_COLS" =~ ^[0-9]+$ ]]; then
      l=$(fit "$l" "$TERM_COLS"); printf '%s' "$l"; vlen "$l"; [ "$VN" -lt "$TERM_COLS" ] && printf '\033[K'
    else printf '%s\033[K' "$l"; fi
    printf '\n'
  done)
  printf '\e[H%s\n\e[J' "$frame"
  # One frame and out, for the tests: what the loop writes is what they check.
  [ -n "${STATUS_FRAMES:-}" ] && { STATUS_FRAMES=$(( STATUS_FRAMES - 1 )); [ "$STATUS_FRAMES" -le 0 ] && exit 0; }
  [ "$RESIZED" = 1 ] && continue
  # In the Herdr plugin's popup, which only closes when this exits: q or Esc does it.
  if [ -n "${SANDCASTLE_STATUS_KEYS:-}" ] && [ -t 0 ]; then
    key=""; IFS= read -rsn1 -t "$INTERVAL" key || true
    case "$key" in q|Q) exit 0;; esac
    # An arrow key is Esc and more, sent at once, and closed the view; Esc alone has nothing
    # after it. One more character settles it: bash 3.2 drops what a read had when it times
    # out, so waiting for the whole sequence lost it. 3.2 also takes only whole seconds.
    if [ "$key" = "$ESC" ]; then
      rest=""; IFS= read -rsn1 -t "$( [ "${BASH_VERSINFO[0]}" -ge 4 ] && echo 0.05 || echo 1 )" rest || true
      [ -z "$rest" ] && exit 0
    fi
    continue
  fi
  sleep "$INTERVAL" & SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null
done

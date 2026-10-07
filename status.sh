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

# macOS (BSD) and Linux (GNU) spell these differently. Which one this is, is asked once: trying
# one spelling and then the other on every call started two processes where one does, on each
# of a frame's dozens of calls.
if stat -c %Y / >/dev/null 2>&1; then # portability-ok: the probe; BSD's spelling is the else
  mtime_of() { stat -c %Y "$1" 2>/dev/null || echo 0; } # portability-ok: only where the probe found GNU
else
  mtime_of() { stat -f %m "$1" 2>/dev/null || echo 0; }
fi
if date -j -u -f '%s' 0 '+%s' >/dev/null 2>&1; then
  utc_to_epoch() { date -j -u -f '%Y-%m-%dT%H:%M:%S' "$1" '+%s' 2>/dev/null || echo 0; }
  epoch_fmt() { date -r "$1" "$2" 2>/dev/null; }
else
  utc_to_epoch() { date -u -d "$1" '+%s' 2>/dev/null || echo 0; } # portability-ok: only where BSD's failed
  epoch_fmt() { date -d "@$1" "$2" 2>/dev/null; } # portability-ok: only where BSD's failed
fi
# Whether $1 is a whole line of $2, compared as text. In bash itself: a `grep -qx` for it started a
# process on every ticket of every frame.
has_line() { [[ $'\n'"$2"$'\n' == *$'\n'"$1"$'\n'* ]]; }
# The first line of $2 whose first field, split at $3, is $1: the line into LINE and its fields
# into F, as awk -F splits them (read "${F[i]:-}": a missing one is unset). Status 1 when no line
# has it. In bash: a `printf | awk` for each lookup started two processes per ticket per frame.
NL=$'\n'
fields_of() {
  local rest="$2$NL"
  LINE=""; F=()
  while [ -n "$rest" ]; do
    LINE="${rest%%"$NL"*}"; rest="${rest#*"$NL"}"
    if [ "${LINE%%"$3"*}" = "$1" ]; then IFS="$3" read -r -a F <<<"$LINE"; return 0; fi
  done
  LINE=""
  return 1
}

# "Sand": the frame in dark, muted browns and its text in lighter sand, so the
# state colours, which carry meaning, stand out against it. 24-bit where the terminal says it
# has it (COLORTERM); the 256-colour palette has almost no dark browns, so
# elsewhere the nearest of its colours.
if [ "${COLORTERM:-}" = truecolor ] || [ "${COLORTERM:-}" = 24bit ]; then
  sand() { printf -v "$1" '\e[38;2;%sm' "$2"; }
else
  sand() { printf -v "$1" '\e[38;5;%sm' "$3"; }
fi
bold=$'\e[1m'; off=$'\e[0m'
sand rule '74;58;42' 58       # frame lines: wet sand
sand mute '146;124;94' 137    # activity text, labels
sand head '205;184;148' 180   # column headings, numbers: dry sand
sand accent '192;164;120' 180  # base branch, clock, stage
sand wht '232;214;180' 223    # ticket ids
grn=$'\e[38;5;77m'        # merged
ylw=$'\e[38;5;221m'       # working
cyn=$'\e[38;5;80m'        # ready to land
blu=$'\e[38;5;111m'       # queued, not started
sand gry '94;78;60' 95        # nothing there: damp sand
hot=$'\e[38;5;203m'       # needs you; a container working hard (red, clear of the sand)
# The logo: dry sand at the top, wet sand at the base, specks of shell.
sand moon '232;214;180' 223; sand dusk '205;184;148' 180; sand night '160;134;98' 137; sand deep '112;92;66' 95; sand star '74;58;42' 58
# No colour when NO_COLOR is set (non-empty, no-color.org) or stdout is not a
# terminal. Top level on purpose: the live loop calls render inside $(...),
# where stdout is always a pipe, so the check there would always strip colour.
if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then bold=''; off=''; rule=''; mute=''; head=''; accent=''; wht=''; grn=''; ylw=''; cyn=''; blu=''; gry=''; hot=''; moon=''; dusk=''; night=''; deep=''; star=''; fi
# Inside Herdr each ticket links to its latest log (OSC 8), and the note band says so. Only
# with the kit's Herdr plugin linked (`sandcastle herdr configure` leaves the marker, `--remove`
# takes it out): Ctrl-click opens that ticket's card in a popup, and without the plugin Herdr does nothing
# with the click. No links elsewhere or into a pipe. SANDCASTLE_LINKS=1 or 0 overrides (the tests).
# Whether this is Herdr and a terminal is decided once here; the marker is re-read each redraw
# (relink: a file test, no process), as a view opened before `sandcastle herdr configure` linked
# the plugin would otherwise draw no links until reopened, with nothing to say why. The loop calls
# relink at its top level, not inside render's $(...), whose assignment would be lost with its
# subshell. The path is src/live-runs.ts's KIT_CACHE (an empty XDG_CACHE_HOME is unset, as there).
LINKS="${SANDCASTLE_LINKS:-}"
LINKS_MARKER=""
if [ -z "$LINKS" ] && [ "${HERDR_ENV:-}" = 1 ] && [ -t 1 ]; then LINKS_MARKER="${XDG_CACHE_HOME:-$HOME/.cache}/sandcastle-kit/herdr-plugin-linked"; fi
relink() {
  if [ -n "$LINKS_MARKER" ] && [ -e "$LINKS_MARKER" ]; then LINKS=1
  elif [ -n "$LINKS_MARKER" ] || [ -z "$LINKS" ]; then LINKS=0; fi
}
relink
# The hint's modifier, sensed once by `sandcastle status` from the outer terminal (src/click-hint.ts):
# Ctrl-click is macOS's right-click in iTerm2, where Cmd-click opens the link itself (the log, not
# the card Herdr's plugin draws). Unset or unknown: both named.
case "${SANDCASTLE_CLICK_MOD:-}" in
  ctrl) CLICK_HINT="ctrl-click a ticket for its card" ;;
  cmd) CLICK_HINT="cmd-click a ticket for its log" ;;
  *) CLICK_HINT="ctrl-click a ticket for its card (iTerm2: cmd-click for its log)" ;;
esac

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
# $1 cut to $2 visible columns, ending in … when it was longer, into FIT: no subshell, as the live
# view fits every line of every frame.
fit() {
  local s="$1" w="$2" out="" n=0 esc
  vlen "$s"
  if [ "$VN" -le "$w" ]; then FIT="$s"; return 0; fi
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
  FIT="${out}…${off}"
}

# ---------------------------------------------------------------------------
# The grid. The whole view is one window: every band is split into cells that
# span the pane, and the rules between bands join the bars above and below.
# The helpers return in REPLY rather than print, so a frame of a few hundred
# cells costs no subshell per cell.

# Visible width into VN, without a subshell.
vlen() { vstrip "$1"; VN=${#VS}; }
# A coloured string aligned in $2 columns (l, c or r), cut with … when longer.
align() {
  local s="$1" w="$2" l
  [ "$w" -le 0 ] && { REPLY=""; return 0; }
  vlen "$s"
  if [ "$VN" -gt "$w" ]; then fit "$s" "$w"; REPLY="$FIT"; return 0; fi
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
# Moves each inner bar of OW that lies within 4 columns of a bar of the band
# above ($1, positions as bars_of gives them) onto it, so the two meet in one
# ┼ rather than a near-miss like ┴┬. The widths after $1 are the least each
# cell may be (one already narrower keeps its width): a bar whose move would
# cut a cell stays, and the band still fills the window, the last cell taking
# the remainder. A few integer comparisons per band, never per cell or row.
snap_w() {
  local -a refs=($1) mn=() pos=() suf=()
  local n=${#OW[@]} i r p prev=0 best bd d acc=0
  shift
  for (( i=0; i<n; i++ )); do mn[i]=${1:-0}; [ "${mn[i]}" -gt "${OW[i]}" ] && mn[i]=${OW[i]}; [ $# -gt 0 ] && shift; done
  # suf[i]: columns the cells from i on need, each with the bar that ends it.
  suf[n]=0
  for (( i=n-1; i>=0; i-- )); do suf[i]=$(( suf[i+1] + mn[i] + 1 )); done
  for (( i=0; i<n-1; i++ )); do
    acc=$(( acc + OW[i] + 1 )); p=$acc; best=$p; bd=5
    for r in ${refs[@]+"${refs[@]}"}; do
      d=$(( r > p ? r - p : p - r ))
      [ "$d" -lt "$bd" ] && { bd=$d; best=$r; }
    done
    # A move that cuts this cell or leaves the later ones too little stays put.
    if [ "$best" != "$p" ] && { [ $(( best - prev - 1 )) -lt "${mn[i]}" ] || [ $(( WIN - 1 - best )) -lt "${suf[i+1]}" ]; }; then best=$p; fi
    # An earlier move right may have squeezed this cell.
    [ "$best" -lt $(( prev + 1 + mn[i] )) ] && best=$(( prev + 1 + mn[i] ))
    pos[i]=$best; prev=$best
  done
  prev=0
  for (( i=0; i<n-1; i++ )); do OW[i]=$(( pos[i] - prev - 1 )); prev=${pos[i]}; done
  OW[n-1]=$(( WIN - 2 - prev ))
}
# A rule across the window whose joints meet the bars above ($4) and below
# ($5): $1 left end, $2 right end, $3 fill (─). Into REPLY.
junction() {
  local f="$3" up=" $4 " dn=" $5 " i out="" a b x='┼' y='┴' z='┬'
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
# A slot gauge, █████░ 5/6; only the count past a dozen slots. Used can pass the limit (7/6: the
# base check's extra sandbox, pool.ts `withExtraSlot`): then no free cell, as a negative width
# pads printf to one.
gauge() {
  local g="" free
  if [ "$2" -le 12 ] 2>/dev/null; then
    free=$(( $2 - $1 )); [ "$free" -lt 0 ] && free=0
    rep █ "$1"; g="${ylw}${REPLY}"; rep ░ "$free"; g="${g}${rule}${REPLY}${off} "
  fi
  REPLY="${g}${head}$1/$2${off}"
}
# The frame being built: each line appended and counted, written in one go.
put() { BUF="${BUF}$1
"; BUF_N=$((BUF_N+1)); }
# Items joined by " · " into as few lines of $1 columns as they fit, into the
# WRAPPED array: the note's last clause was cut off in a narrow pane. A caller's
# own WRAP_SEP keeps its row's separator colour.
wrap_items() {
  local w="$1" sep="${WRAP_SEP:-${gry} · ${off}}" line="" item; shift
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
    n=""; fields_of "$name" "$map" '|' && n="${F[1]:-}"
    [ -z "$n" ] && continue
    # "275.8MiB / 11.73GiB" -> "276M"; a GiB figure under 10 keeps a decimal: "2.1GiB" -> "2.1G"
    mem=$(printf '%s' "${mem%%/*}" \
          | awk '{v=$1; sub(/iB$/,"",v);
                  u=substr(v,length(v),1); q=substr(v,1,length(v)-1);
                  if (u == "G" && q + 0 < 10) printf "%.1f%s", q, u; else printf "%.0f%s", q, u}')
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
in_queue() { has_line "$1" "$QUEUE"; }
# Whether a readable log ends saying the plan allowance is spent (run.ts logSaysLimit). A `! error`
# or `! exit N` line quotes a failed tool's output, which can say "usage limit" too, so it is skipped.
# No grep -q at the end: under pipefail, an early exit can fail the pipeline through a writer's SIGPIPE.
log_says_limit() {
  tail -12 "$1" 2>/dev/null | grep -vE '^! (error|exit -?[0-9]+)(: |$)' | tail -5 \
    | grep -iE "out of usage credits|usage limit|limit reached" >/dev/null
}
# The .jsonl sidecars (each pass's raw agent stream) are deliberately not matched here or by any log glob below.
# Ticket ids from log names, one per line. A log is agent-issue-<id>-<phase>-<id>.log
# (phase impl, resolve, review, review-codex, repair, or gates - the orchestrator's gate output):
# the id appears twice, and the repeat tells a ticket called "code-review-01" from the
# phase "review". Logs of hand-suffixed branches (agent-issue-12-closeout-impl-12)
# fall back to the first phase word. (BSD sed has no back-references in -E; awk does it.)
log_ids() {
  awk '{ f=$0; sub(/^.*\//, "", f); if (f !~ /^agent-issue-/) next
    s=substr(f, 13); sub(/\.log$/, "", s); n=length(s); found=""
    for (i=1; i<n; i++) { rest=substr(s, i+1)
      if (rest ~ /^-(impl|resolve|review-codex|review|repair|gates)-/) { t=rest; sub(/^-(impl|resolve|review-codex|review|repair|gates)-/, "", t)
        if (t == substr(s, 1, i)) { found=substr(s, 1, i); break } } }
    if (found == "" && match(s, /-(impl|resolve|review|repair|gates)-/)) found=substr(s, 1, RSTART-1)
    if (found != "") print found }'
}
# A ticket as a person names it: "#12", a suffixed branch "#12" (its suffix is
# shown apart), or a slug such as "checkout-03" as it is.
legacy_id() { [[ "$1" =~ ^[0-9]+(-[a-z]+)*$ ]]; }
# A ticket id as the view shows it, into DISP: no subshell, as every row shows one.
disp() { if legacy_id "$1"; then DISP="#${1%%-*}"; else DISP="$1"; fi; }

# Machine-wide slots (pool.ts): one lock file per slot, holding its owner's
# pid first (then token, run and label, which this ignores). Counts live ones only; the limits come from the CLI.
# A slot's owner is a process of the kit, the rule of src/pool.ts `holderRunning`: a pid that
# `ps` shows as some other process is a killed run's, whose pid came round. When `ps` cannot say
# (BusyBox has no -p) the pid still counts if the process exists, as a signal of 0 shows.
slot_alive() {
  local command
  case "$1" in ''|*[!0-9]*) return 1;; esac
  command=$(ps -p "$1" -o command= 2>/dev/null)
  [ -n "$command" ] && { [[ "$command" == *"$RUN_COMMAND"* ]]; return; }
  kill -0 "$1" 2>/dev/null
}

load_pool() {
  local dir="${XDG_CACHE_HOME:-$HOME/.cache}/sandcastle-kit/slots" pool used f pid
  for pool in sandboxes gates; do
    used=0
    for f in "$dir/$pool"-*.lock; do
      [ -f "$f" ] || continue
      pid=$(cut -d' ' -f1 "$f")
      slot_alive "$pid" && used=$((used+1))
    done
    case "$pool" in sandboxes) lim="${SANDCASTLE_MAX_SANDBOXES:-6}";; gates) lim="${SANDCASTLE_MAX_GATES:-2}";; esac
    printf -v "USED_$pool" '%s' "$used"; printf -v "LIM_$pool" '%s' "$lim"
  done
}

# A run's pid is the run only while it is a process of the kit: a pid comes round again as some
# other process, and a run that was killed would read as live. The same rule as
# mod/hooks/run-live.ts (`RUN_COMMAND`, and `ps -p <pid> -o command=`, the flags BSD and procps
# share), in bash: a node start on each redraw is too slow. test/run-live-contract.test.ts holds
# the two together.
RUN_COMMAND="src/cli.ts"
run_alive() {
  local command
  command=$(ps -p "$1" -o command= 2>/dev/null) || return 1
  [[ "$command" == *"$RUN_COMMAND"* ]]
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
#   TICKETS  "id US state US since US started US order US note US requeued US tokens" lines
#   RECORD   1 while the live run keeps TICKETS (an older orchestrator does not)
# Older records: RUN_ISSUES, WAITING ("issue|#dep, #dep") and ACTIVE
# ("issue|phase|since") are what a run wrote before `tickets`.
US=$'\x1f'
WAITING=""; RUN_LIVE=0; RUN_ISSUES=""; RUN_STARTED=""; OUTCOMES=""; ACTIVE=""; UNMETS=""; LAST_TOKENS=""; ENDED_TICKETS=""
TICKETS=""; TICKET_IDS=""; RECORD=0; TYPICAL=""; RUN_ETA=""; FREE=0; SHARE_WAIT=0; RUN_PAUSED=0
load_run() {
  WAITING=""; RUN_LIVE=0; RUN_ISSUES=""; RUN_STARTED=""; OUTCOMES=""; ACTIVE=""; UNMETS=""; LAST_TOKENS=""; ENDED_TICKETS=""
  TICKETS=""; TICKET_IDS=""; RECORD=0; TYPICAL=""; RUN_ETA=""; FREE=0; POOL_DEMAND=""; POOL_SHARE=""; POOL_CAP=""; SHARE_WAIT=0; RUN_PAUSED=0
  local f=logs/run.json pid="" paused="" pool="" issues="" waiting="" active="" tickets="" free="" typical="" eta="" last_tokens=""
  # What each branch's last run decided: "slug|run|kind|text" lines. A row
  # shows it, and one whose run is not the recorded run is a leftover. An
  # older kit's entry has no kind, and its line under "outcome".
  [ -f logs/outcomes.json ] && OUTCOMES=$(jq -r 'to_entries[] | "\(.key)|\(.value.run // "")|\(.value.kind // "")|\(.value.text // .value.outcome // "")"' logs/outcomes.json 2>/dev/null)
  [ -f "$f" ] || return 0
  # The whole record in one jq: one call per field read the file a dozen times a frame. Each field
  # is still its own: one that a newer or older kit wrote in another shape empties only itself, and
  # a field's lines are what `jq -r` printed for it alone. Assignments, quoted by @sh, for eval.
  #   UNMETS   the criterion each partly-done ticket left unmet ("id US text" lines): kept for a
  #            run that has ended too.
  #   paused   1 while a person has the run paused (`sandcastle pause`): no ticket starts until
  #            `sandcastle resume`.
  #   pool     this run's demand and share of the machine pool, live values the run rewrites; an
  #            older kit's record has neither. The cap (`sandcastle cap`) is a person's, and
  #            absent when there is none. Then 1 while the run waits for a slot its share holds
  #            back (`waitsForShare`), else 0.
  #   free     sandboxes the run has yet to fill: queued tickets that fit in them start at once,
  #            so none of them is "behind" another. A ticket that is landing holds no slot: its
  #            merge runs on the host, or in the landing worker's own box.
  #   eta      when the run ends: the queued tickets at a typical issue's length each, the working
  #            ones at what is left of theirs (a minute at least), over the sandboxes the run uses
  #            at once. Only once there is a typical issue - from earlier runs, or this run's first
  #            finished one. A ticket that is landing is neither queued nor working here, so the
  #            figure is when the last pipeline ends. Tickets land as they go green, on one worker,
  #            one landing gate after another: the tickets not yet landed times a ticket's usual
  #            landing gates (`typical["landing gates"]`, none for a ticket that landed without
  #            one) is a floor on the end, which the landing queue, not the pipelines, can set.
  eval "$(jq -r --argjson now "$now_s" '
    def lines(f): [(f)? | if type == "string" then . else tojson end] | join("\n") | sub("\n+$"; "");
    @sh "UNMETS=\(lines((.tickets // {}) | to_entries[] | select(.value.unmet) | [.key, (.value.unmet | tostring | gsub("[\\n\\r]+"; " "))] | join("\u001f")))",
    @sh "RUN_STARTED=\(lines(.startedAt // empty))",
    @sh "pid=\(lines(if .finishedAt then empty else (.pid // empty) end))",
    @sh "paused=\(lines(if (.paused | type) == "object" then 1 else 0 end))",
    @sh "pool=\(lines([(.demand // "" | tostring), (.share // "" | tostring), (.cap // "-" | tostring), (if .waitsForShare == true then "1" else "0" end)] | join(" ")))",
    @sh "issues=\(lines((.issues // [])[] | tostring))",
    @sh "waiting=\(lines((.waiting // [])[] | "\(.issue)|\([.on[] | tostring | if test("^[0-9]+$") then "#" + . else . end] | join(", "))"))",
    @sh "active=\(lines((.active // {}) | to_entries[] | "\(.key)|\(.value.phase)|\(.value.since)"))",
    @sh "tickets=\(lines((.tickets // {}) | to_entries[] | [.key, (.value.state // ""), (.value.since // "" | tostring),
      (.value.started // "" | tostring), (.value.order // "" | tostring), (.value.note // ""), (.value.requeued // ""), (.value.tokens // "" | tostring)] | join("\u001f")))",
    @sh "free=\(lines([((.concurrency // 1) - ([(.tickets // {})[] | select((.state // "") | IN("setup", "implement", "resolve", "review", "cross-review", "gates", "repair"))] | length)), 0] | max))",
    @sh "typical=\(lines((.typical // {}) | to_entries[] | "\(.key)|\(.value)"))",
    @sh "last_tokens=\(lines((.tickets // {}) | to_entries[] | select(.value.tokens | type == "string") | "\(.key)|\(.value.tokens)"))",
    @sh "eta=\(lines(
      (.typical.issue // null) as $t
      | if $t == null or (.stage // "") != "running" then empty else
        ([(.tickets // {})[] | select(.state == "queued")] | length) as $q
        | ([(.tickets // {})[] | (.attemptStarted // .started) as $s | select($s != null and ((.state // "") | IN("setup", "implement", "resolve", "review", "cross-review", "gates", "repair"))) | ([$t - ($now - $s), 60] | max)] | add // 0) as $a
        | ([(.tickets // {})[] | select((.state // "") | IN("queued", "setup", "implement", "resolve", "review", "cross-review", "gates", "repair", "ready", "landing"))] | length) as $n
        | ($now + ($q * $t + $a) / ([(.concurrency // 1), 1] | max)) as $p
        | ($now + $n * (.typical["landing gates"] // 0)) as $l
        | ([$p, $l] | max) | floor end))"
  ' "$f" 2>/dev/null)"
  # An ended run's rows are inferred from git and the logs, but its per-ticket tokens are still the record's,
  # and so are its finished tickets' starts and ends (TIME).
  LAST_TOKENS="$last_tokens"; ENDED_TICKETS="$tickets"
  [ -n "$pid" ] && run_alive "$pid" || return 0
  RUN_LIVE=1
  [ "$paused" = 1 ] && RUN_PAUSED=1
  read -r POOL_DEMAND POOL_SHARE POOL_CAP SHARE_WAIT <<<"$pool"
  [[ "$POOL_DEMAND" =~ ^[0-9]+$ && "$POOL_SHARE" =~ ^[0-9]+$ ]] || { POOL_DEMAND=""; POOL_SHARE=""; }
  [[ "$POOL_CAP" =~ ^[0-9]+$ ]] || POOL_CAP=""
  [ "$SHARE_WAIT" = 1 ] || SHARE_WAIT=0
  RUN_ISSUES="$issues"; WAITING="$waiting"; ACTIVE="$active"; TICKETS="$tickets"; TYPICAL="$typical"; RUN_ETA="$eta"
  if [ -n "$TICKETS" ]; then
    RECORD=1
    TICKET_IDS=$(printf '%s\n' "$TICKETS" | cut -d"$US" -f1 | sort -V)
  fi
  FREE="$free"
  [[ "$FREE" =~ ^[0-9]+$ ]] || FREE=0
  return 0
}
# "phase|since" for an issue an older live run is working on, or empty.
active_of() { fields_of "$1" "$ACTIVE" '|' || return 0; printf '%s|%s\n' "${F[1]:-}" "${F[2]:-}"; }
in_record() { [ "$RECORD" = 1 ] && has_line "$1" "$TICKET_IDS"; }
# Seconds a step usually takes in this project (run.json's `typical`), or empty.
typical_of() { fields_of "$1" "$TYPICAL" '|' || return 0; printf '%s\n' "${F[1]:-}"; }

# Seconds as the TIME column shows them.
# Into AGO, not printed: every row has one, and a subshell each cost the frame a process.
ago() {
  # The frame's clock is read before run.json, so a state written in between is a second "ahead".
  if   [ "$1" -lt 1 ]; then AGO=0s
  elif [ "$1" -lt 60 ]; then AGO="$1s"
  elif [ "$1" -lt 3600 ]; then AGO="$(( $1 / 60 ))m"
  else AGO="$(( $1 / 3600 ))h"; fi
}
# A run's length: "48m", "1h12m". Into DUR, as ago into AGO: every finished row has one.
dur_v() {
  if [ "$1" -lt 3600 ]; then DUR="$(( $1 / 60 ))m"
  else printf -v DUR '%sh%02dm' "$(( $1 / 3600 ))" "$(( $1 % 3600 / 60 ))"; fi
}
dur() { dur_v "$1"; printf '%s' "$DUR"; }
# A finished ticket's TIME, into FIN: its whole length, first start to end (`since` is when it entered its
# end state), as "how long ago" reads the same for a quick ticket and a slow one. False for a working
# state, or a record with no start. $1 state, $2 since, $3 started.
finished_time() {
  case "$1" in merged|held|red|conflict|nochange|uncommitted|crashed|"not landed"|withdrawn|stopped|skipped) ;; *) return 1;; esac
  [[ "$2" =~ ^[0-9]+$ && "$3" =~ ^[0-9]+$ ]] && [ "$2" -ge "$3" ] || return 1
  if [ $(( $2 - $3 )) -lt 60 ]; then ago $(( $2 - $3 )); FIN="$AGO"; else dur_v $(( $2 - $3 )); FIN="$DUR"; fi
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
  local updated merged landing
  disp "$1"
  landing=$(git log "$BASE" -1 --format='%ct %s' --fixed-strings --grep="Merge agent/issue-$1 (closes $DISP)" --grep="Merge agent/issue-$1 (part of $DISP)" 2>/dev/null)
  merged="${landing%% *}"
  [ -z "$merged" ] && return 0
  # A partly-done landing leaves its ticket open and in the queue by design, and its own comment moves
  # the issue after the merge: neither is a person putting it back, so it reads as partly done.
  case "$landing" in *"(part of "*) return 1;; esac
  updated=""; fields_of "$1" "$QUEUE_UPDATED" '|' && updated="${F[1]:-}"
  [ -n "$updated" ] && [ "$updated" -gt "$merged" ]
}

# What an issue waits for: the live run's own decision first - it will not
# start the issue this run even if the dependency closes meanwhile - then the
# issue body's open dependencies. Empty when nothing holds it back.
blocked_on() {
  local on
  on=""; fields_of "$1" "$WAITING" '|' && on="${F[1]:-}"
  [ -z "$on" ] && fields_of "$1" "$QUEUE_DEPS" '|' && on="${F[1]:-}"
  printf '%s' "$on"
}

# "run|kind|text" for a branch slug, from OUTCOMES.
outcome_of() { fields_of "$1" "$OUTCOMES" '|' || return 0; printf '%s|%s|%s\n' "${F[1]:-}" "${F[2]:-}" "${F[3]:-}"; }
# A branch the kit held for a person (at landing, or a conflict resolution it
# would not trust) that a person has since merged by hand: its tip is on the
# base, so it has no commits over it, as a hand-back has none. Only the
# outcome tells the two apart; the ticket stays open until the push closes it.
hand_merged() {
  local oc
  oc=$(outcome_of "$1")
  case "$oc" in *'|held|needs a human: handed back') return 1;; *'|held|'*) ;; *) return 1;; esac
  git merge-base --is-ancestor "refs/heads/agent/issue-$1" "refs/heads/$BASE" 2>/dev/null
}
# What a hand-merged row says the push still has to do. The view cannot ask the
# tracker on every refresh, but the merge commit being on origin's base branch
# says the push happened. The merge commit is the merge that took the branch tip
# in (the tip as a second parent); a fast-forward has none, so the tip itself -
# not a later merge onto it, which would wait for a push already made. No
# origin/<base> ref, or no way to find the commit, keeps "closes on push".
hand_merged_note() {
  local tip merge
  if git rev-parse --verify --quiet "refs/remotes/origin/$BASE" >/dev/null 2>&1 \
    && tip=$(git rev-parse --verify --quiet "refs/heads/agent/issue-$1" 2>/dev/null) && [ -n "$tip" ]; then
    merge=$(git rev-list --merges --ancestry-path --parents "$tip..refs/heads/$BASE" 2>/dev/null \
      | awk -v t="$tip" '{ for (i = 3; i <= NF; i++) if ($i == t) { print $1; exit } }')
    if git merge-base --is-ancestor "${merge:-$tip}" "refs/remotes/origin/$BASE" 2>/dev/null; then
      printf 'merged by hand'; return
    fi
  fi
  printf 'merged by hand; closes on push'
}

# The row state for a recorded outcome's kind (mod/hooks/run-record.ts), in
# the words the live view uses. Never the line's words: a line the case did
# not foresee once read as ready. No kind, or one this view does not know,
# is no state, and the row is worked out as if no outcome were recorded.
outcome_state() {
  case "$1" in
    green) printf 'ready';;
    merged) printf 'merged';;
    conflict) printf 'conflict';;
    # Red at landing, once or again after a requeue, is as red as a pipeline's gate.
    red|"gate red") printf 'gate red';;
    held|"taken back") printf 'held';;
    uncommitted) printf 'uncommitted';;
    crashed) printf 'crashed';;
    "not landed") printf 'not landed';;
    withdrawn) printf 'withdrawn';;
    stopped) printf 'stopped';;
    "no change") printf 'no change';;
  esac
}

# The one vocabulary: the table, the header, the Herdr panes and the report
# all use these words. Sets glyph, colour, prio (sort order) and grp (the
# header count and the overflow line).
style_of() {
  case "$1" in
    setup|impl|resolve|review|codex|gates|repair|landing) glyph='●'; colour="$ylw"; prio=0; grp=working;;
    stalled|orphaned|stopped|"gate red"|conflict|held|uncommitted|crashed|"not landed") glyph='!'; colour="$hot"; prio=1; grp="needs you";;
    ready|finished) glyph='>'; colour="$cyn"; prio=2; grp=ready;;
    queued|requeued|paused) glyph='○'; colour="$blu"; prio=3; grp=queued;;
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

# The CPU/MEM column's two halves from stat_for; the CPU figure is coloured only when
# it is high enough to be worth noticing.
cpu_cols() {
  cpu="$S_CPU"; mem="$S_MEM"; cpu_col="$head"
  if [ -z "$cpu" ]; then cpu="-"; mem="-"; cpu_col="$gry"
  elif [ "$S_HOT" = "1" ]; then cpu_col="$hot"; fi
  tok="-"; tok_col="$gry"
}

# The TOKENS cell of a ticket from its record's `tokens` ("3.1M in / 42k out", what the run writes, the
# running pass included): "3.1M/42k". Anything else, and none yet, is a grey "-".
tokens_cell() {
  [[ "$1" =~ ^([0-9.]+[kM]?)\ in\ /\ ([0-9.]+[kM]?)\ out$ ]] || return 0
  tok="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"; tok_col="$head"
}

# The run cell of a run a person has paused: `PAUSED since 15:40 - finishing #12 review, #14 landing`
# while tickets are still finishing a pass or a landing, then `PAUSED since 15:40`. In a pane too narrow
# for the whole line the tickets still finishing take the cell's second row. No end time: a paused run has none.
# A run that paused itself for its plan's usage (USAGE_PAUSE) says what it waits for and when it resumes in
# place of when it paused: `PAUSED - weekly usage 95%, resumes Wed 06:01`, the tickets still finishing on the
# second row; in a pane too narrow for that, `resumes Wed 06:01` takes the second row.
# $1: when it was paused (epoch seconds or milliseconds, or an ISO time); $2: "id=state ..."; $3: when the run started.
# $4-$7, only for a usage pause: its window (fiveHour or week), the window's percent, when the run resumes
# (epoch seconds) and whose plan it is (claude or codex).
paused_cell() {
  local when="$1" fin="$2" began="$3" uwin="${4:-}" upct="${5:-}" ures="${6:-}" uprov="${7:-}" at pair id st word list="" plain sep="" room what back
  case "$when" in
    *[!0-9]*) at=$(utc_to_epoch "${when%%.*}");;
    *) at="$when"; [ "${#at}" -ge 13 ] && at=$(( at / 1000 ));;
  esac
  if [ "$(epoch_fmt "$at" +%F)" = "$(date +%F)" ]; then when=$(epoch_fmt "$at" '+%H:%M'); else when=$(epoch_fmt "$at" '+%d %b %H:%M'); fi
  # What each ticket is doing, in the table's words; a green branch waiting for the landing worker is about to land.
  for pair in $fin; do
    id="${pair%%=*}"; st="${pair#*=}"
    case "$st" in implement) word=impl;; cross-review) word=codex;; ready) word=landing;; *) word="$st";; esac
    disp "$id"; list="${list}${sep}${DISP}${word:+ $word}"; sep=", "
  done
  plain="PAUSED since ${when}"
  # The cell's text room: its share of the pane (half below 170 columns, a fifth from there) less the bars,
  # the cell's padding and the row's label.
  if [ "$cols" -ge 170 ]; then room=$(( (cols - 5) / 5 - 12 )); else room=$(( (cols - 3) / 2 - 12 )); fi
  if [ -n "$uwin" ]; then
    what="weekly"; [ "$uwin" = fiveHour ] && what="5-hour"
    [ "$uprov" = codex ] && what="Codex ${what}"
    what="${what} usage ${upct}%"
    # The reset's day only when it is not today, with the weekday as the usage row has it.
    if [ "$(epoch_fmt "$ures" +%F)" = "$(date +%F)" ]; then back=$(epoch_fmt "$ures" '+%H:%M'); else back=$(epoch_fmt "$ures" '+%a %H:%M'); fi
    # Shorter and shorter until the state fits its row: the whole line, then the window, then only that it is usage.
    if [ $(( 9 + ${#what} + 10 + ${#back} )) -le "$room" ]; then
      kvl state "${bold}${ylw}PAUSED${off} ${mute}- ${what}, resumes ${back}${off}"; RUNC[0]="$REPLY"
      if [ -n "$list" ]; then kvl finishing "${head}${list}${off}"; else kvl since "${mute}${began}${off}"; fi
    else
      [ $(( 9 + ${#what} )) -gt "$room" ] && what="usage ${upct}%"
      kvl state "${bold}${ylw}PAUSED${off} ${mute}- ${what}${off}"; RUNC[0]="$REPLY"
      kvl resumes "${mute}${back}${off}"
    fi
    RUNC[1]="$REPLY"
    return 0
  fi
  if [ -n "$list" ] && [ $(( ${#plain} + 13 + ${#list} )) -le "$room" ]; then
    kvl state "${bold}${ylw}PAUSED${off} ${mute}since ${when} - finishing${off} ${head}${list}${off}"; RUNC[0]="$REPLY"
    kvl since "${mute}${began}${off}"
  else
    kvl state "${bold}${ylw}PAUSED${off} ${mute}since ${when}${off}"; RUNC[0]="$REPLY"
    if [ -n "$list" ]; then kvl finishing "${head}${list}${off}"; else kvl since "${mute}${began}${off}"; fi
  fi
  RUNC[1]="$REPLY"
}

# The run's state, its times and its tokens, as the run cell's three rows (RUNC).
run_cell() {
  local f=logs/run.json orch pid started finished code models stage dry tokens paused_at finishing p_win p_pct p_res p_prov stopped t0 eta
  RUNC=("" "" "")
  [ -f "$f" ] || { kvl state "${mute}no run recorded yet${off}"; RUNC[0]="$REPLY"; return 0; }
  # A unit separator, not a tab: read collapses runs of whitespace IFS, so an
  # empty finishedAt would shift every later field. A paused run (`sandcastle pause`) adds when it
  # was paused (empty when it is not) and the tickets it still finishes, as "id=state id=state"; one that
  # paused itself for its plan's usage adds the window, its percent, when it resumes and whose plan it is
  # (empty for a person's pause, and for a cause the record does not state with numbers). A run that
  # stopped landing (its `.git` guard tripped) but still finishes what is in flight adds 1 last.
  IFS="$US" read -r orch pid started finished code models stage dry tokens paused_at finishing p_win p_pct p_res p_prov stopped < <(jq -r \
    '. as $r | (if (.paused | type) == "object" then .paused else null end) as $p
      | [.orchestrator, (.pid|tostring), .startedAt, (.finishedAt // ""), (.exitCode // "" | tostring), .models, (.stage // ""), (if .dryRun then "dry run" else "" end), (.tokens // ""),
      (if $p then ($p.since // 0 | tostring) else "" end),
      (if $p and ($p.finishing | type) == "array" then [$p.finishing[] | tostring as $i | "\($i)=\(($r.tickets[$i].state // "") | tostring)"] | join(" ") else "" end)]
      + (if $p and $p.cause == "usage" and ($p.window == "fiveHour" or $p.window == "week") and ($p.percent | type) == "number" and ($p.resumesAt | type) == "number"
         then [$p.window, ([([$p.percent | floor, 100] | min), 0] | max | tostring), ($p.resumesAt | floor | tostring), (if $p.provider == "codex" then "codex" else "claude" end)]
         else ["", "", "", ""] end)
      + [(if (.stopped | type) == "string" and .stopped != "" then "1" else "" end)]
      | join("\u001f")' "$f")
  t0=$(utc_to_epoch "${started%%.*}")
  # The date only when it is not today: the run cell has to fit 80 columns.
  if [ "$(epoch_fmt "$t0" +%F)" = "$(date +%F)" ]; then started=$(epoch_fmt "$t0" '+%H:%M'); else started=$(epoch_fmt "$t0" '+%d %b %H:%M'); fi
  # "running" is the stage between the start-up steps and landing; the run
  # cell already says running.
  [ "$stage" = running ] && stage=""
  if [ -n "$finished" ]; then
    kvl state "${mute}ended (exit ${code})${off}"; RUNC[0]="$REPLY"
    kvl started "${mute}${started}${off}"; RUNC[1]="$REPLY"
  elif run_alive "$pid" && [ -n "$stopped" ]; then
    # The guard stopped the landing: what is in flight still finishes, nothing more lands. Said in the
    # cell the moment it happens, not once the run has ended - and before a pause, which a stop ends
    # (it wakes the parked tickets), so the cell never reads PAUSED for a run that cannot resume.
    kvl state "${bold}${hot}STOPPED${off} ${mute}landing · $(dur $(( $(date +%s) - t0 )))${off}"; RUNC[0]="$REPLY"
    kvl since "${mute}${started} · lands nothing more${off}"; RUNC[1]="$REPLY"
  elif run_alive "$pid" && [ -n "$paused_at" ]; then
    paused_cell "$paused_at" "$finishing" "$started" "$p_win" "$p_pct" "$p_res" "$p_prov"
  elif run_alive "$pid"; then
    # The stage says what a run is doing before its first sandbox exists -
    # image, preflight, base gates - and after its last: "landing 6/25".
    kvl state "${ylw}running${off}${dry:+ ${accent}${dry}${off}} ${mute}· $(dur $(( $(date +%s) - t0 )))${off}${stage:+ ${rule}·${off} ${accent}${stage}${off}}"; RUNC[0]="$REPLY"
    if [ -n "$RUN_ETA" ]; then
      kvl ends "${accent}~$(epoch_fmt "$RUN_ETA" '+%H:%M')${off} ${mute}· since ${started}${off}"
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

# The run settings the settings row shows, as "autonomy US turn US cap US repair US concurrency US asked US cross US model US effort US guard US stop US reading US apikey US pause" into SET_FIELDS:
# a live run's record, else the next run's (`sandcastle status` passes them as SANDCASTLE_SETTINGS,
# a settings group, the way it passes the models), else the last run's record. Only what the
# source holds: a field it lacks stays empty and is never filled with a default, and a record
# with no settings group gives no row. $1: a file holding a run record.
read_settings() {
  local f="$1"
  jq -r '(.settings // {}) | if type == "object" then [(.autonomy // "" | tostring), (.turn // "" | tostring), (.cap // "" | tostring), (.repair // "" | tostring), (.concurrency // "" | tostring), (.asked // "" | tostring),
    (if .crossReview == true then "on" elif .crossReview == false then "off" else "" end),
    (if .crossReview == true then (.crossReviewModel // "" | tostring) else "" end),
    (if .crossReview == true then (.crossReviewEffort // "" | tostring) else "" end),
    (.usageGuard | if . == null then "" else tostring end), (.usageStop // "" | tostring), (.usageReading // "" | tostring),
    (if .apiKey == true then "on" else "" end), (.usagePause // "" | tostring)] | join("\u001f") else "" end' "$f" 2>/dev/null
}
settings_fields() {
  SET_MARK=""; SET_FIELDS=""
  if [ "$RUN_LIVE" = 1 ]; then SET_FIELDS=$(read_settings logs/run.json)
  elif [ -n "${SANDCASTLE_SETTINGS+x}" ]; then SET_MARK="next run"; SET_FIELDS=$(read_settings <(printf '{"settings":%s}' "${SANDCASTLE_SETTINGS:-null}"))
  elif [ -f logs/run.json ]; then SET_MARK="last run"; SET_FIELDS=$(read_settings logs/run.json)
  fi
}

# The settings row into SETTINGS_ROWS (empty for none), from the pane's width in $cols. A row too
# wide for the pane wraps whole items onto further lines, so the usage guard's warning is never cut
# off. Each item is
# added with set_item: its text, the shorter text it has below 100 columns, and the narrowest pane
# it stays in (0: always; 80 for an item marked ○ in the plan, which drops below 80 columns).
SET_ITEMS=()
set_item() { # full narrow min_cols
  [ "$cols" -ge "${3:-0}" ] || return 0
  if [ "$cols" -ge 100 ]; then SET_ITEMS[${#SET_ITEMS[@]}]="$1"; else SET_ITEMS[${#SET_ITEMS[@]}]="${2:-$1}"; fi
}
settings_row() {
  local lvl turn cap repair conc asked ask cross xmodel xeffort guard stop reading apikey pause l i n levels="" WRAP_SEP="${rule} · ${off}"
  SETTINGS_ROWS=(); SET_ITEMS=(); CROSS_SET=""
  settings_fields
  [ -n "$SET_FIELDS" ] || return 0
  IFS="$US" read -r lvl turn cap repair conc asked cross xmodel xeffort guard stop reading apikey pause <<<"$SET_FIELDS"
  CROSS_SET="$cross"
  # A level the record does not hold, or one outside the five, is not drawn.
  case "$lvl" in
    0|1|2|3|drain)
      for l in 0 1 2 3 drain; do
        if [ "$l" = "$lvl" ]; then levels="$levels ${bold}${accent}[${l}]${off}"; else levels="$levels ${gry}${l}${off}"; fi
      done
      set_item "${mute}autonomy${off}${levels}" "${mute}autonomy${off} ${bold}${accent}${lvl}${off}";;
  esac
  [[ "$cap" =~ ^[0-9]+$ ]] || cap=""
  [[ "$turn" =~ ^[0-9]+$ ]] && set_item "${mute}turn${off} ${head}${turn}${cap:+/${cap}}${off}"
  # Repair attempts: off is greyed, with the ○ that says so without colour, and drops below 80 columns.
  if [[ "$repair" =~ ^[0-9]+$ ]]; then
    if [ "$repair" -eq 0 ]; then set_item "${gry}○ repair${off}" "" 80
    else set_item "${mute}repair${off} ${head}${repair}${off}"; fi
  fi
  # Concurrency, as the run takes it after the machine-wide sandbox cap; what it asked for only when that differs.
  if [[ "$conc" =~ ^[0-9]+$ ]]; then
    ask=""
    [[ "$asked" =~ ^[0-9]+$ ]] && [ "$asked" -ne "$conc" ] && ask=" ${gry}(asked ${asked})${off}"
    set_item "${mute}concurrency${off} ${head}${conc}${off}${ask}"
  fi
  # The record is a file in a repository: a model or effort that is not plain text is left out,
  # never drawn into the terminal.
  case "$cross" in
    on)
      [[ "$xmodel" =~ ^[A-Za-z0-9._:/-]+$ ]] || xmodel=""
      case "$xeffort" in low|medium|high|xhigh) ;; *) xeffort="";; esac
      set_item "${accent}●${off} ${mute}cross-review${off}${xmodel:+ ${head}${xmodel}${xeffort:+ ${xeffort}}${off}}";;
    off) set_item "${gry}○ cross-review${off}" "" 80;;
  esac
  # The usage guard: only a record that holds the field says anything about it. A lost reading is a
  # fact beside the setting, drawn in the warning colour, and stays at any width.
  [[ "$stop" =~ ^[0-9]+$ ]] || stop=""
  case "$guard" in
    true)
      if [ "$reading" = unavailable ]; then set_item "${ylw}● usage-guard${stop:+ ${stop}%} (no reading - not guarding)${off}"
      else set_item "${grn}●${off} ${mute}usage-guard${off}${stop:+ ${head}${stop}%${off}}"; fi;;
    false) set_item "${gry}○ usage-guard${off}" "" 80;;
  esac
  # The usage pause (USAGE_PAUSE) watches the plan too, so a row that says the guard is off says it.
  [[ "$pause" =~ ^[0-9]+$ ]] && set_item "${grn}●${off} ${mute}usage-pause${off} ${head}${pause}%${off}"
  # An API key the sandboxes spend: never silent, so it is red, says so in words, and stays at any width.
  [ "$apikey" = on ] && set_item "${hot}● API credits (ANTHROPIC_API_KEY)${off}" "${hot}● API credits${off}"
  [ "${#SET_ITEMS[@]}" -gt 0 ] || return 0
  # The next run's settings are not the ended run's: "next run:" leads the whole row, so a reader of
  # the closing summary's recorded settings never takes this row for them.
  [ "$SET_MARK" = "next run" ] && SET_ITEMS[0]="${gry}next run:${off} ${SET_ITEMS[0]}"
  wrap_items $(( cols - 14 )) "${SET_ITEMS[@]}"
  if [ "$SET_MARK" = "last run" ]; then
    # The mark ends the last line, or stands on a line of its own when that would cut the line.
    n=$(( ${#WRAPPED[@]} - 1 ))
    vlen "${WRAPPED[n]} (${SET_MARK})"
    if [ "$VN" -le $(( cols - 14 )) ]; then WRAPPED[n]="${WRAPPED[n]} ${gry}(${SET_MARK})${off}"; else WRAPPED[n+1]="${gry}(${SET_MARK})${off}"; fi
  fi
  kvl settings "${WRAPPED[0]}"; SETTINGS_ROWS[0]="$REPLY"
  for (( i=1; i<${#WRAPPED[@]}; i++ )); do SETTINGS_ROWS[i]="          ${WRAPPED[i]}"; done
  return 0
}

# The plan's usage: a live run's record holds the newest reading of each provider across its agents'
# own rate-limit events (`usage`, written by src/usage.ts: a list with an entry per provider, or the one
# object an older kit wrote), and the row shows both windows of each beside the reading's age. Claude's
# entry is there only for a live run that spends a subscription on a Claude model, Codex's only while
# cross-review runs on a ChatGPT plan: the record says nothing (no line) for any other run, a record whose
# settings say API credits has no Claude line whatever else it holds, and one whose settings say
# cross-review is off has no Codex line. Before a provider's first reading, its line says it is waiting.
# The fields come out of the record one provider a line, as "provider US 5h percent US 5h resets US week
# percent US week resets US at", and are checked here, a record being a file in a repository.
read_usage() {
  USAGE_FIELDS=""
  [ "$RUN_LIVE" = 1 ] || return 0
  USAGE_FIELDS=$(jq -r 'def num(f): try (f | if type == "number" then tostring else "" end) catch "";
    (if (.settings | type) == "object" then .settings else {} end) as $s
    | ((.usage // []) | if type == "array" then . elif type == "object" then [.] else [] end)
    | .[] | select(type == "object")
    | select((.provider == "claude" and $s.apiKey != true) or (.provider == "codex" and $s.crossReview != false))
    | [.provider, num(.windows.fiveHour.percent), num(.windows.fiveHour.resetsAt), num(.windows.week.percent), num(.windows.week.resetsAt), num(.at)] | join("\u001f")' logs/run.json 2>/dev/null)
}
# One window as "5h ▓░░░░░░░░░ 14% · resets 18:10", the bar and the percentage in the band's
# colour: the normal one below 75%, amber from 75%, red from 90% (src/usage.ts holds the same two
# numbers), grey once the reading is stale ($USAGE_GREY). $1 label, $2 percent, $3 resets (epoch
# seconds), $4 the reset time's date format.
usage_window() {
  local n when="" c filled empty
  if [ "$USAGE_GREY" = 1 ]; then c="$gry"; elif [ "$2" -ge 90 ]; then c="$hot"; elif [ "$2" -ge 75 ]; then c="$ylw"; else c="$head"; fi
  n=$(( ($2 + 5) / 10 )); [ "$2" -gt 0 ] && [ "$n" -eq 0 ] && n=1
  rep ▓ "$n"; filled="$REPLY"
  rep ░ $(( 10 - n )); empty="$REPLY"
  REPLY="${mute}$1${off} ${c}${filled}${gry}${empty}${off} ${c}${2}%${off}"
  when=$(epoch_fmt "$3" "$4")
  [ -n "$when" ] && REPLY="${REPLY} ${mute}· resets ${when}${off}"
  return 0
}
# A whole number from $1 into REPLY: a fraction loses its decimals, anything else is empty.
whole_number() { if [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then REPLY="${1%%.*}"; else REPLY=""; fi; }
# The usage rows into the header's rows (SETTINGS_ROWS, which settings_row filled), a line for each
# provider in use, each wrapped at whole items from the pane's width in $cols:
# "claude  5h ...   week ...   (2m ago)", then "codex   5h ...   week ...   (2m ago)".
usage_row() {
  local line prov p5 r5 pw rw at age w5 ww name who n=0 i WRAP_SEP="   "
  local -a items=()
  read_usage
  [ -n "$USAGE_FIELDS" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    IFS="$US" read -r prov p5 r5 pw rw at <<<"$line"
    whole_number "$p5"; p5="$REPLY"; whole_number "$r5"; r5="$REPLY"
    whole_number "$pw"; pw="$REPLY"; whole_number "$rw"; rw="$REPLY"
    whole_number "$at"; at="$REPLY"
    # The names are one width, so the bars of the lines below one another start in one column.
    printf -v name '%-6s' "$prov"
    if [ -n "$p5" ] && [ -n "$r5" ] && [ -n "$pw" ] && [ -n "$rw" ] && [ -n "$at" ]; then
      # A percentage past 100 stops there.
      [ "$p5" -gt 100 ] && p5=100
      [ "$pw" -gt 100 ] && pw=100
      age=$(( $(date +%s) - at )); [ "$age" -lt 0 ] && age=0
      # A reading older than 15 minutes (USAGE_STALE_SECONDS) is greyed, its age beside it.
      USAGE_GREY=0; [ "$age" -gt 900 ] && USAGE_GREY=1
      usage_window 5h "$p5" "$r5" +%H:%M; w5="$REPLY"
      usage_window week "$pw" "$rw" '+%a %H:%M'; ww="$REPLY"
      ago "$age"
      items=("${mute}${name}${off}  ${w5}" "$ww" "${mute}(${AGO} ago)${off}")
    else
      # Claude's reading comes from any agent's stream, Codex's from the cross-review pass's.
      who="agent's"; [ "$prov" = codex ] && who="cross-review's"
      items=("${mute}${name}${off}  ${gry}waiting for the first ${who} reading${off}")
    fi
    wrap_items $(( cols - 14 )) "${items[@]}"
    if [ "$n" -eq 0 ]; then kvl usage "${WRAPPED[0]}"; else REPLY="          ${WRAPPED[0]}"; fi
    SETTINGS_ROWS[${#SETTINGS_ROWS[@]}]="$REPLY"
    for (( i=1; i<${#WRAPPED[@]}; i++ )); do SETTINGS_ROWS[${#SETTINGS_ROWS[@]}]="          ${WRAPPED[i]}"; done
    n=$(( n + 1 ))
  done <<<"$USAGE_FIELDS"
  return 0
}

# How many commits a merged ticket landed: once merged, its branch has none
# left over the base, and a 0 read as "merged nothing". Its merge commit's
# second parent says (a squash is the one commit); "-" when none is found. A merge that left a
# criterion unmet is "part of" its ticket, not "closes" it.
landed_commits() {
  local p
  disp "$1"
  p=$(git log "$BASE" -1 --format=%P --fixed-strings --grep="Merge agent/issue-$1 (closes $DISP)" --grep="Merge agent/issue-$1 (part of $DISP)" 2>/dev/null)
  case "$p" in
    # --no-merges, as the kit counts a branch's own commits: a base merge or a resolution is not one.
    *' '*) git rev-list --count --no-merges "${p%% *}..${p#* }" 2>/dev/null || echo -;;
    ?*) echo 1;;
    *) echo -;;
  esac
}

# One row into the frame, counted in its group - or, while a live run keeps a
# record, as outside that run ($1 = 1), so the counts add up to the run.
emit() {
  local age_c="$age_col" cmt_c="$head"
  if [ "$state" = merged ] && { [ "$commits" = 0 ] || [ "$commits" = "-" ]; }; then commits=$(landed_commits "$n"); fi
  [ "$age" = "-" ] && age_c="$gry"
  [ "$commits" = "-" ] && cmt_c="$gry"
  disp "$n"
  local id_cell="${bold}${wht}${DISP}${off}" lf url
  if [ "$LINKS" = 1 ]; then
    lf=$(ls -t logs/agent-issue-"$n"-*-"$n".log 2>/dev/null | head -1)
    if [ -n "$lf" ]; then
      url="$PWD/$lf"; url="${url//\%/%25}"; url="${url// /%20}"; url="${url//\#/%23}"
      id_cell="${ESC}]8;;file://${url}${ST}${id_cell}${ESC}]8;;${ST}"
    fi
  fi
  CELL=("$id_cell" "${colour}${glyph} ${state}${off}" "${age_c}${age}${off}" "${cmt_c}${commits}${off}")
  if [ "$wide" = 2 ]; then
    if [ "$cpu" = "-" ]; then CELL[4]="${gry}-${off}"; else CELL[4]="${cpu_col}${cpu}${off}${head}/${mem}${off}"; fi
  fi
  [ "$wide" -ge 1 ] && CELL[wide + 3]="${tok_col}${tok}${off}"
  CELL[${#TW[@]}-1]="${act_col}${activity}${off}"
  OW=("${TW[@]}"); AL=("${TAL[@]}")
  cells_line; rendered="$REPLY"
  out[n_out]="$prio	$key	$n	$grp	$rendered"; n_out=$((n_out+1))
  if [ "$1" = 1 ]; then c_out=$((c_out+1)); return 0; fi
  case "${activity_note:-}" in "partly done"*) c_partly=$((c_partly+1));; esac
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
  local now now_s issues n phase log age commits state glyph colour activity activity_note landed_subj rendered
  local merged_list cols rows prio cpu mem cpu_col tok tok_col tokens budget hidden key wide WIN BUF BUF_N
  local c_work=0 c_attn=0 c_ready=0 c_queue=0 c_block=0 c_merged=0 c_idle=0 c_left=0 c_out=0 c_partly=0
  local mtime q quiet act_col age_col on live_wt kept_wt models gate_wait
  local grp oc oc_run oc_text oc_kind oc_state hidden_list group summary act since
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
  local id longest=6 i sum=0 avail
  for id in $issues $QUEUE $TICKET_IDS; do disp "$id"; [ "${#DISP}" -gt "$longest" ] && longest=${#DISP}; done
  [ "$longest" -gt 16 ] && longest=16
  WIN="$cols"
  # In a narrow pane CPU/MEM gives its width to ACTIVITY, where the notes are:
  # at 80 columns every note was cut to 30 characters. Below 80, TOKENS does too.
  # wide: 2 with CPU/MEM and TOKENS, 1 with TOKENS only (what a person watching the plan's allowance
  # needs), 0 with neither.
  wide=2; [ "$cols" -lt 100 ] && wide=1; [ "$cols" -lt 80 ] && wide=0
  # TIME's minimum fits "1h12m", a finished ticket's length.
  # STATE's minimum fits "! uncommitted", the longest state - but for the
  # narrowest panes, which cut it.
  local -a MIN=($(( longest + 2 )) 15 7 9 13 12) PCT=(6 9 5 6 8 7)
  [ "$wide" = 1 ] && { MIN=($(( longest + 2 )) 15 7 9 12); PCT=(6 9 5 6 7); }
  [ "$wide" = 0 ] && { MIN=($(( longest + 2 )) 12 7 9); PCT=(6 9 5 6); }
  avail=$(( cols - ${#MIN[@]} - 2 ))
  for (( i=0; i<${#MIN[@]}; i++ )); do
    TW[i]=$(( avail * PCT[i] / 100 )); [ "${TW[i]}" -lt "${MIN[i]}" ] && TW[i]=${MIN[i]}; sum=$(( sum + TW[i] ))
  done
  TW[${#MIN[@]}]=$(( avail - sum )); [ "${TW[${#MIN[@]}]}" -lt 10 ] && TW[${#MIN[@]}]=10
  # Every column but STATE and ACTIVITY is centred.
  TAL=(c l c c c c); TAL[${#MIN[@]}]=l

  # 1. The live run's tickets, as its record has them.
  for n in $TICKET_IDS; do
    fields_of "$n" "$TICKETS" "$US"
    IFS="$US" read -r _ tstate since started order note requeued tokens <<<"$LINE"
    case "$tstate" in implement) state=impl;; cross-review) state=codex;; red) state="gate red";; nochange) state="no change";; *) state="$tstate";; esac
    [[ "$since" =~ ^[0-9]+$ ]] || since="$now_s"
    ago $(( now_s - since )); age="$AGO"; age_col="$head"; act_col="$mute"; activity="$note"; key="$since"
    # A finished row's TIME is its whole length; a row with no start in the record keeps time in state.
    finished_time "$tstate" "$since" "$started" && age="$FIN"
    commits=$(git rev-list --count "${BASE}..agent/issue-$n" 2>/dev/null || echo -)
    stat_for "$n"; cpu_cols; tokens_cell "$tokens"
    case "$tstate" in
      setup) activity="${note:-setting up its sandbox}";;
      landing) activity="${note:-merging into $BASE}";;
      # Put back in the queue by the run (a landing that went red, say): it starts again on the next run.
      requeued) activity="${note:-for the next run}";;
      queued)
        # Next to start first: the run takes its queue in this order.
        pos=$(printf '%s\n' "$TICKETS" | awk -F"$US" -v o="${order:-0}" '$2=="queued" && $5+0 < o+0 {c++} END{print c+1}')
        key=$(( 1000000 - ${order:-0} )); age="-"
        if [ $(( pos - FREE )) -le 1 ]; then activity="next to start"; else activity="$(( pos - 1 - FREE )) ahead of it"; fi
        [ "$RUN_PAUSED" = 1 ] && activity="waits for the resume"
        # The run waits for a slot its share of the machine's slots holds back, not only a full pool: the slot goes
        # to the ticket next to start. An older kit wrote it as the note of a ticket a worker had taken.
        if [ "$SHARE_WAIT" = 1 ] && [ "$activity" = "next to start" ]; then activity="waits for the run's share"; fi
        case "$note" in "waits for the run's share"*) activity="$note";; esac;;
      blocked) age="-";;
      held) if hand_merged "$n"; then state=merged; activity=$(hand_merged_note "$n"); fi;;
      implement|resolve|review|cross-review|repair|gates)
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
        # Busy but healthy, or stuck: a step at twice its usual length says which to suspect,
        # and at three times it says so in words and in the activity's colour too, since
        # nothing else bounds an agent pass that keeps producing output.
        typ=$(typical_of "$tstate")
        if [[ "$typ" =~ ^[0-9]+$ ]] && [ "$typ" -gt 0 ]; then
          if [ $(( now_s - since )) -gt $(( typ * 3 )) ]; then
            ago "$typ"; age_col="$hot"; act_col="$hot"; activity="3x over, usually $AGO - $activity"
          elif [ $(( now_s - since )) -gt $(( typ * 2 )) ]; then
            ago "$typ"; age_col="$hot"; activity="usually $AGO - $activity"
          fi
        fi;;
    esac
    # A ticket landing sent back keeps saying so through its second attempt.
    if [ -n "$requeued" ]; then
      case "$activity" in *"$requeued"*) ;; *) activity="$requeued${activity:+ - $activity}";; esac
    fi
    style_of "$state"
    # A spent plan allowance makes the orchestrator report a trust-dialog
    # error or `exited with code 1`; the real cause is only in the log tail.
    if [ "$grp" = working ] && [ -n "${log:-}" ] && [ -f "$log" ] && log_says_limit "$log"; then
      activity="USAGE LIMIT REACHED - $state model"; glyph='!'; colour="$hot"
    fi
    log=""
    emit 0
  done

  # 2. Queued tickets with no log yet and nothing in the record.
  for q in $QUEUE; do
    in_record "$q" && continue
    has_line "$q" "$issues" && continue
    n="$q"; age="-"; commits="-"; cpu="-"; mem="-"; cpu_col="$gry"; tok="-"; tok_col="$gry"; age_col="$gry"; act_col="$mute"; key=0
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
      elif [ "$RECORD" = 0 ] && has_line "$q" "$RUN_ISSUES"; then activity="in this run - waiting for a sandbox"; key=1
      else activity="not in this run"; fi
    fi
    style_of "$state"
    emit "$RECORD"
  done

  # 3. Tickets with logs that the record does not hold: earlier runs', and
  # all of them once the run has ended. Their state is inferred.
  for n in $issues; do
    in_record "$n" && continue
    log=$(ls -t logs/agent-issue-"$n"-impl-*.log logs/agent-issue-"$n"-resolve-*.log logs/agent-issue-"$n"-review-*.log logs/agent-issue-"$n"-repair-*.log logs/agent-issue-"$n"-gates-*.log 2>/dev/null | head -1)
    [ -z "$log" ] && continue
    case "$log" in *-resolve-*) phase="resolve";; *-review-codex-*) phase="codex";; *-review-*) phase="review";; *-repair-*) phase="repair";; *-gates-*) phase="gates";; *) phase="impl";; esac

    mtime=$(mtime_of "$log")
    # TIME is how long a working row has been at its phase, from an older
    # run's record; a ticket the ended run's record holds finished is its whole length, as the live
    # view showed it; any other row's is how long since its log last changed.
    act=""; [ "$RUN_LIVE" = 1 ] && act=$(active_of "$n")
    if [ -n "$act" ]; then
      phase="${act%%|*}"; since="${act#*|}"
      case "$phase" in implement) phase="impl";; cross-review) phase="codex";; esac
      ago $(( now_s - since )); age="$AGO"
    elif [ "$RUN_LIVE" != 1 ] && fields_of "$n" "$ENDED_TICKETS" "$US" && finished_time "${F[1]:-}" "${F[2]:-}" "${F[3]:-}"; then
      age="$FIN"
    else
      ago $(( now_s - mtime )); age="$AGO"
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
      # A landed branch is deleted at landing (merge or squash), so its subject on the base is the proof.
      disp "$n"
      landed_subj=$(git log "$BASE" -1 --format=%s --fixed-strings --grep="Merge agent/issue-$n (closes $DISP)" --grep="Merge agent/issue-$n (part of $DISP)" 2>/dev/null)
      if [ -n "$landed_subj" ]; then
        state="merged"; activity_note="landed on $BASE"
        # A criterion left undone: the ticket stays open, which the row must not hide.
        case "$landed_subj" in *"(part of "*)
          activity_note="partly done, ticket open"
          # The agent's own line, as the closing summary reads it (needsDecision in src/autonomy.ts).
          unmet=""; fields_of "$n" "$UNMETS" "$US" && unmet="${F[1]:-}"
          if printf '%s' "$unmet" | grep -Eiq '(^|[^[:alnum:]_])(decisions?|decides?|decided|maintainers?|humans?|person|people|up to (you|them)|sign[- ]?off)([^[:alnum:]_]|$)'; then
            activity_note="partly done - needs a person's decision"
          fi;;
        esac
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
      oc=$(outcome_of "$n"); oc_run="${oc%%|*}"; oc_text="${oc#*|}"; oc_kind="${oc_text%%|*}"; oc_text="${oc_text#*|}"
      oc_state=""; [ -n "$oc" ] && [ "$oc_run" = "$RUN_STARTED" ] && oc_state=$(outcome_state "$oc_kind")
      if [ -n "$oc_state" ]; then
        state="$oc_state"; activity_note="$oc_text"
      elif [ "$RUN_LIVE" = 1 ] && has_line "$n" "$RUN_ISSUES"; then
        # This run's branch under an older orchestrator, which records no
        # outcome until landing: finished, and landing decides the rest.
        state="finished"; activity_note="this run - landing decides it when the run ends"
      else
        state="left over"; activity_note="earlier run${oc_text:+: $oc_text} - sandcastle clean"
      fi
    elif oc=$(outcome_of "$n") && [ -n "$oc" ] && [ "${oc%%|*}" = "$RUN_STARTED" ] && oc_text="${oc#*|}" \
      && oc_state=$(outcome_state "${oc_text%%|*}") && [ -n "$oc_state" ]; then
      # No commits, but this run said what became of it: handed back, or
      # nothing to change. A branch with no commits is "merged" by git's
      # reckoning, and a question for a human read as done.
      state="$oc_state"; activity_note="${oc_text#*|}"
      if [ "$oc_state" = held ] && hand_merged "$n"; then state="merged"; activity_note=$(hand_merged_note "$n"); fi
    elif grep -q "agent/issue-${n}$" <<<"$merged_list"; then
      state="merged"
    else
      state="no commits"
    fi
    style_of "$state"
    # Back on the queue after an earlier run: it is queued, not done. Never a
    # ticket of the live run - that run is handling it.
    if { [ "$grp" = merged ] || [ "$grp" = idle ] || [ "$grp" = "left over" ]; } && in_queue "$n" && requeued "$n" \
      && ! { [ "$RUN_LIVE" = 1 ] && has_line "$n" "$RUN_ISSUES"; }; then
      state="queued"
      # Its old log's last line is history; say what happens next instead.
      if [ "$RUN_LIVE" = 1 ]; then activity_note="not in this run"; else activity_note="for the next run"; fi
      [ "$commits" -gt 0 ] && activity_note="$activity_note - on its earlier branch ($commits commit(s))"
      on=$(blocked_on "$n")
      if [ -n "$on" ]; then state="blocked"; activity_note="waits for $on to close"; fi
      style_of "$state"
    fi

    cpu_cols
    fields_of "$n" "$LAST_TOKENS" '|' && tokens_cell "${F[1]:-}"
    activity=$(log_activity "$log")
    [ "$kept_wt" = 1 ] && activity="worktree kept (uncommitted files) - $activity"
    [ -n "$activity_note" ] && activity="$activity_note"
    if [ "$quiet" -ge 600 ]; then
      activity="quiet $(( quiet / 60 ))m - $activity"
      act_col="$hot"
    fi
    # Only on an unfinished row: a merged branch's old log keeps the line.
    if [ "$prio" -le 1 ] && log_says_limit "$log"; then
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
  local gate_wait models mprefix SETTINGS_ROWS part item i l hdr_n ftr_n tbars lbars up sep_line need used cost sep pp sorted
  local -a LG=() MAC=() MOD=() LEG=() NOTE=()
  gate_wait=$(printf '%s\n' "$TICKETS" | awk -F"$US" '$2=="gates" && $6 ~ /^waiting for/ {c++} END{print c+0}')
  run_cell
  load_pool
  gauge "$USED_sandboxes" "$LIM_sandboxes"; kvl sandboxes "$REPLY"; MAC[0]="$REPLY"
  gauge "$USED_gates" "$LIM_gates"
  if [ "$RUN_LIVE" = 1 ] && [ -n "$POOL_SHARE" ]; then
    # This run's demand (slots it could use now) and share (its part of the machine pool) take the
    # third row, so the gates queue, when there is one, moves onto the gates row.
    [ "$gate_wait" -gt 0 ] && REPLY="$REPLY ${hot}· ${gate_wait} waiting${off}"
    kvl gates "$REPLY"; MAC[1]="$REPLY"
    kvl "this run" "${head}wants ${POOL_DEMAND}${gry} · share ${head}${POOL_SHARE}${off}${POOL_CAP:+${gry} · cap ${head}${POOL_CAP}${off}}"
  else
    kvl gates "$REPLY"; MAC[1]="$REPLY"
    if [ "$gate_wait" -gt 0 ]; then kvl waiting "${hot}${gate_wait} for a gates slot${off}"; else kvl waiting "${gry}none${off}"; fi
  fi
  MAC[2]="$REPLY"
  # "implement X · review Y", one row each in the models cell.
  settings_row
  usage_row
  models=$(models_line); mprefix=""
  case "$models" in "next run: "*|"last run: "*) mprefix="${models%%: *}"; models="${models#*: }";; esac
  # A record that carries cross-review as a setting shows it in the settings row, so the models cell
  # drops that part of the string; an older record's string is shown as written.
  case "$CROSS_SET" in
    on|off)
      case "$models" in
        *" · cross-review "*)
          part="${models#* · cross-review }"
          case "$part" in *" · "*) part=" · ${part#* · }";; *) part="";; esac
          models="${models%% · cross-review *}${part}";;
      esac;;
  esac
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
  # The view reads git, not the agents' notes: the closing summary counts a merged ticket left open under "needs you".
  # Two notes for the same reason as the time note below: one line of 98 characters was cut at 80 columns.
  [ "$c_partly" -gt 0 ] && NOTE[${#NOTE[@]}]="${gry}${c_partly} merged, partly done (ticket open)${off}" \
    && NOTE[${#NOTE[@]}]="${gry}the closing summary counts it under needs you${off}"
  NOTE[${#NOTE[@]}]="${gry}ready = gates green, waits for the landing worker${off}"
  # Two short notes, not one: wrap_items cuts a note wider than the frame, and one of 81 characters
  # lost what red means at 80 columns.
  NOTE[${#NOTE[@]}]="${gry}time = in state; once finished, start to end${off}"
  NOTE[${#NOTE[@]}]="${gry}red time = past twice the usual${off}"
  # Below 80 columns there is no TOKENS column to explain, and from 100 a CPU/MEM column too.
  [ "$wide" -ge 1 ] && NOTE[${#NOTE[@]}]="${gry}tokens = in/out, cache included${off}"
  [ "$wide" = 2 ] && NOTE[${#NOTE[@]}]="${gry}CPU in cores of ${NCPU}${off}"
  [ "$LINKS" = 1 ] && NOTE[${#NOTE[@]}]="${gry}${CLICK_HINT}${off}"
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
  # The legend's bars snap onto the table's, so the seam between them has no near-miss joints.
  OW=("${TW[@]}"); bars_of; tbars="$BARS"
  split_cols "${LWT[@]}"; snap_w "$tbars" "${LWT[@]}"; bars_of; lbars="$BARS"
  AL=(c c c c c c c c)
  for (( r=0; r<8; r+=per )); do CELL=("${LEG[@]:r:per}"); cells_line; put "$REPLY"; done
  junction '├' '┤' '─' "$lbars" ""; put "$REPLY"
  split_cols 1; AL=(c)
  wrap_items $(( WIN - 4 )) "${NOTE[@]}"
  for l in "${WRAPPED[@]}"; do CELL=("$l"); cells_line; put "$REPLY"; done
  junction '└' '┘' '─' "" ""; put "$REPLY"
  # A run started detached writes its output to a log nobody has open: while it is live, the
  # last three lines of it close the frame, under a light rule. The log's lines are cut to the
  # frame's width here, as the one-shot view does not cut a line itself.
  if [ "$RUN_LIVE" = 1 ] && [ -f logs/run-output.log ]; then
    local tail_lines="" tl
    tail_lines=$(grep -v '^[[:space:]]*$' logs/run-output.log 2>/dev/null | tail -n 3 | tr -d '\r' | tr '\t' ' ' | sed "s/${ESC}\[[0-9;?]*[A-Za-z]//g")
    if [ -n "$tail_lines" ]; then
      rep ─ $(( WIN > 16 ? WIN - 16 : 0 )); put "${rule}── run output ──${REPLY}${off}"
      while IFS= read -r tl; do
        fit "$tl" "$WIN"; tl="$FIT"; put "${mute}${tl}${off}"
      done <<<"$tail_lines"
    fi
  fi
  FTR="$BUF"; ftr_n=$(( BUF_N + 1 ))   # and the rule that opens it

  # A short pane: the logo folds to one row - the wordmark alone, since a castle cut
  # to its battlements reads as a broken logo - so the table keeps some rows.
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
        hidden=$((hidden+1)); disp "$n"; hidden_list="${hidden_list}${group}|${DISP}
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
  junction '├' '┤' '─' "$up" "$lbars"
  printf '%s%s%s\n%s' "$HDR" "$BUF" "$REPLY" "$FTR"
}

# The header bands into HDR (HDR_N lines): the logo cell, the run band, the
# models, the settings row and the queue error when there are any, and the
# table's headings.
# $1: the logo's rows, 3 or 1. Reads render's locals.
build_header() {
  local l m=0 prev i j tb
  local -a need=()
  # The table's bars, which the band above the headings snaps onto.
  OW=("${TW[@]}"); bars_of; tb="$BARS"
  if [ "$1" = 3 ]; then
    LG=(" ${moon}▄ ▄ ▄${off} ${star}+${off}   ${bold}${moon}s a n d c a s t l e${off} ${night}- k i t${off}  ${star}·   +   ·${off}"
      " ${dusk}█████${off}     ${head}${SANDCASTLE_NAME:-}${off}"
      " ${deep}██▀██${off} ${star}·${off}   ${mute}base${off} ${accent}${BASE}${off}${unpushed}  ${rule}·${off}  ${accent}${now}${off}")
  else
    LG=("${bold}${moon}sandcastle-kit${off}  ${head}${SANDCASTLE_NAME:-}${off}  ${mute}base${off} ${accent}${BASE}${off}${unpushed}  ${rule}·${off}  ${accent}${now}${off}")
  fi
  # Every logo line padded to the widest, so centring keeps the castle's shape.
  for l in "${LG[@]}"; do vlen "$l"; [ "$VN" -gt "$m" ] && m=$VN; done
  for (( i=0; i<${#LG[@]}; i++ )); do align "${LG[i]}" "$m"; LG[i]="$REPLY"; done
  BUF=""; BUF_N=0
  if [ "$cols" -ge 170 ]; then
    # Wide: the logo, the run, the machine and the models side by side.
    # No cell narrower than its widest row needs (a cell's text plus a space each side).
    need=($(( m + 2 )) 0 0 0)
    for i in 0 1 2; do
      vlen "${RUNC[i]:-}"; [ $(( VN + 2 )) -gt "${need[1]}" ] && need[1]=$(( VN + 2 ))
      vlen "${MAC[i]:-}"; [ $(( VN + 2 )) -gt "${need[2]}" ] && need[2]=$(( VN + 2 ))
      vlen "${MOD[i]:-}"; [ $(( VN + 2 )) -gt "${need[3]}" ] && need[3]=$(( VN + 2 ))
    done
    split_cols 40 20 20 20; snap_w "$tb" "${need[@]}"; bars_of
    junction '┌' '┐' '─' "" "$BARS"; put "$REPLY"
    AL=(c l l l)
    for i in 0 1 2; do CELL=("${LG[i]:-}" "${RUNC[i]}" "${MAC[i]}" "${MOD[i]:-}"); cells_line; put "$REPLY"; done
  else
    split_cols 1; AL=(c)
    junction '┌' '┐' '─' "" ""; put "$REPLY"
    for l in "${LG[@]}"; do CELL=("$l"); cells_line; put "$REPLY"; done
    need=(0 0)
    for i in 0 1 2; do
      vlen "${RUNC[i]:-}"; [ $(( VN + 2 )) -gt "${need[0]}" ] && need[0]=$(( VN + 2 ))
      vlen "${MAC[i]:-}"; [ $(( VN + 2 )) -gt "${need[1]}" ] && need[1]=$(( VN + 2 ))
    done
    split_cols 1 1; snap_w "$tb" "${need[@]}"; AL=(l l); bars_of
    junction '├' '┤' '─' "" "$BARS"; put "$REPLY"
    for i in 0 1 2; do CELL=("${RUNC[i]}" "${MAC[i]}"); cells_line; put "$REPLY"; done
    if [ -n "$models" ]; then
      prev="$BARS"; split_cols 1; AL=(l)
      junction '├' '┤' '─' "$prev" ""; put "$REPLY"
      kvl models "${mute}${mprefix:+${mprefix}: }${models}${off}"; CELL=("$REPLY"); cells_line; put "$REPLY"
      BARS=""
    fi
  fi
  # The run settings, one full-width row under the run band.
  if [ "${#SETTINGS_ROWS[@]}" -gt 0 ]; then
    prev="$BARS"; split_cols 1; AL=(l)
    junction '├' '┤' '─' "$prev" ""; put "$REPLY"
    for part in "${SETTINGS_ROWS[@]}"; do CELL=("$part"); cells_line; put "$REPLY"; done
    BARS=""
  fi
  prev="$BARS"
  # An unreadable queue is not an empty one: say so, under the run band.
  if [ -n "$QUEUE_ERR" ]; then
    split_cols 1; AL=(l)
    junction '├' '┤' '─' "$prev" ""; put "$REPLY"
    CELL=("${mute}queue: could not read - ${QUEUE_ERR}${off}"); cells_line; put "$REPLY"
    prev=""
  fi
  # The table's headings, under a light rule: their bold text sets them apart.
  OW=("${TW[@]}"); bars_of
  junction '├' '┤' '─' "$prev" "$BARS"; put "$REPLY"
  CELL=("${bold}${head}TICKET${off}" "${bold}${head}STATE${off}" "${bold}${head}TIME${off}" "${bold}${head}COMMITS${off}")
  [ "$wide" = 2 ] && CELL[4]="${bold}${head}CPU/MEM${off}"
  [ "$wide" -ge 1 ] && CELL[wide + 3]="${bold}${head}TOKENS${off}"
  CELL[${#TW[@]}-1]="${bold}${head}ACTIVITY${off}"
  AL=("${TAL[@]}"); cells_line; put "$REPLY"
  junction '├' '┤' '─' "$BARS" "$BARS"; put "$REPLY"
  HDR="$BUF"; HDR_N=$BUF_N
}

# The pane's size from its terminal; without one (a test, an agent's tool), the
# size given. render asks tput from inside $(...), which cannot see the
# terminal and falls back to 80 columns - the snapshot was 80 wide in any pane.
# A pty that reports 0 0 counts as no terminal.
tty_size() {
  local size
  if size=$( { stty size </dev/tty; } 2>/dev/null) && [[ "$size" =~ ^[1-9][0-9]*\ [1-9][0-9]*$ ]]; then
    TERM_ROWS="${size%% *}"; TERM_COLS="${size##* }"
  fi
  export TERM_ROWS TERM_COLS
}

# A size given (the tests, the frame checks) wins over the terminal's.
if [ "$INTERVAL" = "0" ]; then [ -n "${TERM_COLS:-}" ] || tty_size; load_queue; render; exit 0; fi

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
# Ctrl-C in the run's own status pane is a person quitting the view: the view record says so
# (`quit`), and the tab bar then leaves that shell to them instead of typing the view back into it
# every tick (src/herdr.ts, `restartStatusView`). INT only: a Herdr server stop sends HUP, and the
# view must come back after the restart; a TERM is nobody's choice either. One jq and a rename, as
# the pane may be torn down before a slow trap finishes. The pane is checked against the record, so
# the plugin's popup and a view a person opened elsewhere mark nothing.
# A run that reuses the pane (src/herdr.ts) stops this view with Ctrl-C after rewriting the record
# without `status`, so the `select` below finds nothing to mark.
mark_quit() {
  [ "${HERDR_ENV:-}" = 1 ] && [ -n "${HERDR_PANE_ID:-}" ] && [ -f logs/herdr-view.json ] || return 0
  local tmp="logs/herdr-view.json.$$.quit"
  jq -c --arg pane "$HERDR_PANE_ID" 'select(.status == $pane) | .quit = true' logs/herdr-view.json >"$tmp" 2>/dev/null \
    && [ -s "$tmp" ] && mv -f "$tmp" logs/herdr-view.json
  rm -f "$tmp"
}
trap restore EXIT
trap 'mark_quit; restore; exit 130' INT
trap 'restore; exit 130' TERM
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
  tty_size
  if [ "$RESIZED" = 1 ] && [ -n "$frame" ] && [[ "$TERM_ROWS" =~ ^[0-9]+$ ]]; then
    printf '\e[H%s\n\e[J' "$(printf '%s\n' "$frame" | head -n $(( TERM_ROWS - 1 )))"
  fi
  RESIZED=0
  drain
  relink
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
      fit "$l" "$TERM_COLS"; l="$FIT"; printf '%s' "$l"; vlen "$l"; [ "$VN" -lt "$TERM_COLS" ] && printf '\033[K'
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

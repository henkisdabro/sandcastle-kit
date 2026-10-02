#!/usr/bin/env bash
# The status view against a made-up project: a git repo with agent branches,
# logs and run records, each frame rendered once and each row's state checked.
# No Docker, no network, no model calls - a fake `sandcastle queue` and a
# `docker` that finds nothing stand in.
#
# It pins what went wrong before: a live run's green branch, still labelled and
# not yet merged, read as `queued` for over an hour, because the view's rules
# for earlier runs claimed it.
#
#   bash test/status.test.sh
#   STATUS_BASH=/bin/bash COLS=200 bash test/status.test.sh   # macOS's bash 3.2, a wide pane
set -uo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
# A UTF-8 locale, so widths count characters: Linux runners often have only C.UTF-8.
export LC_ALL="$(locale -a 2>/dev/null | grep -iE '^(c|en_US)\.utf-?8$' | head -1)"
TMP=$(mktemp -d)
LIVE=""
cleanup() { [ -n "$LIVE" ] && kill "$LIVE" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

fails=0
# 80 is the narrow pane the view is built for; everything checked must fit it.
COLS="${COLS:-80}"
# A space in the project path: the view once split mount paths on spaces.
REPO="$TMP/my repo"; FAKE="$TMP/bin"
mkdir -p "$REPO" "$FAKE"

# The queue the tracker would list: each id still carries the label.
cat >"$FAKE/sandcastle" <<'EOF'
#!/usr/bin/env bash
printf '['; sep=""
for id in $FAKE_QUEUE; do printf '%s{"id":"%s","title":"t","updated":null,"blockedOn":[]}' "$sep" "$id"; sep=","; done
printf ']\n'
EOF
# No containers, unless FAKE_DOCKER names a project: then one sandbox of
# ticket 101 in it, working at 1.5 cores.
cat >"$FAKE/docker" <<'EOF'
#!/bin/sh
[ -n "${FAKE_DOCKER:-}" ] || exit 1
case "$1" in
  ps) echo c1 ;;
  inspect) printf '/sandcastle-c1|/tmp/cache|%s/.sandcastle/worktrees/agent-issue-101\n' "$FAKE_DOCKER" ;;
  stats) echo 'sandcastle-c1|150.00%|275.8MiB / 11.73GiB' ;;
esac
EOF
chmod +x "$FAKE/sandcastle" "$FAKE/docker"

git_() { git -C "$REPO" -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }
git_ init -q -b main
git_ config user.email test@example.com
git_ config user.name test
git_ commit -q --allow-empty -m base
branch() { # id commits
  git_ checkout -q -b "agent/issue-$1" main
  for i in $(seq "$2"); do echo "$1-$i" >"$REPO/f-$1-$i"; git_ add "f-$1-$i"; git_ commit -q -m "issue $1 commit $i"; done
  git_ checkout -q main
}
L="$REPO/.sandcastle/logs"
mkdir -p "$L" "$REPO/.sandcastle/worktrees"
log() { printf '%s\n' "$3" >"$L/agent-issue-$1-$2-$1.log"; }

render() {
  PATH="$FAKE:$PATH" FAKE_QUEUE="$1" SANDCASTLE_PROJECT="$REPO" SANDCASTLE_BIN="$FAKE/sandcastle" \
    SANDCASTLE_BASE=main SANDCASTLE_NAME=fixture SANDCASTLE_MODELS="implement next-model/high" \
    TERM_COLS="$COLS" TERM_ROWS="${ROWS:-200}" XDG_CACHE_HOME="$TMP/cache" \
    "${STATUS_BASH:-bash}" "$KIT/status.sh" 0 "${SHOW:-all}" 2>&1 | sed $'s/\e\\[[0-9;]*m//g' >"$TMP/frame"
  # Nothing wider than the pane: the live view cuts such a line, losing its
  # end. Counted in characters (awk on macOS counts bytes).
  local l
  while IFS= read -r l; do
    [ "${#l}" -le "$COLS" ] || { echo "FAIL [$SCENARIO] wider than $COLS columns: $l"; fails=$((fails+1)); }
  done <"$TMP/frame"
}
# A row's state: the ticket's cell, then its glyph and state word, in that order.
row() { # ticket state [activity pattern]
  local line
  line=$(grep -E "^│ +$1 +│" "$TMP/frame")
  if ! grep -qE "^│ +$1 +│ . $2 +│" <<<"$line"; then
    echo "FAIL [$SCENARIO] $1: want state '$2', row is: ${line:-(missing)}"; fails=$((fails+1)); return
  fi
  if [ -n "${3:-}" ] && ! grep -qE "$3" <<<"$line"; then
    echo "FAIL [$SCENARIO] $1: want activity /$3/, row is: $line"; fails=$((fails+1))
  fi
}
has() { # pattern
  grep -qE "$1" "$TMP/frame" || { echo "FAIL [$SCENARIO] no line matches /$1/"; fails=$((fails+1)); }
}
hasnt() { # pattern
  ! grep -qE "$1" "$TMP/frame" || { echo "FAIL [$SCENARIO] a line matches /$1/: $(grep -E "$1" "$TMP/frame" | head -1)"; fails=$((fails+1)); }
}

sleep 600 & LIVE=$!
now=$(date +%s)
started=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

# ---------------------------------------------------------------------------
SCENARIO="live run, mid-landing"
# Every state a live run's ticket can be in, from its record. #103 is the
# case that broke: green, labelled, no merge commit on main yet.
branch 101 1; log 101 impl 'Bash(pnpm test)'; mkdir -p "$REPO/.sandcastle/worktrees/agent-issue-101"
branch 102 2; log 102 impl 'done'; log 102 gates 'tests/test_a.py ....   [ 40%]'
branch 103 2; log 103 impl '<promise>COMPLETE</promise>'
branch 104 1; log 104 repair 'could not fix it'
branch 108 1; log 108 impl 'done'
branch 109 1; log 109 impl 'done'
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "implement live-model/high",
  "stage": "landing 2/4", "concurrency": 2, "tokens": "1.2M in / 30k out",
  "typical": { "implement": 600, "gates": 60, "issue": 900 },
  "issues": ["101","102","103","104","105","106","108","109","110"],
  "tickets": {
    "101": { "state": "implement", "since": $((now - 30)), "started": $((now - 60)) },
    "102": { "state": "gates", "since": $((now - 600)), "note": "2/3 pytest" },
    "103": { "state": "ready", "since": $((now - 900)), "note": "gates green" },
    "104": { "state": "red", "since": $((now - 900)), "note": "pytest red, 1 repair(s)" },
    "105": { "state": "queued", "order": 5, "since": $now },
    "106": { "state": "queued", "order": 6, "since": $now },
    "107": { "state": "blocked", "note": "waits for #103 (this run) - next run" },
    "108": { "state": "held", "since": $now, "note": "human merge: .github/" },
    "109": { "state": "conflict", "since": $now, "note": "with #103: src/a.ts" },
    "110": { "state": "merged", "since": $now, "note": "merged and closed" }
  } }
EOF
render "101 102 103 104 105 106 107 108 109 110 120"
# The first column is headed TICKET (6 characters), not the GitHub word; the widths are sized for it.
has '^│ +TICKET +│ +STATE +│'
hasnt 'ISSUE'
row '#101' impl 'Bash|\$ pnpm test'
row '#102' gates 'usually 1m - 2/3 pytest'
row '#103' ready 'gates green'
row '#104' 'gate red' 'pytest red'
row '#105' queued 'next to start'
row '#106' queued '1 ahead of it'
row '#107' blocked 'waits for #103 \(this run\)'
row '#108' held '.github/'
row '#109' conflict 'with #103'
row '#110' merged
row '#120' queued 'not in this run'
# The legend's counts add up to the run (ten tickets), with the rest apart in the note.
for c in 'working 2' 'ready to land 1' 'needs you 3' 'queued 2' 'blocked 1' 'merged 1'; do has "$c +│"; done
has '│ +1 not in this run · '
has 'landing 2/4'
has 'implement +live-model/high'
hasnt 'on its earlier branch'

SCENARIO="live run, agents working"
# Before landing: an estimate of when it starts, once a typical issue is known.
sed -i.bak 's/"stage": "landing 2\/4"/"stage": "running"/' "$L/run.json"
render "101 102 103 104 105 106 107 108 109 110 120"
has 'state +running · [0-9]+m +│'
has 'lands +~[0-9]{2}:[0-9]{2} · since [0-9:]+ +│'
has 'tokens +1.2M in / 30k out +│'

SCENARIO="live run, sandboxes to spare"
# Two free sandboxes: both queued tickets start at once, neither is behind
# the other. With one free, the second is next once a working one finishes.
sed -i.bak 's/"concurrency": 2/"concurrency": 4/' "$L/run.json"
render "101 102 103 104 105 106 107 108 109 110 120"
row '#105' queued 'next to start'
row '#106' queued 'next to start'
hasnt 'ahead of it'
sed -i.bak 's/"concurrency": 4/"concurrency": 3/' "$L/run.json"
render "101 102 103 104 105 106 107 108 109 110 120"
row '#106' queued 'next to start'
sed -i.bak 's/"concurrency": 3/"concurrency": 2/' "$L/run.json"

# ---------------------------------------------------------------------------
SCENARIO="live run, finished work left uncommitted"
# A commit refused by a hook leaves the finished work in a kept worktree: not "no change", and among Needs you.
git_ branch agent/issue-113 main; log 113 impl 'done'
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "landing 0/0",
  "issues": ["113"], "tickets": { "113": { "state": "uncommitted", "since": $now, "note": "work left uncommitted in .sandcastle/worktrees/agent-issue-113" } } }
EOF
render "113"
row '#113' uncommitted 'work left uncommitted in'
has '! +uncommitted'
hasnt 'no change'
git_ branch -q -D agent/issue-113

# ---------------------------------------------------------------------------
SCENARIO="live run, in-run landing"
# Tickets land while others still run: #103 is landing, #104 went red together with
# #110 (landed a minute ago), #105 was put back in the queue. None of the three
# holds a sandbox: of three slots, two are working, so both queued tickets start at once.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m",
  "stage": "running", "concurrency": 3, "landing": "in-run",
  "typical": { "implement": 600, "gates": 60, "issue": 900 },
  "issues": ["101","102","103","104","105","106","107","110"],
  "tickets": {
    "101": { "state": "implement", "since": $((now - 30)), "started": $((now - 60)) },
    "102": { "state": "gates", "since": $((now - 600)), "started": $((now - 700)), "note": "2/3 pytest" },
    "103": { "state": "landing", "since": $((now - 20)), "note": "merging into main" },
    "104": { "state": "red", "since": $((now - 40)), "note": "red with #110" },
    "105": { "state": "requeued", "since": $((now - 50)), "note": "red together with #110 - next run" },
    "106": { "state": "queued", "order": 6, "since": $now },
    "107": { "state": "queued", "order": 7, "since": $now },
    "110": { "state": "merged", "since": $((now - 60)), "note": "merged and closed" }
  } }
EOF
render "101 102 103 104 105 106 107 110"
row '#101' impl
row '#102' gates
row '#103' landing 'merging into main'
row '#104' 'gate red' 'red with #110'
row '#105' requeued 'red together with #110'
row '#106' queued 'next to start'
row '#107' queued 'next to start'
row '#110' merged
hasnt 'ahead of it'
# No landing phase to wait for: the estimate is when the run ends.
has 'ends +~[0-9]{2}:[0-9]{2} · since [0-9:]+ +│'
hasnt 'lands +~'
# The same record without the field is a run with a landing phase after the pipelines:
# the ticket in landing holds no slot there either, and the estimate is when landing starts.
sed -i.bak 's/"landing": "in-run",//' "$L/run.json"
render "101 102 103 104 105 106 107 110"
row '#107' queued 'next to start'
has 'lands +~[0-9]{2}:[0-9]{2} · since [0-9:]+ +│'
hasnt 'ends +~'

# ---------------------------------------------------------------------------
SCENARIO="live run, older orchestrator"
# A run.json with no tickets, from a run started before the record existed:
# its finished branch has no outcome until landing, and must not read as
# queued or left over.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["103"], "waiting": [], "active": {} }
EOF
render "103"
row '#103' finished 'this run - landing'
hasnt 'on its earlier branch'

# ---------------------------------------------------------------------------
SCENARIO="after the run"
# Ended: inference again. The red branch shows its outcome, the merged one is
# merged, and the models line is the config's, not the last run's.
branch 110 1; git_ merge -q --no-ff -m "Merge agent/issue-110 (closes #110)" agent/issue-110
log 110 impl 'done'
# Unqueued during the run: someone's decision, not a branch for them to fix.
branch 111 1; log 111 impl 'done'
# Handed back with no commits: git calls an empty branch merged; the run's outcome says otherwise.
git_ branch agent/issue-112 main; log 112 impl 'done'
# Finished, its commit refused: the outcome says so, and it is not "no change".
git_ branch agent/issue-113 main; log 113 impl 'done'
rm -rf "$REPO/.sandcastle/worktrees/agent-issue-101"
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "finishedAt": "$started", "exitCode": 0,
  "models": "implement old-model/low", "tickets": { "104": { "state": "red" } } }
EOF
cat >"$L/outcomes.json" <<EOF
{ "104": { "run": "$started", "outcome": "gate red: pytest=FAIL" },
  "109": { "run": "$started", "outcome": "merge conflict: src/a.ts" },
  "111": { "run": "$started", "outcome": "withdrawn: taken out of the queue during the run" },
  "112": { "run": "$started", "outcome": "needs a human: handed back" },
  "113": { "run": "$started", "outcome": "uncommitted" },
  "110": { "run": "$started", "outcome": "merged" },
  "103": { "run": "earlier", "outcome": "gate red: ruff=FAIL" } }
EOF
render ""
row '#104' 'gate red' 'pytest=FAIL'
row '#109' conflict
row '#110' merged
# Its commits are what it landed, not the 0 its merged branch has left over the base.
has '^│ +#110 +│ . merged +│[^│]+│ +1 +│'
has 'CPU in cores'
row '#111' withdrawn
row '#112' held 'handed back'
row '#113' uncommitted
git_ branch -q -D agent/issue-112 agent/issue-113 # only this scenario's
row '#103' 'left over' 'earlier run'
has 'next run.*implement +next-model/high|implement +next-model/high.*next run'
hasnt 'old-model'
# Below 80 columns the CPU column goes, and the legend line explaining it with it.
COLS_WAS="$COLS"; COLS=60; render ""
hasnt 'CPU in cores'
row '#110' merged
COLS="$COLS_WAS"

# ---------------------------------------------------------------------------
SCENARIO="container stats, project path with a space"
# A container is tied to its ticket by the worktree it mounts.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["101"], "tickets": { "101": { "state": "implement", "since": $now, "started": $now } } }
EOF
FAKE_DOCKER="$REPO" render "101"
row '#101' impl
has '^│ +#101 .*│ +1\.5c +│'

# ---------------------------------------------------------------------------
SCENARIO="a state written after the frame's clock"
# The frame reads the clock before run.json, so a state the run wrote in between is "in the future".
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["103"], "tickets": { "103": { "state": "ready", "since": $((now + 30)), "note": "gates green" } } }
EOF
render "103"
row '#103' ready
has '^│ +#103 .*│ +0s +│'

# ---------------------------------------------------------------------------
SCENARIO="overflow, ticket-file ids"
# What does not fit is summed up by state. Ticket-file ids have no numeric
# order: they are named, never made into a range like "#0-#0".
SHOW=collapse ROWS=26 render "$(printf 'checkout-%02d ' $(seq 1 12))"
has '\+.*[0-9]+ queued \(checkout-[0-9]{2}, checkout-[0-9]{2}, checkout-[0-9]{2}, …\)'
hasnt '#checkout|#0'

# ---------------------------------------------------------------------------
SCENARIO="live loop, one frame"
# What the refreshing view writes. Line wrap is off, so a line that fills the
# pane leaves the cursor on its last cell, and an erase-to-end there wiped
# that cell: every full-width rule lost its last character. And the frame must
# fit the pane with its window closed - the bottom border on screen, the last
# row left free so the erase below the frame cannot reach it.
PATH="$FAKE:$PATH" FAKE_QUEUE="$(printf 'checkout-%02d ' $(seq 1 12))" SANDCASTLE_PROJECT="$REPO" SANDCASTLE_BIN="$FAKE/sandcastle" \
  SANDCASTLE_BASE=main SANDCASTLE_NAME=fixture TERM_COLS="$COLS" TERM_ROWS=30 XDG_CACHE_HOME="$TMP/cache" STATUS_FRAMES=1 \
  "${STATUS_BASH:-bash}" "$KIT/status.sh" 1 >"$TMP/live" 2>&1 </dev/null
ESC=$'\e'; erased=0; n=0; last=""
while IFS= read -r l; do
  # Only the frame: the screen set-up and restore codes are not rows.
  case "$l" in *"${ESC}[?1049l"*) break;; esac
  n=$((n+1))
  p=$(printf '%s' "$l" | sed $'s/\e\\[[0-9;?]*[a-zA-Z]//g')
  [ "${#p}" -ge "$COLS" ] && [[ "$l" == *"${ESC}[K"* ]] && erased=$((erased+1))
  [ -n "$p" ] && last="$p"
done <"$TMP/live"
[ "$erased" = 0 ] || { echo "FAIL [$SCENARIO] $erased full-width line(s) followed by an erase to the end"; fails=$((fails+1)); }
[ "$n" -le 29 ] || { echo "FAIL [$SCENARIO] $n rows in a 30-row pane: the bottom row must stay free"; fails=$((fails+1)); }
[[ "$last" == └*┘ ]] || { echo "FAIL [$SCENARIO] the frame does not end in its bottom border: $last"; fails=$((fails+1)); }

# ---------------------------------------------------------------------------
SCENARIO="links, inside Herdr"
# Each ticket links to its latest log (OSC 8) for the Herdr plugin's Ctrl-click. A
# link has no width: with the links taken out, every line still fits the pane and
# the frame has as many rows as without them.
render ""; plain_rows=$(wc -l <"$TMP/frame")
PATH="$FAKE:$PATH" FAKE_QUEUE="" SANDCASTLE_PROJECT="$REPO" SANDCASTLE_BIN="$FAKE/sandcastle" \
  SANDCASTLE_BASE=main SANDCASTLE_NAME=fixture SANDCASTLE_MODELS="implement next-model/high" \
  TERM_COLS="$COLS" TERM_ROWS=200 XDG_CACHE_HOME="$TMP/cache" SANDCASTLE_LINKS=1 \
  "${STATUS_BASH:-bash}" "$KIT/status.sh" 0 all >"$TMP/linked" 2>&1
grep -q $'\e]8;;file://.*/my%20repo/\.sandcastle/logs/agent-issue-[a-z0-9-]*\.log\e\\\\' "$TMP/linked" \
  || { echo "FAIL [$SCENARIO] no ticket links to its log (the space in the path as %20)"; fails=$((fails+1)); }
sed $'s/\e]8;[^\e]*\e\\\\//g; s/\e\\[[0-9;]*m//g' "$TMP/linked" >"$TMP/frame"
while IFS= read -r l; do
  [ "${#l}" -le "$COLS" ] || { echo "FAIL [$SCENARIO] wider than $COLS columns: $l"; fails=$((fails+1)); }
done <"$TMP/frame"
[ "$(wc -l <"$TMP/frame")" = "$plain_rows" ] || { echo "FAIL [$SCENARIO] $(wc -l <"$TMP/frame") rows with links, $plain_rows without"; fails=$((fails+1)); }
row '#103' ready

# ---------------------------------------------------------------------------
SCENARIO="every log archived"
# Runs happened - the run cell says how the last ended - but merged tickets'
# logs moved to logs/archive/, so no row is left: not "no runs yet".
mv "$L" "$TMP/logs-kept"; mkdir -p "$L/archive"
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": 1, "startedAt": "$started", "finishedAt": "$started", "exitCode": 0, "models": "m", "issues": [] }
EOF
render ""
has '\(nothing to show\)'
hasnt 'no runs yet'
rm -f "$L/run.json"; render ""
has '\(no runs yet\)'
rm -rf "$L"; mv "$TMP/logs-kept" "$L"

# ---------------------------------------------------------------------------
SCENARIO="log strip, detached run"
# A run started detached writes its output to logs/run-output.log. While the run is live the
# frame closes with the last three non-empty lines of it, under a light rule, each cut to the
# pane's width; with no log, or once the run has ended, the frame is the one it always was.
cp "$L/run.json" "$TMP/run.json.kept" 2>/dev/null || true
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "issues": [],
  "tickets": { "301": { "state": "implement", "since": $now, "title": "t" } } }
EOF
rm -f "$L/run-output.log"
render ""; cp "$TMP/frame" "$TMP/frame-plain"
hasnt 'run output'
long=$(printf 'x%.0s' $(seq 1 $((COLS + 40))))
printf 'first line\nsecond line\n\n   \nthird line\r\n\033[32mfourth line\033[0m\n%s\n' "$long" >"$L/run-output.log"
render ""
has '^── run output ─+$'
hasnt 'first line'
hasnt 'second line'
has '^third line$'
has '^fourth line$'
has '^x+…$'
# The strip is the frame's last four rows, after the table's bottom border.
[ "$(wc -l <"$TMP/frame")" -eq "$(( $(wc -l <"$TMP/frame-plain") + 4 ))" ] || { echo "FAIL [$SCENARIO] the strip is not four rows"; fails=$((fails+1)); }
[ "$(grep -n '^── run output' "$TMP/frame" | cut -d: -f1)" = "$(( $(wc -l <"$TMP/frame-plain") + 1 ))" ] || { echo "FAIL [$SCENARIO] the strip does not follow the plain frame"; fails=$((fails+1)); }
# The two renders can fall in different seconds: the clock and the AGE cells are not what is compared.
steady() { sed -E 's/[0-9]{2}:[0-9]{2}:[0-9]{2}/HH:MM:SS/g; s/│ +[0-9]+[smh] +│/│ age │/g'; }
head -n "$(wc -l <"$TMP/frame-plain")" "$TMP/frame" | steady | diff -q - <(steady <"$TMP/frame-plain") >/dev/null || { echo "FAIL [$SCENARIO] the frame above the strip changed"; fails=$((fails+1)); }
# A finished run's output is in its report, not on the view.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": 1, "startedAt": "$started", "finishedAt": "$started", "exitCode": 0, "models": "m", "issues": [] }
EOF
render ""
hasnt 'run output'
rm -f "$L/run-output.log" "$L/run.json"; if [ -f "$TMP/run.json.kept" ]; then mv "$TMP/run.json.kept" "$L/run.json"; fi

if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed. Last frame:"; cat "$TMP/frame"; exit 1; fi
echo "status view: all checks passed"

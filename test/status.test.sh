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
  stats) echo "${FAKE_STATS:-sandcastle-c1|150.00%|275.8MiB / 11.73GiB}" ;;
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

# A process of the kit as far as status.sh can tell: its command line holds the kit's entry
# (`src/cli.ts`), which is how a live run is told from a process that took a dead run's pid.
( exec -a "node src/cli.ts" sleep 600 ) & LIVE=$!
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
  "settings": { "autonomy": 2, "turn": 2, "cap": 2 },
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
# A live run's settings come from its record: no (next run) or (last run) mark, whatever the pane's width.
has '^│ settings +autonomy (0 1 \[2\] 3 drain|2) · turn 2/2 +│'
hasnt '\((next|last) run\)'
row '#101' impl 'Bash|\$ pnpm test'
row '#102' gates '3x over, usually 1m'
row '#103' ready 'gates green'
row '#104' 'gate red' 'pytest red'
row '#105' queued 'next to start'
row '#106' queued '1 ahead of it'
row '#107' blocked 'waits for #103'
row '#108' held 'human merge: .gi'
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
# An estimate of when the run ends, once a typical issue is known. Tickets land as
# they go green, so the header never says when a landing phase "lands".
sed -i.bak 's/"stage": "landing 2\/4"/"stage": "running"/' "$L/run.json"
render "101 102 103 104 105 106 107 108 109 110 120"
has 'state +running · [0-9]+m +│'
has 'ends +~[0-9]{2}:[0-9]{2} · since [0-9:]+ +│'
hasnt 'lands +~'
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
SCENARIO="live run, sharing the machine pool"
# The run's own demand and share, live values in its record, beside the pool's use in the
# machine cell. #106 is held back by the run's share (a free slot is another run's): its row says
# so, where #105 only waits its turn. An older kit's record has neither value, and the cell shows none.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m",
  "stage": "running", "concurrency": 4, "demand": 4, "share": 3,
  "issues": ["105","106"],
  "tickets": {
    "105": { "state": "queued", "order": 5, "since": $now },
    "106": { "state": "queued", "order": 6, "since": $now, "note": "waits for the run's share" }
  } }
EOF
render "105 106"
has 'this run +wants 4 · share 3'
row '#105' queued 'next to start'
row '#106' queued "waits for the run's"
sed -i.bak 's/"demand": 4, "share": 3,//' "$L/run.json"
render "105 106"
has 'sandboxes +[█░ ]*[0-9]+/[0-9]+'
hasnt 'wants [0-9]|share [0-9]'
has 'waiting +none'

# A person's cap (`sandcastle cap`) sits beside the demand and the share; a lifted cap leaves the record.
sed -i.bak 's/"concurrency": 4,/"concurrency": 4, "demand": 4, "share": 2, "cap": 2,/' "$L/run.json"
render "105 106"
has 'this run +wants 4 · share 2 · cap 2'
sed -i.bak 's/"cap": 2,//' "$L/run.json"
render "105 106"
has 'this run +wants 4 · share 2'
hasnt 'cap [0-9]'

# ---------------------------------------------------------------------------
SCENARIO="paused run"
# `sandcastle pause`: the run record's `paused` says since when and which tickets are still finishing
# a pass or a landing. The run cell reads PAUSED, and the tickets finishing in the table's words
# (a green branch waiting for the landing worker is "landing"); a ticket parked between two phases
# has the state `paused`, and the ones that have not started wait for the resume. Where the pane has
# no room for it all on the first row, the tickets still finishing take the second.
branch 120 1; log 120 review 'reading the diff'
branch 121 1; log 121 impl 'done'
branch 122 1; log 122 impl 'done'
since_at=$((now - 600))
when=$(date -d "@$since_at" +%H:%M 2>/dev/null || date -r "$since_at" +%H:%M)
# Within ten minutes after midnight the pause was yesterday, and the cell gives its date first.
when="([0-9]{2} [A-Za-z]{3} )?$when"
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running", "concurrency": 3,
  "typical": { "implement": 600, "gates": 60, "issue": 900 },
  "paused": { "since": $since_at, "finishing": ["120", "121"] },
  "issues": ["120","121","122","123"],
  "tickets": {
    "120": { "state": "review", "since": $((now - 120)), "started": $((now - 900)) },
    "121": { "state": "ready", "since": $((now - 60)), "note": "gates green" },
    "122": { "state": "paused", "since": $((now - 300)), "note": "before review at a1b2c3d" },
    "123": { "state": "queued", "order": 4, "since": $now }
  } }
EOF
render "120 121 122 123"
has "PAUSED since $when"
has 'finishing +#120 review, #121 landing'
hasnt 'running · '
hasnt 'ends ~'
row '#120' review
row '#122' paused 'before review at a1'
row '#123' queued 'waits for the resume'
# Nothing in flight: the cell says only that it is paused.
sed -i.bak 's/"finishing": \["120", "121"\]/"finishing": []/' "$L/run.json"
render "120 121 122 123"
has "PAUSED since $when"
hasnt 'finishing'
# The time as milliseconds or as an ISO time reads the same way (the record is a file in a repository).
sed -i.bak "s/\"since\": $since_at,/\"since\": $((since_at * 1000)),/" "$L/run.json"
render "120 121 122 123"
has "PAUSED since $when"
sed -i.bak "s/\"since\": $((since_at * 1000)),/\"since\": \"$started\",/" "$L/run.json"
render "120 121 122 123"
has 'PAUSED since ([0-9]{2} [A-Za-z]{3} )?[0-9]{2}:[0-9]{2}'
# A record that is not an object pauses nothing, and does not blank the run cell.
sed -i.bak 's/"paused": {[^}]*},/"paused": "yes",/' "$L/run.json"
render "120 121 122 123"
hasnt 'PAUSED'
has 'state +running'
# Not paused any more: the live row is back, with the queued ticket next in line.
sed -i.bak 's/"paused": "yes",//' "$L/run.json"
render "120 121 122 123"
hasnt 'PAUSED'
row '#123' queued 'next to start'

# ---------------------------------------------------------------------------
SCENARIO="run whose landing the guard stopped"
# The `.git` guard tripped (the base moved under the run): nothing more lands, but tickets in flight
# finish. The run record's `stopped` says so while the run is still live, and the run cell reads
# STOPPED at once - not only after the run has ended.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running", "concurrency": 3,
  "stopped": "STOPPED before landing #121: main moved while sandboxes ran (abc1234 by a person, 2 minutes ago: quick fix)",
  "issues": ["120","121"],
  "tickets": {
    "120": { "state": "review", "since": $((now - 120)), "started": $((now - 900)) },
    "121": { "state": "stopped", "since": $((now - 60)), "note": "finished before the run stopped - lands on a later run" }
  } }
EOF
render "120 121"
has 'state +STOPPED landing · '
has 'since +[0-9:]+ · lands nothing more'
hasnt 'running · '
# A stop that arrives while the run is paused wakes its parked tickets: the cell reads STOPPED, never PAUSED.
sed -i.bak "s/\"stopped\": /\"paused\": { \"since\": $((now - 300)), \"finishing\": [] }, \"stopped\": /" "$L/run.json"
render "120 121"
has 'state +STOPPED landing · '
hasnt 'PAUSED'
sed -i.bak 's/"paused": {[^}]*}, //' "$L/run.json"
# A record whose `stopped` is empty stops nothing.
sed -i.bak 's/"stopped": "[^"]*",/"stopped": "",/' "$L/run.json"
render "120 121"
hasnt 'STOPPED +landing'
has 'state +running'

# ---------------------------------------------------------------------------
SCENARIO="run paused for plan usage"
# USAGE_PAUSE: the run paused itself when a window reached the threshold. The cell names the cause and when it
# resumes in place of when it paused: `PAUSED - weekly usage 95%, resumes Wed 06:01`, with the tickets still
# finishing on the row below. A pane too narrow for that keeps the cause on the first row and moves the
# resume time to the second. Two days ahead is never today, so the reset's weekday is drawn.
resumes_at=$((now + 172800))
back=$(date -d "@$resumes_at" '+%a %H:%M' 2>/dev/null || date -r "$resumes_at" '+%a %H:%M')
usage_paused() { # window percent provider finishing-json
  cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running", "concurrency": 3,
  "paused": { "since": $since_at, "finishing": $4, "cause": "usage", "provider": "$3", "window": "$1", "percent": $2, "resumesAt": $resumes_at },
  "issues": ["120","121","123"],
  "tickets": {
    "120": { "state": "review", "since": $((now - 120)), "started": $((now - 900)) },
    "121": { "state": "ready", "since": $((now - 60)), "note": "gates green" },
    "123": { "state": "queued", "order": 4, "since": $now }
  } }
EOF
}
usage_paused week 95 claude '["120", "121"]'
render "120 121 123"
has 'PAUSED - weekly usage 95%'
has "resumes +$back"
hasnt 'PAUSED since'
row '#123' queued 'waits for the resume'
# A wide pane has room for the whole line, and the tickets finishing take the row below it.
COLS_WAS="$COLS"; COLS=160
render "120 121 123"
has "PAUSED - weekly usage 95%, resumes $back"
has 'finishing +#120 review, #121 landing'
hasnt 'PAUSED since'
# Nothing in flight: the row below says when the run started, as an unpaused run's does.
usage_paused week 95 claude '[]'
render "120 121 123"
has "PAUSED - weekly usage 95%, resumes $back"
hasnt 'finishing'
# The 5-hour window, and Codex's windows, are named; a reset later today shows the time alone.
usage_paused fiveHour 93 claude '[]'
render "120 121 123"
has "PAUSED - 5-hour usage 93%, resumes $back"
usage_paused week 100 codex '[]'
render "120 121 123"
has "PAUSED - Codex weekly usage 100%, resumes $back"
COLS=80
# At 80 columns the longest wording does not fit its row, so it keeps only what it can: usage and its percent.
usage_paused week 100 codex '[]'
render "120 121 123"
has 'PAUSED - usage 100%'
has "resumes +$back"
# A record whose cause is not stated with numbers is read as a person's pause, never as a blank or broken cell.
sed -i.bak 's/"percent": 100,/"percent": "high",/' "$L/run.json"
render "120 121 123"
has "PAUSED since $when"
hasnt 'usage'
COLS="$COLS_WAS"

# ---------------------------------------------------------------------------
SCENARIO="pause ten minutes old, the clock at 00:05"
# The pause the scenarios above draw is made at now - 600: within ten minutes after midnight that is
# yesterday, and the cell then gives its date (`PAUSED since 08 Oct 23:55`). The same two records, a
# person's pause and a usage pause whose percent is no number, are drawn under a `date` that says it is
# 00:05, so the date prefix is held at any hour of the day and not only by a run that starts after midnight.
mkdir -p "$TMP/clock"
cat >"$TMP/clock/date" <<'EOF'
#!/bin/sh
# Only a bare "+format" asks for the time now: the clock is FAKE_NOW then, and the real date is run otherwise.
if [ "$#" = 1 ] && [ "${1#+}" != "$1" ]; then
  if [ "$1" = "+%s" ]; then echo "$FAKE_NOW"; else "$REAL_DATE" -d "@$FAKE_NOW" "$1" 2>/dev/null || "$REAL_DATE" -r "$FAKE_NOW" "$1"; fi
else exec "$REAL_DATE" "$@"; fi
EOF
chmod +x "$TMP/clock/date"
REAL_DATE="$(command -v date)"
midnight_now=$(date -d "$(date +%F) 00:05:00" +%s 2>/dev/null || date -j -f '%Y-%m-%d %H:%M:%S' "$(date +%F) 00:05:00" +%s)
since_was="$since_at"; since_at=$((midnight_now - 600))
usage_paused week 100 codex '[]'
sed -i.bak 's/"percent": 100,/"percent": "high",/' "$L/run.json"
PATH="$TMP/clock:$PATH" REAL_DATE="$REAL_DATE" FAKE_NOW="$midnight_now" render "120 121 123"
has 'PAUSED since [0-9]{2} [A-Za-z]{3} 23:55'
hasnt 'usage'
# The clock itself is held: a pause made after midnight, four minutes ago, gives the time alone.
since_at=$((midnight_now - 240))
usage_paused week 100 codex '[]'
sed -i.bak 's/"percent": 100,/"percent": "high",/' "$L/run.json"
PATH="$TMP/clock:$PATH" REAL_DATE="$REAL_DATE" FAKE_NOW="$midnight_now" render "120 121 123"
has 'PAUSED since 00:01'
hasnt 'PAUSED since [0-9]{2} [A-Za-z]{3}'
since_at="$since_was"

# ---------------------------------------------------------------------------
SCENARIO="live run, finished work left uncommitted"
# A commit refused by a hook leaves the finished work in a kept worktree: not "no change", and among Needs you.
git_ branch agent/issue-113 main; log 113 impl 'done'
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "landing 0/0",
  "issues": ["113"], "tickets": { "113": { "state": "uncommitted", "since": $now, "note": "work left uncommitted in .sandcastle/worktrees/agent-issue-113" } } }
EOF
render "113"
row '#113' uncommitted 'work left uncommit'
has '! +uncommitted'
hasnt 'no change'
git_ branch -q -D agent/issue-113

# ---------------------------------------------------------------------------
SCENARIO="live run, in-run landing"
# Tickets land while others still run: #103 is landing, #104 went red together with
# #110 (landed a minute ago), #105 was put back in the queue: queued, with the line
# that says why. None of the three holds a sandbox: of four slots, two are working,
# so all three queued tickets start at once.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m",
  "stage": "running", "concurrency": 4,
  "typical": { "implement": 600, "gates": 60, "issue": 900 },
  "issues": ["101","102","103","104","105","106","107","110"],
  "tickets": {
    "101": { "state": "implement", "since": $((now - 30)), "started": $((now - 60)) },
    "102": { "state": "gates", "since": $((now - 600)), "started": $((now - 700)), "note": "2/3 pytest" },
    "103": { "state": "landing", "since": $((now - 20)), "note": "merging into main" },
    "104": { "state": "red", "since": $((now - 40)), "note": "red with #110" },
    "105": { "state": "queued", "order": 5, "since": $((now - 50)), "requeued": "requeued after red with #110" },
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
row '#105' queued 'requeued after red'
row '#106' queued 'next to start'
row '#107' queued 'next to start'
row '#110' merged
hasnt 'ahead of it'
# No landing phase to wait for: the estimate is when the run ends.
has 'ends +~[0-9]{2}:[0-9]{2} · since [0-9:]+ +│'
hasnt 'lands +~'

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
SCENARIO="live run, earlier run's kept worktrees"
# A new run starts while the last run's closed sandboxes left worktrees with
# uncommitted files. Those tickets are not the live run's: they read as they do
# with no live run, never stalled or working. #521 landed (its kept worktree
# holds the branch, so landing could not delete it); #522 never did.
branch 521 1; git_ merge -q --no-ff -m "Merge agent/issue-521 (closes #521)" agent/issue-521
log 521 impl '# build green in 1.2s'; touch -t 202001010000 "$L/agent-issue-521-impl-521.log"
mkdir -p "$REPO/.sandcastle/worktrees/agent-issue-521"
branch 522 1; log 522 impl '# build green in 2.4s'
mkdir -p "$REPO/.sandcastle/worktrees/agent-issue-522"
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["530"], "waiting": [], "active": {},
  "tickets": { "530": { "state": "implement", "since": $((now - 30)), "started": $((now - 60)) } } }
EOF
render "530"
row '#521' merged 'worktree kept'
row '#522' 'left over' 'earlier run - sandc'
hasnt 'stalled'

# An older orchestrator's record has no tickets: its `issues` are the live
# run's, and its quiet worktree with no container is a sandbox that died.
branch 523 1; log 523 impl '# build green in 3.1s'; touch -t 202001010000 "$L/agent-issue-523-impl-523.log"
mkdir -p "$REPO/.sandcastle/worktrees/agent-issue-523"
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["523"], "waiting": [], "active": {} }
EOF
render "523"
row '#523' stalled
row '#521' merged
row '#522' 'left over' 'earlier run'
# Later scenarios rewrite the record; the worktrees, branches and logs here must not show in them.
rm -rf "$REPO/.sandcastle/worktrees/agent-issue-521" "$REPO/.sandcastle/worktrees/agent-issue-522" "$REPO/.sandcastle/worktrees/agent-issue-523"
git_ branch -q -D agent/issue-521 agent/issue-522 agent/issue-523
rm -f "$L"/agent-issue-52[123]-*

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
# Red at landing, once and again after a requeue: red, not ready.
branch 114 1; log 114 impl 'done'
branch 115 1; log 115 impl 'done'
# The kind decides, never the line: a line no prefix foresaw is still red, and a person's take-back is held.
branch 116 1; log 116 impl 'done'
branch 117 1; log 117 impl 'done'
# Landed partly done, its branch deleted: the row says the ticket is open, and the base merged into
# the branch is not counted as one of its commits.
branch 118 1; echo moved >"$REPO/f-118-base"; git_ add f-118-base; git_ commit -q -m "main moves on"
git_ checkout -q agent/issue-118; git_ merge -q --no-ff -m "Merge main into agent/issue-118" main
git_ checkout -q main; git_ merge -q --no-ff -m "Merge agent/issue-118 (part of #118)" agent/issue-118
git_ branch -q -D agent/issue-118; log 118 impl 'done'
rm -rf "$REPO/.sandcastle/worktrees/agent-issue-101"
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "finishedAt": "$started", "exitCode": 0,
  "models": "implement old-model/low", "tickets": { "104": { "state": "red" } } }
EOF
cat >"$L/outcomes.json" <<EOF
{ "104": { "run": "$started", "kind": "gate red", "text": "gate red: pytest=FAIL" },
  "109": { "run": "$started", "kind": "conflict", "with": ["110"], "text": "merge conflict: src/a.ts" },
  "111": { "run": "$started", "kind": "withdrawn", "text": "withdrawn: taken out of the queue during the run" },
  "112": { "run": "$started", "kind": "held", "text": "needs a human: handed back" },
  "113": { "run": "$started", "kind": "uncommitted", "text": "uncommitted" },
  "114": { "run": "$started", "kind": "red", "with": ["110"], "text": "red when merged with #110" },
  "115": { "run": "$started", "kind": "red", "with": ["110", "114"], "text": "red again with #110, #114 after a requeue" },
  "116": { "run": "$started", "kind": "red", "with": ["110"], "text": "test red with #110" },
  "117": { "run": "$started", "kind": "taken back", "text": "needs a human: marked for a human during the run" },
  "110": { "run": "$started", "kind": "merged", "text": "merged" },
  "103": { "run": "earlier", "outcome": "gate red: ruff=FAIL" } }
EOF
render ""
row '#104' 'gate red' 'pytest=FA'
row '#109' conflict
row '#110' merged
# Its commits are what it landed, not the 0 its merged branch has left over the base.
has '^│ +#110 +│ . merged +│[^│]+│ +1 +│'
has 'tokens = in/out, cache included'
row '#111' withdrawn
row '#112' held 'needs a human: hand'
row '#113' uncommitted
row '#114' 'gate red' 'red when merged'
row '#115' 'gate red' 'red again'
row '#116' 'gate red' 'test red with'
row '#117' held 'needs a human'
row '#118' merged 'partly done, ticket'
has '^│ +#118 +│ . merged +│[^│]+│ +1 +│'
git_ branch -q -D agent/issue-112 agent/issue-113 agent/issue-114 agent/issue-115 agent/issue-116 agent/issue-117 # only this scenario's
# An older kit's entry carries no kind: its line is shown, and no state is taken from it.
row '#103' 'left over' 'earlier run: gate'
has 'next run.*implement +next-model/high|implement +next-model/high.*next run'
hasnt 'old-model'
# Below 80 columns the TOKENS column goes, and the legend line explaining it with it.
COLS_WAS="$COLS"; COLS=60; render ""
hasnt 'CPU in cores'
hasnt 'tokens = in/out'
hasnt 'TOKENS'
row '#110' merged
COLS="$COLS_WAS"

# ---------------------------------------------------------------------------
SCENARIO="container stats, project path with a space"
# A container is tied to its ticket by the worktree it mounts.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["101"], "tickets": { "101": { "state": "implement", "since": $now, "started": $now } } }
EOF
# CPU and memory share one column, from 100 columns.
COLS_WAS="$COLS"; COLS=120
FAKE_DOCKER="$REPO" render "101"
row '#101' impl
has '^│ +#101 .*│ +1\.5c/276M +│'
has 'CPU/MEM'
has 'CPU in cores'
has 'time = in state; once finished, start to end'
has 'red time = past twice the usual'
# A GiB figure under 10 keeps its decimal.
FAKE_STATS='sandcastle-c1|100.00%|2.1GiB / 11.73GiB' FAKE_DOCKER="$REPO" render "101"
has '^│ +#101 .*│ +1\.0c/2\.1G +│'
FAKE_STATS='sandcastle-c1|100.00%|12.4GiB / 31.00GiB' FAKE_DOCKER="$REPO" render "101"
has '^│ +#101 .*│ +1\.0c/12G +│'
# A ticket with no container has a grey dash for both halves.
render "101"
has '^│ +#101 .*│ +- +│ +- +│'
COLS="$COLS_WAS"

# ---------------------------------------------------------------------------
SCENARIO="tokens per ticket"
# The TOKENS column shows what the run's record holds of each ticket - its finished passes and the one
# running - as in/out, cache counted in "in"; a ticket with none yet, or a figure that is no tokens, has a dash.
branch 131 1; log 131 impl 'working'
branch 132 1; log 132 review 'reading'
branch 133 1; log 133 impl 'starting'
branch 134 1; log 134 impl 'odd'
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running", "concurrency": 3,
  "issues": ["131","132","133","134"], "tickets": {
    "131": { "state": "implement", "since": $now, "started": $now, "tokens": "3.1M in / 42k out" },
    "132": { "state": "review", "since": $now, "started": $now, "tokens": "980k in / 1.2M out" },
    "133": { "state": "implement", "since": $now, "started": $now },
    "134": { "state": "implement", "since": $now, "started": $now, "tokens": "plenty" } } }
EOF
COLS_WAS="$COLS"
# 100 columns and up: both columns.
COLS=120; render "131 132 133 134"
has '^│ +TICKET +│ +STATE +│ +TIME +│ +COMMITS +│ +CPU/MEM +│ +TOKENS +│ +ACTIVITY +│'
has '^│ +#131 .*│ +- +│ +3\.1M/42k +│'
has '^│ +#132 .*│ +- +│ +980k/1\.2M +│'
has '^│ +#133 .*│ +- +│ +- +│'
has '^│ +#134 .*│ +- +│ +- +│'
# The legend says what the figure counts.
has 'tokens = in/out, cache included'
has 'CPU in cores'
# 80 to 99: TOKENS alone, which is what a person watching the plan's allowance needs.
for COLS in 80 90 99; do
  render "131 132 133 134"
  has '^│ +TICKET +│ +STATE +│ +TIME +│ +COMMITS +│ +TOKENS +│ +ACTIVITY +│'
  hasnt 'CPU/MEM'
  hasnt 'CPU in cores'
  has '^│ +#131 .*│ +3\.1M/42k +│'
  has '^│ +#132 .*│ +980k/1\.2M +│'
  has 'tokens = in/out, cache included'
done
# Below 80: neither, and no legend for them.
COLS=70; render "131 132 133 134"
has '^│ +TICKET +│ +STATE +│ +TIME +│ +COMMITS +│ +ACTIVITY +│'
hasnt 'TOKENS'
hasnt 'CPU/MEM'
hasnt 'tokens = in/out'
row '#131' impl
# Once the run has ended its rows come from git and the logs, but each ticket's tokens are still the record's.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "finishedAt": "$started", "exitCode": 0, "models": "m",
  "issues": ["131","132"], "tickets": { "131": { "state": "merged", "tokens": "3.1M in / 42k out" }, "132": { "state": "merged" } } }
EOF
COLS=120; render ""
has '^│ +#131 .*│ +- +│ +3\.1M/42k +│'
has '^│ +#132 .*│ +- +│ +- +│'
COLS="$COLS_WAS"

# ---------------------------------------------------------------------------
SCENARIO="a state written after the frame's clock"
# The frame reads the clock before run.json, so a state the run wrote in between is "in the future".
# The clock is read afresh: the script's own $now is minutes old on a loaded machine, and 30s ahead of
# it is then already in the past.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["103"], "tickets": { "103": { "state": "ready", "since": $(($(date +%s) + 30)), "note": "gates green" } } }
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
SCENARIO="live loop, no terminal"
# An agent's tool runs the live view with no terminal and no size given: it drew
# its frame and then died on an unset TERM_COLS under set -u. A failing stty stands
# in for the missing terminal: run from one, the test would otherwise read its size.
mkdir -p "$TMP/no-tty"; printf '#!/bin/sh\nexit 1\n' >"$TMP/no-tty/stty"; chmod +x "$TMP/no-tty/stty"
env -u TERM_COLS -u TERM_ROWS PATH="$TMP/no-tty:$FAKE:$PATH" SANDCASTLE_PROJECT="$REPO" SANDCASTLE_BIN="$FAKE/sandcastle" \
  SANDCASTLE_BASE=main SANDCASTLE_NAME=fixture XDG_CACHE_HOME="$TMP/cache" STATUS_FRAMES=1 \
  "${STATUS_BASH:-bash}" "$KIT/status.sh" 1 >"$TMP/live-notty" 2>&1 </dev/null
if grep -q 'unbound variable' "$TMP/live-notty"; then echo "FAIL [$SCENARIO] $(grep -m1 'unbound variable' "$TMP/live-notty")"; fails=$((fails+1)); fi

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
# The hint may take one more note row: nothing else changes the frame's height.
rows=$(wc -l <"$TMP/frame")
# -eq, not =: BSD wc pads its count with spaces, so a text compare fails on macOS alone.
{ [ "$rows" -eq "$plain_rows" ] || [ "$rows" -eq $((plain_rows+1)) ]; } || { echo "FAIL [$SCENARIO] $rows rows with links, $plain_rows without"; fails=$((fails+1)); }
row '#103' ready
# The hint that the numbers are clickable is shown with the links, and only then. With no
# modifier handed in (SANDCASTLE_CLICK_MOD unset) it names both, as Ctrl-click is iTerm2's right-click.
has 'ctrl-click a ticket for its card \(iTerm2: cmd-click for its log\)'

# ---------------------------------------------------------------------------
SCENARIO="click hint per modifier"
# `sandcastle status` senses the outer terminal once and hands status.sh one word; the view only
# draws its text, and an unknown word draws the fallback.
hinted() { # SANDCASTLE_CLICK_MOD value, expected hint
  PATH="$FAKE:$PATH" FAKE_QUEUE="" SANDCASTLE_PROJECT="$REPO" SANDCASTLE_BIN="$FAKE/sandcastle" \
    SANDCASTLE_BASE=main SANDCASTLE_NAME=fixture TERM_COLS="$COLS" TERM_ROWS=200 XDG_CACHE_HOME="$TMP/cache" \
    SANDCASTLE_LINKS=1 SANDCASTLE_CLICK_MOD="$1" "${STATUS_BASH:-bash}" "$KIT/status.sh" 0 all >"$TMP/linked" 2>&1
  sed $'s/\e]8;[^\e]*\e\\\\//g; s/\e\\[[0-9;]*m//g' "$TMP/linked" >"$TMP/frame"
  grep -qF "$2" "$TMP/frame" || { echo "FAIL [$SCENARIO] SANDCASTLE_CLICK_MOD=$1 does not show: $2"; fails=$((fails+1)); }
}
hinted ctrl 'ctrl-click a ticket for its card'
hasnt 'iTerm2'
hinted cmd 'cmd-click a ticket for its log'
hasnt 'ctrl-click'
hinted fallback 'ctrl-click a ticket for its card (iTerm2: cmd-click for its log)'
hinted bogus 'ctrl-click a ticket for its card (iTerm2: cmd-click for its log)'

# ---------------------------------------------------------------------------
SCENARIO="links off, or no plugin marker"
# SANDCASTLE_LINKS=0 turns links and hint off. With HERDR_ENV=1 and no marker under the cache,
# neither shows either (the pipe already rules them out here; test/status-links.test.ts holds
# the same on a terminal, where only the marker does).
linkless() { # extra env assignments
  env "$@" PATH="$FAKE:$PATH" FAKE_QUEUE="" SANDCASTLE_PROJECT="$REPO" SANDCASTLE_BIN="$FAKE/sandcastle" \
    SANDCASTLE_BASE=main SANDCASTLE_NAME=fixture TERM_COLS="$COLS" TERM_ROWS=200 XDG_CACHE_HOME="$TMP/cache" \
    "${STATUS_BASH:-bash}" "$KIT/status.sh" 0 all >"$TMP/linked" 2>&1
  ! grep -q $'\e]8;' "$TMP/linked" || { echo "FAIL [$SCENARIO] a link with: $*"; fails=$((fails+1)); }
  sed $'s/\e\\[[0-9;]*m//g' "$TMP/linked" >"$TMP/frame"
  hasnt 'ctrl-click'
}
linkless SANDCASTLE_LINKS=0
linkless HERDR_ENV=1
linkless HERDR_ENV=1 SANDCASTLE_LINKS=

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
# The two renders can fall in different seconds, or minutes, so nothing the clock sets is compared: a
# time of day (23:10, 23:10:37) and an age or duration wherever it stands (an age cell, the header's
# "running · 0m", "quiet 9m", "(57s ago)", 1h12m, 1m 2s), with the padding round it, which a longer
# figure ("9m" to "10m") shifts. Every other cell is. A figure is cut from its neighbours by a
# non-alphanumeric character, so "3x over" and "275.8MiB" stay; the second pass takes a figure whose
# left neighbour the first one used up ("57s,1m").
steady() {
  sed -E -e 's/[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?/<time>/g' \
    -e 's/(^|[^0-9A-Za-z])([0-9]+[hms] ?)+([^0-9A-Za-z]|$)/\1<time>\3/g' \
    -e 's/(^|[^0-9A-Za-z])([0-9]+[hms] ?)+([^0-9A-Za-z]|$)/\1<time>\3/g' \
    -e 's/ *<time> */<time>/g'
}
# The live frame is rendered 61 s later than the plain one - a minute boundary between them, as under
# load - by a `date` that runs ahead where status.sh asks for the time (+%s) and is the real one
# otherwise. Before the filter masked the header's "running · 0m", this scenario failed on that alone.
mkdir -p "$TMP/skew"
cat >"$TMP/skew/date" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "+%s" ]; then echo $(( $("$REAL_DATE" +%s) + ${FAKE_SKEW:-0} )); else exec "$REAL_DATE" "$@"; fi
EOF
chmod +x "$TMP/skew/date"
REAL_DATE="$(command -v date)"
skewed() { PATH="$TMP/skew:$PATH" REAL_DATE="$REAL_DATE" FAKE_SKEW=61 render "$1"; }
skewed ""
head -n "$(wc -l <"$TMP/frame-plain")" "$TMP/frame" | steady | diff -q - <(steady <"$TMP/frame-plain") >/dev/null || { echo "FAIL [$SCENARIO] the frame above the strip changed"; fails=$((fails+1)); }
# A real cell still counts: the same run with its ticket in another state is another frame.
sed -i.bak 's/"state": "implement"/"state": "gates"/' "$L/run.json" && rm -f "$L/run.json.bak"
skewed ""
head -n "$(wc -l <"$TMP/frame-plain")" "$TMP/frame" | steady | diff -q - <(steady <"$TMP/frame-plain") >/dev/null && { echo "FAIL [$SCENARIO] a ticket's new state did not change the frame"; fails=$((fails+1)); }
# The figures a live frame holds that this scenario's own does not, each pair a clock tick apart.
same() { [ "$(steady <<<"$1")" = "$(steady <<<"$2")" ]; }
for pair in \
  '│  9s  │|│ 10s  │' '│ 59s  │|│  1m  │' '│ 59m  │|│  1h  │' \
  'running · 9m      │|running · 10m     │' 'running · 59m     │|running · 1h00m   │' \
  'ends ~23:10 · since 22:40|ends ~23:11 · since 22:40' 'base main  ·  23:10:37|base main  ·  23:10:38' \
  'quiet 9m - Bash|quiet 10m - Bash' 'claude  5h 41%  (57s ago)|claude  5h 41%  (1m ago)' \
  'took 1m 2s, 1h12m|took 1m 3s, 1h13m' '(57s,1m,2h)|(58s,2m,3h)'; do
  same "${pair%%|*}" "${pair#*|}" || { echo "FAIL [$SCENARIO] the clock changes the frame: ${pair%%|*} / ${pair#*|}"; fails=$((fails+1)); }
done
for pair in \
  '│ #301 │ ● impl  │ 5s │|│ #301 │ ● gates │ 5s │' '│ #301 │ ● impl │ 5s │|│ #302 │ ● impl │ 5s │' \
  'claude  5h 41%  (57s ago)|claude  5h 42%  (57s ago)' '3x over, usually 1m|2x over, usually 1m' \
  '275.8MiB / 11.73GiB|275.9MiB / 11.73GiB'; do
  ! same "${pair%%|*}" "${pair#*|}" || { echo "FAIL [$SCENARIO] the filter hides a real change: ${pair%%|*} / ${pair#*|}"; fails=$((fails+1)); }
done
# A finished run's output is in its report, not on the view.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": 1, "startedAt": "$started", "finishedAt": "$started", "exitCode": 0, "models": "m", "issues": [] }
EOF
render ""
hasnt 'run output'
rm -f "$L/run-output.log" "$L/run.json"; if [ -f "$TMP/run.json.kept" ]; then mv "$TMP/run.json.kept" "$L/run.json"; fi

# ---------------------------------------------------------------------------
SCENARIO="machine pool past its limit"
# The mid-run base check's sandbox takes an extra slot (pool.ts `withExtraSlot`), outside the
# numbered six, so the pool reads 7/6: seven full cells and no free one, not a stray free cell.
S="$TMP/cache/sandcastle-kit/slots"
mkdir -p "$S"
for i in 0 1 2 3 4 5; do printf '%s t%s run=aaaa ticket\n' "$LIVE" "$i" >"$S/sandboxes-$i.lock"; done
printf '%s t6 run=aaaa base check\n' "$LIVE" >"$S/sandboxes-extra-aaaa-0.lock"
SANDCASTLE_MAX_SANDBOXES=6 render "101 102 103"
has 'sandboxes +███████ 7/6'
hasnt 'sandboxes +[█]*░'
rm -rf "$S"

# ---------------------------------------------------------------------------
SCENARIO="short pane, one-row header"
# The logo folds to one row in a short pane. A castle cut down to its battlements
# read as a broken logo, so the fold draws no castle: the wordmark alone.
SHOW=collapse ROWS=12 render "101 102 103"
has '^│ +sandcastle-kit  fixture'
hasnt '▄|█'
SHOW=collapse ROWS=40 render "101 102 103"
has 's a n d c a s t l e'
has '█████'

# ---------------------------------------------------------------------------
# The usage scenarios' lines are written for an 80-column pane, where a row wraps its windows; a
# wider COLS from the caller (full-check runs this file at 200) would draw them on one line.
COLS_WAS="$COLS"; COLS=80
# The readings' ages ("2m ago") count from `now`, set when this file started minutes ago: a slow
# machine drew "3m ago". Each usage scenario takes `now` afresh before it builds its readings.
now=$(date +%s)
SCENARIO="live run, the plan's usage"
# The newest reading across the agents' own rate-limit events is the record's `usage` (src/usage.ts):
# both windows with a bar, the percentage and the reset time, and the reading's age. Only a live run
# that spends a subscription has one. Colours are the pty test's (test/status-usage.test.ts); here, each band's text.
# A bar is ten cells, a tenth for each ten percent rounded: 14% fills one, 93% nine.
r5=$((now + 7200)); rw=$((now + 3 * 86400))
at5=$(date -d "@$r5" +%H:%M 2>/dev/null || date -r "$r5" +%H:%M)
atw=$(date -d "@$rw" '+%a %H:%M' 2>/dev/null || date -r "$rw" '+%a %H:%M')
usage_record() { # percent5 percentWeek age-seconds [settings json]
  local settings=""
  [ -n "${4:-}" ] && settings="\"settings\": $4,"
  cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["105"], $settings
  "usage": { "provider": "claude", "at": $((now - $3)),
    "windows": { "fiveHour": { "percent": $1, "resetsAt": $r5 }, "week": { "percent": $2, "resetsAt": $rw } } },
  "tickets": { "105": { "state": "queued", "order": 5, "since": $now } } }
EOF
}
usage_record 14 93 120
render "105"
# At 80 columns the row wraps whole items: the provider and the 5-hour window, then the week and the age.
has "^│ usage +claude  5h ▓░░░░░░░░░ 14% · resets $at5 +│"
has "^│ +week ▓▓▓▓▓▓▓▓▓░ 93% · resets $atw   \\(2m ago\\) +│"
COLS=160 render "105"
has "^│ usage +claude  5h ▓░░░░░░░░░ 14% · resets $at5   week ▓▓▓▓▓▓▓▓▓░ 93% · resets $atw   \\(2m ago\\) +│"
# Amber from 75%, red from 90%, a full week: the bars follow the percentage (colours: the pty test).
usage_record 75 80 300
COLS=160 render "105"
has "^│ usage +claude  5h ▓▓▓▓▓▓▓▓░░ 75% · resets $at5   week ▓▓▓▓▓▓▓▓░░ 80% · resets $atw   \\(5m ago\\) +│"
usage_record 90 100 300
COLS=160 render "105"
has "^│ usage +claude  5h ▓▓▓▓▓▓▓▓▓░ 90% · resets $at5   week ▓▓▓▓▓▓▓▓▓▓ 100% · resets $atw   \\(5m ago\\) +│"
# A reading older than 15 minutes shows its age (and is greyed: the pty test).
usage_record 14 93 1200
COLS=160 render "105"
has "week ▓▓▓▓▓▓▓▓▓░ 93% · resets $atw   \\(20m ago\\) +│"
# A percentage past 100 stops at 100; a record with a window that is no number waits for a reading instead.
usage_record 14 250 30
COLS=160 render "105"
has "week ▓▓▓▓▓▓▓▓▓▓ 100% · resets"
sed -i.bak 's/"percent": 14/"percent": "lots"/' "$L/run.json"
COLS=160 render "105"
has '^│ usage +claude  waiting for the first agent.s reading +│'
hasnt '5h ▓'

SCENARIO="live run, no usage to show"
# Before the first agent's reading the row says it waits (the run is watching for one) ...
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["105"], "usage": { "provider": "claude" },
  "tickets": { "105": { "state": "queued", "order": 5, "since": $now } } }
EOF
render "105"
has '^│ usage +claude  waiting for the first agent.s reading +│'
# ... a record without `usage` (an API-key run, a run on no Claude model, an older kit's) draws no row ...
sed -i.bak 's/"usage": { "provider": "claude" },//' "$L/run.json"
render "105"
hasnt '^│ usage '
# ... and neither does one whose settings say the run bills API credits, whatever `usage` holds ...
usage_record 14 93 120 '{ "autonomy": 0, "apiKey": true }'
render "105"
has '^│ settings .*API credits'
hasnt '^│ usage |5h ▓'
# ... nor a usage that is not an object, or names another provider, nor a run that has ended.
for u in '"claude"' '[1]' '{ "provider": "other", "windows": 1 }'; do
  cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["105"], "usage": $u,
  "tickets": { "105": { "state": "queued", "order": 5, "since": $now } } }
EOF
  render "105"
  hasnt '^│ usage |5h ▓|waiting for the first'
done
usage_record 14 93 120
sed -i.bak "s/\"stage\": \"running\",/\"stage\": \"running\", \"finishedAt\": \"$started\", \"exitCode\": 0,/" "$L/run.json"
render "105"
hasnt '^│ usage |5h ▓|waiting for the first'

# ---------------------------------------------------------------------------
SCENARIO="live run, Claude's and Codex's plan usage"
# With cross-review on a ChatGPT plan the record's `usage` is a list with an entry for each provider, and the
# row draws each on a line of its own, the names one width so the bars start in one column. Codex's
# numbers are its `rate_limits` of the ticket: the 5-hour window spent, the week 16%.
count() { # pattern lines
  local n; n=$(grep -cE "$1" "$TMP/frame")
  [ "$n" -eq "$2" ] || { echo "FAIL [$SCENARIO] $n line(s) match /$1/, want $2"; fails=$((fails+1)); }
}
usage_list() { # entries-json [settings json]
  local settings=""
  [ -n "${2:-}" ] && settings="\"settings\": $2,"
  cat >"$L/run.json" <<RECORD
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["105"], $settings "usage": $1,
  "tickets": { "105": { "state": "queued", "order": 5, "since": $now } } }
RECORD
}
reading() { # provider percent5 percentWeek age-seconds
  printf '{ "provider": "%s", "at": %s, "windows": { "fiveHour": { "percent": %s, "resetsAt": %s }, "week": { "percent": %s, "resetsAt": %s } } }' \
    "$1" "$((now - $4))" "$2" "$r5" "$3" "$rw"
}
now=$(date +%s)
claude_reading=$(reading claude 14 93 120); codex_reading=$(reading codex 100 16 120)
usage_list "[$claude_reading, $codex_reading]"
COLS=160 render "105"
has "^│ usage +claude  5h ▓░░░░░░░░░ 14% · resets $at5   week ▓▓▓▓▓▓▓▓▓░ 93% · resets $atw   \\(2m ago\\) +│"
has "^│ +codex   5h ▓▓▓▓▓▓▓▓▓▓ 100% · resets $at5   week ▓▓░░░░░░░░ 16% · resets $atw   \\(2m ago\\) +│"
count '^│ usage ' 1
count 'week ▓' 2
# At 80 columns each provider's line wraps whole items, the second one's under the first's.
render "105"
has "^│ usage +claude  5h ▓░░░░░░░░░ 14% · resets $at5 +│"
has "^│ +week ▓▓▓▓▓▓▓▓▓░ 93% · resets $atw   \\(2m ago\\) +│"
has "^│ +codex   5h ▓▓▓▓▓▓▓▓▓▓ 100% · resets $at5 +│"
has "^│ +week ▓▓░░░░░░░░ 16% · resets $atw   \\(2m ago\\) +│"
# Each line has its own age: Codex's reading is from the last cross-review pass, Claude's from the latest agent.
usage_list "[$claude_reading, $(reading codex 100 16 1200)]"
COLS=160 render "105"
has "^│ usage +claude  5h .*\\(2m ago\\) +│"
has "^│ +codex   5h .*\\(20m ago\\) +│"
# A record with only Claude draws one line, as a list or as the object an older kit wrote ...
usage_list "[$claude_reading]"
COLS=160 render "105"
count 'week ▓' 1
hasnt 'codex'
usage_list "$claude_reading"
COLS=160 render "105"
count 'week ▓' 1
hasnt 'codex'
# ... and each provider waits for its own first reading, Codex's coming from the cross-review pass.
usage_list "[$claude_reading, { \"provider\": \"codex\" }]"
COLS=160 render "105"
has '^│ usage +claude  5h '
has "^│ +codex   waiting for the first cross-review.s reading +│"
usage_list '[{ "provider": "claude" }, { "provider": "codex" }]'
COLS=160 render "105"
has "^│ usage +claude  waiting for the first agent.s reading +│"
has "^│ +codex   waiting for the first cross-review.s reading +│"
# A run on an Anthropic API key has no Claude line, whatever the record holds, but cross-review's Codex plan is another account's ...
usage_list "[$claude_reading, $codex_reading]" '{ "autonomy": 0, "apiKey": true }'
COLS=160 render "105"
has '^│ settings .*API credits'
hasnt 'claude  5h'
has "^│ usage +codex   5h ▓▓▓▓▓▓▓▓▓▓ 100% · resets $at5   week ▓▓░░░░░░░░ 16% · resets $atw   \\(2m ago\\) +│"
# ... and a run whose settings say cross-review is off has no Codex line, whatever the record holds.
usage_list "[$claude_reading, $codex_reading]" '{ "autonomy": 0, "crossReview": false }'
COLS=160 render "105"
has '^│ usage +claude  5h '
hasnt 'codex'
# An entry that is not an object, or names a provider the view does not know, draws nothing.
usage_list "[$claude_reading, 3, \"codex\", { \"provider\": \"other\", \"windows\": 1 }]"
COLS=160 render "105"
count 'week ▓' 1
hasnt 'codex|other'
COLS="$COLS_WAS"

if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed. Last frame:"; cat "$TMP/frame"; exit 1; fi
echo "status view: all checks passed"
# This repo's sandbox image builds macOS's bash 3.2 as bash32 (.sandcastle/Dockerfile): without
# this second pass, an agent's gate proved bash 5 only and 3.2 breakage surfaced after landing.
if [ -z "${STATUS_BASH:-}" ] && [ -x /usr/local/bin/bash32 ]; then
  echo "status view again under bash32 (bash 3.2):"
  STATUS_BASH=/usr/local/bin/bash32 bash "$0"; exit $?
fi

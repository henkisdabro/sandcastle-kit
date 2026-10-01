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
# FAKE_QUEUE_FAIL: the read fails the way a signed-out gh does.
[ -n "${FAKE_QUEUE_FAIL:-}" ] && { echo "$FAKE_QUEUE_FAIL" >&2; exit 1; }
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

git_() { git -C "$REPO" -c core.hooksPath=/dev/null "$@"; }
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
  PATH="${SHADOW:+$SHADOW:}$FAKE:$PATH" FAKE_QUEUE="$1" SANDCASTLE_PROJECT="$REPO" SANDCASTLE_BIN="$FAKE/sandcastle" \
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
# A row's state: the ticket, its glyph and state word, in that order.
row() { # ticket state [activity pattern]
  local line
  line=$(grep -E "^$1 " "$TMP/frame")
  if ! grep -qE "^$1 +. $2( |$)" <<<"$line"; then
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
row '#101' impl 'Bash|\$ pnpm test'
row '#102' gates 'usually 1m - 2/3 pytest - tests/test_a'
row '#103' ready 'gates green'
row '#104' 'gate red' 'pytest red'
row '#105' queued 'next to start'
row '#106' queued '1 ahead of it'
row '#107' blocked 'waits for #103 \(this run\)'
row '#108' held '.github/'
row '#109' conflict 'with #103'
row '#110' merged
row '#120' queued 'not in this run'
# The counts add up to the run (ten tickets), with the rest apart. They wrap in a narrow pane.
for c in '2 working' '1 ready to land' '3 need you' '2 queued' '1 blocked' '1 merged' '1 not in this run'; do has "(^| )$c( ·|$)"; done
has 'landing 2/4'
has 'models +│ implement live-model/high'
hasnt 'on its earlier branch'
hasnt 'queue: could not read'

SCENARIO="live run, agents working"
# Before landing: an estimate of when it starts, once a typical issue is known.
sed -i.bak 's/"stage": "landing 2\/4"/"stage": "running"/' "$L/run.json"
render "101 102 103 104 105 106 107 108 109 110 120"
has 'run +│ running since [0-9:]+ \([0-9]+m\) · lands ~[0-9]{2}:[0-9]{2} · 1.2M in / 30k out'

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
  "110": { "run": "$started", "outcome": "merged" },
  "103": { "run": "earlier", "outcome": "gate red: ruff=FAIL" } }
EOF
render ""
row '#104' 'gate red' 'pytest=FAIL'
row '#109' conflict
row '#110' merged
row '#111' withdrawn
row '#112' held 'handed back'
git_ branch -q -D agent/issue-112 # only this scenario's
row '#103' 'left over' 'earlier run'
has 'models +│ next run: implement next-model/high'
hasnt 'old-model'

# ---------------------------------------------------------------------------
SCENARIO="container stats, project path with a space"
# A container is tied to its ticket by the worktree it mounts.
cat >"$L/run.json" <<EOF
{ "orchestrator": "fixture", "pid": $LIVE, "startedAt": "$started", "models": "m", "stage": "running",
  "issues": ["101"], "tickets": { "101": { "state": "implement", "since": $now, "started": $now } } }
EOF
FAKE_DOCKER="$REPO" render "101"
row '#101' impl
has '^#101 .* 1\.5c '

# ---------------------------------------------------------------------------
SCENARIO="overflow, ticket-file ids"
# What does not fit is summed up by state. Ticket-file ids have no numeric
# order: they are named, never made into a range like "#0-#0".
SHOW=collapse ROWS=16 render "$(printf 'checkout-%02d ' $(seq 1 12))"
has '\+.*[0-9]+ queued \(checkout-[0-9]{2}, checkout-[0-9]{2}, checkout-[0-9]{2}, …\)'
hasnt '#checkout|#0'

# ---------------------------------------------------------------------------
SCENARIO="queue read fails"
# A signed-out gh or a stale token must not read as an empty queue: the
# reason is shown, and the rows that need no queue are still there.
FAKE_QUEUE_FAIL='gh: not logged in' render "101"
has 'queue: could not read - gh: not logged in'
hasnt '^#101 .* queued'
FAKE_QUEUE_FAIL="$(printf 'x%.0s' $(seq 120))" render ""
has 'queue: could not read - x+…$'

SCENARIO="queue read fails, then recovers"
FAKE_QUEUE_FAIL= render "101"
hasnt 'queue: could not read'

SCENARIO="jq missing"
# On PATH but not running (what a shadowing fake in a test, or a broken
# install, looks like): the view says what to install and stops.
mkdir -p "$TMP/nojq"
printf '#!/bin/sh\nexit 127\n' >"$TMP/nojq/jq"; chmod +x "$TMP/nojq/jq"
SHADOW="$TMP/nojq" render "101"
has 'status needs jq \(apt install jq / brew install jq\)'
hasnt '^ *run '

if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed. Last frame:"; cat "$TMP/frame"; exit 1; fi
echo "status view: all checks passed"

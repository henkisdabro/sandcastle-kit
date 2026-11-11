#!/usr/bin/env bash
# The whole suite, as `pnpm test` runs it: `bash test/suite.sh <the node:test command>`. The status
# view's scenarios (test/status.test.sh at 80 columns and again at 180; the 80-column pass also renders
# one scenario under bash32, where this repository's image has it) run beside the command, not before it. They are hundreds
# of serial node starts on one core: run first, they were about half of every test gate's time, and
# a burndown runs that gate one after another on its one gates slot. Their output is held in files
# and printed after the reporter's, so the two never interleave and a `FAIL [` line still reaches
# the gate log. A gate killed at its time bound loses that held output: its own red names the cause.
#
# Quiet when stdout is not a terminal (an agent's tool call, a gate log): a pass printed some 4,400
# `✔` lines, 400 KB that filled an agent's context and buried the one line it needed. A pass now
# prints node:test's summary, the skips with their reasons, any warnings and the slowest tests; a
# failure prints the whole log minus the `✔` lines, so every `✖` line, its assertion, the
# `✖ failing tests:` list with its `test at` lines and the `ℹ` summary stay, in order: the kit's
# own gate reader (`failingTests`, src/gates.ts) parses them. A terminal still streams.
# VERBOSE=1 streams anywhere; QUIET=1 is quiet in a terminal too. CI runs `test:shard`, not this.
set -u
mode=quiet
if [ "${VERBOSE:-}" = 1 ]; then mode=stream
elif [ "${QUIET:-}" != 1 ] && [ -t 1 ]; then mode=stream; fi
# The spec reporter by name: Node before 23 reports TAP when its output is not a terminal, and the
# filters below, and the gate reader's paired `test at` lines, are the spec reporter's.
if [ "${1:-}" = node ]; then shift; set -- node --test-reporter=spec "$@"; fi
held=$(mktemp -d) || exit 1
bash test/status.test.sh >"$held/status-80.log" 2>&1 &
narrow=$!
COLS=180 bash test/status.test.sh >"$held/status-180.log" 2>&1 &
wide=$!
rc=0
if [ "$mode" = stream ]; then
  "$@" || rc=$?
else
  log="$held/node.log"
  : >"$log"
  # Interrupted (a gate's time bound, in-temp.sh's TERM, Ctrl-C): what ran so far, before it is removed.
  trap 'echo "suite: interrupted; the log so far:"; grep -v "^[[:space:]]*✔ " "$log"; rm -rf "$held"; exit 130' INT
  trap 'echo "suite: terminated; the log so far:"; grep -v "^[[:space:]]*✔ " "$log"; rm -rf "$held"; exit 143' TERM
  started=$(date +%s)
  echo "suite: node:test running, output held (VERBOSE=1 streams it)"
  "$@" >"$log" 2>&1 || rc=$?
  echo "suite: node:test exited $rc after $(( $(date +%s) - started )) s"
  if [ "$rc" -eq 0 ]; then
    # The summary, the skips and todos with their reasons, and warnings (a test's own `✔` line can
    # name a warning, so those are left out first).
    grep -v "^[[:space:]]*✔ " "$log" | grep -E "^ℹ |^[[:space:]]*﹣ |# (SKIP|TODO)|Warning|^\(node:[0-9]+\)" || true
    echo "slowest tests:"
    # A top-level `✔` line is a top-level test; its duration ends the line.
    sed -n 's/^✔ \(.*\) (\([0-9.]*\)ms)$/\2 \1/p' "$log" | sort -rn | head -5 \
      | awk '{ ms = $1; $1 = ""; printf "  %6.1f s%s\n", ms / 1000, $0 }'
  else
    grep -v "^[[:space:]]*✔ " "$log" || true
  fi
  trap - INT TERM
fi
wait "$narrow" || rc=1
wait "$wide" || rc=1
cat "$held/status-80.log" "$held/status-180.log"
rm -rf "$held"
exit "$rc"

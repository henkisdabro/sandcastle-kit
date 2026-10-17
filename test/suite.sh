#!/usr/bin/env bash
# The whole suite, as `pnpm test` runs it: `bash test/suite.sh <the node:test command>`. The status
# view's scenarios (test/status.test.sh at 80 columns and again at 180, each with its bash32 pass
# where this repository's image has bash32) run beside the command, not before it. They are hundreds
# of serial node starts on one core: run first, they were about half of every test gate's time, and
# a burndown runs that gate one after another on its one gates slot. Their output is held in files
# and printed after the reporter's, so the two never interleave and a `FAIL [` line still reaches
# the gate log. A gate killed at its time bound loses that held output: its own red names the cause.
set -u
held=$(mktemp -d) || exit 1
bash test/status.test.sh >"$held/status-80.log" 2>&1 &
narrow=$!
COLS=180 bash test/status.test.sh >"$held/status-180.log" 2>&1 &
wide=$!
"$@"
rc=$?
wait "$narrow" || rc=1
wait "$wide" || rc=1
cat "$held/status-80.log" "$held/status-180.log"
rm -rf "$held"
exit "$rc"

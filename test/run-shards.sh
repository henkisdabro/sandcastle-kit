#!/usr/bin/env bash
# The test files run as CI runs them (test/shard.ts packs them by weight), but all the shards side
# by side on this machine, for `test/full-check.sh`. Every file runs once. Prints the pass and fail
# counts summed over the shards, then the failing tests (or the tail of a shard that died before
# reporting any); exits 1 when any shard failed. Each shard's output is kept in LOGDIR.
#
#   bash test/run-shards.sh LOGDIR [SHARDS]
#
# SHARDS defaults to FULL_CHECK_SHARDS, else what test/shard-count.sh gives for this machine's
# cores and one pass. SHARD_CONCURRENCY (default 1) is the test
# files each shard runs at once.
set -u
# All the shards' temp files go in one directory that is removed when this ends (test/in-temp.sh),
# also when it is killed. Before the `cd`: LOGDIR may be relative to where this was started.
if [ -z "${SANDCASTLE_TEST_TEMP:-}" ]; then
  self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  SANDCASTLE_TEST_TEMP=1 exec bash "$(dirname "$self")/in-temp.sh" bash "$self" "$@"
fi
cd "$(dirname "$0")/.." || exit 1
dir="${1:?usage: run-shards.sh LOGDIR [SHARDS]}"
mkdir -p "$dir" && rm -f "$dir"/shard-*

n="${2:-${FULL_CHECK_SHARDS:-}}"
[ -n "$n" ] || n=$(bash test/shard-count.sh "" 1)
[ "$n" -ge 1 ] 2>/dev/null || n=1
conc="${SHARD_CONCURRENCY:-1}"

export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
i=1
while [ "$i" -le "$n" ]; do
  (
    files=$(TEST_SHARD="$i/$n" node test/shard.ts) \
      && node --import ./test/hermetic-env.ts --import ./test/no-stray.ts --test --test-timeout=300000 --test-concurrency="$conc" $files
    echo $? >"$dir/shard-$i.status"
  ) >"$dir/shard-$i.log" 2>&1 &
  i=$((i + 1))
done
wait

fail=0
for log in "$dir"/shard-*.log; do
  status=$(cat "${log%.log}.status" 2>/dev/null || echo 1)
  [ "$status" = 0 ] || fail=1
  # A shard that failed without a failing test (a crash, a timeout) has nothing else to show.
  if [ "$status" != 0 ] && ! grep -q "^✖ " "$log"; then
    echo "$(basename "$log") exited $status:"
    tail -20 "$log"
  fi
done
cat "$dir"/shard-*.log | grep -E "^ℹ (pass|fail) " | awk '{ n[$2] += $3 } END { printf "pass %d fail %d\n", n["pass"], n["fail"] }'
cat "$dir"/shard-*.log | grep -E "^✖ " | sort -u | head -20
[ "$fail" = 0 ]

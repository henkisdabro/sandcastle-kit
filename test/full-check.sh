#!/usr/bin/env bash
# Every check a kit change needs before it is pushed, in one place, so it is not retyped after
# each change or run:
#   1. this machine: types, the tests, the tests again under an agent's committer identity, and
#      on macOS the status view under /bin/bash (3.2). Agents' sandboxes are Linux, so BSD tools
#      and the old bash break only here.
#   2. Linux, in a node container: types and the tests, from the files this checkout tracks (a
#      worktree's .git is a pointer the container cannot follow, so git history is not copied).
#   3. the outbound scan of the commits not yet on the base: gitleaks, the personal denylist (the
#      pre-commit hook's rules), and home-directory paths.
# The legs run side by side, not one after another, and the tests in each are CI's weighted shards
# (test/shard.ts, run by test/run-shards.sh): every file still runs once per pass.
# Prints one summary line per step and RESULT: PASS or FAIL; a failure's output is shown, the rest
# kept in a temp directory.
#
# Shards per pass: the cores shared out between the suite passes running at once (macOS, the
# agent identity and, with Docker, Linux), about two cores a shard, 1 to 6 (test/shard-count.sh).
# FULL_CHECK_SHARDS sets the number instead.
#
#   bash test/full-check.sh [base]     # base defaults to origin/main
#   NO_DOCKER=1 bash test/full-check.sh  # skip the Linux step
set -u
cd "$(dirname "$0")/.." || exit 1
base="${1:-origin/main}"
logs=$(mktemp -d)
fail=0
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false

# Each leg is a function that prints its summary lines and returns its status. They all start at
# once, in the background, each into its own file, and the output is printed in a fixed order once
# they are done: the longest leg (the suite, or the Linux container's) sets the wall time, not the
# sum of them. The tests are the files test/shard.ts packs by weight, in shards side by side.

leg_types() {
  pnpm exec tsc --noEmit >"$logs/tsc.log" 2>&1 && echo "tsc: ok" || { echo "tsc: FAIL"; cat "$logs/tsc.log"; return 1; }
}

# The suite as `pnpm test` runs it: the status view's checks, then every test file once.
leg_tests() {
  local rc=0
  bash test/status.test.sh >"$logs/status-view.log" 2>&1 || { rc=1; echo "status view: FAIL"; tail -20 "$logs/status-view.log"; }
  printf 'pnpm test: '
  bash test/run-shards.sh "$logs/test" >"$logs/test.out" 2>&1 || rc=1
  cat "$logs/test.out"
  return "$rc"
}

# The test files again under an agent's committer identity.
leg_agent() {
  printf 'under the agent committer: '
  GIT_COMMITTER_NAME="Sandcastle agent" GIT_COMMITTER_EMAIL=agent@sandcastle.invalid \
    bash test/run-shards.sh "$logs/agent-env" >"$logs/agent-env.out" 2>&1
  local rc=$?
  cat "$logs/agent-env.out"
  return "$rc"
}

leg_bash32() {
  STATUS_BASH=/bin/bash bash test/status.test.sh >"$logs/status.log" 2>&1 && echo "status view on bash 3.2: ok" \
    || { echo "status view on bash 3.2: FAIL"; tail -20 "$logs/status.log"; return 1; }
}

leg_linux() {
  # COPYFILE_DISABLE: macOS tar would add an AppleDouble `._` file beside each one.
  git ls-files -z -co --exclude-standard | COPYFILE_DISABLE=1 tar --null -T - -cf - 2>/dev/null \
    | docker run --rm -i -e FULL_CHECK_SHARDS="$shards" node:24-trixie bash -c '
      set -e
      apt-get update -qq >/dev/null && apt-get install -y -qq jq bsdutils git >/dev/null
      mkdir /w && cd /w && tar -xf -
      git init -q && git add -A
      git config --global user.email t@example.com && git config --global user.name t
      corepack enable >/dev/null 2>&1 && CI=1 pnpm install --frozen-lockfile >/dev/null 2>&1
      pnpm exec tsc --noEmit
      # The host worked out the count against its own cores; the VM may have fewer.
      bash test/status.test.sh >/tmp/status.log 2>&1 || { tail -20 /tmp/status.log; exit 1; }
      [ "$FULL_CHECK_SHARDS" -le "$(nproc)" ] || export FULL_CHECK_SHARDS=$(nproc)
      bash test/run-shards.sh /tmp/shards >/tmp/t.log 2>&1 || { tail -40 /tmp/t.log; exit 1; }
      cat /tmp/t.log' >"$logs/linux.log" 2>&1 \
    && { printf 'pnpm test: '; tail -1 "$logs/linux.log"; } \
    || { echo "FAIL"; tail -60 "$logs/linux.log"; return 1; }
}

# The outbound scan needs no tests, only git: it is quick, and runs beside everything else.
leg_scan() {
  local rc=0
  if ! git rev-parse -q --verify "$base" >/dev/null; then
    echo "no $base to compare with: git fetch first"
    return 1
  fi
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks git --log-opts="$base..HEAD" --redact --no-banner >"$logs/gitleaks.log" 2>&1 && echo "gitleaks: ok" \
      || { rc=1; echo "gitleaks: FAIL"; tail -20 "$logs/gitleaks.log"; }
  else
    rc=1
    echo "gitleaks: not installed"
  fi
  git diff "$base"...HEAD -U0 --no-color | grep '^+' | grep -v '^+++' >"$logs/added.txt" || true
  local deny="${XDG_CONFIG_HOME:-$HOME/.config}/sandcastle-kit/denylist"
  local allow="${XDG_CONFIG_HOME:-$HOME/.config}/sandcastle-kit/allowlist"
  if [ -f "$deny" ]; then
    grep -vE '^[[:space:]]*(#|$)' "$deny" >"$logs/deny" || true
    : >"$logs/allow"
    [ -f "$allow" ] && { grep -vE '^[[:space:]]*(#|$)' "$allow" >"$logs/allow" || true; }
    local hits=""
    [ -s "$logs/deny" ] && hits=$({ if [ -s "$logs/allow" ]; then grep -vEf "$logs/allow"; else cat; fi; } <"$logs/added.txt" | grep -inEf "$logs/deny" || true)
    if [ -n "$hits" ]; then rc=1; echo "denylist: FAIL"; echo "$hits" | head -20; else echo "denylist: ok"; fi
  else
    echo "denylist: none at $deny"
  fi
  # The placeholder homes the docs and tests use are fine; a real one is not.
  local homes
  homes=$(grep -nE '/(Users|home)/[a-z]' "$logs/added.txt" | grep -vE '/home/(user|node|agent)\b' || true)
  if [ -n "$homes" ]; then rc=1; echo "home paths: FAIL"; echo "$homes" | head -20; else echo "home paths: ok"; fi
  return "$rc"
}

start() { # name function: the function's output and status go to $logs/leg-name.{out,status}
  ( "$2" >"$logs/leg-$1.out" 2>&1; echo $? >"$logs/leg-$1.status" ) &
}
# The legs' summary lines in order, and each one's failure in the overall status.
show() {
  cat "$logs/leg-$1.out"
  [ "$(cat "$logs/leg-$1.status")" = 0 ] || fail=1
}

docker_note=""
if [ -n "${NO_DOCKER:-}" ]; then
  docker_note="skipped (NO_DOCKER)"
elif ! docker info >/dev/null 2>&1; then
  docker_note="skipped: Docker is not running"
fi

# Every pass that runs at once, the Linux container's too (its VM takes its cores from this
# machine), counts against the cores: all of them oversubscribed made a loaded machine's tests
# time out. run-shards.sh and the container read the count from FULL_CHECK_SHARDS.
passes=2
[ -n "$docker_note" ] || passes=3
shards="${FULL_CHECK_SHARDS:-$(bash test/shard-count.sh "" "$passes")}"
export FULL_CHECK_SHARDS="$shards"

# The Linux leg is the slowest (an image, an install), so it starts first.
[ -n "$docker_note" ] || start linux leg_linux
start scan leg_scan
start types leg_types
start tests leg_tests
start agent leg_agent
[ "$(uname -s)" != Darwin ] || start bash32 leg_bash32
wait

echo "== $(uname -s)"
show types
show tests
show agent
[ "$(uname -s)" != Darwin ] || show bash32

echo "== Linux"
if [ -n "$docker_note" ]; then echo "$docker_note"; else show linux; fi

echo "== scan of $base..HEAD"
show scan

echo "logs: $logs"
echo "RESULT: $([ "$fail" = 0 ] && echo PASS || echo FAIL)"
exit "$fail"

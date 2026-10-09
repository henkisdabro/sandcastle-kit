#!/usr/bin/env bash
# Every check a kit change needs before it is pushed, in one place, so it is not retyped after
# each change or run:
#   1. this machine: lint, types, the tests, the tests again under an agent's committer identity, and
#      on macOS the status view under /bin/bash (3.2). Agents' sandboxes are Linux, so BSD tools
#      and the old bash break only here.
#   2. Linux, in a node container: lint, types and the tests, from the files this checkout tracks (a
#      worktree's .git is a pointer the container cannot follow, so git history is not copied).
#   3. the outbound scan of the commits not yet on the base: gitleaks, the personal denylist (the
#      pre-commit hook's rules), and home-directory paths.
# The legs run side by side, not one after another, and the tests in each are CI's weighted shards
# (test/shard.ts, run by test/run-shards.sh): every file still runs once per pass.
# Prints one summary line per step and RESULT: PASS or FAIL; a failure's output is shown, the rest
# kept in a temp directory. The log directory is named first, and each leg's name, ok or FAIL and
# seconds go to stderr as it finishes, ahead of the summary: a check takes minutes, and a hung leg
# must not look like a slow one.
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
echo "logs: $logs" >&2
fail=0
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false

# Each leg is a function that prints its summary lines and returns its status. They all start at
# once, in the background, each into its own file, and the output is printed in a fixed order once
# they are done: the longest leg (the suite, or the Linux container's) sets the wall time, not the
# sum of them. The tests are the files test/shard.ts packs by weight, in shards side by side.

leg_lint() {
  pnpm lint >"$logs/lint.log" 2>&1 && echo "lint: ok" || { echo "lint: FAIL"; cat "$logs/lint.log"; return 1; }
}

leg_types() {
  pnpm exec tsc --noEmit >"$logs/tsc.log" 2>&1 && echo "tsc: ok" || { echo "tsc: FAIL"; cat "$logs/tsc.log"; return 1; }
}

# The status view's checks, a leg of their own: run ahead of the test files in one leg, as
# `pnpm test` orders them, they held the shards back and set the whole check's wall time.
leg_view() {
  bash test/status.test.sh >"$logs/status-view.log" 2>&1 && echo "status view: ok" \
    || { echo "status view: FAIL"; tail -20 "$logs/status-view.log"; return 1; }
}

# Every test file once.
leg_tests() {
  printf 'pnpm test: '
  bash test/run-shards.sh "$logs/test" >"$logs/test.out" 2>&1
  local rc=$?
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
      corepack enable >/dev/null 2>&1
      mkdir /w && cd /w && tar -xf - && chown -R node:node /w
      # As the image'"'"'s own non-root user, as CI and every real run are: the kit refuses root
      # (src/runtime.ts), so a root suite fails each `sandcastle run` test and skips the Linux ones.
      exec runuser -u node -- env HOME=/home/node FULL_CHECK_SHARDS="$FULL_CHECK_SHARDS" bash -ec "
        git init -q && git add -A
        git config --global user.email t@example.com && git config --global user.name t
        CI=1 pnpm install --frozen-lockfile >/dev/null 2>&1
        pnpm lint
        pnpm exec tsc --noEmit
        bash test/status.test.sh >/tmp/status.log 2>&1 || { tail -20 /tmp/status.log; exit 1; }
        # The host worked out the count against its own cores; the VM may have fewer.
        [ \"\$FULL_CHECK_SHARDS\" -le \"\$(nproc)\" ] || export FULL_CHECK_SHARDS=\$(nproc)
        bash test/run-shards.sh /tmp/shards >/tmp/t.log 2>&1 || { tail -40 /tmp/t.log; exit 1; }
        cat /tmp/t.log"' >"$logs/linux.log" 2>&1 \
    && { printf 'pnpm test: '; tail -1 "$logs/linux.log"; } \
    || { echo "FAIL"; tail -60 "$logs/linux.log"; return 1; }
}

# The lines of a file that name a real home directory. `home` must start a path, or a repo path
# such as `site/home/index.html` reads as one; macOS's `Users` may sit mid-path, as it does in
# WSL's `/mnt/c/Users` form. The placeholder homes the docs and tests use are fine.
home_paths() {
  grep -nE '(/Users|(^|[^A-Za-z0-9_.-])/home)/[a-z]' "$1" | grep -vE '/home/(user|node|agent)\b' || true
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
  local homes
  homes=$(home_paths "$logs/added.txt")
  if [ -n "$homes" ]; then rc=1; echo "home paths: FAIL"; echo "$homes" | head -20; else echo "home paths: ok"; fi
  return "$rc"
}

# The status is written before the progress line, so a line on screen means the leg is recorded.
# SECONDS is bash's own whole-second counter, which a macOS /bin/bash 3.2 has too (no date +%s%N).
start() { # name function: the function's output and status go to $logs/leg-name.{out,status}
  (
    began=$SECONDS
    "$2" >"$logs/leg-$1.out" 2>&1
    rc=$?
    echo "$rc" >"$logs/leg-$1.status"
    printf '%s: %s (%ss)\n' "$1" "$([ "$rc" = 0 ] && echo ok || echo FAIL)" "$((SECONDS - began))" >&2
  ) &
}
# The legs' summary lines in order, and each one's failure in the overall status.
show() {
  cat "$logs/leg-$1.out"
  [ "$(cat "$logs/leg-$1.status")" = 0 ] || fail=1
}

# `docker info` with 10 s to answer: a daemon that stopped answering held the whole check, silent,
# until the caller gave up. macOS has no timeout(1), so the wait is a loop. 0 answered, 1 refused,
# 2 no answer in time.
docker_answers() {
  docker info >/dev/null 2>&1 &
  local pid=$! i=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$i" -ge 100 ]; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 2
    fi
    sleep 0.1
    i=$((i + 1))
  done
  wait "$pid" || return 1
}

docker_note=""
if [ -n "${NO_DOCKER:-}" ]; then
  docker_note="skipped (NO_DOCKER)"
else
  docker_answers
  case $? in
    1) docker_note="skipped: Docker is not running" ;;
    2) docker_note="skipped: Docker did not answer within 10 s (restart it, or NO_DOCKER=1)" ;;
  esac
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
start lint leg_lint
start types leg_types
start view leg_view
start tests leg_tests
start agent leg_agent
[ "$(uname -s)" != Darwin ] || start bash32 leg_bash32
wait

echo "== $(uname -s)"
show lint
show types
show view
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

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
# Prints one summary line per step and RESULT: PASS or FAIL; a failure's output is shown, the rest
# kept in a temp directory.
#
#   bash test/full-check.sh [base]     # base defaults to origin/main
#   NO_DOCKER=1 bash test/full-check.sh  # skip the Linux step
set -u
cd "$(dirname "$0")/.." || exit 1
base="${1:-origin/main}"
logs=$(mktemp -d)
fail=0
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false

# The pass/fail counts from node's test runner, or the failing tests when there are any.
summary() {
  grep -E "^ℹ (pass|fail) " "$1" | tr '\n' ' '
  echo
  grep -E "^✖ " "$1" | sort -u | head -20
}

echo "== $(uname -s)"
pnpm exec tsc --noEmit >"$logs/tsc.log" 2>&1 && echo "tsc: ok" || { fail=1; echo "tsc: FAIL"; cat "$logs/tsc.log"; }
pnpm test >"$logs/test.log" 2>&1 || fail=1
printf 'pnpm test: '; summary "$logs/test.log"
GIT_COMMITTER_NAME="Sandcastle agent" GIT_COMMITTER_EMAIL=agent@sandcastle.invalid \
  pnpm exec tsx --test test/*.test.ts >"$logs/agent-env.log" 2>&1 || fail=1
printf 'under the agent committer: '; summary "$logs/agent-env.log"
if [ "$(uname -s)" = Darwin ]; then
  STATUS_BASH=/bin/bash bash test/status.test.sh >"$logs/status.log" 2>&1 && echo "status view on bash 3.2: ok" \
    || { fail=1; echo "status view on bash 3.2: FAIL"; tail -20 "$logs/status.log"; }
fi

echo "== Linux"
if [ -n "${NO_DOCKER:-}" ]; then
  echo "skipped (NO_DOCKER)"
elif ! docker info >/dev/null 2>&1; then
  echo "skipped: Docker is not running"
else
  # COPYFILE_DISABLE: macOS tar would add an AppleDouble `._` file beside each one.
  git ls-files -z -co --exclude-standard | COPYFILE_DISABLE=1 tar --null -T - -cf - 2>/dev/null \
    | docker run --rm -i node:24-trixie bash -c '
      set -e
      apt-get update -qq >/dev/null && apt-get install -y -qq jq bsdutils git >/dev/null
      mkdir /w && cd /w && tar -xf -
      git init -q && git add -A
      git config --global user.email t@example.com && git config --global user.name t
      corepack enable >/dev/null 2>&1 && CI=1 pnpm install --frozen-lockfile >/dev/null 2>&1
      pnpm exec tsc --noEmit
      pnpm test >/tmp/t.log 2>&1 || { grep -E "^✖ " /tmp/t.log | sort -u | head -20; tail -40 /tmp/t.log; exit 1; }
      grep -E "^ℹ (pass|fail) " /tmp/t.log | tr "\n" " "; echo' >"$logs/linux.log" 2>&1 \
    && { printf 'pnpm test: '; tail -1 "$logs/linux.log"; } \
    || { fail=1; echo "FAIL"; tail -60 "$logs/linux.log"; }
fi

echo "== scan of $base..HEAD"
if ! git rev-parse -q --verify "$base" >/dev/null; then
  fail=1
  echo "no $base to compare with: git fetch first"
else
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks git --log-opts="$base..HEAD" --redact --no-banner >"$logs/gitleaks.log" 2>&1 && echo "gitleaks: ok" \
      || { fail=1; echo "gitleaks: FAIL"; tail -20 "$logs/gitleaks.log"; }
  else
    fail=1
    echo "gitleaks: not installed"
  fi
  git diff "$base"...HEAD -U0 --no-color | grep '^+' | grep -v '^+++' >"$logs/added.txt" || true
  deny="${XDG_CONFIG_HOME:-$HOME/.config}/sandcastle-kit/denylist"
  allow="${XDG_CONFIG_HOME:-$HOME/.config}/sandcastle-kit/allowlist"
  if [ -f "$deny" ]; then
    grep -vE '^[[:space:]]*(#|$)' "$deny" >"$logs/deny" || true
    : >"$logs/allow"
    [ -f "$allow" ] && { grep -vE '^[[:space:]]*(#|$)' "$allow" >"$logs/allow" || true; }
    hits=""
    [ -s "$logs/deny" ] && hits=$({ if [ -s "$logs/allow" ]; then grep -vEf "$logs/allow"; else cat; fi; } <"$logs/added.txt" | grep -inEf "$logs/deny" || true)
    if [ -n "$hits" ]; then fail=1; echo "denylist: FAIL"; echo "$hits" | head -20; else echo "denylist: ok"; fi
  else
    echo "denylist: none at $deny"
  fi
  # The placeholder homes the docs and tests use are fine; a real one is not.
  homes=$(grep -nE '/(Users|home)/[a-z]' "$logs/added.txt" | grep -vE '/home/(user|node|agent)\b' || true)
  if [ -n "$homes" ]; then fail=1; echo "home paths: FAIL"; echo "$homes" | head -20; else echo "home paths: ok"; fi
fi

echo "logs: $logs"
echo "RESULT: $([ "$fail" = 0 ] && echo PASS || echo FAIL)"
exit "$fail"

#!/usr/bin/env bash
# Runs a command with its own temporary directory as TMPDIR, and removes that directory when the
# command ends - also when this script is interrupted or terminated. Most test files make a
# `sandcastle-*` directory and never remove it, so a test run on the host left tens of thousands of
# them a day; with the whole run's temp files in one directory, one `rm -rf` clears every one.
# package.json's `test` and `test:shard` and test/run-shards.sh run their test files through it.
#
#   bash test/in-temp.sh COMMAND [ARGS...]
#
# The command runs in the background with this script waiting on it, because bash runs a trap only
# once its foreground command has ended: a TERM would otherwise leave the directory until the whole
# suite finished. A TERM or INT stops the command (a background job of a non-interactive shell
# ignores SIGINT, so the TERM from here is what ends it) and cleans up.
# Only mktemp -d with a template is used (the one form GNU and BSD share).
set -u
[ "$#" -ge 1 ] || { echo "usage: in-temp.sh COMMAND [ARGS...]" >&2; exit 2; }

base="${TMPDIR:-/tmp}"
dir=$(mktemp -d "${base%/}/kit-test-run.XXXXXX") || exit 1
pid=""

cleanup() {
  [ -z "$pid" ] || kill "$pid" 2>/dev/null
  rm -rf "$dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

TMPDIR="$dir" "$@" &
pid=$!
wait "$pid"
status=$?
pid=""
exit "$status"

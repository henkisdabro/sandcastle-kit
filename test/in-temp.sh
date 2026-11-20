#!/usr/bin/env bash
# Runs a command with its own temporary directory as TMPDIR, and removes that directory when the
# command ends - also when this script is interrupted or terminated. Most test files make a
# `sandcastle-*` directory and never remove it, so a test run on the host left tens of thousands of
# them a day; with the whole run's temp files in one directory, one `rm -rf` clears every one.
# package.json's `test`, `test:shard` and `test:weights`, and test/run-shards.sh, run their test files through it.
#
#   bash test/in-temp.sh COMMAND [ARGS...]
#
# The command runs in the background with this script waiting on it, because bash runs a trap only
# once its foreground command has ended: a TERM would otherwise leave the directory until the whole
# suite finished. A TERM or INT stops the command and cleans up: a TERM goes to the command's
# process group - every process it started, the shards' test processes included, not only the
# command itself - and the directory is removed once that group is empty. A process that starts a
# session of its own (a detached run) is outside the group and outlives it.
# Only mktemp -d with a template is used (the one form GNU and BSD share).
#
# A leak gate: a run that ends normally fails (status 1, the paths on stderr) when it left anything in that
# directory - every test file's process removes its own (test/hermetic-env.ts), so a leftover is a process that
# was killed or wrote after its removal - or when a `sandcastle-*` entry that was not there before appeared in
# the outer temp directory or /tmp: something escaped TMPDIR (a hard-coded /tmp, a child started without
# TMPDIR). Another process on the machine making one meanwhile (a live run's) shows up too; the message says so.
set -u
[ "$#" -ge 1 ] || { echo "usage: in-temp.sh COMMAND [ARGS...]" >&2; exit 2; }

base="${TMPDIR:-/tmp}"
dir=$(mktemp -d "${base%/}/kit-test-run.XXXXXX") || exit 1
pid=""

# The `sandcastle-*` entries in the outer temp directories, one path per line, sorted.
outer() {
  for d in "${base%/}" /tmp; do
    [ -d "$d" ] && ls -A "$d" 2>/dev/null | grep '^sandcastle-' | sed "s|^|$d/|"
  done | sort -u
}
before=$(outer)

cleanup() {
  if [ -n "$pid" ]; then
    # The command's whole process group (set -m below): a TERM to the command alone left the
    # shards and their test processes running against a removed TMPDIR. The directory goes
    # once they are gone, so a dying process cannot recreate it; KILL for one that ignores TERM.
    # In a container whose PID 1 reaps nothing (a project image whose ENTRYPOINT replaces the
    # base image's tini, or a process exec'd in place of the shell), an orphan's zombie keeps the
    # group alive, so the wait runs its full five seconds there: slow, but nothing is left running.
    kill -TERM -- -"$pid" 2>/dev/null
    i=0
    while kill -0 -- -"$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
    kill -KILL -- -"$pid" 2>/dev/null
  fi
  rm -rf "$dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Job control for this one command: it starts in a process group of its own, which cleanup can
# signal as a whole. Off again at once: with it on, every foreground command would take a group
# and the terminal. The explicit </dev/null keeps what bash gives a background command without
# job control; with it, the command would inherit this script's stdin, and in a terminal a read
# from it would stop the command (SIGTTIN).
set -m
TMPDIR="$dir" "$@" </dev/null &
pid=$!
set +m
wait "$pid"
status=$?
pid=""
left=$(ls -A "$dir")
new=$(outer)
# Each line of $before is one fixed pattern, matched as a whole line.
[ -z "$before" ] || new=$(printf '%s\n' "$new" | grep -Fxv -e "$before")
if [ -n "$left$new" ]; then
  {
    echo "in-temp.sh: this test run leaked temp files."
    [ -z "$left" ] || { echo "Left in the run's own temp directory (a test file's process did not remove its own):"; echo "$left" | sed "s|^|  $dir/|" | head -20; }
    [ -z "$new" ] || { echo "New in the machine's temp directory (escaped TMPDIR, or made by another process meanwhile):"; echo "$new" | sed 's/^/  /' | head -20; }
  } >&2
  [ "$status" -ne 0 ] || status=1
fi
exit "$status"

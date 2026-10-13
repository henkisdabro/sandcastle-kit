#!/bin/sh
# `gh "$@"`, retried on a GitHub 5xx or a timeout. A prompt's ticket reads (`gh issue view N`, with
# or without `--comments`) run through it, so a moment of GitHub's trouble is not a crashed ticket.
# A 4xx (not found, no access) or any other failure ends at once, with gh's own words on stderr and
# its exit code. Three tries; the waits before the second and the third are RETRY_WAITS.
#
# Sandcastle gives a prompt's shell expression 30 s in all, and the library's constant is not ours
# to raise: the waits are short enough that the last try still has most of that window.

RETRY_WAITS="5 12"

for pause in 0 $RETRY_WAITS; do
  [ "$pause" = 0 ] || sleep "$pause"
  # gh's stdout goes straight through (fd 3); only its stderr is kept, to be read for the cause.
  if { err=$(gh "$@" 2>&1 1>&3 3>&-); } 3>&1; then exit 0; else rc=$?; fi
  case $err in
    *"HTTP 5"[0-9][0-9]* | *[Tt]imeout* | *"timed out"* | *"deadline exceeded"*) ;;
    *) break ;;
  esac
done
printf '%s\n' "$err" >&2
exit "$rc"

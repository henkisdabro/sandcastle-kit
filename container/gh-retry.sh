#!/bin/sh
# `gh "$@"`, retried on a GitHub 5xx or a timeout. A prompt's ticket reads (`gh issue view N`, with
# or without `--comments`) run through it, so a moment of GitHub's trouble is not a crashed ticket.
# A 4xx (not found, no access) or any other failure ends at once, with gh's own words on stderr and
# its exit code. Three tries; the waits before the second and the third are RETRY_WAITS.
#
# Sandcastle gives a prompt's shell expression 120 s in all (the kit's pnpm patch raises its 30 s):
# a GitHub incident's 5xx often outlasts a few seconds, and the waits leave the three tries 60 s.

RETRY_WAITS="15 45"

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

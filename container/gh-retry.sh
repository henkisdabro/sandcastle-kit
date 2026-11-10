#!/bin/sh
# `gh "$@"`, retried on a GitHub 5xx or a timeout. A prompt's ticket reads (`gh issue view N`, and
# comments-view.sh's `gh api` calls) run through it, so a moment of GitHub's trouble is not a crashed ticket.
# A 4xx (not found, no access) or any other failure ends at once, with gh's own words on stderr and
# its exit code. Three tries; the waits before the second and the third are RETRY_WAITS.
#
# Sandcastle gives a prompt's shell expression 120 s in all (the kit's pnpm patch raises its 30 s):
# a GitHub incident's 5xx often outlasts a few seconds, and the waits leave the three tries 60 s.
# A caller that makes more than one read in one expression sets GH_RETRY_UNTIL (epoch seconds), and
# a wait that would end past it is not taken: the reads share the 120 s instead of each taking 60.

RETRY_WAITS="15 45"

out=$(mktemp) || exit
trap 'rm -f "$out"' EXIT

for pause in 0 $RETRY_WAITS; do
  if [ "$pause" != 0 ]; then
    [ -z "${GH_RETRY_UNTIL:-}" ] || [ $(($(date +%s) + pause)) -lt "$GH_RETRY_UNTIL" ] || break
    sleep "$pause"
  fi
  # Each try's stdout is held and printed only when the try succeeds: gh prints an HTTP error's body
  # to stdout, so a failed try passed straight through would leave `{"message":"Server Error"}` (or a
  # 502's HTML) ahead of the good answer, and a reader parsing it as JSON would fail on a retry that worked.
  if err=$(gh "$@" 2>&1 >"$out"); then cat "$out"; exit 0; else rc=$?; fi
  case $err in
    *"HTTP 5"[0-9][0-9]* | *[Tt]imeout* | *"timed out"* | *"deadline exceeded"*) ;;
    *) break ;;
  esac
done
printf '%s\n' "$err" >&2
exit "$rc"

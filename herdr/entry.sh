#!/bin/sh
# Every command of the Herdr plugin (herdr-plugin.toml) starts here. Herdr runs it as
# argv, with no shell around it: from this directory for an action or hook, from the
# project for a pane. The pagers stay in shell; the rest is `sandcastle herdr <verb>`.
kit=$(cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")}/.." && pwd)
# A pager here shows what agents wrote: no shell escape, no editor, no input preprocessor.
export LESSSECURE=1
case "${1:-}" in
  # Refreshed every 5 seconds; q or Esc closes the overlay.
  status) SANDCASTLE_STATUS_KEYS=1 exec "$kit/bin/sandcastle" status 5 ;;
  # less -X: in a Herdr 0.9.3 popup, a pager that switches to the alternate screen stayed
  # blank until a key was pressed. The popup closes with less, so nothing is left behind.
  report) "$kit/bin/sandcastle" report 2>&1 | less -R -X ;;
  # From the end, where the agent is, once the log is longer than the popup (a short one
  # jumped to the end sat at the bottom of an empty popup). F follows it live.
  log)
    rows=$(stty size 2>/dev/null | cut -d' ' -f1)
    if [ "$(wc -l <"$SANDCASTLE_LOG")" -gt "${rows:-40}" ]; then exec less -R -X +G "$SANDCASTLE_LOG"; fi
    exec less -R -X "$SANDCASTLE_LOG" ;;
  *) exec "$kit/bin/sandcastle" herdr "$@" ;;
esac

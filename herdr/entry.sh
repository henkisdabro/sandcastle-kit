#!/bin/sh
# Every command of the Herdr plugin (herdr-plugin.toml) starts here. Herdr runs it as
# argv, with no shell around it: from this directory for an action or hook, from the
# project for a pane. The pagers stay in shell; the rest is `sandcastle herdr <verb>`.
here="${HERDR_PLUGIN_ROOT:-$(dirname "$0")}"
kit=$(cd "$here/.." && pwd)
# Herdr hands a plugin its server's environment, not a login shell's: a Herdr started at
# login by launchd or systemd has no node on PATH. Once, through the user's login shell.
if ! command -v node >/dev/null 2>&1 && [ -z "${SANDCASTLE_LOGIN_PATH:-}" ]; then
  SANDCASTLE_LOGIN_PATH=1 exec "${SHELL:-/bin/sh}" -lc 'exec "$0" "$@"' "$here/entry.sh" "$@"
fi
# A pager here shows what agents wrote: no shell escape, no editor, no input preprocessor.
export LESSSECURE=1
case "${1:-}" in
  # Refreshed every 5 seconds; q or Esc closes the overlay.
  status) SANDCASTLE_STATUS_KEYS=1 exec "$kit/bin/sandcastle" status 5 ;;
  # less -X: in a Herdr 0.9.3 popup, plain less (and less +G) stayed blank until a key was
  # pressed, every time; with -X, no terminal set-up, it draws at once. The status view's own
  # full-screen drawing is fine there, so the cause is narrower than that. The popup closes
  # with less, so nothing is left behind.
  report) "$kit/bin/sandcastle" report 2>&1 | less -R -X ;;
  # Follows the log live, like tail -f, once it is longer than the popup: +F opens at the end
  # and shows new lines as the agent writes them. While following, less ignores q and takes
  # only Ctrl-C, which stops the following - so -K makes Ctrl-C close the popup outright:
  # Ctrl-C closes it (q closes it too when it is not following; Esc is a prefix key in less).
  # A log shorter than the popup keeps the plain view, from its top line: +F, like +G, jumps
  # to the end first, and a short file jumped to the end sat at the bottom of an empty
  # popup. (Chosen for that reason; less was not at hand to prove +F differs.)
  log)
    rows=$(stty size 2>/dev/null | cut -d' ' -f1)
    if [ "$(wc -l <"$SANDCASTLE_LOG")" -gt "${rows:-40}" ]; then exec less -R -X -K +F "$SANDCASTLE_LOG"; fi
    exec less -R -X "$SANDCASTLE_LOG" ;;
  *) exec "$kit/bin/sandcastle" herdr "$@" ;;
esac

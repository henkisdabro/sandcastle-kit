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
# The pager's prompt line ("Waiting for data..." while following) is drawn in standout. A
# LESS_TERMCAP_so from the user's shell colours it for their own pages, and in a popup over
# another theme that came out yellow on light blue, unreadable; the terminal's own standout
# (reverse video) reads on any theme.
unset LESS_TERMCAP_so LESS_TERMCAP_se
# What the pager's prompt line says, so a person never has to guess the key (plain words,
# and none of less's prompt metacharacters: % ? : . \). -Ps replaces less's own prompt, which
# names the file and the position and not the keys. -Pw replaces the "Waiting for data" that
# less draws while following (less 376 on); less still appends its own "... (interrupt to
# abort)", which no option changes, so the words before it name Ctrl-C.
paged="-Psq closes this popup - F follows new lines (Ctrl-C then closes it)"
following="-PwFollowing new lines - Ctrl-C closes this popup"
report_prompt="-Psq closes this popup - space pages down"
case "${1:-}" in
  # Refreshed every 5 seconds; q or Esc closes the overlay.
  status) SANDCASTLE_STATUS_KEYS=1 exec "$kit/bin/sandcastle" status 5 ;;
  # less -X: in a Herdr 0.9.3 popup, plain less (and less +G) stayed blank until a key was
  # pressed, every time; with -X, no terminal set-up, it draws at once. The status view's own
  # full-screen drawing is fine there, so the cause is narrower than that. The popup closes
  # with less, so nothing is left behind.
  report) "$kit/bin/sandcastle" report 2>&1 | less -R -X "$report_prompt" ;;
  # Follows the log live, like tail -f, once it is longer than the popup: +F opens at the end
  # and shows new lines as the agent writes them. While following, less ignores q and takes
  # only Ctrl-C, which stops the following - so -K makes Ctrl-C close the popup outright:
  # Ctrl-C closes it (q closes it too when it is not following). -K is on the short route
  # too, where F starts the following, so the prompt's "Ctrl-C then closes it" holds on
  # both, and Ctrl-C closes a paged log as well. Esc cannot close either view
  # through less: it reads no key but Ctrl-C while following, and holds a lone Esc back as the
  # start of a key sequence while paging.
  # A log shorter than the popup keeps the plain view, from its top line: +F, like +G, jumps
  # to the end first, and a short file jumped to the end sat at the bottom of an empty
  # popup. (Chosen for that reason; less was not at hand to prove +F differs.)
  log)
    rows=$(stty size 2>/dev/null | cut -d' ' -f1)
    if [ "$(wc -l <"$SANDCASTLE_LOG")" -gt "${rows:-40}" ]; then exec less -R -X -K "$paged" "$following" +F "$SANDCASTLE_LOG"; fi
    exec less -R -X -K "$paged" "$following" "$SANDCASTLE_LOG" ;;
  *) exec "$kit/bin/sandcastle" herdr "$@" ;;
esac

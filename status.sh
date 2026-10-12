#!/usr/bin/env bash
# Live view of a Sandcastle run. Sandcastle ships no UI - this reads the artefacts it does leave
# behind: log files, worktrees, branches, containers. The view is src/status-view.ts (ADR 0003); this
# file only starts it, so the commands that name `status.sh` (`sandcastle status`, the Herdr popup, a
# pane left open by an older kit) keep working.
#
#   sandcastle status               refresh every 10s, from a project root
#   sandcastle status 0             print once and exit, every row
#   sandcastle status 10 all        refresh, every row even past the pane
#
# The CLI sets SANDCASTLE_PROJECT, SANDCASTLE_NAME and SANDCASTLE_BASE from the project's
# .sandcastle/config.ts. `exec`, so the pane's command line names status-view.ts, which Herdr looks for
# (src/herdr.ts); the flags are bin/sandcastle's.
set -uo pipefail
kit="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --no-maglev --no-concurrent-sparkplug --import "$kit/src/node-check.mjs" "$kit/src/status-view.ts" "$@"

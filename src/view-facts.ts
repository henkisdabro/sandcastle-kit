// What both terminal hosts' views share (src/herdr.ts for Herdr 1, src/herdr-core.ts for herdr-core): a run's
// tickets counted in the status view's groups, the line that says so, and what a terminal's foreground command
// is. Pure and light: the status view imports it through src/herdr-core.ts, and must not load the run's modules.

import { basename } from "node:path";
import { GROUPS, type TicketRecord } from "../mod/hooks/run-record.ts";

// A run's tickets counted in the status view's own groups (`ticketRows`, src/status-rows.ts), so the
// sidebar never says "needs you" about a ticket the view shows as fine, or the other way.
// `paused` is present (true) only for a run a person has paused: the tickets still finishing are not
// "working" then, the run is held.
export type RunCounts = { working: number; needsYou: number; merged: number; total: number; paused?: true };
export const runCounts = (tickets: Record<string, TicketRecord>, paused = false): RunCounts => {
  // A ticket with no state, or one the guard dropped, is in the "other" group: counted in the total only.
  const groups = Object.values(tickets).map((t) => (t.state ? GROUPS[t.state] : "other"));
  return {
    working: groups.filter((g) => g === "working").length,
    needsYou: groups.filter((g) => g === "needs you").length,
    merged: groups.filter((g) => g === "merged").length,
    total: groups.length,
    ...(paused ? { paused: true as const } : {}),
  };
};

// What needs you first, as that is why anyone looks; then that the run is paused, which "N working" would not say.
export const progress = (c: RunCounts) => `${c.merged}/${c.total}` + (c.needsYou ? ` · ${c.needsYou} needs you` : c.paused ? " · paused" : c.working ? ` · ${c.working} working` : "");

// The status view by its command line: `node ... src/status-view.ts 10`, which status.sh `exec`s in its place - or
// `bash .../status.sh 10`, a pane an older kit left open. Pane reuse, the dead tab and the restart all go by it.
const STATUS_VIEW_FILES = ["status.sh", "status-view.ts"];
export const showsStatus = (cmdlines: string[]) => cmdlines.some((c) => STATUS_VIEW_FILES.some((file) => c.includes(file)));

// A pane's foreground is a bare shell: one process, a known shell's name, and at most the flags
// that make it a login or interactive shell. `bash status.sh`, `claude`, `vim` and a REPL are not,
// and neither is a pane with no foreground process the host can name.
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]);
const SHELL_FLAGS = new Set(["-l", "-i", "--login", "--interactive"]);
export const bareShell = (cmdlines: string[]) => {
  if (cmdlines.length !== 1) return false;
  const [command, ...flags] = cmdlines[0].trim().split(/\s+/);
  return SHELLS.has(basename(command.replace(/^-/, ""))) && flags.every((f) => SHELL_FLAGS.has(f));
};

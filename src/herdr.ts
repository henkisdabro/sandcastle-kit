// Herdr integration: the status pane's helpers, and a per-sandbox view.
//
// Herdr recognises agents by the process in a pane, and a sandbox agent runs
// in a container with no terminal - Herdr cannot see it. But the orchestrator
// knows exactly what each sandbox is doing, and Herdr takes that as a report
// (`pane report-agent`). So a run opens a tab with one pane per concurrent
// sandbox, each tailing its issue's current log, and reports the phase: the
// sidebar then shows every sandbox as a working, blocked or done agent.
//
// Where: a run started alone in its own tab (the skill makes one) adopts that
// tab - the run's output, the status view and the sandboxes side by side.
// Started anywhere else, it makes a tab of its own, whose first pane is the
// status view, and adds nothing to the tab it was launched from. When the run
// ends its sandbox panes close, so no sidebar entry outlives it; the status
// view stays.
//
// Herdr (0.9.2+) clears a reported agent once its pane is back at an idle
// shell. So a pane runs one `tail -F` for its whole life, on a symlink the
// phases repoint: restarting the tail would drop the shell to idle between
// phases and wipe the sandbox from the sidebar.
//
// All of it is a convenience: outside Herdr, or with SANDCASTLE_HERDR_VIEW=0,
// or on any herdr error, it does nothing and the run carries on.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./config.ts";
import { KIT } from "./sandbox.ts";

// stderr is captured, not inherited: herdr reports errors there as JSON
// (a closed pane is `pane_not_found`), which must not leak into the run.
export const herdr = (args: string[]) =>
  execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
export const herdrJson = (args: string[]) => JSON.parse(herdr(args));
export const IN_HERDR = process.env.HERDR_ENV === "1";

// This kit's own entry, not whichever `sandcastle` PATH finds first: a second
// checkout (a branch under test, say) would otherwise run with the other
// checkout's status view.
export const STATUS_COMMAND = `"${KIT}/bin/sandcastle" status`;

// Where the status pane opened beside the caller is recorded (run.ts).
export const statusPaneRecord = (project: Project) => join(project.root, ".sandcastle/logs/status-pane");
export const runsStatus = (pane: string) =>
  (herdrJson(["pane", "process-info", "--pane", pane]).result.process_info.foreground_processes as { cmdline: string }[]).some((p) =>
    p.cmdline.includes("status.sh"),
  );

// Herdr labels a new tab with a bare number; any other label is the operator's. One such ('sandcastle <project> run 4') was overwritten, leaving several tabs with one name.
export const defaultTabLabel = (label: string | undefined) => !label || /^\d+$/.test(label.trim());

type Slot = { pane: string; issue?: string; closed?: boolean };
export type SandboxView = {
  /** The status view's pane; undefined when this view is off and the caller opens one. */
  status?: string;
  tab?: string;
  /** An issue's pipeline starts: it takes a free pane. */
  claim(issue: string, title: string): void;
  /** A timed phase starts. */
  phase(issue: string, phase: string): void;
  /** The pipeline ended; the pane keeps the final state until reused, or closes when `release` (nothing left to start). */
  finish(issue: string, outcome: string, release?: boolean): void;
  /** Landing decided the issue's fate; shown if its pane still shows it. */
  landed(issue: string, ok: boolean, outcome: string): void;
  /** The run ended: a notification with the summary. */
  close(summary: string): void;
};

const NONE: SandboxView = { claim() {}, phase() {}, finish() {}, landed() {}, close() {} };
const SOURCE = "sandcastle-kit";

// Phase -> the sandbox.run name its log is written under (burndown.ts).
// Gates have one too: the orchestrator writes their output as it arrives
// (burndown.ts), so a pane shows the test run instead of the review's last words.
const LOG = { implement: "impl", review: "review", "cross-review": "review-codex", repair: "repair", gates: "gates" } as const;

export const openSandboxView = (project: Project, panes: number, ref: (id: string) => string): SandboxView => {
  if (!IN_HERDR || process.env.SANDCASTLE_HERDR_VIEW === "0" || panes < 1) return NONE;
  const logs = join(project.root, ".sandcastle/logs");
  const record = join(logs, "herdr-view.json");
  let failed = false;
  // One warning, then silence: a broken view must not flood the run's output.
  const safe = <T>(fn: () => T): T | undefined => {
    if (failed) return undefined;
    try {
      return fn();
    } catch (error) {
      failed = true;
      console.log(`Herdr sandbox view off for this run (${String((error as { stderr?: string }).stderr ?? error).trim().slice(0, 160)}).`);
      return undefined;
    }
  };

  const mine = process.env.HERDR_PANE_ID;
  const me = safe(() => (mine ? (herdrJson(["pane", "get", mine]).result.pane as { tab_id: string; workspace_id: string }) : undefined));
  if (failed) return NONE;
  const myTab = me?.tab_id;

  // A previous run's view is replaced, not stacked. Only ids from our own
  // record are closed, and never the pane this run is typed in: a tab the
  // kit made goes whole, an adopted tab keeps its run pane.
  if (existsSync(record)) {
    try {
      const old = JSON.parse(readFileSync(record, "utf8")) as { tab?: string; panes?: string[]; status?: string; adopted?: boolean };
      if (old.tab && !old.adopted && old.tab !== myTab) {
        herdr(["tab", "close", old.tab]);
      } else {
        for (const pane of [...(old.panes ?? []), ...(old.status ? [old.status] : [])]) {
          if (pane === mine) continue;
          try {
            herdr(["pane", "close", pane]);
          } catch {
            /* already closed */
          }
        }
      }
    } catch {
      /* already closed */
    }
  }

  // Alone in its tab: adopt it. The status view splits off the run's pane.
  const myTabInfo = safe(() => (myTab ? (herdrJson(["tab", "get", myTab]).result.tab as { pane_count: number; label?: string }) : undefined));
  if (failed) return NONE;
  const alone = myTabInfo?.pane_count === 1;
  let tab: string;
  let statusPane: string;
  if (alone && mine && myTab) {
    const wide = (safe(() => (herdrJson(["pane", "layout", "--pane", mine]).result.layout.panes as { pane_id: string; rect: { width: number } }[])
      .find((p) => p.pane_id === mine)?.rect.width) ?? 0) >= 160;
    const split = safe(() => herdrJson(["pane", "split", mine, "--direction", wide ? "right" : "down", "--cwd", project.root, "--no-focus"]));
    if (!split) return NONE;
    tab = myTab;
    statusPane = split.result.pane.pane_id as string;
    safe(() => {
      if (defaultTabLabel(myTabInfo?.label)) herdr(["tab", "rename", tab, `sandcastle ${project.name}`]);
      herdr(["pane", "rename", mine, `sandcastle run ${project.name}`]);
    });
  } else {
    // The run's own workspace, never Herdr's default (the focused one): the
    // user has often moved elsewhere by the time the view opens.
    const workspace = me?.workspace_id ?? process.env.HERDR_WORKSPACE_ID;
    const created = safe(() =>
      herdrJson([
        "tab", "create", ...(workspace ? ["--workspace", workspace] : []), "--label", `sandcastle ${project.name}`,
        "--cwd", project.root, "--no-focus",
      ]),
    );
    if (!created) return NONE;
    tab = created.result.tab.tab_id as string;
    statusPane = created.result.root_pane.pane_id as string;
  }
  // Pane-log links left by an earlier run point at logs since archived, and
  // one past this run's pane count would never be repointed.
  for (const f of readdirSync(logs)) if (/^herdr-pane-\d+\.log$/.test(f)) rmSync(join(logs, f), { force: true });
  const adopted = tab === myTab;
  const slots: Slot[] = [];
  const save = () => writeFileSync(record, JSON.stringify({ tab, adopted, status: statusPane, panes: slots.filter((s) => !s.closed).map((s) => s.pane) }) + "\n");
  save();
  if (!safe(() => {
    herdr(["pane", "rename", statusPane, `sandcastle status ${project.name}`]);
    herdr(["pane", "run", statusPane, STATUS_COMMAND]);
    return true;
  })) return NONE;
  // A status pane an earlier kit version opened in the user's own tab is now
  // a second copy. Closed only while it still shows the status view.
  const old = statusPaneRecord(project);
  if (existsSync(old)) {
    try {
      const pane = readFileSync(old, "utf8").trim();
      if (pane !== statusPane && runsStatus(pane)) herdr(["pane", "close", pane]);
    } catch {
      /* already gone */
    }
    unlinkSync(old);
  }
  const linkName = (pane: string) => `herdr-pane-${slots.findIndex((s) => s.pane === pane)}.log`;
  const link = (pane: string) => join(logs, linkName(pane));
  const follow = (pane: string, log: string) => {
    rmSync(link(pane), { force: true });
    symlinkSync(log, link(pane));
  };
  const addSlot = (pane: string) => {
    slots.push({ pane });
    save();
    // A link left by an earlier run would replay that run's log.
    follow(pane, "none.log");
    // Relative to the pane's cwd (the project root), so no path needs quoting.
    herdr(["pane", "run", pane, `tail -n 40 -F .sandcastle/logs/${linkName(pane)}`]);
    return slots[slots.length - 1];
  };

  // Herdr ignores a report older than the last one it took for the pane.
  let n = 0;
  const seq = () => String(Date.now() * 1000 + (n++ % 1000));
  const report = (pane: string, state: "working" | "blocked" | "idle", message: string, title: string) => {
    herdr(["pane", "report-agent", pane, "--source", SOURCE, "--agent", "sandcastle", "--state", state, "--message", message, "--seq", seq()]);
    herdr(["pane", "report-metadata", pane, "--source", SOURCE, "--agent", "sandcastle", "--title", title, "--display-agent", "sandbox"]);
  };
  const slotOf = (issue: string) => slots.find((s) => s.issue === issue);
  // Which issue each pane showed last: a landing result may only update the
  // pane if no later issue has taken it over since.
  const shownBy = new Map<string, string>();

  // Reported states outlive the process: a finished run's panes went on
  // saying "blocked" in the sidebar an hour later. The sandbox panes close
  // with the run - the outcomes are in the report and the status view.
  process.on("exit", () => {
    for (const s of slots.filter((s) => !s.closed)) {
      rmSync(link(s.pane), { force: true });
      try {
        herdr(["pane", "close", s.pane]);
      } catch {
        /* already closed */
      }
    }
    slots.length = 0;
    try {
      save();
    } catch {
      /* best effort */
    }
  });

  return {
    status: statusPane,
    tab,
    claim(issue, title) {
      safe(() => {
        let slot = slots.find((s) => s.issue === undefined && !s.closed);
        const open = slots.filter((s) => !s.closed);
        if (!slot && open.length < panes) {
          // Sandboxes stack to the right of the status view. From an open
          // pane: one that waited for a machine-wide slot starts after the
          // queue looked empty and its neighbours' panes closed, and a split
          // from a closed pane turned the whole view off.
          const [from, direction] = open.length ? [open[open.length - 1].pane, "down"] : [statusPane, "right"];
          const pane = herdrJson(["pane", "split", from, "--direction", direction, "--cwd", project.root, "--no-focus"])
            .result.pane.pane_id as string;
          slot = addSlot(pane);
        }
        if (!slot) return;
        slot.issue = issue;
        shownBy.set(slot.pane, issue);
        herdr(["pane", "rename", slot.pane, `${ref(issue)} ${title}`.slice(0, 60)]);
        report(slot.pane, "working", "setup", `${ref(issue)} setup`);
      });
    },
    phase(issue, phase) {
      const slot = slotOf(issue);
      if (!slot) return;
      safe(() => {
        report(slot.pane, "working", phase, `${ref(issue)} ${phase}`);
        const name = LOG[phase as keyof typeof LOG];
        if (!name) return; // setup has no log of its own
        follow(slot.pane, `agent-issue-${issue}-${name}-${issue}.log`);
      });
    },
    finish(issue, outcome, release) {
      const slot = slotOf(issue);
      if (!slot) return;
      slot.issue = undefined;
      if (release) {
        // Nothing will reuse it. Left open it showed a finished agent's last
        // words for the rest of the run, and five of them read as five stuck
        // sandboxes; the status view has the outcome.
        slot.closed = true;
        shownBy.delete(slot.pane);
        rmSync(link(slot.pane), { force: true });
        safe(() => herdr(["pane", "close", slot.pane]));
        save();
        return;
      }
      // Herdr's "blocked" means "needs your input". A red branch is a
      // finished result, read from the report; a crash is not.
      safe(() => report(slot.pane, outcome === "crashed" ? "blocked" : "idle", outcome, `${ref(issue)} ${outcome}`));
    },
    /** `ok` false: a human has to act - a conflict, a failed landing, a held branch. */
    landed(issue, ok, outcome) {
      const pane = [...shownBy].find(([, shown]) => shown === issue)?.[0];
      if (pane) safe(() => report(pane, ok ? "idle" : "blocked", outcome, `${ref(issue)} ${outcome}`));
    },
    close(summary) {
      safe(() => herdr(["notification", "show", `Sandcastle ${project.name}`, "--body", summary, "--sound", "done"]));
    },
  };
};

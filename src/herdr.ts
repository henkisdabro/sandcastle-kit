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
import { existsSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

type Slot = { pane: string; issue?: number };
export type SandboxView = {
  /** The status view's pane; undefined when this view is off and the caller opens one. */
  status?: string;
  tab?: string;
  /** An issue's pipeline starts: it takes a free pane. */
  claim(issue: number, title: string): void;
  /** A timed phase starts. */
  phase(issue: number, phase: string): void;
  /** The pipeline ended; the pane keeps the final state until reused. */
  finish(issue: number, outcome: string): void;
  /** Landing decided the issue's fate; shown if its pane still shows it. */
  landed(issue: number, ok: boolean, outcome: string): void;
  /** The run ended: a notification with the summary. */
  close(summary: string): void;
};

const NONE: SandboxView = { claim() {}, phase() {}, finish() {}, landed() {}, close() {} };
const SOURCE = "sandcastle-kit";

// Phase -> the sandbox.run name its log is written under (burndown.ts).
const LOG = { implement: "impl", review: "review", "cross-review": "review-codex", repair: "repair" } as const;

export const openSandboxView = (project: Project, panes: number): SandboxView => {
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
  const myTab = safe(() => (mine ? (herdrJson(["pane", "get", mine]).result.pane.tab_id as string) : undefined));
  if (failed) return NONE;

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
  const alone = safe(() => !!myTab && herdrJson(["tab", "get", myTab]).result.tab.pane_count === 1);
  if (failed) return NONE;
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
      herdr(["tab", "rename", tab, `sandcastle ${project.name}`]);
      herdr(["pane", "rename", mine, `sandcastle run ${project.name}`]);
    });
  } else {
    const created = safe(() =>
      herdrJson([
        "tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID ?? "", "--label", `sandcastle ${project.name}`,
        "--cwd", project.root, "--no-focus",
      ]),
    );
    if (!created) return NONE;
    tab = created.result.tab.tab_id as string;
    statusPane = created.result.root_pane.pane_id as string;
  }
  const adopted = tab === myTab;
  const slots: Slot[] = [];
  const save = () => writeFileSync(record, JSON.stringify({ tab, adopted, status: statusPane, panes: slots.map((s) => s.pane) }) + "\n");
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
  const slotOf = (issue: number) => slots.find((s) => s.issue === issue);
  // Which issue each pane showed last: a landing result may only update the
  // pane if no later issue has taken it over since.
  const shownBy = new Map<string, number>();

  // Reported states outlive the process: a finished run's panes went on
  // saying "blocked" in the sidebar an hour later. The sandbox panes close
  // with the run - the outcomes are in the report and the status view.
  process.on("exit", () => {
    for (const s of slots) {
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
        let slot = slots.find((s) => s.issue === undefined);
        if (!slot && slots.length < panes) {
          // Sandboxes stack to the right of the status view.
          const [from, direction] = slots.length ? [slots[slots.length - 1].pane, "down"] : [statusPane, "right"];
          const pane = herdrJson(["pane", "split", from, "--direction", direction, "--cwd", project.root, "--no-focus"])
            .result.pane.pane_id as string;
          slot = addSlot(pane);
        }
        if (!slot) return;
        slot.issue = issue;
        shownBy.set(slot.pane, issue);
        herdr(["pane", "rename", slot.pane, `#${issue} ${title}`.slice(0, 60)]);
        report(slot.pane, "working", "setup", `#${issue} setup`);
      });
    },
    phase(issue, phase) {
      const slot = slotOf(issue);
      if (!slot) return;
      safe(() => {
        report(slot.pane, "working", phase, `#${issue} ${phase}`);
        const name = LOG[phase as keyof typeof LOG];
        if (!name) return; // gates and setup have no agent log of their own
        follow(slot.pane, `agent-issue-${issue}-${name}-${issue}.log`);
      });
    },
    finish(issue, outcome) {
      const slot = slotOf(issue);
      if (!slot) return;
      // Herdr's "blocked" means "needs your input". A red branch is a
      // finished result, read from the report; a crash is not.
      safe(() => report(slot.pane, outcome === "crashed" ? "blocked" : "idle", outcome, `#${issue} ${outcome}`));
      slot.issue = undefined;
    },
    /** `ok` false: a human has to act - a conflict, a failed landing, a held branch. */
    landed(issue, ok, outcome) {
      const pane = [...shownBy].find(([, shown]) => shown === issue)?.[0];
      if (pane) safe(() => report(pane, ok ? "idle" : "blocked", outcome, `#${issue} ${outcome}`));
    },
    close(summary) {
      safe(() => herdr(["notification", "show", `Sandcastle ${project.name}`, "--body", summary, "--sound", "done"]));
    },
  };
};

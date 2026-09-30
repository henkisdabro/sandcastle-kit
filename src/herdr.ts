// Herdr integration: the status pane's helpers, and a per-sandbox view.
//
// Herdr recognises agents by the process in a pane, and a sandbox agent runs
// in a container with no terminal - Herdr cannot see it. But the orchestrator
// knows exactly what each sandbox is doing, and Herdr takes that as a report
// (`pane report-agent`). So a run opens a tab with one pane per concurrent
// sandbox, each tailing its issue's current log, and reports the phase: the
// sidebar then shows every sandbox as a working, blocked or done agent.
//
// All of it is a convenience: outside Herdr, or with SANDCASTLE_HERDR_VIEW=0,
// or on any herdr error, it does nothing and the run carries on.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./config.ts";

// stderr is captured, not inherited: herdr reports errors there as JSON
// (a closed pane is `pane_not_found`), which must not leak into the run.
export const herdr = (args: string[]) =>
  execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
export const herdrJson = (args: string[]) => JSON.parse(herdr(args));
export const IN_HERDR = process.env.HERDR_ENV === "1";

type Slot = { pane: string; issue?: number };
export type SandboxView = {
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
  const record = join(project.root, ".sandcastle/logs/herdr-view.json");
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

  // A previous run's view is replaced, not stacked: close the tab it made.
  // Only an id from our own record is ever closed.
  if (existsSync(record)) {
    try {
      herdr(["tab", "close", JSON.parse(readFileSync(record, "utf8")).tab]);
    } catch {
      /* already closed */
    }
  }
  const created = safe(() =>
    herdrJson([
      "tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID ?? "", "--label", `sandcastle ${project.name}`,
      "--cwd", project.root, "--no-focus",
    ]),
  );
  if (!created) return NONE;
  const tab = created.result.tab.tab_id as string;
  const slots: Slot[] = [{ pane: created.result.root_pane.pane_id as string }];
  const save = () => writeFileSync(record, JSON.stringify({ tab, panes: slots.map((s) => s.pane) }) + "\n");
  save();

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

  // Reported states outlive the process. A run that dies must not leave its
  // panes saying "working" forever.
  process.on("exit", () => {
    for (const s of slots) {
      if (s.issue === undefined) continue;
      try {
        report(s.pane, "blocked", "run ended", `#${s.issue} stopped`);
      } catch {
        /* best effort */
      }
    }
  });

  return {
    claim(issue, title) {
      safe(() => {
        let slot = slots.find((s) => s.issue === undefined);
        if (!slot && slots.length < panes) {
          const pane = herdrJson(["pane", "split", slots[slots.length - 1].pane, "--direction", "down", "--cwd", project.root, "--no-focus"])
            .result.pane.pane_id as string;
          slot = { pane };
          slots.push(slot);
          save();
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
        // Stop the previous phase's tail before following this one.
        herdr(["pane", "send-keys", slot.pane, "ctrl+c"]);
        herdr(["pane", "run", slot.pane, `clear; tail -n 40 -F .sandcastle/logs/agent-issue-${issue}-${name}-${issue}.log`]);
      });
    },
    finish(issue, outcome) {
      const slot = slotOf(issue);
      if (!slot) return;
      safe(() => {
        const done = outcome === "shipped" || outcome === "nochange" || outcome === "merged-earlier";
        report(slot.pane, done ? "idle" : "blocked", outcome, `#${issue} ${outcome}`);
      });
      slot.issue = undefined;
    },
    landed(issue, ok, outcome) {
      const pane = [...shownBy].find(([, shown]) => shown === issue)?.[0];
      if (pane) safe(() => report(pane, ok ? "idle" : "blocked", outcome, `#${issue} ${outcome}`));
    },
    close(summary) {
      safe(() => herdr(["notification", "show", `Sandcastle ${project.name}`, "--body", summary, "--sound", "done"]));
    },
  };
};

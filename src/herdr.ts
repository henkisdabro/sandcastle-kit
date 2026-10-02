// Herdr integration: the status pane's helpers, and a per-sandbox view.
//
// Herdr recognises agents by the process in a pane, and a sandbox agent runs
// in a container with no terminal - Herdr cannot see it. But the orchestrator
// knows exactly what each sandbox is doing, and Herdr takes that as a report
// (`pane report-agent`). So a run opens a tab with one pane per concurrent
// sandbox, each tailing its issue's current log, and reports the phase: the
// sidebar then shows every sandbox as a working, blocked or done agent.
//
// Where: a run a person started alone in a tab, from a terminal, adopts that
// tab - the run's output, the status view and the sandboxes side by side.
// Started anywhere else (a detached run, a pipe), it makes a tab of its own,
// whose first pane is the status view, and adds nothing to the tab it was
// launched from. When the run ends its sandbox panes close, so no sidebar
// entry outlives it; the status view stays.
//
// Sandbox panes are opt-in (`herdr.panes: "all"`, or SANDBOX_PANES=all). By
// default none opens, and the run is one agent on the status pane instead:
// working while a ticket works, blocked or idle at the end.
//
// Herdr (0.9.2+) clears a reported agent once its pane is back at an idle
// shell. So a pane runs one `tail -F` for its whole life, on a symlink the
// phases repoint: restarting the tail would drop the shell to idle between
// phases and wipe the sandbox from the sidebar.
//
// The sidebar also carries the run itself: each sandbox's row is named after
// its ticket and reports `$sc_phase` and `$sc_elapsed` tokens, and the run's
// workspace reports `$sandcastle` ("4/9 · 1 needs you"). Herdr shows a token
// only where a sidebar row names it (`sandcastle herdr configure` adds the
// rows), and keeps none across a server restart, so everything is re-sent
// once a minute: the sidebar heals itself after a restart or a live handoff.
//
// All of it is a convenience: outside Herdr, or with SANDCASTLE_HERDR_VIEW=0,
// or on any herdr error, it does nothing and the run carries on.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { GROUPS, type TicketRecord } from "../mod/hooks/run-record.ts";
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

// Split ratios (Herdr's `--ratio` is the share the pane being split keeps). The status view is
// what an operator watches, so it gets about half the screen; at Herdr's default halves each
// sandbox split took from it, shrinking it as sandboxes opened. Wide: run 25%, status 50%,
// sandbox column 25%. Narrow (status below the run): status takes 70% of the height and 5/7
// of that width, about half the area. Own tab (no run pane): status 2/3, sandboxes 1/3.
export const layoutRatios = (adopted: boolean, wide: boolean) =>
  !adopted ? { column: 0.67 } : wide ? { status: 0.25, column: 0.6667 } : { status: 0.3, column: 0.7143 };

// The sandbox column ends with `panes` equal rows: the pane split for the next one keeps the
// share it will have once all are open (1/5, then 1/4 of the rest, ...). Halving the last pane
// each time left five sandboxes at 1/2, 1/4, 1/8, 1/16, 1/16 of the column.
export const stackRatio = (open: number, panes: number) => 1 / (panes - open + 1);

// A run's tickets counted in the status view's own groups (status.sh `style_of`), so the
// sidebar never says "needs you" about a ticket the view shows as fine, or the other way.
export type RunCounts = { working: number; needsYou: number; merged: number; total: number };
export const runCounts = (tickets: Record<string, TicketRecord>): RunCounts => {
  // A ticket with no state, or one the guard dropped, is in the "other" group: counted in the total only.
  const groups = Object.values(tickets).map((t) => (t.state ? GROUPS[t.state] : "other"));
  return {
    working: groups.filter((g) => g === "working").length,
    needsYou: groups.filter((g) => g === "needs you").length,
    merged: groups.filter((g) => g === "merged").length,
    total: groups.length,
  };
};

// What needs you first, as that is why anyone looks.
const progress = (c: RunCounts) => `${c.merged}/${c.total}` + (c.needsYou ? ` · ${c.needsYou} needs you` : c.working ? ` · ${c.working} working` : "");

// The workspace row in the sidebar, about 22 columns wide. A `contains = "needs you"` rule in
// the sidebar config turns it red.
export const spaceText = (c: RunCounts) => `🏰 ${progress(c)}`;

/**
 * The run as one agent, for a view with no sandbox panes. Working while the run is going, whatever
 * its tickets are doing: a lull between one landing and the next start is not the run waiting for
 * anyone. At the end, blocked when a ticket needs a person (held, failed, conflicted), else idle.
 */
export const runAgent = (c: RunCounts, ended: boolean): { state: "working" | "blocked" | "idle"; message: string } => ({
  state: !ended ? "working" : c.needsYou ? "blocked" : "idle",
  message: progress(c),
});

/**
 * Whether a run takes over the tab it is alone in. Only a person's terminal does: an agent that
 * started the run (or a detached run, which has no terminal) would otherwise get the status view
 * split beside it, in the tab it is working in.
 */
export const adoptsTab = (aloneInTab: boolean, terminal: boolean) => aloneInTab && terminal;

export type SandboxPanes = "none" | "all";
/** `SANDBOX_PANES` wins over the project's `herdr.panes`; unset, no sandbox opens a pane. */
export const sandboxPanes = (project: Pick<Project, "herdr">, env: NodeJS.ProcessEnv = process.env): SandboxPanes => {
  const value = env.SANDBOX_PANES || project.herdr?.panes || "none";
  if (value !== "none" && value !== "all") throw new OperatorError(`SANDBOX_PANES must be "none" or "all", not "${value}".`);
  return value;
};

// One run in the tab bar, which has more room: `name 4/9 · 2 working · 1 needs you`.
export const lineText = (name: string, c: RunCounts) =>
  [`${name} ${c.merged}/${c.total}`, ...(c.working ? [`${c.working} working`] : []), ...(c.needsYou ? [`${c.needsYou} needs you`] : [])].join(" · ");

export const elapsed = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

/** A sandbox's row tokens. `sc_run` names the run, and is what the Agents view sorts on. */
export const sandboxTokens = (run: string, phase: string, since: number | undefined, now: number): Record<string, string | null> => ({
  sc_run: run,
  sc_phase: phase,
  // Only a step in progress has a clock; a finished pipeline's outcome stands alone.
  sc_elapsed: since === undefined ? null : elapsed(now - since),
});

/** `--token k=v` to set, `--clear-token k` for null: Herdr's token patch, as CLI arguments. */
export const tokenArgs = (tokens: Record<string, string | null>) =>
  Object.entries(tokens).flatMap(([k, v]) => (v === null ? ["--clear-token", k] : ["--token", `${k}=${v}`]));

/**
 * While the run's own pane waits for an answer (autonomy level 1), Herdr is told: the pane
 * reads as a blocked agent - sidebar, notification, `agent wait --until blocked` - like any
 * agent with a question, instead of a run quietly waiting in a tab nobody is looking at.
 * Released after, as a reported state outlives what it was about.
 */
export const askingInPane = async <T>(about: string, ask: () => Promise<T>): Promise<T> => {
  const pane = process.env.HERDR_PANE_ID;
  if (!IN_HERDR || !pane) return ask();
  const tell = (args: string[]) => {
    try {
      herdr(args);
    } catch {
      /* the question works without Herdr knowing */
    }
  };
  tell(["pane", "report-agent", pane, "--source", "sandcastle-kit", "--agent", "sandcastle", "--state", "blocked", "--message", about.slice(0, 80)]);
  try {
    return await ask();
  } finally {
    tell(["pane", "release-agent", pane, "--source", "sandcastle-kit", "--agent", "sandcastle"]);
  }
};

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
// Two and a half of the minute's re-sends: no flicker between them, gone soon after a kill.
const TTL = "150000";

// Phase -> the sandbox.run name its log is written under (burndown.ts).
// Gates have one too: the orchestrator writes their output as it arrives
// (burndown.ts), so a pane shows the test run instead of the review's last words.
const LOG = { implement: "impl", review: "review", "cross-review": "review-codex", repair: "repair", gates: "gates" } as const;

export const openSandboxView = (
  project: Project,
  panes: number,
  ref: (id: string) => string,
  tickets: () => Record<string, TicketRecord> = () => ({}),
  // Not `sandboxPanes()`'s default: the caller resolves the setting, and a view opened with no
  // word on it keeps a pane per sandbox.
  mode: SandboxPanes = "all",
): SandboxView => {
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

  // Alone in its tab, in a terminal: adopt it. The status view splits off the run's pane.
  const myTabInfo = safe(() => (myTab ? (herdrJson(["tab", "get", myTab]).result.tab as { pane_count: number; label?: string }) : undefined));
  if (failed) return NONE;
  const alone = adoptsTab(myTabInfo?.pane_count === 1, !!process.stdout.isTTY);
  let tab: string;
  let statusPane: string;
  let workspace = me?.workspace_id ?? process.env.HERDR_WORKSPACE_ID;
  let wide = false;
  if (alone && mine && myTab) {
    wide = (safe(() => (herdrJson(["pane", "layout", "--pane", mine]).result.layout.panes as { pane_id: string; rect: { width: number } }[])
      .find((p) => p.pane_id === mine)?.rect.width) ?? 0) >= 160;
    const ratio = String(layoutRatios(true, wide).status);
    const split = safe(() => herdrJson(["pane", "split", mine, "--direction", wide ? "right" : "down", "--ratio", ratio, "--cwd", project.root, "--no-focus"]));
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
    const created = safe(() =>
      herdrJson([
        "tab", "create", ...(workspace ? ["--workspace", workspace] : []), "--label", `sandcastle ${project.name}`,
        "--cwd", project.root, "--no-focus",
      ]),
    );
    if (!created) return NONE;
    tab = created.result.tab.tab_id as string;
    statusPane = created.result.root_pane.pane_id as string;
    workspace = created.result.tab.workspace_id as string;
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
  // What each pane shows: which issue, the step or outcome, and since when (a step in
  // progress only). A landing result may only update a pane no later issue has taken over.
  type Shown = { issue: string; title: string; state: "working" | "blocked" | "idle"; phase: string; since?: number };
  const shown = new Map<string, Shown>();
  // A pane the operator closed by hand is forgotten. Left to `safe`, its pane_not_found on
  // the next minute's report switched every other pane's reporting off too.
  const gone = (pane: string, error: unknown) => {
    if (!/pane_not_found/.test(String((error as { stderr?: string }).stderr ?? ""))) return false;
    shown.delete(pane);
    const slot = slots.find((s) => s.pane === pane);
    if (slot) Object.assign(slot, { closed: true, issue: undefined });
    save();
    return true;
  };
  // `state` only when it changed: the minute's re-send is the metadata alone, as a repeated
  // idle report could mark a finished sandbox unseen again. Metadata expires (TTL) unless
  // re-sent, so a run killed without its exit handler leaves nothing behind for long.
  const report = (pane: string, state = false) => {
    const s = shown.get(pane);
    if (!s) return;
    const now = Date.now();
    const label = s.since === undefined ? s.phase : `${s.phase} · ${elapsed(now - s.since)}`;
    try {
      if (state) herdr(["pane", "report-agent", pane, "--source", SOURCE, "--agent", "sandcastle", "--state", s.state, "--message", s.phase, "--seq", seq()]);
      herdr([
        "pane", "report-metadata", pane, "--source", SOURCE, "--agent", "sandcastle", "--title", `${ref(s.issue)} ${s.phase}`,
        // The ticket, not "sandbox": the agent row names it even with Herdr's default sidebar.
        "--display-agent", `${ref(s.issue)} ${s.title}`.slice(0, 80),
        // Wherever Herdr shows a state's text (Go To, `state_text` rows), the step instead.
        ...["working", "blocked", "idle", "done"].flatMap((k) => ["--state-label", `${k}=${label}`]),
        ...tokenArgs(sandboxTokens(project.name, s.phase, s.since, now)),
        "--ttl-ms", TTL,
      ]);
    } catch (error) {
      if (!gone(pane, error)) throw error;
    }
  };
  const show = (pane: string, s: Shown) => {
    shown.set(pane, s);
    report(pane, true);
    reportSpace();
  };
  const reportSpace = () => {
    if (workspace) {
      herdr(["workspace", "report-metadata", workspace, "--source", SOURCE, "--token", `sandcastle=${spaceText(runCounts(tickets()))}`, "--ttl-ms", TTL]);
    }
  };
  const slotOf = (issue: string) => slots.find((s) => s.issue === issue);

  // Without sandbox panes the run is one agent, on the status pane. `said` is what Herdr was last
  // told: the state is sent only when it changed (as for a sandbox), the metadata every time.
  const startedAt = Date.now();
  let ended = false;
  let said = "";
  const reportRun = (final?: ReturnType<typeof runAgent>) => {
    const a = final ?? runAgent(runCounts(tickets()), ended);
    if (said !== `${a.state} ${a.message}`) {
      herdr(["pane", "report-agent", statusPane, "--source", SOURCE, "--agent", "sandcastle", "--state", a.state, "--message", a.message, "--seq", seq()]);
      said = `${a.state} ${a.message}`;
    }
    herdr([
      "pane", "report-metadata", statusPane, "--source", SOURCE, "--agent", "sandcastle", "--title", `${project.name} run`, "--display-agent", "sandcastle",
      ...["working", "blocked", "idle", "done"].flatMap((k) => ["--state-label", `${k}=${a.message}`]),
      ...tokenArgs(sandboxTokens(project.name, a.message, ended ? undefined : startedAt, Date.now())),
      "--ttl-ms", TTL,
    ]);
  };
  const reportRunAndSpace = () => {
    if (mode === "none") reportRun();
    reportSpace();
  };
  // Herdr keeps no tokens across a restart, even when it keeps the panes. Re-sent once a
  // minute, which also moves each `$sc_elapsed`.
  const tick = setInterval(() => safe(() => {
    for (const pane of shown.keys()) report(pane);
    reportRunAndSpace();
  }), 60_000);
  tick.unref();
  // Reported states outlive the process: a finished run's panes went on
  // saying "blocked" in the sidebar an hour later. The sandbox panes close
  // with the run - the outcomes are in the report and the status view.
  process.on("exit", () => {
    clearInterval(tick);
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
    // A run that never reached its close was killed or crashed: its pane must not go on saying "working".
    if (mode === "none" && !ended) {
      try {
        reportRun({ state: "blocked", message: "ended early" });
      } catch {
        /* the pane or the server is gone */
      }
    }
    try {
      if (workspace) herdr(["workspace", "report-metadata", workspace, "--source", SOURCE, "--clear-token", "sandcastle"]);
    } catch {
      /* the workspace or the server is gone */
    }
  });

  return {
    status: statusPane,
    tab,
    claim(issue, title) {
      if (mode === "none") return void safe(reportRunAndSpace);
      safe(() => {
        let slot = slots.find((s) => s.issue === undefined && !s.closed);
        const open = slots.filter((s) => !s.closed);
        if (!slot && open.length < panes) {
          // Sandboxes stack to the right of the status view. From an open
          // pane: one that waited for a machine-wide slot starts after the
          // queue looked empty and its neighbours' panes closed, and a split
          // from a closed pane turned the whole view off.
          const [from, direction] = open.length ? [open[open.length - 1].pane, "down"] : [statusPane, "right"];
          const ratio = String(open.length ? stackRatio(open.length, panes) : layoutRatios(adopted, wide).column);
          const pane = herdrJson(["pane", "split", from, "--direction", direction, "--ratio", ratio, "--cwd", project.root, "--no-focus"])
            .result.pane.pane_id as string;
          slot = addSlot(pane);
        }
        if (!slot) return;
        slot.issue = issue;
        herdr(["pane", "rename", slot.pane, `${ref(issue)} ${title}`.slice(0, 60)]);
        show(slot.pane, { issue, title, state: "working", phase: "setup", since: Date.now() });
      });
    },
    phase(issue, phase) {
      if (mode === "none") return void safe(reportRunAndSpace);
      const slot = slotOf(issue);
      const s = slot && shown.get(slot.pane);
      if (!slot || !s) return;
      safe(() => {
        show(slot.pane, { ...s, state: "working", phase, since: Date.now() });
        const name = LOG[phase as keyof typeof LOG];
        if (!name) return; // setup has no log of its own
        follow(slot.pane, `agent-issue-${issue}-${name}-${issue}.log`);
      });
    },
    finish(issue, outcome, release) {
      if (mode === "none") return void safe(reportRunAndSpace);
      const slot = slotOf(issue);
      if (!slot) return;
      slot.issue = undefined;
      if (release) {
        // Nothing will reuse it. Left open it showed a finished agent's last
        // words for the rest of the run, and five of them read as five stuck
        // sandboxes; the status view has the outcome.
        slot.closed = true;
        shown.delete(slot.pane);
        rmSync(link(slot.pane), { force: true });
        safe(() => {
          herdr(["pane", "close", slot.pane]);
          reportSpace();
        });
        save();
        return;
      }
      // Herdr's "blocked" means "needs your input". A red branch is a
      // finished result, read from the report; a crash is not.
      const s = shown.get(slot.pane);
      if (s) safe(() => show(slot.pane, { ...s, state: outcome === "crashed" ? "blocked" : "idle", phase: outcome, since: undefined }));
    },
    /** `ok` false: a human has to act - a conflict, a failed landing, a held branch. */
    landed(issue, ok, outcome) {
      if (mode === "none") return void safe(reportRunAndSpace);
      const [pane, s] = [...shown].find(([, s]) => s.issue === issue) ?? [];
      if (pane && s) safe(() => show(pane, { ...s, state: ok ? "idle" : "blocked", phase: outcome, since: undefined }));
      else safe(reportSpace);
    },
    close(summary) {
      // An autonomy run's next turn opens a view of its own, closing these panes: this
      // tick would report into them and turn its view off with a warning.
      clearInterval(tick);
      ended = true;
      safe(() => {
        reportRunAndSpace();
        herdr(["notification", "show", `Sandcastle ${project.name}`, "--body", summary, "--sound", "done"]);
      });
    },
  };
};

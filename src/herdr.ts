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
// entry outlives it; the status view stays, and the next run reuses its pane
// wherever a person moved it, in place of either.
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
// its ticket and reports `$sc_phase` and `$sc_elapsed` tokens, the run's
// workspace reports `$sandcastle` ("4/9 · 1 needs you"), and the run's status
// pane `$sc_usage` (the plan's usage, "5h 14% · wk 93%"; "claude wk 93% · codex wk 16%" when
// cross-review shows Codex's too) once an agent has reported it. Herdr shows a token only where a sidebar row names it
// (`sandcastle herdr configure` adds the rows), and keeps none across a
// server restart, so everything is re-sent once a minute: the sidebar heals
// itself after a restart or a live handoff.
//
// All of it is a convenience: outside Herdr, or with SANDCASTLE_HERDR_VIEW=0,
// or on any herdr error, it does nothing and the run carries on.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { Project } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { GROUPS, type PlanUsage, type TicketRecord } from "../mod/hooks/run-record.ts";
import { viewRecord } from "./live-runs.ts";
import { KIT } from "./sandbox.ts";
import { readPlanUsages, usageBand } from "./usage.ts";

export { viewRecord };

// stderr is captured, not inherited: herdr reports errors there as JSON
// (a closed pane is `pane_not_found`), which must not leak into the run.
export const herdr = (args: string[]) =>
  execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
export const herdrJson = (args: string[]) => JSON.parse(herdr(args));
export const IN_HERDR = process.env.HERDR_ENV === "1";

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

// This kit's own entry, not whichever `sandcastle` PATH finds first: a second
// checkout (a branch under test, say) would otherwise run with the other
// checkout's status view.
export const statusCommand = (kit = KIT) => `${shellQuote(join(kit, "bin/sandcastle"))} status`;
export const STATUS_COMMAND = statusCommand();

// Where the status pane opened beside the caller is recorded (run.ts).
export const statusPaneRecord = (project: Project) => join(project.root, ".sandcastle/logs/status-pane");
type Foreground = { cmdline: string }[];
const foreground = (pane: string) => herdrJson(["pane", "process-info", "--pane", pane]).result.process_info.foreground_processes as Foreground;
const showsStatus = (processes: Foreground) => processes.some((p) => p.cmdline.includes("status.sh"));
export const runsStatus = (pane: string) => showsStatus(foreground(pane));

// A pane's foreground is a bare shell: one process, a known shell's name, and at most the flags
// that make it a login or interactive shell. `bash status.sh`, `claude`, `vim` and a REPL are not,
// and neither is a pane with no foreground process Herdr can name.
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]);
const SHELL_FLAGS = new Set(["-l", "-i", "--login", "--interactive"]);
const bareShell = (processes: Foreground) => {
  if (processes.length !== 1) return false;
  const [command, ...flags] = processes[0].cmdline.trim().split(/\s+/);
  return SHELLS.has(basename(command.replace(/^-/, ""))) && flags.every((f) => SHELL_FLAGS.has(f));
};
export const runsBareShell = (pane: string) => bareShell(foreground(pane));
// The closing report the plugin types into a finished run's status pane (`bin/sandcastle` runs the CLI as `node ... cli.ts report`).
const showsReport = (processes: Foreground) => processes.some((p) => /\bcli\.ts\s+report(\s|$)/.test(p.cmdline));
const pause = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** What herdr said went wrong, cut to its `message` when it answered with its JSON error, and to 160 characters. */
export const herdrMessage = (error: unknown) => {
  // One line: anything else herdr or node says (a panic, `Command failed: ...` and its output) spans several.
  const text = String((error as { stderr?: string }).stderr || (error as Error)?.message || error).replace(/\s+/g, " ").trim();
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 160);
  } catch {
    /* not JSON: herdr's own words, or node's */
  }
  return text.slice(0, 160);
};
const paneNotFound = (error: unknown) => /pane_not_found/.test(String((error as { stderr?: string }).stderr ?? ""));

type View = { tab?: string; adopted?: boolean; status?: string; reported?: boolean; socket?: string; kit?: string; terminal_id?: string; quit?: boolean; panes?: string[] };
// The record sits in a clone's gitignored `logs/`, where a hostile clone can force-add a file, and
// the tab bar runs whatever kit it names: used only as an absolute path to a checkout that has
// `bin/sandcastle`, else the caller's. A relative one would run a script from inside the repo.
const recordedKit = (view: View, kit: string) =>
  typeof view.kit === "string" && isAbsolute(view.kit) && existsSync(join(view.kit, "bin/sandcastle")) ? view.kit : kit;
// Pane ids mean something only to the server that made them: another server's `w1:t2-1` may be
// a bare shell of someone else's. A record without `socket`, or a caller without
// HERDR_SOCKET_PATH, cannot tell.
const onOtherServer = (view: View) => !!view.socket && !!process.env.HERDR_SOCKET_PATH && view.socket !== process.env.HERDR_SOCKET_PATH;
type Pane = { tab_id?: string; terminal_id?: string };
const paneOf = (pane: string) => herdrJson(["pane", "get", pane]).result.pane as Pane;
// After a restart Herdr may number its tabs afresh: the pane must still be in the recorded tab.
const inRecordedTab = (view: View, pane: Pane) => pane.tab_id === view.tab;
// A person quit the view (Ctrl-C: status.sh's INT trap marks `quit`) and the pane is still the
// terminal the kit last started it in. Herdr keeps a pane's terminal_id through anything run in it
// and gives it a new one on each server restart, which a pane id cannot tell (Herdr reuses those).
// Without it the tab bar typed the view back into that shell every tick, onto anything half-typed.
// A record with no terminal_id (an older kit's) cannot tell, and acts as before.
const quitHere = (view: View, pane: Pane) => !!view.quit && !!view.terminal_id && pane.terminal_id === view.terminal_id;
// Whole or not at all: status.sh's trap and the tab bar read it at any moment.
const writeView = (root: string, view: View) => {
  const file = viewRecord(root);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(view) + "\n");
  renameSync(tmp, file);
};
/**
 * A run that opens no view marks an earlier run's record `reported`, keeping its tab and pane ids
 * (a later run inside Herdr still closes that tab). The record is only rewritten by a run that
 * opens a view, so it would otherwise stay an own, unreported tab: the tab bar's tick would type
 * the status view into its pane, ids a Herdr restart may have given to someone's shell, and
 * `registerRun` would park this run's live-runs file in the awaiting directory for it. Nothing to do
 * when there is no record or it is already reported; best effort, as the view is.
 */
const retireViewRecord = (root: string) => {
  try {
    const view = JSON.parse(readFileSync(viewRecord(root), "utf8")) as View;
    if (!view.reported) writeView(root, { ...view, reported: true });
  } catch {
    /* no record, or not readable: nothing for a reader to act on */
  }
};

/**
 * A live run's own tab after a cold Herdr restart: the panes come back as idle shells, and the
 * status view died with the server. The tab bar's tick starts it again in the recorded status
 * pane, with the command the run used, whenever it finds that pane a bare shell: nothing marks it
 * done, as a second restart in the same run needs it again. The kit is the record's (`kit`, the run's
 * own checkout: the tab bar's is the one the plugin is linked from), else the caller's. Left alone, as `tellDeadTab` leaves
 * them: a tab adopted from a person's terminal, a record already reported (an earlier run's), a
 * tab on another Herdr server or not the recorded one, a pane still running the status view or
 * anything else, and any herdr error. Also left alone: a view a person quit (`quit`) in the same
 * terminal (`terminal_id`), which is their shell until the run ends or Herdr restarts. Starting the
 * view records the pane's terminal_id and clears `quit`. True when the view was started.
 */
export const restartStatusView = (root: string, kit = KIT): boolean => {
  try {
    const view = JSON.parse(readFileSync(viewRecord(root), "utf8")) as View;
    if (!view.tab || !view.status || view.adopted !== false || view.reported || onOtherServer(view)) return false;
    const pane = paneOf(view.status);
    if (!inRecordedTab(view, pane) || quitHere(view, pane) || !bareShell(foreground(view.status))) return false;
    // `cd`: a restored shell does not always start in the project, and the view is the project's.
    herdr(["pane", "run", view.status, `cd ${shellQuote(root)} && ${statusCommand(recordedKit(view, kit))}`]);
    // A quit before the restart does not hold after it; the view now runs in this terminal.
    if (pane.terminal_id && (view.quit || view.terminal_id !== pane.terminal_id)) {
      const { quit: _, ...rest } = view;
      writeView(root, { ...rest, terminal_id: pane.terminal_id });
    }
    return true;
  } catch {
    return false;
  }
};

/**
 * A run that is no longer live (its pid gone, or its record finished) leaves its tab as the
 * server last had it, and after a cold Herdr restart that is idle shells with nothing saying the
 * run ended. The tab the kit opened for it gets the closing report in its status pane (from the record's `kit`, else the caller's), once: the
 * record is marked, so a later tick finds nothing to do. Left alone: a tab a person's terminal
 * was adopted into (that terminal is theirs), a tab that is not the recorded one any more, and a
 * status pane that is not a bare shell - the status view still running (it already shows how the
 * run ended), or anything a person started there since (Herdr may reuse a pane id across a
 * restart, and the command would be typed into an editor or a REPL). Any herdr error leaves the
 * tab as it is (`retry`, below). `reported` when the report was started, and `left` for every other
 * case above but one.
 *
 * The record is claimed by renaming it to a name of this caller's own, which only one of two
 * callers can do, before anything is typed; it goes back marked `reported` once the command is
 * sent, and unmarked if herdr failed.
 *
 * That one is `showing`, the status view still running in the recorded pane: the tab may yet need
 * the report, once a later restart leaves the pane a bare shell (or a quit, in a record with no
 * `terminal_id`). The live-runs
 * reader moves the run's file to the awaiting directory for it (`awaitReport`): a kill with no restart
 * until some ticks later would otherwise never be reported, and kept in the runs directory it would
 * start the kit on every tab-bar tick for as long as the view ran.
 *
 * `quit`: a person quit the view (`quit`) in the terminal the kit last started it in (`terminal_id`):
 * that pane is their shell now. The record is marked `reported` with nothing typed, and the run's
 * file goes. With another terminal_id, Herdr restarted since, and the report is typed as above.
 *
 * `elsewhere`: the record names the Herdr server that holds the tab (`socket`) and this caller is
 * on another. Nothing is asked of herdr and the record is untouched; the live-runs reader moves the
 * run's file to the awaiting directory for the right server. A record without `socket`, or a caller without
 * HERDR_SOCKET_PATH, cannot tell and acts as it always did.
 *
 * `retry`: herdr itself failed (a server not yet restored at startup, a transient error, or a pane
 * it no longer has, which it answers alike: `pane_not_found`): nothing is
 * known of the tab, so the record is as it was and the run's file stays awaiting for the next
 * reader, until `AWAIT_REPORT_DAYS` ends it. Not `left`, which deletes the file and loses the report.
 */
export type DeadTab = "reported" | "showing" | "quit" | "elsewhere" | "retry" | "left";
// A failure of a herdr call, as opposed to a record that cannot be read or a claim another caller won.
class HerdrFailure extends Error {}
const askHerdr = <T>(call: () => T): T => {
  try {
    return call();
  } catch (error) {
    throw new HerdrFailure(error instanceof Error ? error.message : String(error));
  }
};
export const tellDeadTab = (root: string, kit = KIT): DeadTab => {
  const file = viewRecord(root);
  const claim = `${file}.${process.pid}.${randomUUID()}.claim`;
  try {
    const read = readFileSync(file, "utf8");
    const view = JSON.parse(read) as View;
    if (!view.tab || !view.status || view.adopted !== false || view.reported) return "left";
    // Before any herdr call, and the record stays as it is.
    if (onOtherServer(view)) return "elsewhere";
    const pane = askHerdr(() => paneOf(view.status!));
    if (!inRecordedTab(view, pane)) return "left";
    const quit = quitHere(view, pane);
    if (!quit) {
      const processes = askHerdr(() => foreground(view.status!));
      if (showsStatus(processes)) return "showing";
      if (!bareShell(processes)) return "left";
    }
    // ENOENT here is the other caller having claimed it first.
    renameSync(file, claim);
    // A record a new run wrote meanwhile stays: `wx` never overwrites it.
    const giveBack = (record: string) => writeFileSync(file, record, { flag: "wx" });
    // Between our read and our claim the other caller may have finished and written the record back
    // marked, or a new run may have written its own: either way it is not the record checked above.
    const claimed = readFileSync(claim, "utf8");
    if (claimed !== read) {
      try {
        giveBack(claimed);
      } finally {
        rmSync(claim, { force: true });
      }
      return "left";
    }
    if (quit) {
      try {
        giveBack(JSON.stringify({ ...view, reported: true }) + "\n");
      } finally {
        rmSync(claim, { force: true });
      }
      return "quit";
    }
    try {
      // `cd`: a restored shell does not always start in the project.
      askHerdr(() => herdr(["pane", "run", view.status!, `cd ${shellQuote(root)} && ${shellQuote(join(recordedKit(view, kit), "bin/sandcastle"))} report`]));
    } catch (error) {
      giveBack(read);
      throw error;
    } finally {
      rmSync(claim, { force: true });
    }
    giveBack(JSON.stringify({ ...view, reported: true }) + "\n");
    return "reported";
  } catch (error) {
    return error instanceof HerdrFailure ? "retry" : "left";
  }
};
export const reportInDeadTab = (root: string, kit = KIT): boolean => tellDeadTab(root, kit) === "reported";

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
const progress = (c: RunCounts) => `${c.merged}/${c.total}` + (c.needsYou ? ` · ${c.needsYou} needs you` : c.paused ? " · paused" : c.working ? ` · ${c.working} working` : "");

// The workspace row in the sidebar, about 22 columns wide. A `contains = "needs you"` rule in
// the sidebar config turns it red.
export const spaceText = (c: RunCounts) => `♜ ${progress(c)}`;

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

// One run in the tab bar, which has more room: `name 4/9 · 2 working · 1 needs you · share 3`, its
// share of the machine's sandbox slots last (a record from an older kit has none).
export const lineText = (name: string, c: RunCounts, share?: number) =>
  [`${name} ${c.merged}/${c.total}`, ...(c.paused ? ["paused"] : c.working ? [`${c.working} working`] : []), ...(c.needsYou ? [`${c.needsYou} needs you`] : []), ...(share === undefined ? [] : [`share ${share}`])].join(" · ");

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

/** The marks that carry a usage band into the token's text, where Herdr's rules (`contains`) can colour by it: nothing below `USAGE_AMBER` percent, `▲` from it, `■` from `USAGE_RED`. */
export const USAGE_MARKS = { normal: "", amber: " ▲", red: " ■" } as const;

/**
 * The status pane's `sc_usage` token, and the mark of the worst window's band (`USAGE_MARKS`) after it. One
 * provider's reading, Claude's, is `5h 14% · wk 93%`; with another provider's too, each is its name and its
 * weekly window, `claude wk 93% · codex wk 16%` (the sidebar's row is narrow), and the mark is the worst of every
 * window of both. Undefined until a reading exists, and for a record whose readings are not well-formed:
 * the token is then not sent at all.
 */
export const usageText = (usage: PlanUsage[] | PlanUsage | undefined): string | undefined => {
  const readings = readPlanUsages(usage).flatMap((u) => (u.windows ? [{ provider: u.provider, ...u.windows }] : []));
  if (!readings.length) return undefined;
  const worst = Math.max(...readings.flatMap((r) => [r.fiveHour.percent, r.week.percent]));
  const [only] = readings;
  const text = readings.length === 1 && only.provider === "claude" ? `5h ${only.fiveHour.percent}% · wk ${only.week.percent}%` : readings.map((r) => `${r.provider} wk ${r.week.percent}%`).join(" · ");
  return `${text}${USAGE_MARKS[usageBand(worst)]}`;
};

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
  /** Send the run's sidebar tokens now: its state moved with no ticket's phase doing so (a pause or a resume). */
  refresh(): void;
  /** The run ended: a notification with the summary. */
  close(summary: string): void;
};

const NONE: SandboxView = { claim() {}, phase() {}, finish() {}, landed() {}, refresh() {}, close() {} };
const SOURCE = "sandcastle-kit";
// Two and a half of the minute's re-sends: no flicker between them, gone soon after a kill.
const TTL = "150000";

// Phase -> the sandbox.run name its log is written under (burndown.ts).
// Gates have one too: the orchestrator writes their output as it arrives
// (burndown.ts), so a pane shows the test run instead of the review's closing lines.
const LOG = { implement: "impl", resolve: "resolve", review: "review", "cross-review": "review-codex", repair: "repair", gates: "gates" } as const;

export const openSandboxView = (
  project: Project,
  panes: number,
  ref: (id: string) => string,
  tickets: () => Record<string, TicketRecord> = () => ({}),
  // Not `sandboxPanes()`'s default: the caller resolves the setting, and a view opened with no
  // word on it keeps a pane per sandbox.
  mode: SandboxPanes = "all",
  // The plan usage the run record holds now, sent as the status pane's `sc_usage` token.
  usage: () => PlanUsage[] | PlanUsage | undefined = () => undefined,
  // Whether a person has the run paused: the sidebar says so in place of "N working".
  paused: () => boolean = () => false,
): SandboxView => {
  // Every way out before this run writes its own record retires the earlier one.
  const none = () => {
    retireViewRecord(project.root);
    return NONE;
  };
  if (!IN_HERDR || process.env.SANDCASTLE_HERDR_VIEW === "0" || panes < 1) return none();
  const logs = join(project.root, ".sandcastle/logs");
  const record = viewRecord(project.root);
  let failed = false;
  // One warning, then silence: a broken view must not flood the run's output. Herdr's own
  // `message`, not the JSON it answers with.
  const safe = <T>(fn: () => T): T | undefined => {
    if (failed) return undefined;
    try {
      return fn();
    } catch (error) {
      failed = true;
      console.log(`Herdr sandbox view off for this run (${herdrMessage(error)}).`);
      return undefined;
    }
  };

  const mine = process.env.HERDR_PANE_ID;
  const me = safe(() => (mine ? (herdrJson(["pane", "get", mine]).result.pane as { tab_id: string; workspace_id: string }) : undefined));
  if (failed) return none();
  const myTab = me?.tab_id;

  let previous: View = {};
  if (existsSync(record)) {
    try {
      previous = JSON.parse(readFileSync(record, "utf8")) as View;
    } catch {
      /* unreadable: no earlier view to tell */
    }
  }
  const home = me?.workspace_id ?? process.env.HERDR_WORKSPACE_ID;

  // The previous run's status pane is reused when it is still there, wherever the person put it:
  // the same server, the same terminal (Herdr reuses pane ids across a restart), this run's
  // workspace, and not the pane this run is typed in. What it runs is stopped first: the previous status
  // view or the plugin's report. A bare shell is as good (the view ended or was quit); any other
  // command is a person's, and the pane is replaced as below.
  const reuse = ((): Pane | undefined => {
    if (!previous.status || !previous.terminal_id || previous.status === mine || onOtherServer(previous)) return undefined;
    try {
      const pane = paneOf(previous.status) as Pane & { workspace_id?: string };
      if (pane.terminal_id !== previous.terminal_id || !pane.tab_id || (home && pane.workspace_id !== home)) return undefined;
      const processes = foreground(previous.status);
      if (bareShell(processes)) return pane;
      if (!showsStatus(processes) && !showsReport(processes)) return undefined;
      // Ctrl-C makes status.sh mark the record `quit` when it names the pane (a person quitting the
      // view). The record names no status pane while the view is stopped, so nothing is marked and
      // the tab bar leaves the pane alone; the new record is written once the pane is a shell.
      const { status: _, quit: __, ...rest } = previous;
      writeView(project.root, rest);
      herdr(["pane", "send-keys", previous.status, "ctrl+c"]);
      for (let waited = 0; waited < 5000; waited += 100) {
        pause(100);
        if (bareShell(foreground(previous.status))) return pane;
      }
    } catch {
      /* gone, or Herdr cannot say: not reused */
    }
    return undefined;
  })();
  const reusedStatus = reuse ? previous.status : undefined;
  // The kit's own tab goes whole with the status pane in it; a tab that holds a person's panes never does.
  // Read as the close below reads it (a record with no `adopted` is an own tab), or that close took the
  // reused pane with the tab. The tab this run is typed in holds the person's run pane: adopted.
  const reusedOwnTab = !!reuse && !previous.adopted && reuse.tab_id === previous.tab && reuse.tab_id !== myTab;

  // A previous run's view is replaced, not stacked. Only ids from our own
  // record are closed, and never the pane this run is typed in: a tab the
  // kit made goes whole, an adopted tab keeps its run pane. A pane a person
  // moved out of that tab outlives the tab, or the tab is already gone and
  // its close fails: either way the record's panes are closed by id after it,
  // the status pane only while it is still the recorded terminal (Herdr
  // reuses pane ids across a restart). A status pane being reused stays, and
  // so does the tab it is in.
  if (existsSync(record)) {
    try {
      if (previous.tab && !previous.adopted && previous.tab !== myTab && !reusedOwnTab) {
        try {
          herdr(["tab", "close", previous.tab]);
        } catch {
          /* gone already: its panes may live on in another tab */
        }
      }
      const close = (pane: string, terminal?: string) => {
        if (pane === mine) return;
        try {
          if (terminal && paneOf(pane).terminal_id !== terminal) return;
          herdr(["pane", "close", pane]);
        } catch {
          /* already closed */
        }
      };
      for (const pane of previous.panes ?? []) close(pane);
      if (previous.status && !reusedStatus) close(previous.status, previous.terminal_id);
    } catch {
      /* already closed */
    }
  }

  // Alone in its tab, in a terminal: adopt it. The status view splits off the run's pane.
  const myTabInfo = safe(() => (myTab ? (herdrJson(["tab", "get", myTab]).result.tab as { pane_count: number; label?: string }) : undefined));
  if (failed) return none();
  const alone = !reuse && adoptsTab(myTabInfo?.pane_count === 1, !!process.stdout.isTTY);
  let tab: string;
  let statusPane: string;
  let workspace = home;
  let wide = false;
  if (reuse && reusedStatus) {
    tab = reuse.tab_id!;
    statusPane = reusedStatus;
  } else if (alone && mine && myTab) {
    wide = (safe(() => (herdrJson(["pane", "layout", "--pane", mine]).result.layout.panes as { pane_id: string; rect: { width: number } }[])
      .find((p) => p.pane_id === mine)?.rect.width) ?? 0) >= 160;
    const ratio = String(layoutRatios(true, wide).status);
    const split = safe(() => herdrJson(["pane", "split", mine, "--direction", wide ? "right" : "down", "--ratio", ratio, "--cwd", project.root, "--no-focus"]));
    if (!split) return none();
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
    if (!created) return none();
    tab = created.result.tab.tab_id as string;
    statusPane = created.result.root_pane.pane_id as string;
    workspace = created.result.tab.workspace_id as string;
  }
  // Pane-log links left by an earlier run point at logs since archived, and
  // one past this run's pane count would never be repointed.
  for (const f of readdirSync(logs)) if (/^herdr-pane-\d+\.log$/.test(f)) rmSync(join(logs, f), { force: true });
  // A reused pane in a tab the kit did not make is a person's: the tab is never closed whole.
  const adopted = reuse ? !reusedOwnTab : tab === myTab;
  const slots: Slot[] = [];
  // The status pane's terminal, so a person's quit of the view is told from a Herdr restart
  // (`restartStatusView`). Without it the view still opens: the record then acts as an older kit's.
  let terminal: string | undefined;
  try {
    terminal = paneOf(statusPane).terminal_id;
  } catch {
    /* no terminal_id recorded */
  }
  let saved = false;
  let statusGone = false;
  const save = () => {
    // Others write the record while the run lives: status.sh marks the view quit, and the tab bar
    // records a restarted view's terminal. A rewrite here (a pane closing, the run's exit) keeps both,
    // or a quit view would be typed into once the run ended. The first save replaces an earlier run's.
    let kept: View = { terminal_id: terminal };
    if (saved) {
      try {
        const now = JSON.parse(readFileSync(record, "utf8")) as View;
        if (now.status === statusPane) kept = { terminal_id: now.terminal_id ?? terminal, ...(now.quit ? { quit: true } : {}) };
      } catch {
        /* gone or half-written: what this run knows */
      }
    }
    // Through `writeView`: status.sh's trap and the tab bar read the record at any moment, and a
    // plain write shows them a truncated one.
    // A status pane that is gone is no longer recorded: the tab bar would type the view into whatever
    // Herdr gave its id to, or find it moved to a tab that is not the run's.
    writeView(project.root, { tab, adopted, ...(process.env.HERDR_SOCKET_PATH ? { socket: process.env.HERDR_SOCKET_PATH } : {}), kit: KIT, ...(statusGone ? {} : { status: statusPane }), ...kept, panes: slots.filter((s) => !s.closed).map((s) => s.pane) });
    saved = true;
  };
  save();
  if (!safe(() => {
    herdr(["pane", "rename", statusPane, `sandcastle status ${project.name}`]);
    // `cd`: a pane a person moved or kept may sit in another directory than the project's.
    herdr(["pane", "run", statusPane, reuse ? `cd ${shellQuote(project.root)} && ${STATUS_COMMAND}` : STATUS_COMMAND]);
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
    if (!paneNotFound(error)) return false;
    shown.delete(pane);
    const slot = slots.find((s) => s.pane === pane);
    if (slot) Object.assign(slot, { closed: true, issue: undefined });
    save();
    return true;
  };
  // The status pane closed by hand, moved or lost is no broken view: the workspace's tokens and the
  // end notification do not need it. Left to `safe`, its pane_not_found turned all of them off
  // with a line of raw JSON. Told once, and the record forgets the pane.
  const statusPaneClosed = (error: unknown) => {
    if (!paneNotFound(error)) return false;
    if (!statusGone) {
      statusGone = true;
      save();
      console.log("Herdr status pane closed - `sandcastle status` shows the run.");
    }
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
      herdr(["workspace", "report-metadata", workspace, "--source", SOURCE, "--token", `sandcastle=${spaceText(runCounts(tickets(), paused()))}`, "--ttl-ms", TTL]);
    }
  };
  const slotOf = (issue: string) => slots.find((s) => s.issue === issue);

  // Without sandbox panes the run is one agent, on the status pane. `said` is what Herdr was last
  // told: the state is sent only when it changed (as for a sandbox), the metadata every time.
  const startedAt = Date.now();
  let ended = false;
  let said = "";
  const reportRun = (final?: ReturnType<typeof runAgent>) => {
    if (statusGone) return;
    const a = final ?? runAgent(runCounts(tickets(), paused()), ended);
    try {
      if (said !== `${a.state} ${a.message}`) {
        herdr(["pane", "report-agent", statusPane, "--source", SOURCE, "--agent", "sandcastle", "--state", a.state, "--message", a.message, "--seq", seq()]);
        said = `${a.state} ${a.message}`;
      }
      herdr([
        "pane", "report-metadata", statusPane, "--source", SOURCE, "--agent", "sandcastle", "--title", `${project.name} run`, "--display-agent", "sandcastle",
        ...["working", "blocked", "idle", "done"].flatMap((k) => ["--state-label", `${k}=${a.message}`]),
        ...tokenArgs({ ...sandboxTokens(project.name, a.message, ended ? undefined : startedAt, Date.now()), ...usageTokens() }),
        "--ttl-ms", TTL,
      ]);
    } catch (error) {
      if (!statusPaneClosed(error)) throw error;
    }
  };
  // The plan's usage, once a reading exists: no token before it, and none cleared after.
  const usageTokens = (): Record<string, string> => {
    const text = usageText(usage());
    return text ? { sc_usage: text } : {};
  };
  // With a pane per sandbox the status pane is no reported agent, so its token goes alone and on a
  // best-effort basis: a Herdr that has no use for it must not turn the whole view off.
  const reportUsage = () => {
    const tokens = usageTokens();
    if (!tokens.sc_usage) return;
    if (statusGone) return;
    try {
      herdr(["pane", "report-metadata", statusPane, "--source", SOURCE, ...tokenArgs(tokens), "--ttl-ms", TTL]);
    } catch (error) {
      statusPaneClosed(error); // the sidebar's usage is a convenience: any other error is let go
    }
  };
  const reportRunAndSpace = () => {
    if (mode === "none") reportRun();
    else reportUsage();
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

  // One try at a sandbox pane for a ticket; true when a pane it met had been closed by hand and is forgotten.
  const claimOnce = (issue: string, title: string): boolean | void => {
    let slot = slots.find((s) => s.issue === undefined && !s.closed);
    const open = slots.filter((s) => !s.closed);
    if (!slot && open.length < panes) {
      // Sandboxes stack to the right of the status view. From an open
      // pane: one that waited for a machine-wide slot starts after the
      // queue looked empty and its neighbours' panes closed, and a split
      // from a closed pane turned the whole view off.
      // With no pane open and the status pane gone there is nothing to split from: no sandbox
      // pane then, and the rest of the view goes on. Not another pane, and not a new status pane.
      if (!open.length && statusGone) return;
      const [from, direction] = open.length ? [open[open.length - 1].pane, "down"] : [statusPane, "right"];
      const ratio = String(open.length ? stackRatio(open.length, panes) : layoutRatios(adopted, wide).column);
      let pane: string;
      try {
        pane = herdrJson(["pane", "split", from, "--direction", direction, "--ratio", ratio, "--cwd", project.root, "--no-focus"])
          .result.pane.pane_id as string;
      } catch (error) {
        // The status pane closed since the last report: told as a closed pane, not a broken view.
        if (!open.length && statusPaneClosed(error)) return;
        if (open.length && gone(from, error)) return true;
        throw error;
      }
      slot = addSlot(pane);
    }
    if (!slot) return;
    slot.issue = issue;
    try {
      herdr(["pane", "rename", slot.pane, `${ref(issue)} ${title}`.slice(0, 60)]);
    } catch (error) {
      if (gone(slot.pane, error)) return true;
      throw error;
    }
    show(slot.pane, { issue, title, state: "working", phase: "setup", since: Date.now() });
  };

  return {
    status: statusPane,
    tab,
    claim(issue, title) {
      if (mode === "none") return void safe(reportRunAndSpace);
      // A pane closed by hand before any report found it gone is forgotten here too, and the claim tries
      // again: its pane_not_found left to `safe` turned the whole view off. Each try closes a slot, so the
      // tries end.
      for (let again = true, tries = 0; again && tries <= slots.length; tries++) again = safe(() => claimOnce(issue, title)) === true;
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
    refresh() {
      safe(reportRunAndSpace);
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

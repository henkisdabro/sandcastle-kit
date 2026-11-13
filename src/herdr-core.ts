// herdr-core (herdr-core, `hc`): the run's status view as a core terminal split into the caller's tab, and what the
// view tells the core about the run (OSC 7501). It shares no state with the Herdr TUI view (src/herdr.ts): its own
// record, `.sandcastle/logs/core-view.json`, so nothing that reads `herdr-view.json` - the plugin's tick, the dead
// tab, the restart, `tabAwaitsReport` - ever acts on a core address.
//
// Light on purpose: the status view imports it for its records, and must not load the run's modules.
//
// Identity: a project key (a short hash of the resolved root: two checkouts of one project never share a terminal)
// names the status terminal and labels it (`sandcastle.root`); a run instance, fresh in each `sandcastle run`
// process, labels what this run started (`sandcastle.instance`) and is the one marker that lets a status view write
// the terminal's root record (`SANDCASTLE_CORE_VIEW`). Teardown touches only what the record holds under this
// instance, never everything with the project's label: a successor run that took the lock as this one exited owns
// what it started.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GROUPS, retriedNextTurn, type RunRecord, type TicketRecord, WORDS } from "../mod/hooks/run-record.ts";
import { appCliPorts, type AppPorts, type ModPane } from "./herdr-app.ts";
import { real } from "./live-runs.ts";
import { clear, record, TEXT_MAX, windowTitle } from "./osc7501.ts";
import type { CoreTerminal } from "./terminal-host.ts";
import type { SandboxView } from "./herdr.ts";
import { bareShell, PHASE_LOG, progress, runCounts, showsStatus } from "./view-facts.ts";

/** One `hc` call: its stdout. Throws as `execFileSync` does; the tests put a stub `hc` on PATH. */
export type Hc = (args: string[]) => string;
// stderr captured: hc reports errors there as JSON, which must not leak into the run's output.
const hcCli: Hc = (args) => execFileSync("hc", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });

export const projectKey = (root: string) => createHash("sha1").update(real(root)).digest("hex").slice(0, 10);
/** Fits hc's names (`[a-z0-9_-]{1,32}`). */
export const statusName = (root: string) => `sc-${projectKey(root)}-status`;
export const slotName = (root: string, n: number) => `sc-${projectKey(root)}-slot-${n}`;
const nameWord = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
/**
 * A sandbox sub-agent's name, `<project>-<ticket>` (`shop-12`): the app's agents list shows a terminal with no pane by
 * its name alone, never its title or record, so the name is what says which ticket it is. Fits hc's names; not
 * unique across checkouts of one project, so a taken name starts the terminal unnamed.
 */
export const ticketName = (root: string, issue: string) => {
  const ticket = (nameWord(issue) || "ticket").slice(0, 20).replace(/-+$/, "");
  const project = nameWord(basename(real(root))).slice(0, 31 - ticket.length).replace(/-+$/, "");
  return project ? `${project}-${ticket}` : ticket;
};
/** Fresh in each process: an autonomy run's turns are one run. */
export const RUN_INSTANCE = randomUUID().replaceAll("-", "").slice(0, 12);

/** `pane`: the Herdr app's mod pane this instance opened in place of the status terminal's own pane (#959). */
export type CoreView = { instance: string; status?: string; slots?: string[]; pane?: string };
export const coreViewRecord = (root: string) => join(root, ".sandcastle/logs/core-view.json");
const readView = (file: string): CoreView | undefined => {
  try {
    const view = JSON.parse(readFileSync(file, "utf8"));
    return view && typeof view === "object" && typeof view.instance === "string" ? (view as CoreView) : undefined;
  } catch {
    return undefined;
  }
};
export const readCoreView = (root: string) => readView(coreViewRecord(root));
// Whole or not at all: a status view and the slots read it at any moment.
const writeWhole = (file: string, value: unknown) => {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n");
  renameSync(tmp, file);
};
const writeCoreView = (root: string, view: CoreView) => writeWhole(coreViewRecord(root), view);

type Terminal = { address: string; state?: string; labels?: Record<string, string>; foreground?: { argv?: string[] } };
const get = (hc: Hc, t: string): Terminal | undefined => {
  try {
    const found = JSON.parse(hc(["get", t, "--json"])) as Terminal;
    return typeof found?.address === "string" ? found : undefined;
  } catch {
    return undefined; // not found, or hc cannot say: either way not one to reuse
  }
};
// hc names one foreground process: for a view started as `sandcastle status` that is the CLI (`node ... cli.ts status`),
// which runs status.sh in a child; for one an older kit's way typed in, the view itself.
const foregroundOf = (t: Terminal | undefined) => (t?.foreground?.argv?.length ? [t.foreground.argv.join(" ")] : []);
const runsStatusView = (t: Terminal | undefined) => {
  const fg = foregroundOf(t);
  return showsStatus(fg) || fg.some((c) => /\bcli\.ts\s+status(\s|$)/.test(c));
};
const pause = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const message = (error: unknown) => String((error as { stderr?: string }).stderr || (error as Error)?.message || error).replace(/\s+/g, " ").trim().slice(0, 160);

// The roots this process opened a view for, each torn down at exit by one listener.
const opened = new Map<string, { instance: string; hc: Hc }>();
/**
 * Ends what this run instance started, by the addresses its record holds - never by label, so a successor's terminals
 * are untouched - and forgets them. The status terminal stays (`--keep`), as on Herdr TUI: it shows how the run ended,
 * and the next run reuses it. A record a later instance wrote holds nothing of this one's.
 */
export const teardown = (root: string, instance = RUN_INSTANCE, hc: Hc = hcCli) => {
  const view = readCoreView(root);
  if (!view || view.instance !== instance || !view.slots?.length) return;
  for (const slot of view.slots) {
    for (const verb of ["kill", "rm"]) {
      try {
        hc([verb, slot, "--json"]);
      } catch {
        /* gone already */
      }
    }
  }
  try {
    writeCoreView(root, { ...view, slots: [] });
  } catch {
    /* best effort, as the view is */
  }
};

export type CoreStatusOptions = { kit: string; hc?: Hc; instance?: string; app?: AppPorts };

/**
 * Opens the run's status view as a core terminal, or reuses the project's, and records it. Started with
 * `--outlive-parent` (a detached run's caller may end first), `--no-notify` (hc would type its exit note into the
 * caller, which may be the Claude Code session the mod talks to) and `--keep` (the view comes back as a shell
 * after a core restart, where the next run finds it by name). Argv, never a shell string, so no path is quoted
 * wrong, and nothing is ever typed into a terminal. The caller's `herdr.space` and `herdr.tab` put
 * it in the caller's tab (an unlabelled terminal stays hidden). Undefined, with the reason printed, when hc fails:
 * whatever this call started is ended first.
 *
 * In the Herdr app with the kit's mod current (#959), the mod pane opens beside the caller in place of the terminal
 * view: the status terminal still runs - its records are the run's agent state, needs-you alert included, and the
 * slots' parent - but as the caller's sub-agent with no pane. Anything short of that (`appPane`) opens the terminal
 * view as before.
 */
export const openCoreStatus = (root: string, caller: CoreTerminal, { kit, hc = hcCli, instance = RUN_INSTANCE, app = appCliPorts() }: CoreStatusOptions): string | undefined => {
  const key = projectKey(root);
  const name = statusName(root);
  const marker = `SANDCASTLE_CORE_VIEW=${instance}`;
  const bin = join(kit, "bin/sandcastle");
  let started: string | undefined;
  let pane: string | undefined;
  try {
    const previous = readCoreView(root);
    // An autonomy run's next turn: the view the first turn opened is already this run's.
    // A stray mod pane comes only from a split, which a start tries in the app with the mod current: only such a
    // start, or one after a run that had a pane, reads the app's layout for one.
    // A mod check that throws (the kit's files read mid-pull) is a no: the run starts with the terminal view.
    const current = () => {
      try {
        return app.modCurrent(kit);
      } catch {
        return false;
      }
    };
    const sweep = !!previous?.pane || (inApp(caller) && current());
    if (previous?.instance === instance && previous.status && runsStatusView(get(hc, previous.status))) {
      if (sweep) closeStrayPanes(root, previous.pane, app);
      return previous.status;
    }
    // The mod pane on record goes, as the status terminal does below - an earlier run's, or this run's own whose
    // status terminal is gone: this start opens its own beside its caller, and a pane left open would be orphaned.
    if (previous?.pane) closeRecordedPane(root, previous.pane, app);
    if (sweep) closeStrayPanes(root, undefined, app);
    pane = appPane(root, caller, kit, app, instance);

    // The project's status terminal from an earlier run: a view still running is stopped first, and what is left - a
    // bare shell (Ctrl-C leaves a `--keep` terminal one only when the view dies by the signal) or a finished terminal
    // (hc 0.1.19: an ordinary exit is final) - is removed and the view opened afresh by name. Anything else in it is a
    // person's, and keeps the name; this run's view then goes unnamed.
    let nameFree = true;
    // The name is asked again after the kit tried to end its own terminal: hc's answer on the address says only that
    // the terminal is gone, and the name is what the new view needs. Still taken, the old terminal is the person's
    // to close, and the one line names it - printed only here, for a terminal the kit tried to remove, never for one
    // it leaves alone as a person's.
    let triedToRemove: string | undefined;
    const removedLine = (old: string) => `The old status terminal ${old} could not be removed, so this run's status view is unnamed beside it: close it yourself.`;
    const nameIsFree = (old: string) => {
      triedToRemove = old;
      const free = !get(hc, name);
      if (!free) console.log(removedLine(old));
      return free;
    };
    const found = get(hc, name);
    if (found?.state === "live") {
      nameFree = false;
      if (found.labels?.["sandcastle.root"] === key) {
        let t: Terminal | undefined = found;
        const wasView = runsStatusView(t);
        if (wasView) {
          hc(["keys", found.address, "ctrl+c", "--json"]);
          for (let waited = 0; waited < 5000 && t !== undefined && !bareShell(foregroundOf(t)) && t.state !== "finished"; waited += 100) {
            pause(100);
            t = get(hc, found.address);
          }
        }
        // A bare shell is removed too, never typed into: once a terminal has published a status record, `hc send`
        // from another terminal wraps the text in `<hc from=...>` tags (hc 0.1.19), and a view that died leaving its
        // root record would be handed a line the shell cannot run. A live shell is killed before it is removed, as
        // every terminal the kit ends is; and the name is taken again only once the terminal is gone, so a shell hc
        // would not remove costs the view its name, never the view.
        // A view that has not given way within the wait (a loaded machine takes longer than hc's usual 2.5 s to hand a
        // `--keep` terminal its shell) is ended too: opening beside it would leave two status terminals, the old one a
        // bare shell a moment later that the next run reuses. It is this project's own (the root label), never a person's.
        if (t?.state === "finished" || bareShell(foregroundOf(t)) || (wasView && runsStatusView(t))) {
          for (const verb of t?.state === "finished" ? ["rm"] : ["kill", "rm"]) {
            try {
              hc([verb, found.address, "--json"]);
            } catch {
              /* judged below, by whether the name is free */
            }
          }
          nameFree = nameIsFree(found.address);
        } else if (!t) {
          // The terminal vanished during the wait: nothing of the kit's is left to end, and the name may be free.
          nameFree = !get(hc, name);
        }
      }
    } else if (found) {
      // Finished: removed, so the name is free for this run's view. An hc that cannot remove it costs the view its
      // name, never the view.
      try {
        hc(["rm", found.address, "--json"]);
      } catch {
        /* judged below, by whether the name is free */
      }
      nameFree = nameIsFree(found.address);
    }

    // With the mod pane, no `herdr.*` labels: the app gives the terminal no pane, and lists it under the caller.
    const labels = [
      ...(pane ? [] : (["herdr.space", "herdr.tab"] as const).flatMap((k) => (caller.labels[k] ? [`${k}=${caller.labels[k]}`] : []))),
      `sandcastle.root=${key}`,
      `sandcastle.instance=${instance}`,
    ];
    const runArgs = (named: boolean) => [
      "run", "--bg", "--json", "--no-notify", "--outlive-parent", "--keep", ...(pane ? ["--parent", caller.address] : []), ...(named ? ["--name", name] : []), "--cwd", root,
      ...labels.flatMap((l) => ["--label", l]), "--", "env", marker, bin, "status",
    ];
    // `get` answers undefined on any hc error, so a failed `get` reads as a free name and `run --name` can fail as
    // taken. Only hc itself throwing is retried, once and unnamed: a `run` that answered (no address, or not JSON)
    // may have started a terminal the kit cannot address, so it is never run twice.
    let unnamedLine: string | undefined;
    let raw: string;
    try {
      raw = hc(runArgs(nameFree));
    } catch (error) {
      if (!nameFree) throw error;
      raw = hc(runArgs(false));
      unnamedLine = triedToRemove
        ? removedLine(triedToRemove)
        : `The status view's name ${name} is still taken, so this run's status view is unnamed beside it: close the old one yourself.`;
    }
    const out = JSON.parse(raw) as { address?: unknown };
    if (typeof out.address !== "string") throw new Error(`hc run gave no address: ${JSON.stringify(out).slice(0, 120)}`);
    if (unnamedLine) console.log(unnamedLine);
    started = out.address;
    const address = started;
    writeCoreView(root, { instance, status: address, slots: [], ...(pane ? { pane } : {}) });
    if (!opened.size) process.on("exit", () => opened.forEach((o, r) => teardown(r, o.instance, o.hc)));
    opened.set(root, { instance, hc });
    return address;
  } catch (error) {
    if (started) {
      for (const verb of ["kill", "rm"]) {
        try {
          hc([verb, started, "--json"]);
        } catch {
          /* gone already */
        }
      }
    }
    if (pane) {
      try {
        app.close(pane);
      } catch {
        /* gone already */
      }
    }
    console.log(`Could not open the status view in herdr-core (${message(error)}).`);
    return undefined;
  }
};

/** A caller the app shows: its terminal carries the app's `herdr.space` and `herdr.tab` labels. */
const inApp = (caller: CoreTerminal) => !!caller.labels["herdr.space"] && !!caller.labels["herdr.tab"];

/** This project's `sandcastle` mod panes in the app's layout; undefined when the layout cannot be read. */
const projectPanes = (root: string, app: AppPorts): Set<string> | undefined => {
  try {
    return new Set(app.modPanes().filter((p) => p.project === root).map((p) => p.pane));
  } catch {
    return undefined;
  }
};

/**
 * Closes a pane `core-view.json` names, only once the app's layout shows it is still this project's `sandcastle` mod
 * pane: the record is a bare id, and the pane may since have been closed and its id meant something else, or the
 * layout may be unreadable - either way it is left alone.
 */
const closeRecordedPane = (root: string, pane: string, app: AppPorts) => {
  if (!projectPanes(root, app)?.has(pane)) return;
  try {
    app.close(pane);
  } catch {
    /* closed meanwhile, or no window */
  }
};

/**
 * Closes every mod pane a run opened for this project (its `run` prop) but `keep`: a split the app completed after
 * its answer timed out is recorded nowhere, and the run lock means one run owns the project, so no other run's pane
 * is live. A pane a person opened by hand has no `run` prop and stays; an unreadable layout closes nothing.
 */
const closeStrayPanes = (root: string, keep: string | undefined, app: AppPorts) => {
  let panes: ModPane[];
  try {
    panes = app.modPanes();
  } catch {
    return;
  }
  for (const p of panes) {
    if (p.project !== root || !p.run || p.pane === keep) continue;
    try {
      app.close(p.pane);
    } catch {
      /* closed meanwhile, or no window */
    }
  }
};

/**
 * The Herdr app's mod pane, split beside the caller's pane, or undefined for the terminal view: the caller is not in
 * the app (no `herdr.*` labels, or no pane in a running window), or the mod is not current (doctor not `ok`), or the
 * split failed - said in one line, as the run goes on with the terminal view. The mod reads the run through this
 * kit's own `sandcastle`, as the status terminal does, never whichever one is on PATH.
 *
 * A split whose answer was lost (a timeout, output that is not JSON) may still have made the pane: the one new pane
 * of this project's in the layout is adopted, and more than one are closed, so no pane is left that nothing records.
 * The split focuses the new pane; the keyboard goes back to whatever pane had it, so a run started in a tab in the
 * background does not bring that tab forward - or, when the app cannot say which had it, to the caller's.
 * The props carry `run` (the instance), which marks the pane as a run's for `closeStrayPanes`; the mod ignores it.
 */
export const appPane = (root: string, caller: CoreTerminal, kit: string, app: AppPorts, instance = RUN_INSTANCE): string | undefined => {
  if (!inApp(caller)) return undefined;
  let focused: string | undefined;
  let pane: string | undefined;
  try {
    if (!app.modCurrent(kit)) return undefined;
    const beside = app.paneOf(caller.address);
    if (!beside) return undefined;
    focused = app.focused() ?? beside;
    // Only panes this split could have made: this project's, carrying this instance as their `run`. A log pane or
    // a status pane a person opened meanwhile is never adopted or closed.
    const mine = () => {
      try {
        return new Set(app.modPanes().filter((p) => p.project === root && p.run === instance).map((p) => p.pane));
      } catch {
        return undefined;
      }
    };
    const before = mine();
    try {
      pane = app.split(beside, { project: root, command: [join(kit, "bin/sandcastle"), "status", "--json", "--frame"], run: instance });
    } catch (error) {
      const made = before ? [...(mine() ?? [])].filter((p) => !before.has(p)) : [];
      if (made.length === 1) pane = made[0];
      else {
        for (const p of made) {
          try {
            app.close(p);
          } catch {
            /* gone already */
          }
        }
        throw error;
      }
    }
  } catch (error) {
    console.log(`Could not open the Herdr app pane (${message(error)}): the terminal status view opens instead.`);
    return undefined;
  }
  if (focused) {
    try {
      app.focus(focused);
    } catch {
      /* the pane is open; focus is a nicety */
    }
  }
  return pane;
};

/** The start's `Status view:` line on herdr-core: the mod pane when this run opened one, else the terminal. */
export const coreStatusLine = (root: string, status: string) => {
  const view = readCoreView(root);
  return view?.status === status && view.pane ? `Status view: app pane ${view.pane} (terminal ${status})` : `Status view: terminal ${status}`;
};

/**
 * A question asked in a person's own core terminal (autonomy level 1, the API-key question): its root record reads
 * blocked with `kind=question` meanwhile, which the core's apps raise as a needs-you alert. Only with a terminal on
 * stdout - piped, the bytes would land in someone's file - and cleared after, as the record outlives what it was about.
 */
export const askingInCore = async <T>(about: string, ask: () => Promise<T>, out: { isTTY?: boolean; write(s: string): unknown } = process.stdout): Promise<T> => {
  if (!out.isTTY) return ask();
  out.write(record({ state: "blocked", app: "sandcastle", kind: "question", msg: about }));
  try {
    return await ask();
  } finally {
    out.write(clear());
  }
};

/** What the status view knows of the run, as its snapshot holds it. */
export type RunFacts = { name: string; hasRecord: boolean; live: boolean; record: Pick<RunRecord, "finishedAt" | "paused" | "settings" | "dryRun" | "stopped" | "verify" | "exitCode">; tickets: Record<string, TicketRecord> };

const childId = (ticket: string) => ticket.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "_";

/**
 * The newest ticket that needs a person, and why: `#12 needs you: conflict in src/a.ts, src/b.ts`, its note in place
 * of files it has none of, and how many others need them too. Within `room` code points, the why cut with `…`: the
 * record's msg is cut at its end (`TEXT_MAX`), and the count after it must stay.
 */
export const needsYouLine = (tickets: Record<string, TicketRecord>, retried: ReadonlySet<string>, room = Infinity): string => {
  const wanted = Object.entries(tickets)
    .filter(([id, t]) => t.state && GROUPS[t.state] === "needs you" && !retried.has(id))
    .sort(([, a], [, b]) => (b.since ?? 0) - (a.since ?? 0));
  if (!wanted.length) return "needs you";
  const [id, t] = wanted[0];
  const ref = /^\d+$/.test(id) ? `#${id}` : id;
  const files = t.files?.length ? ` in ${t.files.slice(0, 2).join(", ")}${t.files.length > 2 ? ` +${t.files.length - 2}` : ""}` : "";
  const why = files || (t.note ? ` - ${t.note}` : "");
  const others = wanted.length > 1 ? ` (+${wanted.length - 1} more)` : "";
  // The ref is cut too when it alone overruns (a ticket file's id can be a long slug): what follows is the count.
  const body = [...`${ref} needs you: ${WORDS[t.state!] ?? t.state}${why}`];
  const fit = room - [...others].length;
  const cut = body.length > fit ? `${body.slice(0, Math.max(0, fit - 1)).join("")}…` : body.join("");
  return `${cut}${others}`;
};

/**
 * The records the run's status view holds in its terminal, by key: the root (the run: working; blocked with
 * `kind=question` while a ticket needs a person; done at the end; error for a run that ended without finishing),
 * the window title, and a child record per ticket in flight. None without a run record.
 */
export const runRecords = (run: RunFacts): Map<string, string> => {
  const shown = new Map<string, string>();
  if (!run.hasRecord) return shown;
  // A ticket a later turn takes by itself is not a person's yet: the root stays working (`retriedNextTurn`).
  const retried = retriedNextTurn({ ...run.record, tickets: run.tickets }, run.live);
  const counts = runCounts(run.tickets, !!run.record.paused, retried);
  const text = progress(counts);
  const state = counts.needsYou ? "blocked" : run.live ? "working" : run.record.finishedAt ? "done" : "error";
  // Herdr's own toast for a blocked or done agent carries the record's msg (#961): so the msg leads with what the
  // person is wanted for - the newest ticket that needs them and why - and an ended run says how it ended.
  const ended = run.live ? "" : run.record.finishedAt ? "run finished: " : "run ended early: ";
  const merged = ` · ${counts.merged}/${counts.total} merged`;
  const msg =
    state === "blocked"
      ? `${ended}${needsYouLine(run.tickets, retried, TEXT_MAX - [...ended].length - [...merged].length)}${merged}`
      : state === "done"
        ? `run finished: ${text}`
        : state === "error"
          ? `${text} · ended early`
          : text;
  shown.set(
    "root",
    record({
      state,
      app: "sandcastle",
      ...(state === "blocked" ? { kind: "question" as const } : {}),
      ...(counts.total ? { progress: (100 * counts.merged) / counts.total } : {}),
      title: `sandcastle ${run.name}`,
      msg,
    }),
  );
  shown.set("title", windowTitle(`sandcastle ${run.name} · ${text}`));
  if (run.live) {
    for (const [id, t] of Object.entries(run.tickets)) {
      if (!t.state || GROUPS[t.state] !== "working") continue;
      shown.set(`child ${childId(id)}`, record({ id: childId(id), state: "working", app: "sandcastle", ...(t.title ? { title: t.title } : {}), msg: `${id} ${t.state}` }));
    }
  }
  return shown;
};

/**
 * The status view's writer of its terminal's records: only for a view a run started for this instance
 * (`SANDCASTLE_CORE_VIEW` matching the record's, checked whenever something changed: a successor may have taken the
 * terminal over), and only with a terminal on stdout. `update` gives the bytes of what changed since the last
 * update - a child gone is cleared, and a redraw with nothing new gives nothing - and `end` clears the lot.
 */
export const coreRecords = (dir: string, env: NodeJS.ProcessEnv, terminal: boolean) => {
  const instance = env.SANDCASTLE_CORE_VIEW;
  if (!instance || !terminal) return undefined;
  const file = join(dir, "logs/core-view.json");
  let shown = new Map<string, string>();
  return {
    update(run: RunFacts): string {
      const next = runRecords(run);
      let bytes = "";
      for (const [k, v] of next) if (shown.get(k) !== v) bytes += v;
      for (const k of shown.keys()) if (!next.has(k)) bytes += k === "root" ? clear() : k.startsWith("child ") ? clear(k.slice(6)) : "";
      if (!bytes || readView(file)?.instance !== instance) return "";
      shown = next;
      return bytes;
    },
    end(): string {
      if (!shown.size) return "";
      shown = new Map();
      return clear();
    },
  };
};

/**
 * What a slot terminal shows, written by the run and read by `sandcastle slot` (src/core-slot.ts) and the status
 * view: the ticket (`issue`, kept after its pipeline ends so a landing can still say how it went), its ref and
 * title, the step or outcome, and the state its record reads. Beside it the slot's log link, `herdr-pane-N.log`, the
 * name Herdr TUI's panes follow, repointed per phase (src/herdr.ts).
 */
export type SlotState = { address: string; issue?: string; ref: string; title: string; phase: string; state: "working" | "blocked" | "idle" };
export const slotStateFile = (root: string, n: number) => join(root, `.sandcastle/logs/core-slot-${n}.json`);
export const slotLink = (root: string, n: number) => join(root, `.sandcastle/logs/herdr-pane-${n}.log`);
export const readSlotState = (file: string): SlotState | undefined => {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return s && typeof s === "object" && typeof s.ref === "string" && typeof s.title === "string" && typeof s.phase === "string" ? (s as SlotState) : undefined;
  } catch {
    return undefined;
  }
};

const NO_SLOTS: SandboxView = { claim() {}, phase() {}, finish() {}, landed() {}, refresh() {}, close() {} };

export type CoreViewOptions = CoreStatusOptions & {
  /** At most this many slots at once; none with `slots` false (SANDCASTLE_HERDR_VIEW=0). */
  panes: number;
  slots: boolean;
  /**
   * `herdr.panes: "all"`: each slot a pane in the caller's tab (the caller's `herdr.*` labels), reused ticket after
   * ticket. Otherwise a sub-agent of the status terminal, with no pane: the app lists it under the run's agent and a
   * click peeks at it. Named after its ticket, as that list shows only a name, so a slot is started afresh per ticket.
   */
  paned?: boolean;
  ref: (id: string) => string;
};

/**
 * The run's view on herdr-core: the status terminal, and with slots on, a terminal per sandbox - a pane beside it
 * (`paned`), as Herdr TUI's sandbox panes (src/herdr.ts), else a sub-agent listed under it - each tailing its ticket's
 * current log, and saying the ticket and its step as the terminal's record. A slot is `sandcastle slot N`, a terminal of its own the run starts and ends: started `--rm`
 * (gone once it exits) under the status terminal (`--parent`, so the apps nest it there), and recorded under this
 * run instance so `teardown` ends it. A slot also ends itself once the run is not live or a later run owns the
 * project's view: a run killed with no exit handler leaves none behind.
 */
export const openCoreView = (root: string, caller: CoreTerminal, { panes, slots: slotsOn, paned = true, ref, ...opts }: CoreViewOptions): SandboxView => {
  const { hc = hcCli, instance = RUN_INSTANCE } = opts;
  // An autonomy run's next turn: what the last turn left open goes, as a Herdr TUI view's panes do.
  teardown(root, instance, hc);
  // No slots: the caller opens the status terminal (`openStatusPane`), as for a view that is off.
  if (!slotsOn || panes < 1) return NO_SLOTS;
  const status = openCoreStatus(root, caller, opts);
  if (!status) return NO_SLOTS;

  const logs = join(root, ".sandcastle/logs");
  // Links and states an earlier run left would replay its logs.
  for (const f of readdirSync(logs)) if (/^(herdr-pane-\d+\.log|core-slot-\d+\.json)$/.test(f)) rmSync(join(logs, f), { force: true });
  const key = projectKey(root);
  const bin = join(opts.kit, "bin/sandcastle");
  // Without the caller's `herdr.*` labels the app gives a slot no pane: it is the status terminal's sub-agent.
  const labels = [
    ...(paned ? (["herdr.space", "herdr.tab"] as const).flatMap((k) => (caller.labels[k] ? [`${k}=${caller.labels[k]}`] : [])) : []),
    `sandcastle.root=${key}`,
    `sandcastle.instance=${instance}`,
  ];
  type Slot = { n: number; address: string; issue?: string; shown?: SlotState; closed?: boolean };
  const slots: Slot[] = [];
  let failed = false;
  // One warning, then none: a broken view must not flood the run's output, and the run goes on without it.
  const safe = (fn: () => void) => {
    if (failed) return;
    try {
      fn();
    } catch (error) {
      failed = true;
      console.log(`herdr-core sandbox terminals off for this run (${message(error)}).`);
    }
  };
  const record = () => {
    const view = readCoreView(root);
    if (view?.instance === instance) writeCoreView(root, { ...view, slots: slots.filter((s) => !s.closed).map((s) => s.address) });
  };
  const follow = (n: number, log: string) => {
    rmSync(slotLink(root, n), { force: true });
    symlinkSync(log, slotLink(root, n));
  };
  const show = (slot: Slot, s: Omit<SlotState, "address">) => {
    slot.shown = { address: slot.address, ...s };
    writeWhole(slotStateFile(root, slot.n), slot.shown);
  };
  const end = (address: string) => {
    for (const verb of ["kill", "rm"]) {
      try {
        hc([verb, address, "--json"]);
      } catch {
        /* gone already (`--rm`) */
      }
    }
  };
  const launch = (n: number, issue: string): string => {
    follow(n, "none.log");
    const run = (named: boolean) =>
      JSON.parse(
        hc([
          "run", "--bg", "--json", "--no-notify", "--outlive-parent", "--rm", "--parent", status, ...(named ? ["--name", paned ? slotName(root, n) : ticketName(root, issue)] : []), "--cwd", root,
          ...labels.flatMap((l) => ["--label", l]), "--", bin, "slot", String(n), "--instance", instance,
        ]),
      ) as { address?: unknown };
    let out: { address?: unknown };
    try {
      out = run(true);
    } catch (error) {
      // A killed run's slot of that name, still ending itself (it looks once a second), or another checkout's
      // ticket of the same name: this one goes unnamed.
      if (!/name_taken/.test(message(error))) throw error;
      out = run(false);
    }
    if (typeof out.address !== "string") throw new Error(`hc run gave no address: ${JSON.stringify(out).slice(0, 120)}`);
    return out.address;
  };
  const start = (n: number, issue: string): Slot => {
    const slot = { n, address: launch(n, issue) };
    slots.push(slot);
    record();
    return slot;
  };
  // A sub-agent's name is its ticket's, fixed at start: the next ticket gets a terminal of its own.
  // Closed until the new one has started: a failed start leaves no address on record that nothing runs at.
  const restart = (slot: Slot, issue: string) => {
    end(slot.address);
    slot.closed = true;
    record();
    slot.address = launch(slot.n, issue);
    slot.closed = false;
    record();
  };
  const slotOf = (issue: string) => slots.find((s) => s.issue === issue);

  return {
    status,
    claim(issue, title) {
      safe(() => {
        const free = slots.find((s) => !s.issue && !s.closed);
        if (free && !paned) restart(free, issue);
        const slot = free ?? (slots.filter((s) => !s.closed).length < panes ? start(slots.length, issue) : undefined);
        if (!slot) return;
        slot.issue = issue;
        follow(slot.n, "none.log");
        show(slot, { issue, ref: ref(issue), title, phase: "setup", state: "working" });
      });
    },
    phase(issue, phase) {
      const slot = slotOf(issue);
      if (!slot?.shown) return;
      safe(() => {
        show(slot, { ...slot.shown!, phase, state: "working" });
        const name = PHASE_LOG[phase as keyof typeof PHASE_LOG];
        if (name) follow(slot.n, `agent-issue-${issue}-${name}-${issue}.log`); // setup has no log of its own
      });
    },
    finish(issue, outcome, release) {
      const slot = slotOf(issue);
      if (!slot) return;
      slot.issue = undefined;
      safe(() => {
        // A crash needs a person; a red branch is a finished result, read from the report.
        if (!release) return void (slot.shown && show(slot, { ...slot.shown, phase: outcome, state: outcome === "crashed" ? "blocked" : "idle" }));
        // Nothing will reuse it: left open, a finished agent's last words read as a stuck sandbox.
        slot.closed = true;
        rmSync(slotLink(root, slot.n), { force: true });
        rmSync(slotStateFile(root, slot.n), { force: true });
        end(slot.address);
        record();
      });
    },
    /** `ok` false: a person has to act - a conflict, a failed landing, a held branch. */
    landed(issue, ok, outcome) {
      const slot = slots.find((s) => !s.closed && s.shown?.issue === issue);
      if (slot) safe(() => show(slot, { ...slot.shown!, phase: outcome, state: ok ? "idle" : "blocked" }));
    },
    // The run's own state is the status view's records; the slots go with the run (`teardown`).
    refresh() {},
    close() {},
  };
};

/** The live slots the record holds, each as the ticket it shows and its address (`#12 t7`), for the status view. */
export const slotAddresses = (logs: string): string[] => {
  const view = readView(join(logs, "core-view.json"));
  if (!view?.slots?.length) return [];
  const shown: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(logs).filter((f) => /^core-slot-\d+\.json$/.test(f)).sort((a, b) => parseInt(a.slice(10)) - parseInt(b.slice(10)));
  } catch {
    return [];
  }
  for (const f of names) {
    const s = readSlotState(join(logs, f));
    if (s?.issue && view.slots.includes(s.address)) shown.push(`${s.ref} ${s.address}`);
  }
  return shown;
};

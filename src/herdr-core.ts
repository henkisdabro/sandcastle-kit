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
import { GROUPS, type RunRecord, type TicketRecord } from "../mod/hooks/run-record.ts";
import { real } from "./live-runs.ts";
import { clear, record, windowTitle } from "./osc7501.ts";
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

export type CoreView = { instance: string; status?: string; slots?: string[] };
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
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
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

export type CoreStatusOptions = { kit: string; hc?: Hc; instance?: string };

/**
 * Opens the run's status view as a core terminal, or reuses the project's, and records it. Started with
 * `--outlive-parent` (a detached run's caller may end first), `--no-notify` (hc would type its exit note into the
 * caller, which may be the Claude Code session the mod talks to) and `--keep` (the view comes back as a shell
 * after a core restart, where the next run finds it by name). Argv, never a shell string, so no path is quoted
 * wrong; only a reused shell is typed into, with every word quoted. The caller's `herdr.space` and `herdr.tab` put
 * it in the caller's tab (an unlabelled terminal stays hidden). Undefined, with the reason printed, when hc fails:
 * whatever this call started is ended first.
 */
export const openCoreStatus = (root: string, caller: CoreTerminal, { kit, hc = hcCli, instance = RUN_INSTANCE }: CoreStatusOptions): string | undefined => {
  const key = projectKey(root);
  const name = statusName(root);
  const marker = `SANDCASTLE_CORE_VIEW=${instance}`;
  const bin = join(kit, "bin/sandcastle");
  let started: string | undefined;
  try {
    const previous = readCoreView(root);
    // An autonomy run's next turn: the view the first turn opened is already this run's.
    if (previous?.instance === instance && previous.status && runsStatusView(get(hc, previous.status))) return previous.status;

    // The project's status terminal from an earlier run, reused in place wherever a person moved it: a view still
    // running is stopped first (Ctrl-C leaves a `--keep` terminal a shell), and a bare shell is as good. Anything
    // else in it is a person's, and keeps the name; this run's view then goes unnamed.
    let address: string | undefined;
    let nameFree = true;
    const found = get(hc, name);
    if (found?.state === "live") {
      nameFree = false;
      if (found.labels?.["sandcastle.root"] === key) {
        let t: Terminal | undefined = found;
        if (runsStatusView(t)) {
          hc(["keys", found.address, "ctrl+c", "--json"]);
          for (let waited = 0; waited < 5000 && !bareShell(foregroundOf(t)); waited += 100) {
            pause(100);
            t = get(hc, found.address);
          }
        }
        if (bareShell(foregroundOf(t))) {
          hc(["label", found.address, `sandcastle.instance=${instance}`, "--json"]);
          // `cd`: a shell a person kept may sit in another directory.
          hc(["send", found.address, `cd ${quote(root)} && env ${marker} ${quote(bin)} status`, "--json"]);
          address = found.address;
        }
      }
    } else if (found) {
      // Finished: removed, so the name is free for this run's view.
      hc(["rm", found.address, "--json"]);
    }

    if (!address) {
      const labels = [
        ...(["herdr.space", "herdr.tab"] as const).flatMap((k) => (caller.labels[k] ? [`${k}=${caller.labels[k]}`] : [])),
        `sandcastle.root=${key}`,
        `sandcastle.instance=${instance}`,
      ];
      const out = JSON.parse(
        hc([
          "run", "--bg", "--json", "--no-notify", "--outlive-parent", "--keep", ...(nameFree ? ["--name", name] : []), "--cwd", root,
          ...labels.flatMap((l) => ["--label", l]), "--", "env", marker, bin, "status",
        ]),
      ) as { address?: unknown };
      if (typeof out.address !== "string") throw new Error(`hc run gave no address: ${JSON.stringify(out).slice(0, 120)}`);
      address = started = out.address;
    }
    writeCoreView(root, { instance, status: address, slots: [] });
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
    console.log(`Could not open the status view in herdr-core (${message(error)}).`);
    return undefined;
  }
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
export type RunFacts = { name: string; hasRecord: boolean; live: boolean; record: Pick<RunRecord, "finishedAt" | "paused">; tickets: Record<string, TicketRecord> };

const childId = (ticket: string) => ticket.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "_";

/**
 * The records the run's status view holds in its terminal, by key: the root (the run: working; blocked with
 * `kind=question` while a ticket needs a person; done at the end; error for a run that ended without finishing),
 * the window title, and a child record per ticket in flight. None without a run record.
 */
export const runRecords = (run: RunFacts): Map<string, string> => {
  const shown = new Map<string, string>();
  if (!run.hasRecord) return shown;
  const counts = runCounts(run.tickets, !!run.record.paused);
  const text = progress(counts);
  const state = counts.needsYou ? "blocked" : run.live ? "working" : run.record.finishedAt ? "done" : "error";
  shown.set(
    "root",
    record({
      state,
      app: "sandcastle",
      ...(state === "blocked" ? { kind: "question" as const } : {}),
      ...(counts.total ? { progress: (100 * counts.merged) / counts.total } : {}),
      title: `sandcastle ${run.name}`,
      msg: state === "error" ? `${text} · ended early` : text,
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

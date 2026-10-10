// The sandcastle mod: shows a live run in the Claude Code session, in the status view's own
// castle, glyphs and colours - a band above the prompt, a notice when a ticket needs a person -
// and submits a prompt when the run ends, so the session that started it closes it. Between runs,
// in a project `sandcastle init` has set up, it draws a quiet idle mark in sand above the prompt.
//
// It reads `.sandcastle/logs/run.json` under the session's root and asks whether the run's
// process is alive. Once the session has used the sandcastle skill it also follows a run this
// session started in another directory: every run records the id of the Claude Code session
// that started it, and lists itself in a machine-wide directory while it lives. It writes
// nothing, opens no pane and calls no model but for one thing: while a run this session started is
// live, it refreshes the session's prompt cache (keep-warm.ts). It does nothing at all in a
// project with no `.sandcastle/` until the skill is used.

import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import { band, building, CASTLE_FRAMES, endedHow, endPrompt, followable, HELD, line, needing, parse, parseRegistry, REGISTRY_SCRIPT, rows, type Run, SAND, startedBy, summarise } from "./run-state.ts";
import { kitRunning } from "./run-live.ts";
import { activity, afterTurn, type Kept, keepWarm, parseKept, settle } from "./keep-warm.ts";
import { afterRead, type Choice, choiceAfter, dismissalEnded, due, MARK_USAGE, machineSwitch, markAction, markReport, markText, type MarkInput, parseChoice, parseEntry, readyIds, SETTINGS_SCRIPT, type Trigger } from "./idle.ts";

const view = atom({ plugin: "sandcastle", key: "view" } as const, null);
/** The castle frame the band draws: an index into CASTLE_FRAMES. */
const castle = atom({ plugin: "sandcastle", key: "castle" } as const, HELD);
/** The castle tower (a chess rook: one cell, text style, no emoji form) that leads the idle mark's row. */
const MARK_ICON = "♜";
/** The idle mark's line the band draws between runs, in sand; null for none. */
const markLine = atom({ plugin: "sandcastle", key: "mark" } as const, null);
/** The cache refresh's row the band draws under the castle; null for none. */
const warmLine = atom({ plugin: "sandcastle", key: "warm" } as const, null);
/** What the cache refresh remembers; `$.state`, because a reload restarts module variables and not state. */
const kept = atom({ plugin: "sandcastle", key: "kept" } as const, { misses: 0 } as Kept);

const RECORD = ".sandcastle/logs/run.json";
// What makes a project set up: `sandcastle init` writes it.
const CONFIG = ".sandcastle/config.ts";
const LIVE_MS = 3000;
// A read of the queue is given up after this long, so one stuck tracker call never blocks the next.
const READ_TIMEOUT_MS = 20000;
// With no run alive the record is read this often: a run started by hand shows within it.
const IDLE_MS = 15000;
// Room for the control Claude Code draws at the band's right end.
const BAND_MARGIN = 4;

const NOTE =
  "\n\n---\nThe sandcastle mod is loaded in this Claude Code session. When a run this session started ends, in this project or any other directory, the mod submits a prompt that says so: skip `sandcastle wait` in step 3 of the run action, and close the run (run.md) when that prompt arrives. The mod also keeps this session's prompt cache warm while the run is live, so skip the skill's keep-warm tick.";

// Module variables on purpose: a reload starts the watch over, and the first look at the
// record rebuilds all of it but `armed` and each project's `since`, which `$.store` keeps.
let starting: Promise<boolean> | undefined;
/** The project the watch reads. A `/cd` does not move it. */
let watched: string | undefined;
/** The sandcastle skill was used in this session, so this session closes the run. */
let armed = false;
/** The session root's own record and store entry are taken up (once `.sandcastle/` exists). */
let adopted = false;
/** What one watched project's looks remember. */
type Seen = {
  /**
   * `startedAt` of the last record whose end this session has accounted for. A record that
   * differs and whose process is gone is a run that ended - whether or not a look ever saw it
   * alive: a run that dies on a missing Docker lasts seconds, inside one idle look.
   */
  since?: string;
  /** False until the first look: what that finds was there before, so it announces nothing new. */
  primed: boolean;
  needs: string[];
};
const seen = new Map<string, Seen>();
const seenAt = (root: string): Seen => seen.get(root) ?? (seen.set(root, { primed: false, needs: [] }).get(root) as Seen);
/**
 * Roots, resolved, of runs this session started outside its own root. Kept once seen: the
 * registry file goes when the run exits (or later, once its Herdr tab has its report), and the end
 * is still to be announced.
 */
const followed = new Set<string>();
/**
 * Every id this session has had in this process. `/clear` gives the session a new one, and a run
 * started before it records the old: the terminal that started the run still closes it.
 */
const known = new Set<string>();
/** What makes the next idle look read the queue ahead of the entry's age; one is enough, they all mean "now". */
let trigger: Trigger | undefined;
/** A queue read is under way in this session: one at a time. */
let reading = false;
/** A trigger fired during that read, which may have started before what the trigger is about. */
let again = false;
/** The sandcastle skill was used and its turn has not ended: the labelling it may do is still to come. */
let skillTurn = false;
/** The `sandcastle` to run, found once: the kit's own `bin/sandcastle` beside the mod, else the one on PATH. */
let kitBin: string | undefined;
/** The last round drew the idle mark (no needs-you text, no live run of the root): a choice made now redraws it at once. */
let idling = false;
let drawn = "";
/** The cache refresh's timer while a run of this session is live; undefined otherwise. */
let warmTimer: { cancel: () => void } | undefined;
/** The run the refresh looks after: this session's newest live one. */
let warmRun: Run | undefined;
/** A refresh request is under way: one at a time, and a tick that finds it waits for the next. */
let refreshing = false;
/** The cache refresh's row the band was last told to draw. */
let warmed: string | null = null;
/** null: nothing pinned or cleared since this load, so the first call always reaches Claude Code. */
let pinned: string | undefined | null = null;

/**
 * Whether `path` is a plain file. A plain file only: in a stranger's repository the path could be
 * a link to a device that never ends.
 */
async function plain($: EngineInterface, path: string): Promise<boolean> {
  const at = await stat($, path);
  return at !== undefined && at.kind === "file" && !at.isLink;
}

/** The one place the mod stats a path; `resolve` also answers where the path lands. Undefined when it cannot be read. */
async function stat($: EngineInterface, path: string, resolve = false) {
  try {
    return await $.fs.stat(path, resolve ? { resolve: true } : undefined);
  } catch {
    return undefined;
  }
}

async function record($: EngineInterface, root: string): Promise<Run | undefined> {
  const path = `${root}/${RECORD}`;
  try {
    if (!(await plain($, path))) return undefined;
    return parse(await $.fs.read(path));
  } catch {
    return undefined;
  }
}

const isProject = ($: EngineInterface, root: string) => $.fs.exists(`${root}/.sandcastle`);

/** The one place the mod starts a process. */
const exec = ($: EngineInterface, argv: string[], init?: { cwd?: string; timeoutMs?: number }) => $.process.run(argv, init);

// Asks for the process's command line and sends nothing to it; that it is the kit's is
// run-live.ts's rule, the same everywhere a run is asked about. The record's `finishedAt` is
// left out on purpose: every turn of one run writes one, a killed run none, and between two
// turns the run is still going.
async function alive($: EngineInterface, pid: number): Promise<boolean> {
  try {
    // `-p` and `-o command=` are the flags BSD `ps` (macOS) and procps-ng share. BusyBox has no
    // `-p`: the call fails, so there it is no live run and no false end.
    const ps = await exec($, ["ps", "-p", String(pid), "-o", "command="]);
    return kitRunning(pid, () => (ps.exitCode === 0 ? ps.stdout : undefined));
  } catch {
    return false;
  }
}

type Kept = { session?: string; since?: string } | undefined;

// Kept across a restart of Claude Code: a resumed session still hears that its run ended.
// One entry per project, so of two sessions that used the skill there the later one owns it.
async function remember($: EngineInterface, root: string) {
  const since = seenAt(root).since;
  await $.store.set(root, { session: await $.session.id(), ...(since === undefined ? {} : { since }) });
}

/** The session's id, kept in `known`. */
async function me($: EngineInterface): Promise<string> {
  const id = await $.session.id();
  known.add(id);
  return id;
}

/** Whether `run` records an id this session has had. */
const ours = (run: Run | undefined) => [...known].some((id) => startedBy(run, id));

async function owns($: EngineInterface, kept: Kept): Promise<boolean> {
  return kept?.session === (await $.session.id());
}

/** The idle mark the band was last told to draw; undefined until the first look of this load. */
let marked: string | null | undefined;

/**
 * The idle mark is drawn by the band, not pinned as a status line: Claude Code prefixes every
 * pinned status line with its warning triangle and paints it in its notice colour, and a mod
 * cannot change either. The pinned line stays for what needs a person.
 */
async function place($: EngineInterface, text: string | undefined) {
  const line = text ?? null;
  if (line === marked) return;
  marked = line;
  await update($, markLine, () => line);
}

function pin($: EngineInterface, text: string | undefined) {
  if (text === pinned) return;
  pinned = text;
  $.ui.status(text);
}

/** The castle's timer while it builds; undefined while it stands still. */
let tick: { cancel: () => void } | undefined;

// A timer of its own, apart from the look at the record: a frame writes the one atom and reads
// nothing, and a look never waits for a frame. One write per frame, about one a second while it
// builds and none while it holds - far inside the band's redraw rate, so the prompt never flickers.
function animate($: EngineInterface, on: boolean) {
  if (on === (tick !== undefined)) return;
  if (!on) {
    tick?.cancel();
    tick = undefined;
    void update($, castle, () => HELD);
    return;
  }
  const show = (i: number) => {
    void update($, castle, () => i);
    tick = $.clock.after(CASTLE_FRAMES[i]!.ms, () => show((i + 1) % CASTLE_FRAMES.length));
  };
  show(0);
}

async function draw($: EngineInterface, run: Run | undefined) {
  const next = run ? summarise(run) : null;
  animate($, next !== null && building(next));
  if (JSON.stringify(next) === drawn) return;
  drawn = JSON.stringify(next);
  await update($, view, () => next);
}

/**
 * One look at one project's record: the live run, if there is one. `follow` is set for a
 * followed root: its run is this session's by the id it records, so it is never "old" and needs
 * no store entry; a record that is another session's run, or none, ends the following.
 */
async function look($: EngineInterface, root: string, follow = false): Promise<Run | undefined> {
  const run = await record($, root);
  const w = seenAt(root);
  const first = !follow && !w.primed;
  w.primed = true;
  if (follow && !ours(run)) {
    followed.delete(root);
    seen.delete(root);
    return undefined;
  }
  if (run?.pid !== undefined && (await alive($, run.pid))) {
    const now = needing(run);
    const fresh = now.filter((n) => !w.needs.includes(n));
    // What the first look finds needed a person already: the status line names it, no notice.
    if (!first && fresh.length) $.ui.toast(`${fresh.join(", ")} ${fresh.length > 1 ? "need" : "needs"} you`, { timeoutMs: 10000 });
    w.needs = now;
    return run;
  }
  w.needs = [];
  if (!run?.startedAt || run.startedAt === w.since) return undefined;
  // Read before `since` moves: a store that cannot be read leaves the end to the next look.
  // A run that records the session that started it is that session's, wherever it was started
  // from: the store's "later session owns the project" would have a second session close it too.
  // A run with no id (a plain terminal, Codex, OpenCode) is the store's.
  const mine = armed && (follow || (run.session ? ours(run) : await owns($, (await $.store.get(root)) as Kept)));
  w.since = run.startedAt;
  // The end is accounted for: a later run of this session in that root is found again.
  if (follow) {
    followed.delete(root);
    seen.delete(root);
  }
  // A session that was not waiting for a run meets an old record: nothing ended on its watch.
  if (first && !armed) return undefined;
  // The run closed or left tickets: the count is read again at the next idle look. A followed run
  // too - it may be a second clone of this project, burning down the same tracker.
  trigger = "run-ended";
  const how = endedHow(run);
  if (mine) {
    // The store keeps the old `since` until the turn this starts has begun, which may be much
    // later: a session quit with the prompt still queued hears it again when it is resumed.
    const text = endPrompt(root, run);
    void $.prompt.submit({ text }).then(() => (follow ? undefined : remember($, root))).catch(() => {});
  }
  $.ui.toast(`run ${how}`, { timeoutMs: 10000 });
  return undefined;
}

/**
 * Finds runs this session started outside its own root: the registered live runs whose record
 * names an id this session has had. Fails closed - a shell or a record that cannot be read adds
 * nothing.
 */
async function discover($: EngineInterface, root: string) {
  let out: string;
  try {
    const ls = await exec($, ["sh", "-c", REGISTRY_SCRIPT, "sh", root]);
    if (ls.exitCode !== 0) return;
    out = ls.stdout;
  } catch {
    return;
  }
  for (const other of followable(parseRegistry(out))) {
    if (followed.has(other)) continue;
    const run = await record($, other);
    if (ours(run) && run?.pid !== undefined && (await alive($, run.pid))) followed.add(other);
  }
}

/** The session root's store entry, `/sandcastle-status` and `/sandcastle-mark`, once `.sandcastle/` exists. */
async function adopt($: EngineInterface, root: string) {
  if (adopted || !(await isProject($, root))) return;
  adopted = true;
  const kept = (await $.store.get(root)) as Kept;
  if (await owns($, kept)) {
    armed = true;
    seenAt(root).since = kept?.since;
  }
  await $.command.register({ name: "sandcastle-status", description: "Show the sandcastle run in this project, with no model turn", immediate: true });
  await $.command.register({ name: "sandcastle-mark", description: "Dismiss the idle mark's ready count, or hide or show the mark, with no model turn", argumentHint: "[dismiss|hide|show]", immediate: true });
}

/** The shared cache entry's key: one per project root, apart from the session entry under the bare root. */
const readyKey = (root: string) => `ready:${root}`;

/**
 * The command that reads the queue. The mod is linked from the kit's checkout, so `bin/sandcastle`
 * sits beside it; a mod copied elsewhere finds none and uses the `sandcastle` on PATH.
 */
async function sandcastle($: EngineInterface): Promise<string> {
  if (kitBin !== undefined) return kitBin;
  kitBin = "sandcastle";
  // No stat of the mod's own folder, or no file beside it: the one on PATH.
  const dir = ((await stat($, $.plugin.root, true))?.realPath ?? $.plugin.root).replace(/\/+$/, "");
  const bin = `${dir.slice(0, Math.max(dir.lastIndexOf("/"), 0))}/bin/sandcastle`;
  if (await plain($, bin)) kitBin = bin;
  return kitBin;
}

/** The ready ids from `sandcastle queue --json`, or undefined when the read failed or timed out. */
async function readQueue($: EngineInterface, root: string): Promise<string[] | undefined> {
  try {
    const out = await exec($, [await sandcastle($), "queue", "--json"], { cwd: root, timeoutMs: READ_TIMEOUT_MS });
    return out.exitCode === 0 && !out.isStdoutTruncated ? readyIds(out.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the queue into the shared entry, one read at a time in this session; never awaited by a
 * look or a render, so a slow or hung tracker holds nothing up. A failed read keeps the last good
 * ids and their time. Another session racing to the same stale entry may read too: accepted.
 */
async function refresh($: EngineInterface, root: string, forced: boolean) {
  if (reading) {
    // An age that is due again is the read under way; only a trigger asks for another after it.
    if (forced) again = true;
    return;
  }
  reading = true;
  try {
    do {
      again = false;
      const ids = await readQueue($, root);
      const prior = parseEntry(await $.store.get(readyKey(root)));
      await $.store.set(readyKey(root), afterRead(prior, ids, await $.clock.now()));
    } while (again);
  } catch {
    // A store or clock that cannot be reached leaves the entry as it was: the next look reads again.
  } finally {
    reading = false;
  }
}

/** The person's choices for a project's mark: the store's entry, none when it holds nothing usable. */
const markKey = (root: string) => `mark:${root}`;

/** The machine switch: one read of the personal settings, on unless they say `"idleMark": false`. */
async function machineOn($: EngineInterface): Promise<boolean> {
  try {
    const out = await exec($, ["sh", "-c", SETTINGS_SCRIPT]);
    if (out.exitCode === 0) return machineSwitch(out.stdout);
  } catch {
    // Settings that cannot be read leave the switch on.
  }
  return true;
}

/**
 * Everything the idle mark is decided from that the mod already holds: set up is one `stat` of
 * `.sandcastle/config.ts`, the machine switch one read of the personal settings, the choices and
 * the count what the store holds. Nothing here reaches the tracker.
 */
async function facts($: EngineInterface, root: string): Promise<MarkInput> {
  const setUp = await plain($, `${root}/${CONFIG}`);
  const idleMark = setUp ? await machineOn($) : true;
  const now = await $.clock.now();
  const entry = parseEntry(await $.store.get(readyKey(root)));
  const choice = parseChoice(await $.store.get(markKey(root)));
  return { setUp, idleMark, hidden: choice?.hidden, dismissed: choice?.dismissed, entry, now };
}

/**
 * The idle mark's text for the session root's project, which no followed run changes - a read it
 * starts is for the next look to show.
 */
async function mark($: EngineInterface, root: string): Promise<string | undefined> {
  const input = await facts($, root);
  if (!input.setUp || !input.idleMark) return markText(input);
  if (input.dismissed && dismissalEnded(input.dismissed, input.entry, input.now)) {
    // A ticket not in the dismissal is ready: the dismissal is over for good, not only while it shows.
    await $.store.set(markKey(root), { hidden: input.hidden === true });
    input.dismissed = undefined;
  }
  if (!input.hidden && due(input.entry, input.now!, trigger)) {
    void refresh($, root, trigger !== undefined);
    trigger = undefined;
  }
  return markText(input);
}

/** `/sandcastle-mark`: the choice is kept, the line redrawn at once if the mark is what it shows, the reply is text. */
async function choose($: EngineInterface, root: string, args: string): Promise<string> {
  const action = markAction(args);
  if (action === undefined) return MARK_USAGE;
  if (action !== "report") {
    const input = await facts($, root);
    const prior: Choice = { hidden: input.hidden === true, ...(input.dismissed ? { dismissed: input.dismissed } : {}) };
    await $.store.set(markKey(root), choiceAfter(action, prior, input.entry, input.now));
    if (idling) await place($, await mark($, root));
  }
  const input = await facts($, root);
  const done = { dismiss: "Dismissed: the count stays quiet until a ticket not ready now becomes ready.", hide: "Hidden in this project until /sandcastle-mark show.", show: "Shown." };
  return action === "report" ? markReport(input) : `${done[action]}\n${markReport(input)}`;
}

const REFRESH_PROMPT = "Reply with the single word: ok";

/**
 * One tick of the cache refresh: builds the rule's input, sends the request when it says so, keeps
 * what it found in `$.state` and redraws the row. A request that is not answered is a miss, logged.
 * Nothing here throws into the timer: a failed read leaves the row as it was.
 */
async function warm($: EngineInterface) {
  const run = warmRun;
  if (!run || refreshing) return;
  try {
    const now = await $.clock.now();
    let memory = parseKept(await read($, kept));
    // Another run starts the count of misses over; the turn that ended last still counts.
    if (memory.run !== run.startedAt) memory = { misses: 0, ...(memory.turnEnd === undefined ? {} : { turnEnd: memory.turnEnd }), ...(run.startedAt === undefined ? {} : { run: run.startedAt }) };
    const usage = await $.session.usage();
    // The run's start is the floor: the turn that started it ended about then, and a reload forgets the later ones.
    const input = (m: Kept) => ({ enabled: run.keepWarm, live: true, lastActivity: activity(m, Date.parse(run.startedAt ?? "")), last: m.last, misses: m.misses, rateLimits: usage.rateLimits, now });
    let verdict = keepWarm(input(memory));
    if (verdict.refresh) {
      refreshing = true;
      try {
        const result = await $.model.fork({ prompt: REFRESH_PROMPT });
        if (!result.isAnswered) $.ui.log(`sandcastle: the cache refresh was not answered (${result.reason}); counted as a miss`);
        memory = settle(memory, result, usage.context.tokens ?? 0, await $.clock.now());
        verdict = keepWarm(input(memory));
      } finally {
        refreshing = false;
      }
    }
    await update($, kept, () => memory);
    await shine($, verdict.band ?? null);
  } catch {
    // A usage or request that failed is tried again at the next tick.
  }
}

async function shine($: EngineInterface, line: string | null) {
  if (line === warmed) return;
  warmed = line;
  await update($, warmLine, () => line);
}

/** Starts the refresh's timer while `run` is live and stops it when none is; the tick itself decides whether to send. */
function keepCacheOf($: EngineInterface, run: Run | undefined) {
  warmRun = run;
  if (run && !warmTimer) {
    warmTimer = $.clock.every(60_000, () => void warm($));
    void warm($);
  } else if (!run && warmTimer) {
    warmTimer.cancel();
    warmTimer = undefined;
    void shine($, null);
  }
}

/** One round: every watched project once; true while a run is alive. The newest live run is the one drawn. */
async function round($: EngineInterface, root: string): Promise<boolean> {
  await adopt($, root);
  await me($);
  if (armed) await discover($, root);
  const live: Run[] = [];
  const own = adopted ? await look($, root) : undefined;
  if (own) live.push(own);
  // oxlint-disable-next-line no-useless-spread -- a snapshot: `look` deletes from `followed`, and other rounds change it across the awaits
  for (const other of [...followed]) {
    const run = await look($, other, true);
    if (run) live.push(run);
  }
  const shown = live.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  const now = shown ? needing(shown) : [];
  // The line is the needs-you text while a live run needs a person, and otherwise the idle mark -
  // unless a run is alive, here or followed elsewhere: its castle and counts take over, and a
  // mark above them would read as a second, stale queue. Last, so after the end notice: the mark
  // returns once the run is over.
  idling = !now.length && !shown && adopted;
  // The refresh looks after a run this session started or follows (or its root's, when it records no session and this one closes it).
  keepCacheOf($, live.filter((run) => armed && (ours(run) || !run.session)).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0]);
  pin($, now.length ? `${now.join(", ")} - /sandcastle-status` : undefined);
  await place($, idling ? await mark($, root) : undefined);
  await draw($, shown);
  return live.length > 0;
}

async function watch($: EngineInterface, root: string) {
  let live = false;
  try {
    live = await round($, root);
  } catch {
    // A look that failed is tried again at the next one.
  }
  $.clock.after(live ? LIVE_MS : IDLE_MS, () => void watch($, root));
}

/**
 * Starts the loop. In a project with no `.sandcastle/` it starts only when the session has used
 * the skill (`used`): the loop then watches runs started from here, and the project's own record
 * once `sandcastle init` makes it.
 */
async function start($: EngineInterface, root: string, used: boolean): Promise<boolean> {
  if (!used && !(await isProject($, root))) return false;
  watched = root;
  // Awaited: what the first look finds is what every later one is compared with.
  await watch($, root);
  return true;
}

/** Starts the watch, once however many callers ask at the same time; false in a project with no `.sandcastle/` unless `used`. */
function begin($: EngineInterface, root: string, used = false): Promise<boolean> {
  starting ??= start($, root, used).then(
    (ok) => {
      if (!ok) starting = undefined;
      return ok;
    },
    (error) => {
      starting = undefined;
      throw error;
    },
  );
  return starting;
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const out = await next(e);
    await begin($, await $.session.root());
    return out;
  });

  // `/clear` and a `/resume` inside Claude Code change the session under the same process and
  // start no session anew. The arming stays with this terminal, and the store learns the new
  // session id, so it is still this one's after a restart.
  on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
    const out = await next(e);
    if (watched === undefined) return out;
    if (await owns($, (await $.store.get(watched)) as Kept)) armed = true;
    else if (armed) await remember($, watched);
    return out;
  });

  on("skill.prompt", { skill: "sandcastle" }, async ($, e, next) => {
    const out = await next(e);
    const root = await $.session.root();
    // Whatever the root, the note is true: a run this session starts records the session's id and
    // is followed wherever it lives, so the end prompt arrives. (`sandcastle init` may have made
    // the project after this session started; a `/cd` leaves the watch on the first root, which
    // the id-based follow does not depend on.)
    await me($);
    // The skill may just have labelled tickets: the next idle look reads the count. Triaging
    // labels them well after this hook, so the end of the turn asks for one more read.
    trigger = "skill";
    skillTurn = true;
    await begin($, root, true);
    await remember($, root);
    armed = true;
    return { text: out.text + NOTE };
  });

  // The turn that used the skill is over: whatever it labelled is labelled, so the count is read
  // again. A subagent's turn (one with an `agentId`) is not it: triage reads tickets through
  // subagents before it labels, so their ends would spend the read too early.
  on("turn.complete", async ($, e, next) => {
    const out = await next(e);
    if (skillTurn && e.agentId === undefined) {
      skillTurn = false;
      trigger = "skill";
    }
    // The main thread's turn used the cache; a subagent's has its own.
    if (e.agentId === undefined) {
      const at = await $.clock.now();
      await update($, kept, (m) => afterTurn(parseKept(m), at));
    }
    return out;
  });

  on("command.run", { command: "sandcastle-status" }, async ($) => {
    const roots = [await $.session.root(), ...followed];
    const blocks: string[] = [];
    for (const root of roots) {
      const run = await record($, root);
      if (!run) continue;
      const live = run.pid !== undefined && (await alive($, run.pid));
      const head = live ? "live" : run.finishedAt ? `ended (exit ${run.exitCode ?? "unknown"})` : "ended without a clean exit";
      blocks.push(
        [
          ...(roots.length > 1 ? [root] : []),
          `${head} · ${line(run, live)}`,
          ...rows(run),
          ...(live ? [] : ["`sandcastle report` prints the closing summary."]),
        ].join("\n"),
      );
    }
    return { text: blocks.join("\n\n") || "No sandcastle run on record in this project." };
  });

  on("command.run", { command: "sandcastle-mark" }, async ($, e) => ({ text: await choose($, await $.session.root(), e.args) }));

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const now = await read($, view);
    const line = await read($, markLine);
    const cache = await read($, warmLine);
    if ((now === null && line === null && cache === null) || e.props.hasSurvey) return next(e);
    const frame = CASTLE_FRAMES[await read($, castle)] ?? CASTLE_FRAMES[HELD];
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {line === null ? null : (
          <Box flexDirection="row" columnGap={1}>
            <Text color={SAND.top} bold>
              {MARK_ICON}
            </Text>
            <Text color={SAND.name}>{line}</Text>
          </Box>
        )}
        {now === null
          ? null
          : band(now, e.props.bodyColumns - BAND_MARGIN, frame).map((row) => (
              <Box flexDirection="row" columnGap={2}>
                {row.map((seg) => (
                  <Box flexDirection="row" columnGap={1}>
                    <Text color={seg.colour} bold={seg.bold}>
                      {seg.text}
                    </Text>
                    {seg.count === undefined ? null : (
                      <Text color={seg.colour} bold>
                        {String(seg.count)}
                      </Text>
                    )}
                  </Box>
                ))}
              </Box>
            ))}
        {cache === null ? null : <Text color={SAND.name}>{cache}</Text>}
        {await next(e)}
      </Box>
    );
  });
};

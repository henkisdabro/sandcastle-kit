// The sandcastle mod: shows a live run in the Claude Code session, in the status view's own
// castle, glyphs and colours - a band above the prompt, a notice when a ticket needs a person -
// and submits a prompt when the run ends, so the session that started it closes it.
//
// It reads `.sandcastle/logs/run.json` under the session's root and asks whether the run's
// process is alive. Once the session has used the sandcastle skill it also follows a run this
// session started in another directory: every run records the id of the Claude Code session
// that started it, and lists itself in a machine-wide directory while it lives. It writes
// nothing, opens no pane and calls no model, and it does nothing at all in a project with no
// `.sandcastle/` until the skill is used.

import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import { band, followable, line, needing, parse, parseRegistry, REGISTRY_SCRIPT, rows, type Run, RUN_COMMAND, startedBy, summarise } from "./run-state";

const view = atom({ plugin: "sandcastle", key: "view" } as const, null);

const RECORD = ".sandcastle/logs/run.json";
const LIVE_MS = 3000;
// With no run alive the record is read this often: a run started by hand shows within it.
const IDLE_MS = 15000;
// Room for the control Claude Code draws at the band's right end.
const BAND_MARGIN = 4;

const NOTE =
  "\n\n---\nThe sandcastle mod is loaded in this Claude Code session. When a run this session started ends, in this project or any other directory, the mod submits a prompt that says so: skip `sandcastle wait` in step 3 of the run action, and close the run (run.md) when that prompt arrives.";

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
 * registry file goes when the run exits, and the end is still to be announced.
 */
const followed = new Set<string>();
let drawn = "";
/** null: nothing pinned or cleared since this load, so the first call always reaches Claude Code. */
let pinned: string | undefined | null = null;

async function record($: EngineInterface, root: string): Promise<Run | undefined> {
  const path = `${root}/${RECORD}`;
  try {
    // A plain file only: in a stranger's repository the path could be a link to a device
    // that never ends.
    const at = await $.fs.stat(path);
    if (at.kind !== "file" || at.isLink) return undefined;
    return parse(await $.fs.read(path));
  } catch {
    return undefined;
  }
}

const isProject = ($: EngineInterface, root: string) => $.fs.exists(`${root}/.sandcastle`);

/** The one place the mod starts a process. */
const exec = ($: EngineInterface, argv: string[]) => $.process.run(argv);

// Asks for the process's command line and sends nothing to it. The pid alone is not enough:
// it comes round again as some other process, and the run would seem to come back to life.
// `finishedAt` cannot say it either - every turn of one run writes one, a killed run none.
async function alive($: EngineInterface, pid: number): Promise<boolean> {
  try {
    // `-p` and `-o command=` are the flags BSD `ps` (macOS) and procps-ng share. BusyBox has no
    // `-p`: the call fails, so there it is no live run and no false end.
    const ps = await exec($, ["ps", "-p", String(pid), "-o", "command="]);
    return ps.exitCode === 0 && ps.stdout.includes(RUN_COMMAND);
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

async function owns($: EngineInterface, kept: Kept): Promise<boolean> {
  return kept?.session === (await $.session.id());
}

function pin($: EngineInterface, text: string | undefined) {
  if (text === pinned) return;
  pinned = text;
  $.ui.status(text);
}

async function draw($: EngineInterface, run: Run | undefined) {
  const next = run ? summarise(run) : null;
  if (JSON.stringify(next) === drawn) return;
  drawn = JSON.stringify(next);
  await update($, view, () => next);
}

/**
 * One look at one project's record: the live run, if there is one. `session` is set for a
 * followed root: its run is this session's by the id it records, so it is never "old" and needs
 * no store entry; a record that is another session's run, or none, ends the following.
 */
async function look($: EngineInterface, root: string, session?: string): Promise<Run | undefined> {
  const run = await record($, root);
  const w = seenAt(root);
  const first = session === undefined && !w.primed;
  w.primed = true;
  if (session !== undefined && !startedBy(run, session)) {
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
  const mine = armed && (session !== undefined || (await owns($, (await $.store.get(root)) as Kept)));
  w.since = run.startedAt;
  // The end is accounted for: a later run of this session in that root is found again.
  if (session !== undefined) {
    followed.delete(root);
    seen.delete(root);
  }
  // A session that was not waiting for a run meets an old record: nothing ended on its watch.
  if (first && !armed) return undefined;
  const how = run.finishedAt ? `ended (exit ${run.exitCode ?? "unknown"})` : "ended without a clean exit";
  if (mine) {
    // The store keeps the old `since` until the turn this starts has begun, which may be much
    // later: a session quit with the prompt still queued hears it again when it is resumed.
    const text = `The sandcastle run in ${root} ${how}. Close it now: read run.md in the sandcastle skill's directory and follow it.`;
    void $.prompt.submit({ text }).then(() => (session === undefined ? remember($, root) : undefined)).catch(() => {});
  }
  $.ui.toast(`run ${how}`, { timeoutMs: 10000 });
  return undefined;
}

/**
 * Finds runs this session started outside its own root: the registered live runs whose record
 * names this session's id. Fails closed - a shell or a record that cannot be read adds nothing.
 */
async function discover($: EngineInterface, root: string, session: string) {
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
    if (startedBy(run, session) && run?.pid !== undefined && (await alive($, run.pid))) followed.add(other);
  }
}

/** The session root's store entry and `/sandcastle-status`, once `.sandcastle/` exists. */
async function adopt($: EngineInterface, root: string) {
  if (adopted || !(await isProject($, root))) return;
  adopted = true;
  const kept = (await $.store.get(root)) as Kept;
  if (await owns($, kept)) {
    armed = true;
    seenAt(root).since = kept?.since;
  }
  await $.command.register({ name: "sandcastle-status", description: "Show the sandcastle run in this project, with no model turn", immediate: true });
}

/** One round: every watched project once; true while a run is alive. The newest live run is the one drawn. */
async function round($: EngineInterface, root: string): Promise<boolean> {
  await adopt($, root);
  const session = await $.session.id();
  if (armed) await discover($, root, session);
  const live: Run[] = [];
  const own = adopted ? await look($, root) : undefined;
  if (own) live.push(own);
  for (const other of [...followed]) {
    const run = await look($, other, session);
    if (run) live.push(run);
  }
  const shown = live.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  const now = shown ? needing(shown) : [];
  pin($, now.length ? `${now.join(", ")} - /sandcastle-status` : undefined);
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
    await begin($, root, true);
    await remember($, root);
    armed = true;
    return { text: out.text + NOTE };
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

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const now = await read($, view);
    if (now === null || e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {band(now, e.props.bodyColumns - BAND_MARGIN).map((row) => (
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
        {await next(e)}
      </Box>
    );
  });
};

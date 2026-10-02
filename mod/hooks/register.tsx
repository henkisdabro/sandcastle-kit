// The sandcastle mod: shows a live run in the Claude Code session, in the status view's own
// castle, glyphs and colours - a band above the prompt, a notice when a ticket needs a person -
// and submits a prompt when the run ends, so the session that started it closes it.
//
// It reads `.sandcastle/logs/run.json` under the session's root and asks whether the run's
// process is alive. It writes nothing to the project, opens no pane and calls no model, and
// it does nothing at all in a project with no `.sandcastle/`.

import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import { band, line, needing, parse, rows, type Run, RUN_COMMAND, summarise } from "./run-state";

const view = atom({ plugin: "sandcastle", key: "view" } as const, null);

const RECORD = ".sandcastle/logs/run.json";
const LIVE_MS = 3000;
// With no run alive the record is read this often: a run started by hand shows within it.
const IDLE_MS = 15000;
// Room for the control Claude Code draws at the band's right end.
const BAND_MARGIN = 4;

const NOTE =
  "\n\n---\nThe sandcastle mod is loaded in this Claude Code session. When a run in this project ends, the mod submits a prompt that says so: skip the watcher in step 3 of the run action, and close the run (run.md) when that prompt arrives.";

// Module variables on purpose: a reload starts the watch over, and the first look at the
// record rebuilds all of it but `armed` and `since`, which `$.store` keeps.
let starting: Promise<boolean> | undefined;
/** The project the watch reads. A `/cd` does not move it. */
let watched: string | undefined;
/** The sandcastle skill was used in this session, so this session closes the run. */
let armed = false;
/**
 * `startedAt` of the last record whose end this session has accounted for. A record that
 * differs and whose process is gone is a run that ended - whether or not a look ever saw it
 * alive: a run that dies on a missing Docker lasts seconds, inside one idle look.
 */
let since: string | undefined;
/** False until the first look: what that finds was there before, so it announces nothing new. */
let primed = false;
let needs: string[] = [];
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

// Asks for the process's command line and sends nothing to it. The pid alone is not enough:
// it comes round again as some other process, and the run would seem to come back to life.
// `finishedAt` cannot say it either - every turn of one run writes one, a killed run none.
async function alive($: EngineInterface, pid: number): Promise<boolean> {
  try {
    const ps = await $.process.run(["ps", "-p", String(pid), "-o", "command="]);
    return ps.exitCode === 0 && ps.stdout.includes(RUN_COMMAND);
  } catch {
    return false;
  }
}

type Kept = { session?: string; since?: string } | undefined;

// Kept across a restart of Claude Code: a resumed session still hears that its run ended.
// One entry per project, so of two sessions that used the skill there the later one owns it.
async function remember($: EngineInterface, root: string) {
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

/** One look at the record; true while a run is alive. */
async function look($: EngineInterface, root: string): Promise<boolean> {
  const run = await record($, root);
  const first = !primed;
  primed = true;
  if (run?.pid !== undefined && (await alive($, run.pid))) {
    const now = needing(run);
    const fresh = now.filter((n) => !needs.includes(n));
    // What the first look finds needed a person already: the status line names it, no notice.
    if (!first && fresh.length) $.ui.toast(`${fresh.join(", ")} ${fresh.length > 1 ? "need" : "needs"} you`, { timeoutMs: 10000 });
    needs = now;
    pin($, now.length ? `${now.join(", ")} - /sandcastle-status` : undefined);
    await draw($, run);
    return true;
  }
  needs = [];
  pin($, undefined);
  await draw($, undefined);
  if (!run?.startedAt || run.startedAt === since) return false;
  // Read before `since` moves: a store that cannot be read leaves the end to the next look.
  const mine = armed && (await owns($, (await $.store.get(root)) as Kept));
  since = run.startedAt;
  // A session that was not waiting for a run meets an old record: nothing ended on its watch.
  if (first && !armed) return false;
  const how = run.finishedAt ? `ended (exit ${run.exitCode ?? "unknown"})` : "ended without a clean exit";
  if (mine) {
    // The store keeps the old `since` until the turn this starts has begun, which may be much
    // later: a session quit with the prompt still queued hears it again when it is resumed.
    const text = `The sandcastle run in ${root} ${how}. Close it now: read run.md in the sandcastle skill's directory and follow it.`;
    void $.prompt.submit({ text }).then(() => remember($, root)).catch(() => {});
  }
  $.ui.toast(`run ${how}`, { timeoutMs: 10000 });
  return false;
}

async function watch($: EngineInterface, root: string) {
  let live = false;
  try {
    live = await look($, root);
  } catch {
    // A look that failed is tried again at the next one.
  }
  $.clock.after(live ? LIVE_MS : IDLE_MS, () => void watch($, root));
}

async function start($: EngineInterface, root: string): Promise<boolean> {
  if (!(await $.fs.exists(`${root}/.sandcastle`))) return false;
  const kept = (await $.store.get(root)) as Kept;
  if (await owns($, kept)) {
    armed = true;
    since = kept?.since;
  }
  watched = root;
  // Awaited: what the first look finds is what every later one is compared with.
  await watch($, root);
  await $.command.register({ name: "sandcastle-status", description: "Show the sandcastle run in this project, with no model turn", immediate: true });
  return true;
}

/** Starts the watch in a sandcastle project, once however many callers ask at the same time; false anywhere else. */
function begin($: EngineInterface, root: string): Promise<boolean> {
  starting ??= start($, root).then(
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
    // `sandcastle init` may have made the project after this session started. After a `/cd`
    // the watch is still on the first project: no note, so the skill arranges its own watcher.
    if (!(await begin($, root)) || root !== watched) return out;
    await remember($, root);
    armed = true;
    return { text: out.text + NOTE };
  });

  on("command.run", { command: "sandcastle-status" }, async ($) => {
    const run = await record($, await $.session.root());
    if (!run) return { text: "No sandcastle run on record in this project." };
    const live = run.pid !== undefined && (await alive($, run.pid));
    const head = live ? "live" : run.finishedAt ? `ended (exit ${run.exitCode ?? "unknown"})` : "ended without a clean exit";
    return { text: [`${head} · ${line(run, live)}`, ...rows(run), ...(live ? [] : ["`sandcastle report` prints the closing summary."])].join("\n") };
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

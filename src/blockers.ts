// What holds a ticket back. A blocker is named in the ticket body as
// "Blocked by #12", "Depends on ENG-42" or "Blocked by .scratch/x/issues/03-y.md",
// or declared by the tracker itself (a ticket file's "Blocked by: 01"): a
// GitHub issue or pull request, a Linear issue (project.blockers.linear), a
// ticket file, or a ticket on the project's own tracker. Only the tracker holds
// the queue; what a ticket can wait for is broader.
//
// A blocker that cannot be read counts as open: guessing wrong there starts
// work on a missing foundation.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Project } from "./config.ts";
import { mergedByHand } from "./run.ts";
import { USER_CONFIG } from "./sandbox.ts";
import { DEFAULT_DONE, refOf, statusOf, type Tracker } from "./tracker.ts";

export type Ref = { kind: "github" | "linear" | "file" | "ticket"; id: string };
// `closed-unmerged`: closed as not planned, so the work it stood for will never land.
export type Blocker = Ref & { state: "open" | "closed" | "closed-unmerged" | "unreadable" };

export const refLabel = (r: Ref) => (r.kind === "github" ? `#${r.id}` : r.id);

const TRIGGER = "(?:blocked by|depends on):?\\s+";

const tokens = (project: Project) => {
  const alts = ["#\\d+"];
  const linear = project.blockers?.linear ?? [];
  if (linear.length) alts.push(`(?:${linear.map((k) => k.replace(/[^A-Za-z0-9]/g, "")).join("|")})-\\d+`);
  const dir = project.blockers?.files?.dir ?? (project.tracker.kind === "files" ? project.tracker.dir : undefined);
  if (dir) alts.push(`${dir.replace(/^\.?\/+|\/+$/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s,;)]+\\.md`);
  return alts.join("|");
};

// A ticket that quotes example blocker lines (a spec for this parser's own tests, say) was held
// back by issues it never depended on, so code is removed before blockers are read: fenced
// blocks first (a fence line closes only on the same character, at least as long as the
// opener; an unclosed fence runs to the end, as GitHub renders it), then inline spans (a run of
// N backticks to the next run of exactly N, never across a blank line). Not stripped: indented
// (four-space) code blocks and HTML <code>/<pre> - the decision names fenced and inline code only.
export const stripCode = (text: string): string => {
  let fence: { char: string; len: number } | undefined;
  const lines = text.split("\n").map((line) => {
    if (fence) {
      const close = line.match(/^[ \t]*(`+|~+)[ \t]*\r?$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = undefined;
      return "";
    }
    const open = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
    // A backtick fence's info string has no backtick: "```foo```" is inline code.
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], len: open[1].length };
      return "";
    }
    return line;
  });
  return lines.join("\n").replace(/(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g, " ");
};

// `text` is read as given: parseRefs strips code first, blockerProblems also reads the raw body
// to find what the stripping hid.
const refsIn = (project: Project, text: string): Ref[] => {
  const token = tokens(project);
  const phrase = new RegExp(`${TRIGGER}((?:${token})(?:\\s*(?:,|and|&)\\s*(?:${token}))*)`, "gi");
  const seen = new Map<string, Ref>();
  for (const m of text.matchAll(phrase)) {
    for (const t of m[1].match(new RegExp(token, "gi")) ?? []) {
      const ref: Ref = t.startsWith("#")
        ? { kind: "github", id: t.slice(1) }
        : t.toLowerCase().endsWith(".md")
          ? { kind: "file", id: t }
          : { kind: "linear", id: t.toUpperCase() };
      seen.set(`${ref.kind}:${ref.id}`, ref);
    }
  }
  return [...seen.values()];
};

/** Every blocker named after a trigger phrase; a list ("#1, #2 and ENG-3") counts each. */
export const parseRefs = (project: Project, text: string): Ref[] => refsIn(project, stripCode(text));

// Linear's key: the user-level credentials file, then the process
// environment. Never the project's .sandcastle/.env: Sandcastle forwards every
// key in that file into each container, and credentials() refuses this one there.
export const linearKey = () => {
  const file = join(USER_CONFIG, ".env");
  const v = existsSync(file) ? parseEnv(readFileSync(file, "utf8")).LINEAR_API_KEY : undefined;
  return v || process.env.LINEAR_API_KEY;
};

const linearState = async (project: Project, id: string): Promise<Blocker["state"]> => {
  const key = linearKey();
  if (!key) return "unreadable";
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query: "query($id: String!) { issue(id: $id) { state { type } } }", variables: { id } }),
      signal: AbortSignal.timeout(15_000),
    });
    const type = ((await res.json()) as { data?: { issue?: { state?: { type?: string } } } }).data?.issue?.state?.type;
    if (!type) return "unreadable";
    return type === "completed" || type === "canceled" ? "closed" : "open";
  } catch {
    return "unreadable";
  }
};

// Read from the base branch, not the working tree: a blocker counts once its
// done state is on the branch the dependent will start from. A file without a
// `Status:` line, or a missing one, is not done. Both Matt Pocock's layout
// (`Status: done`) and YAML front matter (`status: done`) are read.
const fileState = (project: Project, path: string): Blocker["state"] => {
  try {
    const text = execFileSync("git", ["show", `${project.baseBranch}:${path}`], { encoding: "utf8", cwd: project.root, stdio: ["ignore", "pipe", "ignore"] });
    const status = statusOf(text);
    const done = (project.blockers?.files?.done ?? project.tracker.done ?? DEFAULT_DONE).map((x) => x.toLowerCase());
    return status && done.includes(status) ? "closed" : "open";
  } catch {
    return "open";
  }
};

// The issues API also answers for a pull request (`closed` once merged),
// where `gh issue view` does not. An issue closed as not planned is not done: nobody did the work.
const githubState = (id: string): Blocker["state"] => {
  try {
    const out = execFileSync("gh", ["api", `repos/{owner}/{repo}/issues/${id}`, "--jq", '.state + " " + (.state_reason // "")'], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const [state, reason] = out.split(/\s+/);
    return state !== "closed" ? "open" : reason === "not_planned" ? "closed-unmerged" : "closed";
  } catch {
    return "unreadable";
  }
};

// `known`: ids of tickets in the queue, which are open by definition - no lookup.
export const blockerResolver = (project: Project, tracker: Tracker, known = new Set<string>()) => {
  const cache = new Map<string, Promise<Blocker>>();
  return (ref: Ref): Promise<Blocker> => {
    const key = `${ref.kind}:${ref.id}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        (async () => ({
          ...ref,
          state:
            (ref.kind === "github" || ref.kind === "ticket") && known.has(ref.id) ? "open"
            : ref.kind === "github" ? githubState(ref.id)
            : ref.kind === "linear" ? await linearState(project, ref.id)
            : ref.kind === "ticket" ? (tracker.isClosed(ref.id) === undefined ? "unreadable" : tracker.isClosed(ref.id) ? "closed" : "open")
            : fileState(project, ref.id),
        }))(),
      );
    }
    return cache.get(key)!;
  };
};

type Blocked = { id: string; body?: string };

export type Why = "not-planned" | "held" | "merged-by-hand" | "unqueued";

/** The words after "waits for #B" in the closing summary. */
export const whyShort: Record<Why, string> = {
  "not-planned": "closed as not planned",
  held: "held for a human",
  "merged-by-hand": "merged by hand, closes on push",
  unqueued: "open but not queued",
};

/**
 * Why an open blocker will not close by itself: closed as not planned, held for a person (or merged
 * by one, and closing on the push), or not in the queue. GitHub and ticket-file blockers only: Linear issues and task files have no queue.
 * `queued`: ids the caller knows are in the queue; without it a ticket's own queue label decides.
 * One `tracker.get` per distinct blocker; a ticket that cannot be read says nothing.
 */
export const blockerWhy = (project: Project, tracker: Tracker, queued?: Set<string>) => {
  const seen = new Map<string, Why | undefined>();
  return (b: Blocker): Why | undefined => {
    if (b.state === "closed-unmerged") return "not-planned";
    if (b.state !== "open" || !(b.kind === "ticket" || (b.kind === "github" && tracker.kind === "github")) || queued?.has(b.id)) return undefined;
    const key = `${b.kind}:${b.id}`;
    if (!seen.has(key)) {
      try {
        const t = tracker.get(b.id);
        seen.set(key, t.held ? (mergedByHand(project.root, project.baseBranch, b.id) ? "merged-by-hand" : "held") : (queued ? true : t.status !== project.label) ? "unqueued" : undefined);
      } catch {
        seen.set(key, undefined);
      }
    }
    return seen.get(key);
  };
};

/** Every blocker a ticket names: in its body, and any its tracker declares. */
export const refsOf = (project: Project, tracker: Tracker, t: Blocked): Ref[] => {
  const refs = parseRefs(project, t.body ?? "");
  for (const id of tracker.declaredBlockers(t.id)) refs.push({ kind: "ticket", id });
  return refs;
};

/** The blockers of a ticket that are not closed. */
export const openBlockers = async (project: Project, tracker: Tracker, resolve: ReturnType<typeof blockerResolver>, t: Blocked) =>
  (await Promise.all(refsOf(project, tracker, t).map(resolve))).filter((b) => b.state !== "closed");

// A ticket file's own "Blocked by: 01, 02" line names siblings by number; written in a comment it
// is read by nobody, as a body-style line in a comment is not.
const declaredIn = (project: Project, id: string, text: string): Ref[] => {
  if (project.tracker.kind !== "files" || !/-\d+$/.test(id)) return [];
  const feature = id.replace(/-\d+$/, "");
  return [...stripCode(text).matchAll(/^[ \t]*blocked by:[ \t]*(\d+(?:[ \t]*,?[ \t]*\d+)*)[ \t]*$/gim)].flatMap((m) =>
    m[1].split(/[,\s]+/).filter(Boolean).map((n) => ({ kind: "ticket" as const, id: `${feature}-${String(Number(n)).padStart(2, "0")}` })),
  );
};

type Commented = { id: string; body?: string; comments?: string[]; queued: boolean };

/**
 * Tickets whose comments say "blocked by X" while the body does not: a run
 * reads only the body, so it starts a queued one regardless, and an unqueued
 * one would start the moment it is queued. `stale` means every blocker the
 * comment names is closed, so the note is only clutter.
 */
export const commentOnlyBlocks = async (project: Project, tracker: Tracker, tickets: Commented[]) => {
  const resolve = blockerResolver(project, tracker);
  const found: { issue: string; queued: boolean; blockers: Blocker[]; stale: boolean }[] = [];
  for (const i of tickets) {
    const inBody = new Set(refsOf(project, tracker, i).map((r) => `${r.kind}:${r.id}`));
    const named = new Map<string, Ref>();
    for (const c of i.comments ?? []) for (const r of [...parseRefs(project, c), ...declaredIn(project, i.id, c)]) if (!inBody.has(`${r.kind}:${r.id}`)) named.set(`${r.kind}:${r.id}`, r);
    if (!named.size) continue;
    const blockers = await Promise.all([...named.values()].map(resolve));
    found.push({ issue: i.id, queued: i.queued, blockers, stale: blockers.every((b) => b.state === "closed") });
  }
  return found;
};

export const commentBlockLine = (f: Awaited<ReturnType<typeof commentOnlyBlocks>>[number]) => {
  const names = f.blockers.map((b) => `${refLabel(b)} (${b.state})`).join(", ");
  const who = `${refOf(f.issue)}${f.queued ? "" : " (not queued)"}`;
  if (f.stale) return `${who}: a comment says blocked by ${names} - all closed, so the comment is stale and can be ignored.`;
  return f.queued
    ? `${who}: a comment says blocked by ${names}, but the body does not, and a run reads only the body - it would start this ticket. Move "Blocked by ..." into the body.`
    : `${who}: a comment says blocked by ${names}. When you queue it, put "Blocked by ..." in the body, or a run will start it at once.`;
};

// The to-tickets template writes blockers as a list under a heading (`## Blocked by`, then
// `- #12`). The parser reads only a ref on the `Blocked by` line itself, so such a ticket starts
// before its blocker lands, and nothing else says so.
const LIST_BLOCKERS = /^(?:#+[ \t]*)?(?:blocked by|depends on):?[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*[-*+][ \t]/im;

/**
 * Queued tickets that will never start, or start too soon, because of how their blockers are
 * written: a blocker that does not exist or cannot be read (it counts as open, so the ticket
 * waits for good), tickets that wait for each other, and a Linear-style id the config does not
 * name (the line is ignored, so the ticket starts at once). Each line says what to change.
 */
export const blockerProblems = async (project: Project, tracker: Tracker, queued: Blocked[]): Promise<string[]> => {
  const queuedIds = new Set(queued.map((t) => t.id));
  const resolve = blockerResolver(project, tracker, queuedIds);
  const whyOf = blockerWhy(project, tracker, queuedIds);
  const lines: string[] = [];
  const waits = new Map<string, string[]>();
  for (const t of queued) {
    const who = refOf(t.id);
    const refs = refsOf(project, tracker, t);
    waits.set(t.id, refs.filter((r) => r.kind === "ticket" || r.kind === "github").map((r) => r.id).filter((id) => queued.some((q) => q.id === id)));
    for (const b of await Promise.all(refs.map(resolve))) {
      const name = refLabel(b);
      const why = whyOf(b);
      if (why === "not-planned") lines.push(`${who} waits for ${name}, which was closed as not planned - it will never start. Remove the line, or reopen ${name}.`);
      else if (why === "merged-by-hand") lines.push(`${who} waits for ${name}, which is merged locally and closes on push - it starts once ${name} is closed.`);
      else if (why === "held") lines.push(`${who} waits for ${name}, which is held for a human - it starts once ${name} is closed.`);
      else if (why === "unqueued") lines.push(`${who} waits for ${name}, which is open but not queued - queue ${name} or remove the line.`);
      if (b.state !== "unreadable") continue;
      lines.push(
        b.kind === "ticket"
          ? `${who} waits for ${name}, which does not exist - it will never start. Fix the "Blocked by" line, or remove it.`
          : b.kind === "linear"
            ? `${who} waits for ${name}, which could not be read from Linear${linearKey() ? "" : " (no LINEAR_API_KEY in ~/.config/sandcastle-kit/.env)"} - a blocker that cannot be read counts as open, so it waits.`
            : `${who} waits for ${name}, which gh could not read (no such GitHub issue, or no access) - it counts as open, so it waits.`,
      );
    }
    // Stripped on purpose, so a run starts the ticket without waiting: say so, as the author thinks it waits.
    const read = new Set(refsIn(project, stripCode(t.body ?? "")).map((r) => `${r.kind}:${r.id}`));
    for (const r of refsIn(project, t.body ?? "")) {
      if (!read.has(`${r.kind}:${r.id}`)) lines.push(`${who} mentions "Blocked by ${refLabel(r)}" inside code, which a run does not read - write it as plain text if ${who} should wait.`);
    }
    if (LIST_BLOCKERS.test(stripCode(t.body ?? ""))) lines.push(`${who} lists its blockers under a "Blocked by" heading, which is not read: write them on the line itself ("Blocked by #12, #14")`);
    const linear = new Set((project.blockers?.linear ?? []).map((k) => k.toUpperCase()));
    for (const m of stripCode(t.body ?? "").matchAll(new RegExp(`${TRIGGER}([A-Z][A-Z0-9]+)-\\d+`, "gi"))) {
      if (linear.has(m[1].toUpperCase())) continue;
      lines.push(`${who} says "${m[0].trim()}", but ${m[1].toUpperCase()} is not in \`blockers.linear\` in .sandcastle/config.ts - the line is ignored and a run starts the ticket. Add the key there (README: Blockers), or remove the line.`);
    }
  }
  // Tickets that wait, through each other, for themselves: none of them can ever start.
  const seen = new Set<string>();
  for (const start of waits.keys()) {
    if (seen.has(start)) continue;
    const path: string[] = [];
    const walk = (id: string): string[] | undefined => {
      const at = path.indexOf(id);
      if (at >= 0) return path.slice(at);
      if (seen.has(id)) return undefined;
      path.push(id);
      for (const next of waits.get(id) ?? []) {
        const cycle = walk(next);
        if (cycle) return cycle;
      }
      path.pop();
      seen.add(id);
      return undefined;
    };
    const cycle = walk(start);
    if (cycle) {
      cycle.forEach((id) => seen.add(id));
      lines.push(`${cycle.map(refOf).join(", ")} wait for each other - none of them can ever start. Remove one "Blocked by" line.`);
    }
  }
  return lines;
};

/** The ticket of a run a blocker can be: a GitHub issue or a ticket on the project's own tracker. */
export const blockerTicket = (b: Blocker): string | undefined => (b.kind === "github" || b.kind === "ticket" ? b.id : undefined);

/**
 * The words after the ticket's name in the status view. A blocker still in flight lands in this
 * run, which is when its dependant starts; one that was in this run and ended without landing is
 * named by `ended` (its id to the state it ended in: `stopped`, `gate red`); any other is not this
 * run's to land. One that has `landed` is no blocker any more and is left out. A blocker that is in
 * the run is never called "not in this run".
 */
export const blockedNote = (on: Blocker[], inFlight: Set<string>, landed: ReadonlySet<string> = new Set(), ended: ReadonlyMap<string, string> = new Map()): string => {
  on = on.filter((b) => {
    const id = blockerTicket(b);
    return id === undefined || !landed.has(id);
  });
  // Every blocker landed but the read that frees the ticket threw, or the run stopped first: no
  // later landing reads its blockers again, so nothing starts it before the next run.
  if (!on.length) return "waits for the next run";
  const here = (b: Blocker) => {
    const id = blockerTicket(b);
    return id !== undefined && inFlight.has(id);
  };
  const wordOf = (b: Blocker) => {
    const id = blockerTicket(b);
    return id === undefined || here(b) ? undefined : ended.get(id);
  };
  const lands = on.filter(here).map(refLabel);
  // One group per state, in the order each first appears.
  const words = [...new Set(on.map(wordOf).filter((w): w is string => w !== undefined))];
  const away = on.filter((b) => !here(b) && wordOf(b) === undefined).map(refLabel);
  const groups = [
    lands.length && `${lands.join(", ")} (lands this run)`,
    ...words.map((w) => `${on.filter((b) => wordOf(b) === w).map(refLabel).join(", ")} (${w})`),
    away.length && `${away.join(", ")} (not in this run)`,
  ];
  return `waits for ${groups.filter(Boolean).join(", ")}`;
};

/**
 * The scheduler's blockers port (`Plan.blockers.open` in schedule.ts): the open blockers of each
 * of `tickets` now, asked as a ticket they waited for lands. `queued`: the ids of the queued
 * tickets. One that has not landed is open without a lookup, which is wrong once it lands - the
 * tracker has closed it by then - so every call makes a fresh resolver (the cache keeps the answer
 * it gave first) over the ones not `landed`, shared by the tickets of that call. A ticket in
 * `landed` is closed for its dependants whatever the tracker says: its work is on the base, and a
 * close the tracker refused (a transient error, `closeFailed`) is the tracker's lag, not the work's.
 */
export const openBlockersNow = (project: Project, tracker: Tracker, queued: Iterable<string>) => {
  const ids = [...queued];
  return async (tickets: Blocked[], landed: ReadonlySet<string>): Promise<Blocker[][]> => {
    const lookup = blockerResolver(project, tracker, new Set(ids.filter((id) => !landed.has(id))));
    const resolve = async (ref: Ref): Promise<Blocker> => ((ref.kind === "github" || ref.kind === "ticket") && landed.has(ref.id) ? { ...ref, state: "closed" } : lookup(ref));
    const open: Blocker[][] = [];
    for (const t of tickets) open.push(await openBlockers(project, tracker, resolve, t));
    return open;
  };
};

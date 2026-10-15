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
import { mergedByHand, mergedPartly } from "./run.ts";
import { shAsync, USER_CONFIG } from "./sandbox.ts";
import { DEFAULT_DONE, refOf, slug, statusOf, TRACKER_READ_MS, type TicketState, type Tracker } from "./tracker.ts";

// `remote`: an issue of another GitHub repository (a native blocker across repositories), id `owner/repo#N`.
// It is none of this run's tickets, so it is never queued and no landing here releases it.
// `links`: a ticket's own native blocker links, which a run's time-limited read could not get. It stands for the
// blockers it could not name, always `unreadable` (so the ticket waits), and no landing here releases it.
export type Ref = { kind: "github" | "remote" | "linear" | "file" | "ticket" | "links"; id: string };
// `closed-unmerged`: closed as not planned, so the work it stood for will never land.
export type Blocker = Ref & { state: "open" | "closed" | "closed-unmerged" | "unreadable" };

export const refLabel = (r: Ref) => (r.kind === "github" ? `#${r.id}` : r.kind === "links" ? `${refOf(r.id)}'s blocker links` : r.id);

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
const githubState = (id: string, repo = "{owner}/{repo}"): Blocker["state"] => {
  try {
    const out = execFileSync("gh", ["api", `repos/${repo}/issues/${id}`, "--jq", '.state + " " + (.state_reason // "")'], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const [state, reason] = out.split(/\s+/);
    return state !== "closed" ? "open" : reason === "not_planned" ? "closed-unmerged" : "closed";
  } catch {
    return "unreadable";
  }
};

// The same read for a run, asynchronously and given up at `limitMs`: the run's heartbeat, slot hand-offs and
// status writes go on while gh answers, and one that does not answer is unreadable.
const githubStateAsync = async (id: string, limitMs: number, repo = "{owner}/{repo}"): Promise<Blocker["state"]> => {
  try {
    const out = await shAsync("gh", ["api", `repos/${repo}/issues/${id}`, "--jq", '.state + " " + (.state_reason // "")'], limitMs);
    const [state, reason] = out.split(/\s+/);
    return state !== "closed" ? "open" : reason === "not_planned" ? "closed-unmerged" : "closed";
  } catch {
    return "unreadable";
  }
};

// `known`: ids of tickets in the queue, which are open by definition - no lookup.
// `limitMs`: the resolver of a run, whose GitHub reads are asynchronous and time-limited (`TRACKER_READ_MS`); without it
// they are the synchronous reads of a command outside a run (`queue`, `lint`, `report`).
export const blockerResolver = (project: Project, tracker: Tracker, known = new Set<string>(), limitMs?: number) => {
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
            : ref.kind === "links" ? "unreadable"
            : ref.kind === "github" ? (limitMs === undefined ? githubState(ref.id) : await githubStateAsync(ref.id, limitMs))
            : ref.kind === "remote" ? (limitMs === undefined
              ? githubState(ref.id.slice(ref.id.lastIndexOf("#") + 1), ref.id.slice(0, ref.id.lastIndexOf("#")))
              : await githubStateAsync(ref.id.slice(ref.id.lastIndexOf("#") + 1), limitMs, ref.id.slice(0, ref.id.lastIndexOf("#"))))
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

export type Why = "not-planned" | "held" | "merged-by-hand" | "merged-partly" | "unqueued";

/** The words after "waits for #B" in the closing summary. */
export const whyShort: Record<Why, string> = {
  "not-planned": "closed as not planned",
  held: "held for a human",
  "merged-by-hand": "merged by hand, closes on push",
  "merged-partly": "merged by hand, partly done: stays open",
  unqueued: "open but not queued",
};

/**
 * Why an open blocker will not close by itself: closed as not planned, held for a person (or merged
 * by one, and closing on the push, or "part of" its ticket and staying open), or not in the queue. GitHub and ticket-file blockers only: Linear issues and task files have no queue.
 * `queued`: ids the caller knows are in the queue; without it a ticket's own queue label decides.
 * One `tracker.get` per distinct blocker; a ticket that cannot be read says nothing.
 */
export const blockerWhy = (project: Project, tracker: Tracker, queued?: Set<string>) => {
  const seen = new Map<string, Why | undefined>();
  return (b: Blocker): Why | undefined => {
    const key = whyKey(tracker, b, queued);
    if (key === undefined) return b.state === "closed-unmerged" ? "not-planned" : undefined;
    if (!seen.has(key)) {
      try {
        seen.set(key, whyFrom(project, b, tracker.get(b.id), queued));
      } catch {
        seen.set(key, undefined);
      }
    }
    return seen.get(key);
  };
};

/** `blockerWhy` for a run: the ticket read with the run's time limit (`getAsync`), a read given up meaning no reason. */
export const blockerWhyAsync = (project: Project, tracker: Tracker, queued: Set<string> | undefined, limitMs: number) => {
  const seen = new Map<string, Promise<Why | undefined>>();
  return (b: Blocker): Promise<Why | undefined> => {
    const key = whyKey(tracker, b, queued);
    if (key === undefined) return Promise.resolve(b.state === "closed-unmerged" ? "not-planned" : undefined);
    if (!seen.has(key)) {
      const read = tracker.getAsync ? tracker.getAsync(b.id, limitMs) : Promise.resolve().then(() => tracker.get(b.id));
      seen.set(key, read.then((t) => whyFrom(project, b, t, queued), () => undefined));
    }
    return seen.get(key)!;
  };
};

// The blockers whose reason needs the ticket read: open, of this tracker, and not queued in the run. Undefined for the rest.
const whyKey = (tracker: Tracker, b: Blocker, queued?: Set<string>): string | undefined =>
  b.state !== "open" || !(b.kind === "ticket" || (b.kind === "github" && tracker.kind === "github")) || queued?.has(b.id) ? undefined : `${b.kind}:${b.id}`;

const whyFrom = (project: Project, b: Blocker, t: TicketState, queued?: Set<string>): Why | undefined =>
  t.held ? (mergedByHand(project.root, project.baseBranch, b.id) ? (mergedPartly(project.root, project.baseBranch, b.id) ? "merged-partly" : "merged-by-hand") : "held") : (queued ? true : t.status !== project.label) ? "unqueued" : undefined;

// On GitHub a declared blocker is a native "blocked by" edge: an issue gh reads the state of, closed
// as not planned included. One the body names too is one blocker.
// One from another repository is `owner/repo#N`: read from that repository, never taken for this one's #N.
const withDeclared = (tracker: Tracker, refs: Ref[], declared: string[]): Ref[] => {
  for (const id of declared) {
    const kind = tracker.kind !== "github" ? "ticket" : id.includes("#") ? "remote" : "github";
    if (!refs.some((r) => r.kind === kind && r.id === id)) refs.push({ kind, id });
  }
  return refs;
};

/** Every blocker a ticket names: in its body, and any its tracker declares (a ticket file's `Blocked by:` line, GitHub's native edge). */
export const refsOf = (project: Project, tracker: Tracker, t: Blocked): Ref[] => withDeclared(tracker, parseRefs(project, t.body ?? ""), tracker.declaredBlockers(t.id));

/**
 * `refsOf` for a run: the tracker's declared blockers are read asynchronously and given up at `limitMs`. Links that cannot
 * be read stand as one `links` blocker, which is never closed, so the ticket waits and starts once a later read
 * gets them (the run's next landing reads it again; a ticket held from the start waits for the next run) - the sync read's `[]` would start it with a blocker it never saw.
 */
export const refsOfAsync = async (project: Project, tracker: Tracker, t: Blocked, limitMs: number): Promise<Ref[]> => {
  const refs = parseRefs(project, t.body ?? "");
  try {
    return withDeclared(tracker, refs, tracker.declaredBlockersAsync ? await tracker.declaredBlockersAsync(t.id, limitMs) : tracker.declaredBlockers(t.id));
  } catch {
    return [...refs, { kind: "links", id: t.id }];
  }
};

/** The blockers of a ticket that are not closed. `limitMs`: a run's reads (see `blockerResolver`), which `resolve` must share. */
export const openBlockers = async (project: Project, tracker: Tracker, resolve: ReturnType<typeof blockerResolver>, t: Blocked, limitMs?: number) =>
  (await Promise.all((limitMs === undefined ? refsOf(project, tracker, t) : await refsOfAsync(project, tracker, t, limitMs)).map(resolve))).filter((b) => b.state !== "closed");

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
export const commentOnlyBlocks = async (project: Project, tracker: Tracker, tickets: Commented[], limitMs?: number) => {
  const resolve = blockerResolver(project, tracker, undefined, limitMs);
  const found: { issue: string; queued: boolean; blockers: Blocker[]; stale: boolean }[] = [];
  for (const i of tickets) {
    const inBody = new Set((limitMs === undefined ? refsOf(project, tracker, i) : await refsOfAsync(project, tracker, i, limitMs)).map((r) => `${r.kind}:${r.id}`));
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

// The to-tickets template names a child's spec under a `## Parent` heading. A queued spec that
// has queued children is run as one ticket beside them, so the parents a body names are read here:
// `#12`, the issue's URL, or (files tracker) the parent's ticket-file path. Plain text, no tracker call.
const parentsOf = (project: Project, body: string): string[] => {
  const dir = project.tracker.kind === "files" ? project.tracker.dir.replace(/^\.?\/+|\/+$/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : undefined;
  const found = new Set<string>();
  let inside = false;
  for (const line of stripCode(body).split("\n")) {
    if (/^#{1,6}[ \t]/.test(line)) {
      inside = /^#{1,6}[ \t]+parent:?[ \t]*#*[ \t]*\r?$/i.test(line);
      continue;
    }
    if (!inside) continue;
    for (const m of line.matchAll(/(?:^|[^\w/&])#(\d+)\b|\/issues\/(\d+)(?![\d-])/g)) found.add(m[1] ?? m[2]);
    if (dir) for (const m of line.matchAll(new RegExp(`${dir}/([^/\\s]+)/issues/(\\d+)-[^\\s,;)]*\\.md`, "gi"))) found.add(`${slug(m[1])}-${String(Number(m[2])).padStart(2, "0")}`);
  }
  return [...found];
};

/**
 * Queued tickets that will never start, or start too soon, because of how their blockers are
 * written: a blocker that does not exist or cannot be read (it counts as open, so the ticket
 * waits for good), tickets that wait for each other, a Linear-style id the config does not
 * name (the line is ignored, so the ticket starts at once), and blockers listed under a heading
 * (not read, so the ticket starts at once). Also a queued spec that queued children name under
 * `## Parent`: a run would implement it whole beside them. Each line says what to change.
 * `inQueue`: the ids of the whole queue, when `queued` is only some of it (the tickets a run
 * names), so a blocker queued outside them is not called "not queued". `limitMs`: a run's start, whose every read is
 * time-limited (a hanging GitHub held the whole start); commands outside a run read without it.
 */
export const blockerProblems = async (project: Project, tracker: Tracker, queued: Blocked[], inQueue = new Set(queued.map((t) => t.id)), limitMs?: number): Promise<string[]> => {
  const resolve = blockerResolver(project, tracker, inQueue, limitMs);
  const whyOf = limitMs === undefined ? blockerWhy(project, tracker, inQueue) : blockerWhyAsync(project, tracker, inQueue, limitMs);
  const lines: string[] = [];
  const waits = new Map<string, string[]>();
  for (const t of queued) {
    const who = refOf(t.id);
    const refs = limitMs === undefined ? refsOf(project, tracker, t) : await refsOfAsync(project, tracker, t, limitMs);
    waits.set(t.id, refs.filter((r) => r.kind === "ticket" || r.kind === "github").map((r) => r.id).filter((id) => queued.some((q) => q.id === id)));
    // A GitHub native edge the body does not name has no line to remove: it is removed on GitHub.
    const fromBody = parseRefs(project, t.body ?? "");
    const resolved = await Promise.all(refs.map(resolve));
    for (const [i, b] of resolved.entries()) {
      const name = refLabel(b);
      const why = await whyOf(b);
      const native = tracker.kind === "github" && !fromBody.some((r) => r.kind === refs[i].kind && r.id === refs[i].id);
      const removeIt = native ? `remove ${who}'s "blocked by" relationship on GitHub` : "remove the line";
      if (why === "not-planned") lines.push(`${who} waits for ${name}, which was closed as not planned - it will never start. ${native ? "Remove the relationship on GitHub" : "Remove the line"}, or reopen ${name}.`);
      else if (why === "merged-by-hand") lines.push(`${who} waits for ${name}, which is merged locally and closes on push - it starts once ${name} is closed.`);
      else if (why === "merged-partly") lines.push(`${who} waits for ${name}, which is merged by hand but only partly done, so it stays open - it starts once ${name} is closed.`);
      else if (why === "held") lines.push(`${who} waits for ${name}, which is held for a human - it starts once ${name} is closed.`);
      else if (why === "unqueued") lines.push(`${who} waits for ${name}, which is open but not queued - queue ${name} or ${removeIt}.`);
      if (b.state !== "unreadable") continue;
      lines.push(
        b.kind === "ticket"
          ? `${who} waits for ${name}, which does not exist - it will never start. Fix the "Blocked by" line, or remove it.`
          : b.kind === "linear"
            ? `${who} waits for ${name}, which could not be read from Linear${linearKey() ? "" : " (no LINEAR_API_KEY in ~/.config/sandcastle-kit/.env)"} - a blocker that cannot be read counts as open, so it waits.`
            : b.kind === "remote"
              ? `${who} waits for ${name}, which gh could not read (no such issue, or no access to that repository) - it counts as open, so it waits.`
              : `${who} waits for ${name}, which gh could not read (no such GitHub issue, or no access) - it counts as open, so it waits.`,
      );
    }
    // Stripped on purpose, so a run starts the ticket without waiting: say so, as the author thinks it waits.
    const read = new Set(refsIn(project, stripCode(t.body ?? "")).map((r) => `${r.kind}:${r.id}`));
    const inCode = new Map<string, string>();
    for (const r of refsIn(project, t.body ?? "")) {
      if (!read.has(`${r.kind}:${r.id}`)) inCode.set(`${r.kind}:${r.id}`, refLabel(r));
    }
    if (inCode.size) lines.push(`${who} mentions "Blocked by ${[...inCode.values()].join(", ")}" inside code, which a run does not read - write it as plain text if ${who} should wait.`);
    if (LIST_BLOCKERS.test(stripCode(t.body ?? ""))) lines.push(`${who} lists its blockers under a "Blocked by" heading, which is not read: write them on the line itself ("Blocked by #12, #14")`);
    const linear = new Set((project.blockers?.linear ?? []).map((k) => k.toUpperCase()));
    for (const m of stripCode(t.body ?? "").matchAll(new RegExp(`${TRIGGER}([A-Z][A-Z0-9]+)-\\d+`, "gi"))) {
      if (linear.has(m[1].toUpperCase())) continue;
      lines.push(`${who} says "${m[0].trim()}", but ${m[1].toUpperCase()} is not in \`blockers.linear\` in .sandcastle/config.ts - the line is ignored and a run starts the ticket. Add the key there (README: Blockers), or remove the line.`);
    }
  }
  // Only a parent the run would take itself: one queued outside the named tickets is not implemented by it.
  const taken = new Set(queued.map((t) => t.id));
  const children = new Map<string, string[]>();
  for (const t of queued) {
    for (const parent of parentsOf(project, t.body ?? "")) {
      if (parent !== t.id && taken.has(parent)) children.set(parent, [...(children.get(parent) ?? []), t.id]);
    }
  }
  for (const [parent, kids] of children) {
    lines.push(`${refOf(parent)} is the parent of ${kids.map(refOf).join(", ")} - a run would implement the whole spec as one ticket: unqueue ${refOf(parent)}`);
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
      lines.push(`${cycle.map(refOf).join(", ")} wait for each other - none of them can ever start. Remove one "Blocked by" line${tracker.kind === "github" ? ' (or "blocked by" relationship on GitHub)' : ""}.`);
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
  const unread = on.filter((b) => b.kind === "links").map(refLabel);
  const away = on.filter((b) => b.kind !== "links" && !here(b) && wordOf(b) === undefined).map(refLabel);
  const groups = [
    lands.length && `${lands.join(", ")} (lands this run)`,
    ...words.map((w) => `${on.filter((b) => wordOf(b) === w).map(refLabel).join(", ")} (${w})`),
    unread.length && `${unread.join(", ")} (could not be read)`,
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
export const openBlockersNow = (project: Project, tracker: Tracker, queued: Iterable<string>, limitMs = TRACKER_READ_MS) => {
  const ids = [...queued];
  return async (tickets: Blocked[], landed: ReadonlySet<string>): Promise<Blocker[][]> => {
    const lookup = blockerResolver(project, tracker, new Set(ids.filter((id) => !landed.has(id))), limitMs);
    const resolve = async (ref: Ref): Promise<Blocker> => ((ref.kind === "github" || ref.kind === "ticket") && landed.has(ref.id) ? { ...ref, state: "closed" } : lookup(ref));
    // Side by side: under a hanging GitHub, one ticket after another held the landing worker for N times the limit.
    return Promise.all(tickets.map((t) => openBlockers(project, tracker, resolve, t, limitMs)));
  };
};

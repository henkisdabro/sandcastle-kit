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
import { sh, USER_CONFIG } from "./sandbox.ts";
import { DEFAULT_DONE, refOf, statusOf, type Tracker } from "./tracker.ts";

export type Ref = { kind: "github" | "linear" | "file" | "ticket"; id: string };
export type Blocker = Ref & { state: "open" | "closed" | "unreadable" };

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

/** Every blocker named after a trigger phrase; a list ("#1, #2 and ENG-3") counts each. */
export const parseRefs = (project: Project, text: string): Ref[] => {
  const token = tokens(project);
  const phrase = new RegExp(`${TRIGGER}((?:${token})(?:\\s*(?:,|and|&)\\s*(?:${token}))*)`, "gi");
  const seen = new Map<string, Ref>();
  for (const m of stripCode(text).matchAll(phrase)) {
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
// where `gh issue view` does not.
const githubState = (id: string): Blocker["state"] => {
  try {
    const out = execFileSync("gh", ["api", `repos/{owner}/{repo}/issues/${id}`, "--jq", ".state"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "closed" ? "closed" : "open";
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

/**
 * Queued tickets that will never start, or start too soon, because of how their blockers are
 * written: a blocker that does not exist or cannot be read (it counts as open, so the ticket
 * waits for good), tickets that wait for each other, and a Linear-style id the config does not
 * name (the line is ignored, so the ticket starts at once). Each line says what to change.
 */
export const blockerProblems = async (project: Project, tracker: Tracker, queued: Blocked[]): Promise<string[]> => {
  const resolve = blockerResolver(project, tracker, new Set(queued.map((t) => t.id)));
  const lines: string[] = [];
  const waits = new Map<string, string[]>();
  for (const t of queued) {
    const who = refOf(t.id);
    const refs = refsOf(project, tracker, t);
    waits.set(t.id, refs.filter((r) => r.kind === "ticket" || r.kind === "github").map((r) => r.id).filter((id) => queued.some((q) => q.id === id)));
    for (const b of await Promise.all(refs.map(resolve))) {
      if (b.state !== "unreadable") continue;
      const name = refLabel(b);
      lines.push(
        b.kind === "ticket"
          ? `${who} waits for ${name}, which does not exist - it will never start. Fix the "Blocked by" line, or remove it.`
          : b.kind === "linear"
            ? `${who} waits for ${name}, which could not be read from Linear${linearKey() ? "" : " (no LINEAR_API_KEY in ~/.config/sandcastle-kit/.env)"} - a blocker that cannot be read counts as open, so it waits.`
            : `${who} waits for ${name}, which gh could not read (no such issue, or no access) - it counts as open, so it waits.`,
      );
    }
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

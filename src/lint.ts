// `sandcastle queue --lint`: the shape of a queue before its first run. How many runs a queue
// takes to drain follows from its blocker chains, the files tickets share and the files git
// cannot merge, and none of that shows in the plain listing. Read-only advice built from the
// ticket text and the base branch's tree: no model calls, no Docker, no writes. The `Touches:`
// line is an agent-written hint, so every figure here is a rough one.

import type { Project } from "./config.ts";
import { blockerProblems, blockerResolver, openBlockers, refLabel, refsOf } from "./blockers.ts";
import { protectedAmong, protectedWarning } from "./guard.ts";
import { expandTouches, isGlob, missingTouches, parseTouches, unmergeableFiles } from "./touches.ts";
import { refOf, type Tracker } from "./tracker.ts";

/** A ticket declaring more files than this is likely to meet others at landing. */
export const WIDE_FILES = 10;
/** A file this many tickets declare is where a queue's conflicts will be. */
export const HOT_TICKETS = 4;

export type Queued = { id: string; body?: string };

const names = (ids: string[]) => ids.map(refOf).join(", ");

/** Who waits for whom, among `queued` tickets only: a blocker outside them holds a ticket back, it does not order it. */
const blockerWaits = (project: Project, tracker: Tracker, queued: Queued[]) => {
  const ids = new Set(queued.map((t) => t.id));
  const waits = new Map<string, string[]>();
  for (const t of queued) {
    const on = refsOf(project, tracker, t).filter((r) => (r.kind === "ticket" || r.kind === "github") && ids.has(r.id) && r.id !== t.id).map((r) => r.id);
    waits.set(t.id, [...new Set(on)]);
  }
  return waits;
};

/** The longest chain, as tickets in the order they must run. A cycle is cut where it closes (the problems section names it). */
const longestChain = (queued: Queued[], waits: Map<string, string[]>): string[] => {
  const longest = new Map<string, string[]>();
  const walking = new Set<string>();
  const chainTo = (id: string): string[] => {
    const known = longest.get(id);
    if (known) return known;
    walking.add(id);
    let best: string[] = [];
    for (const dep of waits.get(id) ?? []) {
      if (walking.has(dep)) continue;
      const c = chainTo(dep);
      if (c.length > best.length) best = c;
    }
    walking.delete(id);
    const chain = [...best, id];
    longest.set(id, chain);
    return chain;
  };
  let chain: string[] = [];
  for (const t of queued) {
    const c = chainTo(t.id);
    if (c.length > chain.length) chain = c;
  }
  return chain;
};

/** The longest in-run `Blocked by` chain among `queued`: what `queue --lint` calls the blocker depth, and the run's estimate counts. */
export const blockerChain = (project: Project, tracker: Tracker, queued: Queued[]): string[] => longestChain(queued, blockerWaits(project, tracker, queued));

/**
 * The report, one line each; the caller prints it. `named` says `queued` is the tickets a run was
 * named (`sandcastle run 12 15`), not the whole queue: the figures are those of that run, and a
 * blocker outside the set is listed as the wait a run would make.
 */
export const lintQueue = async (project: Project, tracker: Tracker, queued: Queued[], named = false): Promise<string[]> => {
  if (!queued.length) return [`queue "${project.label}" is empty - nothing to lint.`];

  const waits = blockerWaits(project, tracker, queued);
  const chain = longestChain(queued, waits);

  // The files each ticket declares, against the base branch's tree.
  const files = new Map<string, string[]>();
  for (const t of queued) files.set(t.id, expandTouches(project.root, project.baseBranch, parseTouches(t.body ?? "")));
  const declaredBy = new Map<string, string[]>();
  for (const [id, list] of files) for (const f of list) declaredBy.set(f, [...(declaredBy.get(f) ?? []), id]);

  const edges = queued.flatMap((t) => (waits.get(t.id) ?? []).map((on) => ({ id: t.id, on })));
  const overlapping = edges.filter((e) => (files.get(e.id) ?? []).some((f) => (files.get(e.on) ?? []).includes(f)));
  const real = edges.filter((e) => !overlapping.includes(e));

  const wide = queued.filter((t) => (files.get(t.id)?.length ?? 0) > WIDE_FILES);
  const hot = [...declaredBy].filter(([, by]) => by.length >= HOT_TICKETS);
  const twice = [...declaredBy].filter(([, by]) => by.length >= 2);
  const hard = new Set(unmergeableFiles(project.root, project.baseBranch, twice.map(([f]) => f), project.generated ?? []));
  const shared = twice.filter(([f]) => hard.has(f));
  // Named tickets are some of the queue: a blocker queued outside them is a wait, not "not queued".
  const inQueue = new Set([...queued.map((t) => t.id), ...(named ? tracker.queued(false).map((t) => t.id) : [])]);
  const problems = await blockerProblems(project, tracker, queued, inQueue);

  // A plain path no file matches is kept by expandTouches (it may be a new file) and an empty glob is dropped: neither shows above.
  for (const t of queued) {
    const absent = missingTouches(project.root, project.baseBranch, t.body ?? "");
    const paths = absent.filter((p) => !isGlob(p));
    const globs = absent.filter(isGlob);
    if (paths.length) problems.push(`${refOf(t.id)} names paths not on ${project.baseBranch}: ${paths.join(", ")} - new files (say so under ## Fix) or typos?`);
    // Saying "new" changes nothing for a glob: it orders nothing until files exist.
    if (globs.length) problems.push(`${refOf(t.id)}'s Touches globs match no file on ${project.baseBranch}: ${globs.join(", ")} - a glob orders nothing until files exist: name the new files themselves (and call them new under ## Fix), or fix the glob`);
  }

  // A ticket whose work lies in a protected path ends held whatever the agent does: said before it costs a pipeline.
  const heldFor = queued.flatMap((t) => {
    const paths = protectedAmong(project, files.get(t.id) ?? []);
    return paths.length ? [`${refOf(t.id)} ${protectedWarning(paths)}`] : [];
  });

  // A run of named tickets holds one back for any open blocker, in the set or not: the ones outside the set are not in the chain above.
  const outside: string[] = [];
  if (named) {
    const resolve = blockerResolver(project, tracker, inQueue);
    for (const t of queued) {
      const set = new Set(waits.get(t.id));
      const open = (await openBlockers(project, tracker, resolve, t)).filter((b) => !((b.kind === "ticket" || b.kind === "github") && (set.has(b.id) || b.id === t.id)));
      if (open.length) outside.push(`${refOf(t.id)} waits for ${open.map(refLabel).join(", ")}`);
    }
  }

  const out = [`${project.tracker.kind} tracker (${project.tracker.source}), queue "${project.label}": ${named ? `${queued.length} named ticket(s), not the whole queue` : `${queued.length} ticket(s)`}`];
  out.push(`  blocker depth: ${chain.length} - ${chain.length > 1 ? chain.map(refOf).join(" -> ") : `no queued ticket waits for another (${refOf(chain[0])} is first)`}`);
  out.push(`  blocked-by edges: ${edges.length}, ${overlapping.length} between tickets whose Touches overlap (they only order shared files), ${real.length} that do not (real dependencies)`);
  for (const e of real) out.push(`    real: ${refOf(e.id)} waits for ${refOf(e.on)}`);
  if (named) {
    out.push(outside.length ? "  waits for a blocker outside the named tickets (a run holds them back until it closes):" : "  waits for a blocker outside the named tickets: none");
    for (const o of outside) out.push(`    ${o}`);
  }
  out.push(wide.length ? `  wide tickets (more than ${WIDE_FILES} declared files): ${wide.map((t) => `${refOf(t.id)} (${files.get(t.id)!.length})`).join(", ")}` : `  wide tickets (more than ${WIDE_FILES} declared files): none`);
  out.push(hot.length ? `  hot files (declared by ${HOT_TICKETS}+ tickets):` : `  hot files (declared by ${HOT_TICKETS}+ tickets): none`);
  for (const [f, by] of hot) out.push(`    ${f}: ${names(by)}`);
  out.push(shared.length ? "  unmergeable files declared by 2+ tickets (git cannot merge them line by line):" : "  unmergeable files declared by 2+ tickets: none");
  for (const [f, by] of shared) out.push(`    ${f}: ${names(by)}`);
  out.push(heldFor.length ? "  protected paths (a run cannot land these):" : "  protected paths: none");
  for (const h of heldFor) out.push(`    ${h}`);
  out.push(problems.length ? "  problems:" : "  problems: none");
  for (const p of problems) out.push(`    ${p}`);
  // Dependants start in the same run once their last blocker lands, so depth costs time inside one run, not turns.
  const order = chain.length > 1 ? `${chain.length} tickets one after another in it` : "no ticket waits for another";
  out.push(`  rough estimate: one run; ${order} (blocker depth ${chain.length})${shared.length ? ", maybe one more turn for a shared unmergeable file" : ""}; a guess from the Touches hints, not a promise`);
  return out;
};

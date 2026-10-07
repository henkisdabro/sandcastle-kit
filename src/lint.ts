// `sandcastle queue --lint`: the shape of a queue before its first run. How many runs a queue
// takes to drain follows from its blocker chains, the files tickets share and the files git
// cannot merge, and none of that shows in the plain listing. Read-only advice built from the
// ticket text and the base branch's tree: no model calls, no Docker, no writes. The `Touches:`
// line is an agent-written hint, so every figure here is a rough one.

import type { Project } from "./config.ts";
import { blockerProblems, refsOf, stripCode } from "./blockers.ts";
import { protectedAmong, protectedWarning } from "./guard.ts";
import { expandTouches, missingTouches, parseTouches, unmergeableFiles } from "./touches.ts";
import { refOf, type Tracker } from "./tracker.ts";

/** A ticket declaring more files than this is likely to meet others at landing. */
export const WIDE_FILES = 10;
/** A file this many tickets declare is where a queue's conflicts will be. */
export const HOT_TICKETS = 4;

export type Queued = { id: string; body?: string };

const names = (ids: string[]) => ids.map(refOf).join(", ");

// The to-tickets template writes blockers as a list under a heading (`## Blocked by`, then
// `- #12`). The parser reads only a ref on the `Blocked by` line itself, so such a ticket starts
// before its blocker lands, and nothing else says so.
const LIST_BLOCKERS = /^(?:#+[ \t]*)?(?:blocked by|depends on):?[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*[-*+][ \t]/im;

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

/** The report, one line each; the caller prints it. */
export const lintQueue = async (project: Project, tracker: Tracker, queued: Queued[]): Promise<string[]> => {
  if (!queued.length) return [`queue "${project.label}" is empty - nothing to lint.`];
  const ids = new Set(queued.map((t) => t.id));

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
  const problems = await blockerProblems(project, tracker, queued);
  for (const t of queued) {
    if (LIST_BLOCKERS.test(stripCode(t.body ?? ""))) problems.push(`${refOf(t.id)} lists its blockers under a "Blocked by" heading, which is not read: write them on the line itself ("Blocked by #12, #14")`);
  }

  // A plain path no file matches is kept by expandTouches (it may be a new file) and an empty glob is dropped: neither shows above.
  for (const t of queued) {
    const absent = missingTouches(project.root, project.baseBranch, t.body ?? "");
    if (absent.length) problems.push(`${refOf(t.id)} names paths not on ${project.baseBranch}: ${absent.join(", ")} - new files (say so under ## Fix) or typos?`);
  }

  // A ticket whose work lies in a protected path ends held whatever the agent does: said before it costs a pipeline.
  const heldFor = queued.flatMap((t) => {
    const paths = protectedAmong(project, files.get(t.id) ?? []);
    return paths.length ? [`${refOf(t.id)} ${protectedWarning(paths)}`] : [];
  });

  const out = [`${project.tracker.kind} tracker (${project.tracker.source}), queue "${project.label}": ${queued.length} ticket(s)`];
  out.push(`  blocker depth: ${chain.length} - ${chain.length > 1 ? chain.map(refOf).join(" -> ") : `no queued ticket waits for another (${refOf(chain[0])} is first)`}`);
  out.push(`  blocked-by edges: ${edges.length}, ${overlapping.length} between tickets whose Touches overlap (they only order shared files), ${real.length} that do not (real dependencies)`);
  for (const e of real) out.push(`    real: ${refOf(e.id)} waits for ${refOf(e.on)}`);
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

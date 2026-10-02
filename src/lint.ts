// `sandcastle queue --lint`: the shape of a queue before its first run. How many runs a queue
// takes to drain follows from its blocker chains, the files tickets share and the files git
// cannot merge, and none of that shows in the plain listing. Read-only advice built from the
// ticket text and the base branch's tree: no model calls, no Docker, no writes. The `Touches:`
// line is an agent-written hint, so every figure here is a rough one.

import type { Project } from "./config.ts";
import { blockerProblems, refsOf } from "./blockers.ts";
import { expandTouches, parseTouches, unmergeable } from "./touches.ts";
import { refOf, type Tracker } from "./tracker.ts";

/** A ticket declaring more files than this is likely to meet others at landing. */
export const WIDE_FILES = 10;
/** A file this many tickets declare is where a queue's conflicts will be. */
export const HOT_TICKETS = 4;

type Queued = { id: string; body?: string };

const names = (ids: string[]) => ids.map(refOf).join(", ");

/** The report, one line each; the caller prints it. */
export const lintQueue = async (project: Project, tracker: Tracker, queued: Queued[]): Promise<string[]> => {
  if (!queued.length) return [`queue "${project.label}" is empty - nothing to lint.`];
  const ids = new Set(queued.map((t) => t.id));

  // Who waits for whom, among queued tickets only: a blocker outside the queue is a problem line.
  const waits = new Map<string, string[]>();
  for (const t of queued) {
    const on = refsOf(project, tracker, t).filter((r) => (r.kind === "ticket" || r.kind === "github") && ids.has(r.id) && r.id !== t.id).map((r) => r.id);
    waits.set(t.id, [...new Set(on)]);
  }

  // The longest chain, as tickets in the order they must run. A cycle is cut where it closes
  // (the problems section names it).
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
  const shared = [...declaredBy].filter(([f, by]) => by.length >= 2 && unmergeable(project.root, project.baseBranch, f, project.generated ?? []));
  const problems = await blockerProblems(project, tracker, queued);

  const out = [`${project.tracker.kind} tracker (${project.tracker.source}), queue "${project.label}": ${queued.length} ticket(s)`];
  out.push(`  blocker depth: ${chain.length} - ${chain.length > 1 ? chain.map(refOf).join(" -> ") : `no queued ticket waits for another (${refOf(chain[0])} is first)`}`);
  out.push(`  blocked-by edges: ${edges.length}, ${overlapping.length} between tickets whose Touches overlap (they only order shared files), ${real.length} that do not (real dependencies)`);
  for (const e of real) out.push(`    real: ${refOf(e.id)} waits for ${refOf(e.on)}`);
  out.push(wide.length ? `  wide tickets (more than ${WIDE_FILES} declared files): ${wide.map((t) => `${refOf(t.id)} (${files.get(t.id)!.length})`).join(", ")}` : `  wide tickets (more than ${WIDE_FILES} declared files): none`);
  out.push(hot.length ? `  hot files (declared by ${HOT_TICKETS}+ tickets):` : `  hot files (declared by ${HOT_TICKETS}+ tickets): none`);
  for (const [f, by] of hot) out.push(`    ${f}: ${names(by)}`);
  out.push(shared.length ? "  unmergeable files declared by 2+ tickets (git cannot merge them line by line):" : "  unmergeable files declared by 2+ tickets: none");
  for (const [f, by] of shared) out.push(`    ${f}: ${names(by)}`);
  out.push(problems.length ? "  problems:" : "  problems: none");
  for (const p of problems) out.push(`    ${p}`);
  const turns = chain.length + (shared.length ? 1 : 0);
  out.push(`  rough estimate: about ${turns} turn(s) = blocker depth ${chain.length}${shared.length ? " + 1 for a shared unmergeable file" : ""}; a guess from the Touches hints, not a promise`);
  return out;
};

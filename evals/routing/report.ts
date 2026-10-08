// The results, per arm: how often a ticket came out right, what that cost and how long it took, and
// how alike the repetitions were. Every arm is paired with the baseline on the same tasks.

import type { Pass } from "./trial.ts";
import type { Grade } from "./grade.ts";
import type { Judged } from "./judge.ts";

export type Result = {
  task: number;
  arm: string;
  rep: number;
  at: string;
  dir: string;
  exitCode: number;
  state?: string;
  landed: boolean;
  minutes?: number;
  phases: Pass[];
  start: string;
  implTip: string;
  finalTip?: string;
  impl: { hidden: Grade; probes: (Grade & { commit: string })[] };
  final?: { hidden: Grade; probes: (Grade & { commit: string })[] };
  contaminated: string[];
  record: Record<string, unknown>;
  judge?: Judged;
};

const AGENT = new Set(["implement", "review", "cross-review", "repair", "resolve"]);

export const resolved = (r: Result) => r.landed && !!r.final?.hidden.pass && r.contaminated.length === 0;
// The implementer's own work, before any review: independent of the reviewer an arm pairs it with.
const implResolved = (r: Result) => r.impl.hidden.pass && r.contaminated.length === 0;
const cost = (r: Result) => r.phases.reduce((n, p) => n + p.dollars, 0);
const costOf = (r: Result, phase: string) => r.phases.filter((p) => p.phase === phase).reduce((n, p) => n + p.dollars, 0);
const agentMinutes = (r: Result) => r.phases.filter((p) => AGENT.has(p.phase)).reduce((n, p) => n + p.ms, 0) / 60_000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const pct = (x: number) => (Number.isNaN(x) ? "-" : `${Math.round(x * 100)}%`);
const usd = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : "-");
const min = (x: number) => (Number.isFinite(x) ? `${x.toFixed(1)}m` : "-");

// A fixed seed: the same results always print the same interval.
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);

/** 90% interval of the arm's resolve rate minus the baseline's, resampling tasks (each task's rate is its reps' mean). */
const pairedInterval = (arm: Map<number, number>, base: Map<number, number>) => {
  const tasks = [...arm.keys()].filter((t) => base.has(t));
  if (tasks.length < 3) return undefined;
  const rand = rng(7);
  const diffs: number[] = [];
  for (let i = 0; i < 2000; i++) {
    let d = 0;
    for (let j = 0; j < tasks.length; j++) {
      const t = tasks[Math.floor(rand() * tasks.length)];
      d += arm.get(t)! - base.get(t)!;
    }
    diffs.push(d / tasks.length);
  }
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(0.05 * diffs.length)], diffs[Math.floor(0.95 * diffs.length)]];
};

const rates = (rs: Result[], ok: (r: Result) => boolean) => {
  const byTask = new Map<number, Result[]>();
  for (const r of rs) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
  return new Map([...byTask].map(([t, xs]) => [t, mean(xs.map((x) => (ok(x) ? 1 : 0)))]));
};

export const report = (results: Result[], baseline = "S-high/O-high") => {
  const arms = [...new Set(results.map((r) => r.arm))];
  const baseRs = results.filter((r) => r.arm === baseline);
  const base = rates(baseRs, resolved);
  const baseImpl = rates(baseRs, implResolved);
  const lines = [
    "| arm | trials | resolved | impl alone | review rescued | all reps | $/trial | impl $ | review $ | $/resolved | agent min | min/resolved | $ spread | probes caught | judge vs ref | resolved vs baseline | impl alone vs baseline |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const arm of arms) {
    const rs = results.filter((r) => r.arm === arm);
    const ok = rs.filter(resolved);
    const byTask = rates(rs, resolved);
    const allReps = mean([...byTask.values()].map((v) => (v === 1 ? 1 : 0)));
    const rescued = rs.filter((r) => !r.impl.hidden.pass && resolved(r)).length;
    const probes = rs.flatMap((r) => r.final?.probes ?? []);
    const judged = rs.filter((r) => r.judge);
    const spread = mean([...new Set(rs.map((r) => r.task))].map((t) => {
      const xs = rs.filter((r) => r.task === t).map(cost);
      return xs.length > 1 ? sd(xs) / mean(xs) : NaN;
    }).filter((x) => !Number.isNaN(x)));
    const ci = arm === baseline ? undefined : pairedInterval(byTask, base);
    const ciImpl = arm === baseline ? undefined : pairedInterval(rates(rs, implResolved), baseImpl);
    const interval = (x?: number[]) => (x ? `${pct(x[0])} to ${pct(x[1])}` : "-");
    lines.push(
      `| ${arm} | ${rs.length} | ${pct(ok.length / rs.length)} | ${pct(rs.filter(implResolved).length / rs.length)} | ${rescued} | ${pct(allReps)} | ${usd(mean(rs.map(cost)))} | ${usd(mean(rs.map((r) => costOf(r, "implement"))))} | ${usd(mean(rs.map((r) => costOf(r, "review"))))} | ${usd(rs.map(cost).reduce((a, b) => a + b, 0) / ok.length)} | ${min(mean(rs.map(agentMinutes)))} | ${min(rs.map(agentMinutes).reduce((a, b) => a + b, 0) / ok.length)} | ${pct(spread)} | ${probes.length ? `${probes.filter((p) => p.pass).length}/${probes.length}` : "-"} | ${judged.length ? (mean(judged.map((r) => r.judge!.candidate - r.judge!.reference))).toFixed(1) : "-"} | ${interval(ci)} | ${interval(ciImpl)} |`,
    );
  }
  const tasks = [...new Set(results.map((r) => r.task))].sort((a, b) => a - b);
  const grid = [`| task | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`];
  for (const t of tasks) {
    grid.push(
      `| #${t} | ${arms
        .map((a) => {
          const rs = results.filter((r) => r.task === t && r.arm === a);
          return rs.length ? `${rs.filter(resolved).length}/${rs.length} ${usd(mean(rs.map(cost)))} ${min(mean(rs.map(agentMinutes)))}` : "";
        })
        .join(" | ")} |`,
    );
  }
  const tainted = results.filter((r) => r.contaminated.length);
  return [
    "## Per arm",
    "",
    "resolved: landed, and the reference's tests pass on what landed. impl alone: they pass on the implementer's last commit. review rescued: failed after implement, resolved at the end.",
    "all reps: share of tasks resolved in every repetition. $ spread: mean coefficient of variation of a task's cost across repetitions. Dollars are list-price API equivalents.",
    `vs baseline: 90% interval of the difference from ${baseline}, paired by task and resampled over tasks.`,
    "",
    ...lines,
    "",
    "## Per task (resolved/trials, $/trial, agent minutes)",
    "",
    ...grid,
    ...(tainted.length ? ["", `${tainted.length} trial(s) reached the upstream tracker and count as unresolved: ${tainted.map((r) => `#${r.task} ${r.arm} ${r.rep}`).join(", ")}`] : []),
    "",
  ].join("\n");
};

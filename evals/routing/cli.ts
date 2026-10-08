// node evals/routing/cli.ts <command> - see evals/routing/README.md.
//
//   build <issue...>                 tasks.json from landed tickets (git, and `gh issue view`)
//   validate [--tasks a,b]           no model calls: the hidden tests must fail at the base and pass on the reference
//   run --arms a,b [--reps n] [--tasks a,b | --pilot] [--parallel n] --spend
//                                    the trials; each is a whole `sandcastle run`, and spends the allowance
//   judge [--arms a,b] [--tasks a,b] the Codex judge over finished trials (the ChatGPT plan, not Claude)
//   report [--baseline arm]          the tables, from results.jsonl (baseline S-high/O-high)

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArm } from "./arms.ts";
import { gradeTree } from "./grade.ts";
import { judge } from "./judge.ts";
import { report, type Result } from "./report.ts";
import { buildTasks, loadTasks, REPO, type Task } from "./tasks.ts";
import { collect, prepare, runKit, trialDir, WORK } from "./trial.ts";

const RESULTS = join(WORK, "results.jsonl");
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? undefined : rest[i + 1];
};
const list = (name: string) => flag(name)?.split(",").filter(Boolean);

const tasks = (): Task[] => {
  const only = list("tasks")?.map(Number);
  return loadTasks().filter((t) => !t.drop && (!only || only.includes(t.issue)) && (!rest.includes("--pilot") || t.pilot));
};
const results = (): Result[] =>
  existsSync(RESULTS)
    ? readFileSync(RESULTS, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const validate = () => {
  mkdirSync(WORK, { recursive: true });
  tasks().forEach((t) => {
    const atBase = gradeTree(t, REPO, t.base);
    const atRef = gradeTree(t, REPO, t.ref, { typecheck: true });
    const verdict = !atRef.hidden.pass ? "reference fails its own tests here" : atBase.hidden.pass ? "hidden tests pass at the base: they do not discriminate" : "ok";
    console.log(
      `#${t.issue}: ${verdict}; base ${atBase.hidden.files.filter((f) => f.pass).length}/${t.hidden.length} pass, reference ${atRef.hidden.files.filter((f) => f.pass).length}/${t.hidden.length}` +
        (atRef.probes.length ? `; probes on the reference: ${atRef.probes.map((p) => (p.pass ? "pass (the bug is not there?)" : "fail (the bug is there)")).join(", ")}` : "") +
        (t.sourceReading.length ? `; source-reading: ${t.sourceReading.join(", ")}` : ""),
    );
    // One line per task as it ends, so tasks can be validated in parallel processes.
    appendFileSync(join(WORK, "validation.jsonl"), JSON.stringify({ issue: t.issue, verdict, base: atBase, reference: atRef }) + "\n");
  });
};

// Where a run can leave a ticket on the model's account. Anything else - no state (the run stopped
// before it: preflight, a spent plan, Docker), stopped, crashed, still queued - says nothing about the
// arm, so it is no result: the trial is noted in incomplete.jsonl and the next `run` tries it again.
const ENDINGS = new Set(["merged", "held", "red", "nochange", "uncommitted", "conflict", "not landed"]);

/** Runs one trial; false when it ended for a reason that is not the arm's, and no further trial should start. */
const trial = async (task: Task, armId: string, rep: number) => {
  const arm = parseArm(armId);
  const dir = trialDir(task, arm.id, rep);
  const start = prepare(task, arm, dir);
  console.log(`#${task.issue} ${arm.id} rep ${rep}: running in ${dir}`);
  const exitCode = await runKit(arm, dir);
  const c = collect(task, dir, start, exitCode);
  if (!c.state || !ENDINGS.has(c.state)) {
    const tail = existsSync(`${dir}.out`) ? readFileSync(`${dir}.out`, "utf8").trimEnd().split("\n").slice(-6).join("\n") : "";
    appendFileSync(join(WORK, "incomplete.jsonl"), JSON.stringify({ task: task.issue, arm: arm.id, rep, at: new Date().toISOString(), dir, exitCode, state: c.state, tail }) + "\n");
    console.log(`#${task.issue} ${arm.id} rep ${rep}: incomplete (${c.state ?? `exit ${exitCode}`}), not a result:\n${tail}`);
    return false;
  }
  const r: Result = {
    task: task.issue,
    arm: arm.id,
    rep,
    at: new Date().toISOString(),
    dir,
    ...c,
    start,
    impl: gradeTree(task, dir, c.implTip),
    ...(c.finalTip ? { final: gradeTree(task, dir, c.finalTip, { typecheck: true }) } : {}),
  };
  appendFileSync(RESULTS, JSON.stringify(r) + "\n");
  console.log(`#${task.issue} ${arm.id} rep ${rep}: ${c.state}, hidden ${r.final?.hidden.pass ? "pass" : "fail"} (impl alone ${r.impl.hidden.pass ? "pass" : "fail"})`);
  return true;
};

const run = async () => {
  const arms = list("arms") ?? [];
  if (!arms.length) throw new Error("--arms takes <implement>/<review> pairs, as in S-high/O-high,H-high/O-high (evals/routing/arms.ts)");
  arms.forEach(parseArm);
  const reps = Number(flag("reps") ?? 1);
  const done = new Set(results().map((r) => `${r.task}/${r.arm}/${r.rep}`));
  // Interleaved by repetition, then task, then arm: a slow afternoon on the machine spreads over every arm.
  const queue = Array.from({ length: reps }, (_, i) => i + 1).flatMap((rep) => tasks().flatMap((t) => arms.map((a) => ({ t, a, rep })))).filter((q) => !done.has(`${q.t.issue}/${q.a}/${q.rep}`));
  console.log(`${queue.length} trial(s) to run (${done.size} already in ${RESULTS}).`);
  if (!rest.includes("--spend")) {
    console.log("Each trial is a full `sandcastle run` and spends the plan or API allowance. Add --spend to start.");
    return;
  }
  mkdirSync(WORK, { recursive: true });
  const parallel = Number(flag("parallel") ?? 2);
  // One incomplete trial stops new ones: a spent plan or a broken Docker would fail every trial after it.
  let stop = false;
  const worker = async () => {
    for (let q = queue.shift(); q && !stop; q = queue.shift()) {
      try {
        if (!(await trial(q.t, q.a, q.rep))) stop = true;
      } catch (error) {
        console.log(`#${q.t.issue} ${q.a} rep ${q.rep}: trial failed - ${(error as Error).message}`);
        stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  if (stop) console.log("Stopped after an incomplete trial (incomplete.jsonl says why). The same command carries on from there.");
};

const judgeAll = () => {
  const arms = list("arms");
  const byIssue = new Map(tasks().map((t) => [t.issue, t]));
  const all = results();
  for (const r of all) {
    const t = byIssue.get(r.task);
    if (r.judge || !r.finalTip || !t || (arms && !arms.includes(r.arm))) continue;
    try {
      r.judge = judge(t, r.dir, r.start, r.finalTip);
      console.log(`#${r.task} ${r.arm} rep ${r.rep}: candidate ${r.judge.candidate} vs reference ${r.judge.reference}, ${r.judge.preferred}`);
    } catch (error) {
      console.log(`#${r.task} ${r.arm} rep ${r.rep}: ${(error as Error).message}`);
    }
    writeFileSync(RESULTS, all.map((x) => JSON.stringify(x)).join("\n") + "\n");
  }
};

if (command === "build") buildTasks(rest.map(Number).filter(Boolean));
else if (command === "validate") validate();
else if (command === "run") await run();
else if (command === "judge") judgeAll();
else if (command === "report") console.log(report(results(), flag("baseline")));
else console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 9).join("\n").replace(/^\/\/ ?/gm, ""));

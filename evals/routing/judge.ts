// The judge: a model of another family (Codex, on the ChatGPT plan) compares a trial's change with
// the reference, blind to which is which and which arm made it. Twice, the two sides swapped, so a
// preference for the first or the second position cancels out. Hidden tests say whether a change
// works; the judge says what tests cannot - scope, conventions, the tests a change brought.

import { execFileSync, spawnSync } from "node:child_process";
import { REPO, ticketFile, type Task } from "./tasks.ts";

export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "gpt-6-astra";
const LIMIT = 120_000;

export type Verdict = { a: Scores; b: Scores; better: "A" | "B" | "tie"; why: string };
type Scores = { solves: number; scope: number; tests: number; conventions: number; risk: number };
export type Judged = { candidate: number; reference: number; preferred: "candidate" | "reference" | "tie" | "split"; verdicts: Verdict[] };

const RUBRIC = `Score each change 1-5 on:
- solves: does it do what the ticket asks, every "Done when" line included?
- scope: only what the ticket needs, no unrelated edits, no half-finished paths left behind?
- tests: would its tests fail without the change, and do they exercise the path the ticket names (not a stub around it)?
- conventions: does it follow the repository's rules as the diff shows them (comments say why, British English in prose, docs updated where behaviour changed)?
- risk: 5 = nothing it could break elsewhere; 1 = likely regressions (another caller of a changed function, an ended or inferred state left unhandled).
Then say which change you would merge: A, B or tie.
Answer with one JSON object and nothing else:
{"a":{"solves":n,"scope":n,"tests":n,"conventions":n,"risk":n},"b":{...},"better":"A"|"B"|"tie","why":"one sentence"}`;

const diff = (repo: string, from: string, to: string) => {
  const text = execFileSync("git", ["-C", repo, "diff", "--no-renames", from, to, "--", ".", ":(exclude).scratch"], { encoding: "utf8", maxBuffer: 64 << 20 });
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n[... ${text.length - LIMIT} more characters cut]` : text;
};

const ask = (prompt: string): Verdict => {
  const r = spawnSync("codex", ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "-m", JUDGE_MODEL, prompt], {
    encoding: "utf8",
    timeout: 15 * 60_000,
    maxBuffer: 32 << 20,
  });
  const found = [...`${r.stdout ?? ""}`.matchAll(/\{[^{}]*"a"\s*:\s*\{[^}]*\}[^{}]*"b"\s*:\s*\{[^}]*\}[^{}]*\}/g)].at(-1);
  if (!found) throw new Error(`judge gave no verdict (exit ${r.status}): ${`${r.stdout}${r.stderr}`.slice(-400)}`);
  return JSON.parse(found[0]) as Verdict;
};

const total = (s: Scores) => s.solves + s.scope + s.tests + s.conventions + s.risk;

/** `start..tip` of `repo` against the task's reference, both orders. */
export const judge = (task: Task, repo: string, start: string, tip: string): Judged => {
  const candidate = diff(repo, start, tip);
  const reference = diff(REPO, task.base, task.ref);
  const prompt = (first: string, second: string) =>
    `Two changes were made, independently, for the same ticket in the same repository. Judge them.\n\n# The ticket\n\n${ticketFile(task)}\n\n# Change A\n\n\`\`\`diff\n${first}\n\`\`\`\n\n# Change B\n\n\`\`\`diff\n${second}\n\`\`\`\n\n${RUBRIC}`;
  const one = ask(prompt(candidate, reference));
  const two = ask(prompt(reference, candidate));
  const cand = (total(one.a) + total(two.b)) / 2;
  const ref = (total(one.b) + total(two.a)) / 2;
  const picks = [one.better === "A" ? "candidate" : one.better === "B" ? "reference" : "tie", two.better === "B" ? "candidate" : two.better === "A" ? "reference" : "tie"];
  return { candidate: cand, reference: ref, preferred: picks[0] === picks[1] ? (picks[0] as Judged["preferred"]) : "split", verdicts: [one, two] };
};

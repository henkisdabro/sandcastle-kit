// The closing summary in a run with an autonomy level: a turn the loop continues from does not tell
// the operator to do what the loop does next, "Runnable now" says why each ticket can run, and a
// conflict resolution the kit held is `held` from its first write. Made-up run records and a temp
// git repo; no Docker, model or network.
//
//   pnpm exec tsx --test test/report-turns.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { afterTurn } = await import("../src/autonomy.ts");
const { settledUnlanded } = await import("../src/burndown.ts");
const { closingReport, operatorSteps, render } = await import("../src/report.ts");
const { recordRun } = await import("../src/run.ts");
const { strayChanges, strayNote } = await import("../src/resolution.ts");
type Facts = Parameters<typeof render>[0];
type Project = import("../src/config.ts").Project;

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: { green: true, line: "ok" },
  gateCount: 1,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

// Turn 1 of a run: #101 landed, #104 and #111 were held for a file overlap with it, #106 waited on it
// as a blocker, #108 conflicted.
const turnOne = (over: Partial<Facts> = {}) =>
  facts({
    tickets: {
      "101": { state: "merged" },
      "104": { state: "blocked", note: "waits for #101 (this run) - next run" },
      "106": { state: "blocked", note: "waits for #101 (not in this run)" },
      "108": { state: "conflict", note: "with #101: src/a.ts" },
      "111": { state: "blocked", note: "waits for #112 (not in this run)" },
    },
    runnable: ["104", "106"],
    blocked: [{ id: "111", on: ["#112"] }],
    ahead: 3,
    upstream: "origin/main",
    ...over,
  });

test("a turn the loop continues from: one line for the loop's next turn, then the push line", () => {
  const out = render(turnOne({ next: { level: 3, turn: 2, tickets: ["108", "104", "106"] } }));
  assert.equal(
    body(out, "## 👉 Next step").trim(),
    "1. Autonomy level 3 runs turn 2 of 3 next for #108, #104, #106; nothing to do yet.\n2. Push main (3 commit(s)) under this repo's rules.",
  );
});

test("a continued turn with nothing ahead has the one line only", () => {
  const out = render(turnOne({ ahead: 0, next: { level: 2, turn: 2, tickets: ["108"] } }));
  assert.equal(body(out, "## 👉 Next step").trim(), "1. Autonomy level 2 runs turn 2 of 2 next for #108; nothing to do yet.");
});

test("the last turn's Next step is unchanged", () => {
  const out = render(turnOne());
  const next = body(out, "## 👉 Next step");
  assert.doesNotMatch(next, /Autonomy level/);
  assert.match(next, /Look at #108: still queued/);
  assert.match(next, /Run again for the 2 ticket\(s\) this run unblocked/);
  assert.match(next, /Push main \(3 commit\(s\)\)/);
});

test("afterTurn: only a turn the loop runs is marked as followed; level 1 asks, the cap stops", () => {
  const f = turnOne();
  const open = () => true;
  assert.deepEqual(afterTurn(f, 3, 1, open)?.verdict, "run");
  assert.deepEqual(afterTurn(f, 3, 1, open)?.ids, ["108", "104", "106"]);
  assert.equal(afterTurn(f, 3, 3, open)?.verdict, "cap");
  assert.equal(afterTurn(f, 1, 1, open)?.verdict, "ask");
  assert.equal(afterTurn(f, 3, 1, (id) => id !== "108")?.ids.includes("108"), false);
  assert.equal(afterTurn({ ...f, stopped: "usage limit" }, 3, 1, open), undefined);
});

test("Runnable now says why each ticket can run", () => {
  const out = render(turnOne());
  const runnable = body(out, "## ▶️ Runnable now");
  assert.match(runnable, /^▶️ Runnable now: #104 \(held for overlap with #101, now landed\), #106 \(blocker #101 closed\), #108 \(conflicted - its branch resumes\)$/m);
  // Not runnable, so not in the line; its blocker is still named below.
  assert.doesNotMatch(runnable.split("\n")[0], /#111/);
  assert.match(runnable, /⏳ #111 waits for #112/);
});

test("an overlap partner that did not land is named with its state, several blockers are listed", () => {
  const out = render(
    facts({
      tickets: {
        "101": { state: "red", note: "pytest red" },
        "104": { state: "blocked", note: "waits for #101 (this run) - next run" },
        "106": { state: "blocked", note: "waits for #101, #102 (lands this run)" },
      },
      runnable: ["104", "106"],
    }),
  );
  const line = body(out, "## ▶️ Runnable now").split("\n")[0];
  assert.match(line, /#104 \(held for overlap with #101 \(red\)\)/);
  assert.match(line, /#106 \(blockers #101, #102 closed\)/);
});

test("no runnable ticket reads none", () => {
  const out = render(facts({ tickets: { "7": { state: "blocked" } }, blocked: [{ id: "7", on: ["#6"] }] }));
  assert.match(body(out, "## ▶️ Runnable now"), /^▶️ Runnable now: none$/m);
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

test("a resolution strayChanges holds is held with its note from the first write, never nochange", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-turns-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const commit = (message: string) => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
  };
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  write("conflict.txt", "one\n");
  write("clean.txt", "a\nb\nc\n");
  commit("base");
  git(dir, "checkout", "-q", "-b", "agent/issue-5");
  write("conflict.txt", "branch\n");
  commit("branch work");
  const ours = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  write("conflict.txt", "main\n");
  write("clean.txt", "a\nb\nc\nlanded by another ticket\n");
  commit("main work");
  const theirs = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "agent/issue-5");
  try {
    git(dir, "merge", "--no-edit", theirs);
  } catch {
    // The conflict is the point.
  }
  write("conflict.txt", "both\n");
  write("clean.txt", "a\nb\nc\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-edit");
  const resolved = git(dir, "rev-parse", "HEAD");

  const stray = strayChanges(dir, { ours, theirs, resolved });
  assert.deepEqual(stray, ["clean.txt"]);
  const why = strayNote(stray!);
  assert.equal(why, "conflict resolution changed clean.txt, which merged cleanly - check no other ticket's lines were lost");

  const held = settledUnlanded({ status: "held", heldNote: why }, true);
  assert.deepEqual(held, { state: "held", note: why });
  // The agent handed nothing back, so even with a hold note on file it is not "handed back".
  assert.doesNotMatch(held.note ?? "", /handed back/);
  assert.notEqual(held.state, "nochange");

  // What an agent hands back itself is still said so; no note at all is still "nothing to change".
  assert.deepEqual(settledUnlanded({ status: "nochange" }, true), { state: "nochange", note: "handed back - for a human" });
  assert.deepEqual(settledUnlanded({ status: "nochange" }, false), { state: "nochange", note: "nothing to change" });
});

test("closingReport marks a turn the loop continues from, and only that one", async () => {
  delete process.env.LINEAR_API_KEY;
  const root = mkdtempSync(join(tmpdir(), "sandcastle-turns-report-"));
  // Not removed: the run record's exit handler writes its finish into it.
  git(root, "init", "-q", "-b", "main");
  const dir = join(root, ".scratch/shop/issues");
  mkdirSync(dir, { recursive: true });
  const ticket = (title: string, status: string, head = "") => `# ${title}\n\nStatus: ${status}\n${head}\nDo it.\n\n## Comments\n`;
  writeFileSync(join(dir, "01-base.md"), ticket("Base", "done"));
  writeFileSync(join(dir, "02-next.md"), ticket("Next", "ready-for-agent", "Blocked by: 01"));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "t");
  const project = {
    name: "demo",
    root,
    baseBranch: "main",
    label: "ready-for-agent",
    gates: [],
    tracker: { kind: "files", dir: ".scratch", done: ["done"], source: "config" },
  } as unknown as Project;
  recordRun(project, {
    issues: ["shop-01"],
    tickets: { "shop-01": { state: "merged", title: "Base" }, "shop-02": { state: "blocked", note: "waits for shop-01 (lands this run)", title: "Next" } },
    verify: null,
  });

  const mid = await closingReport(project, { level: 3, turn: 1 });
  assert.match(body(mid, "## 👉 Next step"), /Autonomy level 3 runs turn 2 of 3 next for shop-02; nothing to do yet\./);
  assert.match(body(mid, "## ▶️ Runnable now"), /Runnable now: shop-02 \(blocker shop-01 closed\)/);
  // The cap turn, a plain run and `sandcastle report` keep the operator's own steps.
  for (const last of [await closingReport(project, { level: 3, turn: 3 }), await closingReport(project, { level: 1, turn: 1 }), await closingReport(project)]) {
    assert.doesNotMatch(body(last, "## 👉 Next step"), /Autonomy level/);
    assert.match(body(last, "## 👉 Next step"), /Run again for the 1 ticket\(s\) this run unblocked/);
  }
  // A drain turn that said the loop runs again, and then the loop stopped (drainStop): the operator's steps, alone.
  assert.match(body(await closingReport(project, { level: "drain", turn: 1 }), "## 👉 Next step"), /runs turn 2 of at most 20 next/);
  const steps = await operatorSteps(project);
  assert.match(steps, /^## (👉 )?Next step\n/);
  assert.doesNotMatch(steps, /Autonomy level|Runnable now/);
  assert.match(steps, /Run again for the 1 ticket\(s\) this run unblocked/);
});

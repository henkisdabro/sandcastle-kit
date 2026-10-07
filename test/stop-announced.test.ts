// A stop of the `.git` guard is announced the moment it holds, not in the closing summary, and its
// notes say what happened. A person's commit on the base branch while a run works trips the guard at
// the next landing: the run lands nothing more but finishes what is in flight, and says so once,
// then. A ticket it never started reads `not started: main moved while sandboxes ran` (not "the
// shared .git changed", which reads as tampering), and a ticket that waits for a blocker of the
// same run names the blocker's own ending, never "not in this run". The real guard on a temp git
// repo, the real scheduler and ledger, fake attempts: no Docker, no network.
//
//   node --test test/stop-announced.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-stop-announced-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const { blockedNote, blockerTicket } = await import("../src/blockers.ts");
const { createHostGit } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { causeWords, createLedger, stoppedLine } = await import("../src/ledger.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Blocker = import("../src/blockers.ts").Blocker;
type Project = import("../src/config.ts").Project;
type G = import("../src/landing.ts").Landable;
type O = import("../src/ledger.ts").Finished;
type Attempted = import("../src/schedule.ts").Attempted<G, O>;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ref = (id: string) => `#${id}`;
const blocker = (id: string): Blocker => ({ kind: "github", id }) as Blocker;
const green = (id: string): G => ({ issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0, head: "abc1234" }) as G;

const makeRepo = () => {
  const root = mkdtempSync(join(TMP, "repo-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "shared.txt"), "start\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-q", "-m", "start");
  return root;
};

/**
 * A run of tickets 1, 2 and 3 on one worker, with 4 held for 3 and 5 held for 1 (both blockers are
 * in the run). While 1 works, a person commits on `main`; the guard finds it at 1's landing check.
 * 2's attempt is slow, so 3 only comes up once the stop holds. The `tell` is the burndown's: the
 * ledger records each ending, the stop's line is printed as told, a blocked note carries the
 * state each ended blocker's record holds.
 */
const play = async () => {
  const root = makeRepo();
  const project = { root, name: "fixture", baseBranch: "main" } as unknown as Project;
  const real = createHostGit(project, gitFingerprint(project));
  const states: Record<string, { state?: string; note?: string | null }> = {};
  const printed: string[] = [];
  const events: string[] = [];
  const notes: Record<string, string[]> = {};
  const ledger = createLedger({
    run: { ticket: (id, fields) => void (states[id] = { ...states[id], ...fields }) },
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref,
    say: () => {},
  });
  const schedule = createSchedule<{ id: string }, G, O, Blocker>({
    tickets: [{ id: "1" }, { id: "2" }, { id: "3" }],
    blockers: {
      held: [
        { ticket: { id: "4" }, on: [blocker("3")] },
        { ticket: { id: "5" }, on: [blocker("1")] },
      ],
      ticketOf: blockerTicket,
      open: async (ts) => ts.map(() => []),
    },
  });
  const { endings, stop } = await schedule.run({
    workers: 1,
    attempt: async (t): Promise<Attempted> => {
      events.push(`attempt ${t.id}`);
      if (t.id === "1") {
        // A person's pull into the run's checkout.
        writeFileSync(join(root, "shared.txt"), "a person's quick fix\n");
        git(root, "commit", "-q", "-am", "quick fix");
      }
      if (t.id === "2") await sleep(80);
      return { kind: "green", green: green(t.id) };
    },
    land: async (g) => {
      events.push(`land ${g.issue}`);
      return { kind: "merged" };
    },
    // The check is slow enough for 2's attempt to be under way, and fast enough to find the move before it ends.
    host: {
      check: async (t) => {
        await sleep(20);
        return real.check(`before landing ${ref(t)}`);
      },
      get failed() {
        return real.failed;
      },
    },
    tell: (c) => {
      switch (c.kind) {
        case "requeued":
          return ledger.tell(c);
        case "ended":
          events.push(`ended ${c.id}`);
          return ledger.tell(c);
        case "stopped landing":
          printed.push(stoppedLine(c.cause, ref));
          events.push("STOPPED line");
          return;
        case "blocked":
          (notes[c.id] ??= []).push(blockedNote(c.on, new Set(c.inFlight), new Set(c.landed), new Map(c.ended.map((id) => [id, ledger.endedAs(id)]))));
          return;
      }
    },
  });
  events.push("run returned");
  ledger.close(endings, stop.headline && causeWords(stop.headline, ref));
  return { states, printed, events, notes, stop };
};

test("a base move found at a landing prints the STOPPED line once, while the run is still going", async () => {
  const { printed, events } = await play();
  assert.equal(printed.length, 1, printed.join("\n"));
  assert.match(printed[0], /^STOPPED landing: main moved while sandboxes ran \([0-9a-f]{7} by Operator Example, .*: quick fix; changes shared\.txt\) - the run finishes what is in flight and lands nothing more\.$/);
  // Before any ticket's ending that the stop caused, and long before the run returned.
  assert.equal(events.filter((e) => e === "STOPPED line").length, 1);
  assert.ok(events.indexOf("STOPPED line") < events.indexOf("ended 1"), events.join(" | "));
  assert.ok(events.indexOf("STOPPED line") < events.indexOf("attempt 3") || !events.includes("attempt 3"), events.join(" | "));
  assert.ok(events.indexOf("STOPPED line") < events.indexOf("run returned"), events.join(" | "));
  assert.equal(events.includes("land 1"), false, "nothing landed after the move");
});

test("a ticket the stop kept from starting says what moved, not that the shared .git changed", async () => {
  const { states } = await play();
  assert.equal(states["3"].state, "skipped");
  assert.equal(states["3"].note, "not started: main moved while sandboxes ran");
});

test("a ticket waiting for a blocker of the same run names how that blocker ended, never 'not in this run'", async () => {
  const { notes, states } = await play();
  // 1 finished green and waits to land on a later run; 3 never began.
  assert.equal(states["1"].state, "stopped");
  assert.equal(notes["5"].at(-1), "waits for #1 (stopped)");
  assert.equal(notes["4"].at(-1), "waits for #3 (not started)");
  for (const n of Object.values(notes).flat()) assert.doesNotMatch(n, /not in this run/);
});

test("blockedNote words each ended blocker by its state and keeps 'not in this run' for the ones outside it", () => {
  const on = [blocker("1"), blocker("2"), blocker("3"), blocker("50")];
  const ended = new Map([
    ["1", "gate red"],
    ["2", "gate red"],
    ["3", "stopped"],
  ]);
  assert.equal(blockedNote(on, new Set(), new Set(), ended), "waits for #1, #2 (gate red), #3 (stopped), #50 (not in this run)");
  // In flight, it lands this run; landed, it is no blocker.
  assert.equal(blockedNote(on, new Set(["1"]), new Set(["2"]), new Map([["3", "stopped"]])), "waits for #1 (lands this run), #3 (stopped), #50 (not in this run)");
});

test("a stop that is not the guard's own still gets a clean note", () => {
  const plan = { kind: "plan limit", ticket: "7" } as const;
  assert.equal(causeWords(plan, ref), "#7 hit the plan's usage limit");
  // An error that is no guard's: the note says the shared .git changed, as before.
  assert.equal(causeWords({ kind: "tampered", error: new Error("boom") }, ref), "the shared .git changed");
});

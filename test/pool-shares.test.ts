// The machine pool's shares (src/pool.ts, docs/adr/0001): live runs split the sandbox slots
// equally between them, up to each run's demand. A run above its share takes no new slot while
// another run below its own waits, and never loses one it holds; a dead run's registration is
// ignored; a run with slots and no registration is an older kit's, counted at its concurrency.
//
// This process is one run and the others are files (test/pool-sim.ts): the slot logic runs in
// process, a ticket looking again every few milliseconds, so no test waits on a real poll. Only a
// registration's going with its process needs one (a short-lived child). The wait order between
// real processes is test/pool-wait-order.test.ts.
//
//   pnpm exec tsx --test test/pool-shares.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { runNode } from "./cli-spawn.ts";
import { cache, cleanup, deadPid, end, heldBy, mine, other, pool, registrations, RUN_ID, said, setHeld, slots, steady, tix, ticket, until, waiting } from "./pool-sim.ts";

const { joinPool, members, setDemand, splitShares } = pool;

afterEach(cleanup);

const tmp = () => mkdtempSync(join(tmpdir(), "sandcastle-shares-"));
const sharesOf = () => members().map((m) => m.share).join();

test("the split: equal parts, none above its demand, the rest to the others, the odd slot to the earlier run", () => {
  const split = (total: number, demands: number[]) => {
    const shares = splitShares(total, demands.map((demand, i) => ({ run: `r${i}`, demand, since: i })));
    return demands.map((_, i) => shares.get(`r${i}`));
  };
  assert.deepEqual(split(6, [5, 5]), [3, 3]);
  assert.deepEqual(split(5, [5, 5]), [3, 2]);
  assert.deepEqual(split(6, [1, 5]), [1, 5]);
  assert.deepEqual(split(6, [5, 1]), [5, 1]);
  assert.deepEqual(split(6, [2, 5, 5]), [2, 2, 2]);
  assert.deepEqual(split(6, [1, 2, 9]), [1, 2, 3]);
  assert.deepEqual(split(6, [2, 2]), [2, 2], "the pool is not handed out beyond every demand");
  assert.deepEqual(split(6, [4]), [4]);
  assert.deepEqual(split(6, [0, 5]), [0, 5], "a drained run has no share");
  assert.deepEqual(split(2, [5, 5, 5]), [1, 1, 0]);
});

test("a run filling its demand alone gives way to a second one: its tickets that finish are not replaced above its share", async () => {
  // A fills 5 slots alone. Run B joins and waits for 5; two of A's tickets finish and its workers
  // ask again at once - the way a run starts its next ticket.
  joinPool("alpha", 5, 5);
  const first = tix("a", 5);
  await until(() => heldBy() === "5", "run A to fill its demand alone");
  other("beta", { demand: 5, held: 0 });
  assert.equal(sharesOf(), "3,3");
  first[0]!.release();
  first[1]!.release();
  const again = tix("again", 2);
  await until(() => mine() === 3, "A's two tickets to finish");
  // A holds 3 and its share is 3: the three free slots are B's, and A leaves them.
  await steady(() => mine() === 3 && again.every((t) => !t.taken), "run A took a slot above its share");
  assert.deepEqual(again[0]!.why, ["share"]);
  // B takes them: the pool settles at 3 + 3, and A's two new tickets and its other waiters stay waiting.
  setHeld("beta", 3);
  await steady(() => heldBy() === "3,3" && again.every((t) => !t.taken), "the split moved");
});

test("a run below its share takes the slots a run above its own frees, and not past it", async () => {
  other("alpha", { demand: 5, held: 5 });
  joinPool("beta", 5, 5);
  const b = tix("b", 5);
  // The one free slot is B's at once (it holds none, its share is 3); the others wait for A's.
  await until(() => b.filter((t) => t.taken).length === 1, "run B to take the free slot");
  setHeld("alpha", 3);
  await until(() => heldBy() === "3,3", "B to take what A let go of");
  await steady(() => heldBy() === "3,3", "the pool left 3 + 3", 50);
  assert.equal(b.filter((t) => t.taken).length, 3);
});

test("a run wanting 1 leaves 5 to the other", async () => {
  other("small", { demand: 1, held: 1 });
  joinPool("big", 5, 5);
  tix("b", 5);
  await until(() => heldBy() === "1,5", "1 + 5");
  await steady(() => heldBy() === "1,5", "the pool left 1 + 5");
});

test("a run over its share takes no new slot while another waits, and keeps every slot it holds", async () => {
  // A holds all six; B has joined and waits for 5. Its share is 3, A's own is 3.
  joinPool("alpha", 7, 7);
  const held = tix("a", 6);
  await until(() => mine() === 6, "run A to hold the whole pool");
  other("beta", { demand: 5, held: 0 });
  waiting("beta", Date.now());
  // B is below its share, A above its own: nothing is taken from A.
  await steady(() => mine() === 6, "a slot was taken from run A");
  // A frees one slot and asks again: it is not A's to take.
  held[0]!.release();
  const again = ticket("a again");
  await until(() => mine() === 5, "A to free the slot");
  await steady(() => !again.taken && heldBy() === "5", "run A took the freed slot back");
  assert.deepEqual(again.why, ["share"]);
  assert.ok(said.some((line) => /this run's share is 3 and it holds \d, another run waits below its own/.test(line)), said.join("\n"));
  // B has the slot; A frees two more, B takes them: 3 + 3.
  setHeld("beta", 1);
  held[1]!.release();
  held[2]!.release();
  await until(() => mine() === 3, "A to free two more");
  setHeld("beta", 3);
  await steady(() => heldBy() === "3,3" && !again.taken, "A took a slot above its share");
});

test("a run between two of its tickets keeps its share: another run leaves those free slots alone", async () => {
  // A live run that wants 3 and holds none at this instant: no wait entry, only its registration.
  other("idle", { demand: 3 });
  joinPool("alpha", 6, 6);
  const a = tix("a", 6);
  await until(() => heldBy() === "3", "run A to take its share");
  await until(() => a.some((t) => t.why.includes("share")), "run A to say it waits for its share");
  // Three slots stay free: they are the other run's share, not anyone's to take.
  await steady(() => heldBy() === "3", "a slot of the other run's share was taken");
  // A drained run (demand 0) wants nothing: with no one else wanting one, a free slot is taken as before.
  other("idle", { demand: 0 });
  await until(() => heldBy() === "6", "run A to take the slots no one wants");
});

test("an older wait of a run above its share does not hold back a run below its own", async () => {
  // A holds the whole pool and has a seventh ticket waiting before B arrives.
  other("alpha", { demand: 7, held: 6 });
  waiting("alpha", Date.now() - 5000);
  joinPool("beta", 5, 5);
  const b = tix("b", 5);
  await until(() => b.every((t) => t.why.length > 0), "run B to wait");
  // The slot A frees goes to B, below its share, though A's seventh has waited longer.
  setHeld("alpha", 5);
  await until(() => mine() === 1, "run B to take the freed slot");
  assert.equal(b.filter((t) => t.taken).length, 1);
});

test("a run below its share does hold back a younger wait of a run that could take the slot", async () => {
  // The converse: A is below its share and has waited longer, so the free slot is A's to take.
  other("alpha", { demand: 5, held: 2 });
  other("gamma", { demand: 5, held: 4 });
  waiting("alpha", Date.now() - 5000);
  joinPool("beta", 5, 5);
  const b = ticket("b");
  await until(() => b.why.length > 0, "run B to wait");
  assert.equal(heldBy(), "2,4");
  await steady(() => !b.taken, "run B took a slot A waits for");
  assert.deepEqual(b.why, ["slots"]);
});

test("when one run ends, the other takes the whole pool", async () => {
  // A holds 3 of its 6 and B the other 3 of its 6.
  other("alpha", { demand: 6, held: 3 });
  joinPool("beta", 6, 6);
  tix("b", 6);
  await until(() => heldBy() === "3,3", "3 + 3");
  await steady(() => heldBy() === "3,3", "the pool left 3 + 3");
  end("alpha");
  await until(() => heldBy() === "6", "run B to take the whole pool");
});

test("a dead run's registration is ignored, and removed", async () => {
  other("deadrun", { demand: 6, pid: deadPid(), since: 1 });
  joinPool("beta", 6, 6);
  tix("b", 6);
  await until(() => heldBy() === "6", "run B to take the whole pool");
  assert.ok(!existsSync(join(registrations, "deadrun.run")), "the dead registration was removed");
});

test("a run with slots and no registration is counted at its concurrency, or at the slots it holds", () => {
  other("newrun", { demand: 6 });
  // An older kit's slot, with no run id and no registration.
  mkdirSync(slots, { recursive: true });
  const older = 2_000_000;
  writeFileSync(join(slots, "sandboxes-0.lock"), `${older} t1 an older kit's label\n`);
  // Its run record says it runs 4 at a time; the live-runs directory leads to it.
  const root = tmp();
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const record = join(root, ".sandcastle/logs/run.json");
  writeFileSync(record, JSON.stringify({ pid: older, concurrency: 4 }));
  const runs = join(cache, "sandcastle-kit", "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "older"), root);

  const [old, theirs] = [members().find((m) => !m.registered)!, members().find((m) => m.registered)!];
  assert.equal(old.demand, 4, "its concurrency, though it holds one slot");
  assert.equal(old.held, 1);
  assert.equal(old.share, 3);
  assert.equal(theirs.share, 3, "the older run's wish takes its part of the pool");

  // A record that cannot be read: the slots it holds stand in.
  writeFileSync(record, "not json");
  assert.equal(members().find((m) => !m.registered)!.demand, 1);
  writeFileSync(join(slots, "sandboxes-1.lock"), `${older} t2 another label\n`);
  const unread = members();
  assert.equal(unread.find((m) => !m.registered)!.demand, 2);
  assert.deepEqual(unread.map((m) => m.share).sort(), [2, 4]);
});

test("a registration is written whole and names its run", () => {
  joinPool("gamma", 3, 2);
  setDemand(0);
  setDemand(3);
  const files = readdirSync(registrations).filter((f) => f.endsWith(".run"));
  assert.deepEqual(files, [`${RUN_ID}.run`]);
  const entry = JSON.parse(readFileSync(join(registrations, files[0]!), "utf8"));
  assert.equal(entry.project, "gamma");
  assert.equal(entry.run, RUN_ID);
  assert.equal(entry.pid, process.pid);
  assert.equal(entry.concurrency, 3);
  assert.equal(entry.shares, true);
  assert.equal(entry.demand, 3);
  assert.deepEqual(readdirSync(registrations).filter((f) => !f.endsWith(".run")), [], "no half-written file is left");
});

test("a registration is removed with its process", () => {
  // A real process, once: the file goes with the process's exit, which only a process can show.
  const script = `const { joinPool, RUN_ID } = await import(${JSON.stringify(join(import.meta.dirname, "../src/pool.ts"))}); joinPool("delta", 2, 2); console.log(RUN_ID);`;
  const r = runNode(["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, SANDCASTLE_MAX_SANDBOXES: "6" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const run = r.stdout.trim();
  assert.match(run, /^[0-9a-f]{8}$/);
  assert.ok(!existsSync(join(registrations, `${run}.run`)), "gone with its process");
});

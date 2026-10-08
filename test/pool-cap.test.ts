// A cap (`sandcastle cap`, src/pool.ts) is a person's limit on one live run's share. It lives in the
// run's registration and ends with the run. It only lowers the share (the slots it frees go to the
// other runs, up to their demand), and a capped run above it keeps the slots it holds.
// This process is one run and the others are files, as in test/pool-shares.test.ts.
//
//   pnpm test:file test/pool-cap.test.ts

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { startNode } from "./cli-spawn.ts";
import { cleanup, heldBy, mine, other, pool, registrations, setHeld, slots, steady, tix, ticket, until } from "./pool-sim.ts";

const { joinPool, members, parseCapArgs, setCap, setDemand, splitShares, standing } = pool;

afterEach(cleanup);

const shareOf = (project: string) => members().find((m) => m.project === project)?.share;
const shares = () => [shareOf("alpha"), shareOf("beta")];

test("the split: a cap lowers what a run asks for, and the others take the rest up to their demand", () => {
  const split = (total: number, wants: [number, number?][]) => {
    const split = splitShares(total, wants.map(([demand, cap], i) => ({ run: `r${i}`, demand, cap, since: i })));
    return wants.map((_, i) => split.get(`r${i}`));
  };
  assert.deepEqual(split(6, [[5], [5]]), [3, 3]);
  assert.deepEqual(split(6, [[5, 1], [5]]), [1, 5]);
  assert.deepEqual(split(6, [[5], [5, 1]]), [5, 1]);
  assert.deepEqual(split(6, [[5, 1], [3]]), [1, 3], "the others stop at their own demand");
  assert.deepEqual(split(6, [[5, 4], [5]]), [3, 3], "a cap above the share changes nothing");
  assert.deepEqual(split(6, [[2, 4], [5]]), [2, 4], "a cap above the demand changes nothing");
  assert.deepEqual(split(6, [[0, 2], [5]]), [0, 5], "a drained run still has no share");
});

test("a cap of 1 on one of two runs gives the other 5, and lifting it returns both to 3 + 3; the capped run keeps its slots", async () => {
  // A holds 3 of its 5 and B holds the other 3; A has two tickets waiting.
  joinPool("alpha", 5, 5);
  const first = tix("a", 5);
  await until(() => mine() === 5, "run A to fill its demand alone");
  other("beta", { demand: 5, held: 0 });
  first[0]!.release();
  first[1]!.release();
  const again = tix("again", 2);
  await until(() => mine() === 3, "A's two tickets to finish");
  setHeld("beta", 3);
  assert.deepEqual(shares(), [3, 3]);

  // Capped at 1, A is above its share of 1 and holds 3: it keeps them, and B's share is 5.
  setCap("alpha", 1);
  assert.deepEqual(shares(), [1, 5]);
  await steady(() => heldBy() === "3,3", "the cap took a slot from the capped run");

  // A lets go of two; its own waiting tickets do not take them back, B's do.
  first[2]!.release();
  first[3]!.release();
  await until(() => mine() === 1, "A to let go of two");
  await steady(() => mine() === 1 && again.every((t) => !t.taken), "the capped run took a slot above its cap");
  setHeld("beta", 5);
  assert.equal(heldBy(), "1,5");

  // Lifted, both are at their equal split again (B keeps what it holds until its tickets finish).
  setCap("alpha", "off");
  assert.deepEqual(shares(), [3, 3]);
  assert.equal(standing("alpha").cap, undefined);
  setHeld("beta", 3);
  await until(() => heldBy() === "3,3", "A to take the slots B let go of");
});

test("a capped run takes no slot above its cap even when no other run wants one, and takes them again once lifted", async () => {
  joinPool("alpha", 5, 5);
  setCap("alpha", 2);
  const a = tix("a", 5);
  await until(() => mine() === 2, "run A to hold its cap");
  await steady(() => mine() === 2, "the run took a slot above its cap");
  assert.ok(a.some((t) => t.why.includes("share")));
  setCap("alpha", "off");
  await until(() => mine() === 5, "run A to take its demand");
});

test("a capped run holds no more than its cap when its demand is below it and no other run wants a slot", async () => {
  // The demand is the scheduler's count, told as it changes: a run can ask for a slot above it, and
  // with no other run its share would not stop it. The cap still does.
  joinPool("alpha", 5, 1);
  setCap("alpha", 2);
  tix("a", 4);
  await until(() => mine() === 2, "run A to hold its cap");
  await steady(() => mine() === 2, "the run took a slot above its cap");
});

test("the run's own rewrites of its registration keep a cap set from outside", () => {
  joinPool("alpha", 5, 5);
  setCap("alpha", 2);
  setDemand(3);
  assert.deepEqual([standing("alpha").demand, standing("alpha").cap], [3, 2]);
  joinPool("alpha", 5, 4);
  assert.deepEqual([standing("alpha").demand, standing("alpha").cap], [4, 2]);
});

test("the cap ends with the run: a new run of the same project starts uncapped", async () => {
  // A real process, once: a cap set from outside is in its registration, which goes when it ends.
  const script = `const { joinPool } = await import(${JSON.stringify(join(import.meta.dirname, "../src/pool.ts"))}); joinPool("alpha", 5, 5); console.log("up"); process.stdin.resume(); await new Promise((r) => process.stdin.once("end", r));`;
  const child = startNode(["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const ended = new Promise<number | null>((resolve) => child.once("exit", resolve));
  await until(() => out.includes("up"), "the first run to register");
  setCap("alpha", 2);
  assert.equal(standing("alpha").cap, 2);
  child.stdin!.end();
  assert.equal(await ended, 0, out);
  assert.deepEqual(readdirSync(registrations).filter((f) => f.endsWith(".run")), [], "the registration, and the cap in it, went with the run");
  // The next run of the project: this process, as a new registration.
  joinPool("alpha", 5, 5);
  assert.equal(standing("alpha").cap, undefined);
  assert.equal(shareOf("alpha"), 5);
});

test("refusals: above the run's concurrency, no live run, and what is no cap", () => {
  assert.throws(() => setCap("alpha", 1), /No live sandcastle run of project "alpha"/);
  assert.throws(() => standing("alpha"), /No live sandcastle run of project "alpha"/);
  joinPool("alpha", 4, 4);
  assert.throws(() => setCap("alpha", 5), /above this run's concurrency of 4/);
  assert.equal(standing("alpha").cap, undefined, "a refused cap is not set");
  assert.equal(setCap("alpha", 4).cap, 4, "concurrency itself is allowed");
  for (const bad of ["0", "-1", "1.5", "two", "", "3x", "OFF"]) assert.throws(() => parseCapArgs([bad]), /expected a whole number of 1 or more, or "off"/, `"${bad}"`);
  assert.throws(() => parseCapArgs(["1", "2"]), /Usage: sandcastle cap/);
  assert.throws(() => parseCapArgs(["--project"]), /needs the project's name/);
  assert.deepEqual(parseCapArgs(["--project", "x", "3"]), { project: "x", cap: 3 });
  assert.deepEqual(parseCapArgs(["off"]), { project: undefined, cap: "off" });
  assert.deepEqual(parseCapArgs([]), { project: undefined });
});

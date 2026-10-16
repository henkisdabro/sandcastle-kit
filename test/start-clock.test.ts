// Where a run's start spent its time: the clock is driven with an injected `now`, and the wiring
// (cli.ts, the skill) is held by reading the source, as burndown() needs Docker and has no harness.
//
//   pnpm test:file test/start-clock.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { startClock } from "../src/start-clock.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** A clock whose time is moved by hand, in seconds. */
const timer = () => {
  let ms = 0;
  return { now: () => ms, pass: (s: number) => void (ms += Math.round(s * 1000)) };
};

test("a 64.2 s start names its heaviest steps, heaviest first, and the rest as others", () => {
  const t = timer();
  const clock = startClock(t.now);
  clock.step("queue read");
  t.pass(12.3);
  clock.step("blocker reads");
  t.pass(31.0);
  clock.step("docker info");
  t.pass(4.1);
  clock.step("estimate");
  t.pass(0.4);
  clock.step("keep awake");
  t.pass(0.6);
  clock.step("versions");
  t.pass(9.8);
  clock.step();
  t.pass(6.0);
  assert.equal(clock.line(), "Start took 64.2 s: blocker reads 31.0 s, queue read 12.3 s, versions 9.8 s, docker info 4.1 s, others 7.0 s");
});

test("a start under 10 s says nothing and one of 10.0 s says a line", () => {
  const short = timer();
  const a = startClock(short.now);
  a.step("queue read");
  short.pass(9.9);
  assert.equal(a.line(), undefined);

  const exact = timer();
  const b = startClock(exact.now);
  b.step("queue read");
  exact.pass(10.0);
  assert.equal(b.line(), "Start took 10.0 s: queue read 10.0 s");
});

test("two steps of the same name are one step", () => {
  const t = timer();
  const clock = startClock(t.now);
  clock.step("docker info");
  t.pass(3);
  clock.step("config");
  t.pass(5);
  clock.step("docker info");
  t.pass(2);
  assert.equal(clock.line(), "Start took 10.0 s: docker info 5.0 s, config 5.0 s");
});

test("a step of 0.9 s is never named and a step of 1.0 s is", () => {
  const t = timer();
  const clock = startClock(t.now);
  clock.step("estimate");
  t.pass(0.9);
  clock.step("queue read");
  t.pass(1.0);
  clock.step("config");
  t.pass(9.1);
  assert.equal(clock.line(), "Start took 11.0 s: config 9.1 s, queue read 1.0 s, others 0.9 s");
});

test("others is left off when it rounds to 0.0 s", () => {
  const t = timer();
  const clock = startClock(t.now);
  clock.step("queue read");
  t.pass(10.04);
  assert.equal(clock.line(), "Start took 10.0 s: queue read 10.0 s");
});

test("steps that tie keep the order they were first timed", () => {
  const t = timer();
  const clock = startClock(t.now);
  clock.step("versions");
  t.pass(5);
  clock.step("config");
  t.pass(5);
  assert.equal(clock.line(), "Start took 10.0 s: versions 5.0 s, config 5.0 s");
});

test("a 40 s aside in a 52 s start leaves it out of the total and says so at the end", async () => {
  const t = timer();
  const clock = startClock(t.now);
  clock.step("config");
  t.pass(2);
  const answer = await clock.aside("API-key question", async () => {
    t.pass(40);
    return "yes";
  });
  assert.equal(answer, "yes");
  clock.step("queue read");
  t.pass(10);
  assert.equal(clock.line(), "Start took 12.0 s: queue read 10.0 s, config 2.0 s (not counting 40 s at the API-key question)");
});

test("a 30 s aside in a 35 s start says nothing", async () => {
  const t = timer();
  const clock = startClock(t.now);
  t.pass(5);
  await clock.aside("API-key question", () => t.pass(30));
  assert.equal(clock.line(), undefined);
});

test("an aside ends the step in progress, and its time is not that step's", async () => {
  const t = timer();
  const clock = startClock(t.now);
  clock.step("config");
  t.pass(11);
  await clock.aside("API-key question", () => t.pass(20));
  t.pass(1);
  assert.equal(clock.line(), "Start took 12.0 s: config 11.0 s, others 1.0 s (not counting 20 s at the API-key question)");
});

test("an aside of under 1 s is not said", async () => {
  const t = timer();
  const clock = startClock(t.now);
  clock.step("config");
  t.pass(10);
  await clock.aside("API-key question", () => t.pass(0.5));
  assert.equal(clock.line(), "Start took 10.0 s: config 10.0 s");
});

test("the clock writes nothing: src/start-clock.ts imports no node:fs", () => {
  assert.doesNotMatch(read("src/start-clock.ts"), /node:fs|timings\.jsonl.*(append|write)/);
  assert.doesNotMatch(read("src/start-clock.ts"), /^import .*"node:/m);
});

test("cli.ts asks the attached API-key question inside the aside and hands turn 1 the clock", () => {
  const cli = read("src/cli.ts");
  const calls = [...cli.matchAll(/confirmApiKey\(/g)].map((m) => m.index!);
  const attached = calls.filter((i) => cli.slice(i, i + 200).includes("askingInPane"));
  assert.equal(attached.length, 1);
  assert.match(cli.slice(attached[0] - 40, attached[0]), /clock\.aside\("API-key question", \(\) => $/);
  assert.match(cli, /const clock = startClock\(\);/);
  const burndownCall = cli.slice(cli.indexOf("await burndown(project"));
  assert.match(burndownCall.slice(0, burndownCall.indexOf("\n")), /turn === 1 \? \{ docker, clock,/);
  // The detached parent prints no line: the child, running the attached path, does.
  const detached = cli.slice(cli.indexOf("given.detach ||"), cli.indexOf("An agent that started the run in another pane"));
  assert.doesNotMatch(detached, /clock\.line\(/);
});

test("burndown() takes the first turn's clock, else starts its own", () => {
  const src = read("src/burndown.ts");
  assert.match(src, /const clock = turn\?\.clock \?\? startClock\(\);/);
  assert.match(src, /type TurnOptions = \{[^}]*clock\?: StartClock/);
  for (const name of ["lock and reap", "git baseline", "queue read", "blocker reads", "schedule", "versions", "other runs", "docker info", "carried branches", "blocker chain", "estimate", "keep awake", "run record", "status view"]) {
    assert.ok(src.includes(`clock.step("${name}")`), `burndown() times ${name}`);
  }
});

test("the skill reads the Start took line once after a slow start and names it again when closing the run", () => {
  const run = read("skill/run.md");
  const two = run.slice(run.indexOf("2. **Start it detached.**"), run.indexOf("3. **"));
  assert.ok(two.length > 0);
  for (const word of ["Start took", "once", "step 4"]) assert.ok(two.includes(word), `step 2 says ${word}`);
  const from = run.indexOf("4. **Close the run");
  const rest = run.slice(from);
  const next = rest.indexOf("\n## ");
  assert.ok(from >= 0 && next > 0);
  assert.ok(rest.slice(0, next).includes("Start took"));
});

// The run's one stop state (createStopState in src/schedule.ts): every cause kept, read only as
// "starts nothing", "lands nothing" and the headline the closing summary names. A pure table over
// every cause kind and every mix of them, in every arrival order. No git, no Docker, no network.
//
//   pnpm test:file test/stop-state.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { createStopState, STOP_KINDS, type StopCause } from "../src/schedule.ts";

type Kind = StopCause["kind"];

// One cause of each kind. Typed by kind, so a new kind fails the type check here until it has one.
const ONE: Record<Kind, StopCause> = {
  tampered: { kind: "tampered", error: new Error("STOPPED after #2: main moved while sandboxes ran") },
  "host failed": { kind: "host failed", error: new Error("STOPPED before writing to the base branch: HEAD changed") },
  "plan limit": { kind: "plan limit", ticket: "3" },
  "usage limit": { kind: "usage limit", line: "usage 97% of the 5-hour window" },
};

// The spec, written out rather than read from STOP_KINDS: the safety stops, and the headline order.
const SAFETY: Record<Kind, boolean> = { tampered: true, "host failed": true, "plan limit": false, "usage limit": false };
const SEVERITY: Kind[] = ["tampered", "host failed", "plan limit", "usage limit"];

const KINDS = Object.keys(ONE) as Kind[];
const subsets = <T>(xs: T[]): T[][] => xs.reduce<T[][]>((all, x) => [...all, ...all.map((s) => [...s, x])], [[]]);
const orders = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));

test("each kind is declared once, with whether it is a safety stop", () => {
  assert.deepEqual(Object.keys(STOP_KINDS).sort(), [...KINDS].sort());
  for (const k of KINDS) assert.equal(STOP_KINDS[k].safety, SAFETY[k], k);
  // Every safety stop ranks above every limit, so a run that lands nothing is always headed by why.
  const worstLimit = Math.min(...KINDS.filter((k) => !SAFETY[k]).map((k) => STOP_KINDS[k].rank));
  for (const k of KINDS.filter((k) => SAFETY[k])) assert.ok(STOP_KINDS[k].rank < worstLimit, k);
});

test("no cause: the run starts and lands as normal, with no headline", () => {
  const stop = createStopState({ failed: undefined });
  assert.equal(stop.startsNothing, false);
  assert.equal(stop.landsNothing, false);
  assert.equal(stop.headline, undefined);
  assert.deepEqual(stop.causes, []);
});

test("every mix of kinds, in every arrival order: starts nothing, lands nothing, and the headline", () => {
  let cases = 0;
  for (const mix of subsets(KINDS).filter((s) => s.length)) {
    for (const order of orders(mix)) {
      const stop = createStopState();
      for (const k of order) stop.add(ONE[k]);
      const what = order.join(", then ");
      assert.equal(stop.startsNothing, true, what);
      assert.equal(stop.landsNothing, order.some((k) => SAFETY[k]), what);
      assert.equal(stop.headline, ONE[SEVERITY.find((k) => order.includes(k))!], what);
      assert.deepEqual(stop.causes, order.map((k) => ONE[k]), `${what}: every cause kept, in arrival order`);
      cases++;
    }
  }
  assert.equal(cases, 64);
});

test("a safety stop after a limit still lands nothing, and heads the summary", () => {
  const stop = createStopState();
  stop.add(ONE["usage limit"]);
  assert.equal(stop.landsNothing, false, "a limit still lands what is green");
  stop.add(ONE.tampered);
  assert.equal(stop.landsNothing, true);
  assert.equal(stop.headline, ONE.tampered);
});

test("within a rank the earliest cause is the headline", () => {
  const first: StopCause = { kind: "plan limit", ticket: "4" };
  const second: StopCause = { kind: "plan limit", ticket: "7" };
  const stop = createStopState();
  stop.add(ONE["usage limit"]);
  stop.add(first);
  stop.add(second);
  assert.equal(stop.headline, first);
  const tampered = [1, 2].map((n): StopCause => ({ kind: "tampered", error: new Error(`STOPPED after #${n}`) }));
  for (const c of tampered) stop.add(c);
  assert.equal(stop.headline, tampered[0]);
  assert.equal(stop.causes.length, 5);
});

test("the host's refused write is read live: a safety stop nobody recorded", () => {
  const host: { failed: unknown } = { failed: undefined };
  const stop = createStopState(host);
  stop.add(ONE["plan limit"]);
  assert.equal(stop.landsNothing, false);
  const refused = new Error("STOPPED before writing to the base branch: config changed");
  host.failed = refused;
  assert.equal(stop.startsNothing, true);
  assert.equal(stop.landsNothing, true);
  assert.deepEqual(stop.headline, { kind: "host failed", error: refused });
  assert.deepEqual(stop.causes.map((c) => c.kind), ["plan limit", "host failed"]);
  // A tampered `.git` still heads it; the host's failure stays among the causes.
  stop.add(ONE.tampered);
  assert.equal(stop.headline, ONE.tampered);
  assert.deepEqual(stop.causes.map((c) => c.kind), ["plan limit", "tampered", "host failed"]);
});

test("the host's failure alone stops the run, and is kept once even when also added", () => {
  const refused = new Error("STOPPED before writing to the base branch: HEAD changed");
  const stop = createStopState({ failed: refused });
  assert.equal(stop.startsNothing, true);
  assert.equal(stop.landsNothing, true);
  stop.add({ kind: "host failed", error: refused });
  assert.equal(stop.causes.length, 1);
});

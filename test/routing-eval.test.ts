// The routing eval's own rules where a slip would quietly corrupt its results: a seam hint gives a
// signature and never the body (a one-line function is its own answer), an arm names exactly the
// roles it sets, and Haiku's prompts over 100K tokens are priced on their own card.
//
//   pnpm test:file test/routing-eval.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

const { shapeOf } = await import("../evals/routing/tasks.ts");
const { armEnv, dollars, parseArm } = await import("../evals/routing/arms.ts");

test("a seam is the declaration's name, parameters and return type, without its body", () => {
  assert.equal(
    shapeOf(`export const redBaseExit = (facts: Pick<Facts, "verify"> | undefined): 1 | undefined => (facts?.verify?.green === false ? 1 : undefined);`),
    `export const redBaseExit = (facts: Pick<Facts, "verify"> | undefined): 1 | undefined`,
  );
  assert.equal(
    shapeOf("export const takeStartSlot = async (take: () => Promise<boolean>, now: () => number = Date.now): Promise<number> => {"),
    "export const takeStartSlot = async (take: () => Promise<boolean>, now: () => number = Date.now): Promise<number>",
  );
  assert.equal(shapeOf("export function verifyFailing(failures: string[]): string[] {"), "export function verifyFailing(failures: string[]): string[]");
  assert.equal(shapeOf("export const proof = (x: number) => x > 1;"), "export const proof = (x: number)");
  assert.equal(shapeOf("export const LANDING = 3;"), "export const LANDING");
  assert.equal(shapeOf("export type Slot = { release(): void };"), "export type Slot = { release(): void };");
});

test("an arm sets the implementer and the reviewer it names, and turns cross-review off", () => {
  const arm = parseArm("H-max/O-high+advisor");
  assert.deepEqual(armEnv(arm), { IMPL_MODEL: "claude-haiku-5-5", IMPL_EFFORT: "max", REVIEW_MODEL: "claude-opus-5-5", REVIEW_EFFORT: "high", CROSS_REVIEW: "0" });
  assert.deepEqual(arm.settings, { advisorModel: "claude-opus-5-5" });
  assert.throws(() => parseArm("H-high"), /implement>\/<review/);
  assert.throws(() => parseArm("X-high/O-high"), /is not/);
  assert.throws(() => parseArm("H-high/O-high+magic"), /unknown mechanism/);
});

test("Haiku requests over 100K tokens cost five times the card; other models have one card", () => {
  const t = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 };
  const under = dollars("claude-haiku-5-5", t)!;
  assert.equal(under.toFixed(3), (0.1 + 0.5 + 0.01 + 0.2).toFixed(3));
  assert.equal(dollars("claude-haiku-5-5", t, 1)!.toFixed(3), (5 * under).toFixed(3));
  assert.equal(dollars("claude-haiku-5-5", t, 0.5)!.toFixed(3), (3 * under).toFixed(3));
  assert.equal(dollars("claude-sonnet-5-5", t, 1), dollars("claude-sonnet-5-5", t, 0));
  assert.equal(dollars("some-other-model", t), undefined);
});

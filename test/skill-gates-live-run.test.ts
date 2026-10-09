// `sandcastle gates` refuses while a run of the project is live, and never waits. The init and
// update actions tell an agent to run it, so each must say to check `sandcastle status 0` (or to
// wait with `sandcastle wait`) first, or `/sandcastle update` meets the refusal unprepared.
//
//   pnpm test:file test/skill-gates-live-run.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");

test("the update action says gates refuses during a live run, before the steps that run gates", () => {
  const update = flat(read("skill", "update.md"));
  const note = update.indexOf("refuses while a run of the project is live");
  assert.ok(note > -1, "update.md does not say gates refuses while a run is live");
  assert.ok(note < update.indexOf("`sandcastle build`"), "the caveat must come before the first step of the project");
  const caveat = update.slice(note, note + 300);
  assert.match(caveat, /`sandcastle status 0`/);
  assert.match(caveat, /`sandcastle wait`/);
});

test("the init action says the base-gates step refuses during a live run", () => {
  const init = flat(read("skill", "init.md"));
  const step = init.slice(init.indexOf("Gate the base commit: `sandcastle gates`"));
  assert.match(step.slice(0, 1200), /refuses while a run of the project is live[^.]*check `sandcastle status 0`/);
  assert.match(step.slice(0, 1200), /`sandcastle wait`/);
});

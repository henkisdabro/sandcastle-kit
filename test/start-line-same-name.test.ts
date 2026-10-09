// The start line of a run that begins beside others names each by its project's config `name`, which two
// checkouts of one repository share. A name another listed run (or this run) also has is told apart by
// the run's folder, or its pid where the folder is unknown or alike; a name nothing shares is as before.
// `burndown()` needs Docker, so its call site is held by a source match. Paths are built with `node:path`.
//
//   pnpm test:file test/start-line-same-name.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { startLines } = await import("../src/pool.ts");
type Neighbour = Parameters<typeof startLines>[1][number];

const run = (o: Partial<Neighbour> = {}): Neighbour => ({ project: "site", registered: true, held: 2, demand: 3, ...o });
const split = { share: 2, free: 0 };

test("two live runs of one project are named with their folders", () => {
  const [line] = startLines(split, [run({ root: join("work", "site"), pid: 11 }), run({ root: join("work", "site-review"), pid: 12, held: 1, demand: 1 })]);
  assert.match(line, /^site \(site\) is live \(2 slots, demand 3\) and site \(site-review\) is live \(1 slot, demand 1\): /);
  assert.match(line, /as site \(site\)'s and site \(site-review\)'s tickets finish$/);
});

test("two live runs of one project in folders of one name are named with their pids", () => {
  const [line] = startLines(split, [run({ root: join("a", "site"), pid: 4242 }), run({ root: join("b", "site"), pid: 4243 })]);
  assert.match(line, /^site \(pid 4242\) is live \(2 slots, demand 3\) and site \(pid 4243\) is live /);
});

test("two live runs of one project with no known root are named with their pids", () => {
  const [line] = startLines(split, [run({ pid: 4242 }), run({ pid: 4243 })]);
  assert.match(line, /^site \(pid 4242\) is live .* and site \(pid 4243\) is live /);
});

test("one live run named like this run is named with its folder", () => {
  const [line] = startLines(split, [run({ root: join("work", "site-review"), pid: 7 })], true, "site");
  assert.match(line, /^site \(site-review\) is live \(2 slots, demand 3\): /);
  assert.match(line, /as site \(site-review\)'s tickets finish$/);
  assert.match(startLines(split, [run({ pid: 7 })], true, "site")[0], /^site \(pid 7\) is live /);
});

test("a live run in a folder of this run's own name is named with its pid", () => {
  const [line] = startLines(split, [run({ root: join("b", "site"), pid: 4242 })], true, "site", join("a", "site"));
  assert.match(line, /^site \(pid 4242\) is live \(2 slots, demand 3\): /);
  assert.match(line, /as site \(pid 4242\)'s tickets finish$/);
  assert.match(startLines(split, [run({ root: join("b", "site-review"), pid: 4242 })], true, "site", join("a", "site"))[0], /^site \(site-review\) is live /);
  assert.match(startLines(split, [run({ project: "webshop", root: join("b", "site"), pid: 9 })], true, "site", join("a", "site"))[0], /^webshop is live /);
});

test("a name nothing shares is printed as it was", () => {
  const [line] = startLines(split, [run({ project: "webshop", root: join("work", "webshop"), pid: 7 }), run({ root: join("work", "site"), pid: 8 })], true, "other");
  assert.match(line, /^webshop is live \(2 slots, demand 3\) and site is live \(2 slots, demand 3\): /);
  assert.equal(startLines(split, [run({ root: join("work", "site"), pid: 7 })])[0], startLines(split, [run()])[0]);
});

test("a run predating shares is named the same way", () => {
  const lines = startLines(split, [run({ registered: false, root: join("work", "site-review") }), run({ registered: false, root: join("work", "site") })]);
  assert.deepEqual(lines, [
    "site (site-review)'s run predates shares: it keeps taking free slots until it ends",
    "site (site)'s run predates shares: it keeps taking free slots until it ends",
  ]);
});

test("burndown() hands startLines each run's root and pid and this run's own name", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "burndown.ts"), "utf8");
  assert.match(src, /root: found\?\.root, pid: m\.pid/);
  assert.match(src, /\}\), !DRY_RUN, project\.name, project\.root\)\) console\.log\(line\)/);
});

// test/run-shards.sh, which test/full-check.sh runs each pass of the suite through: the shards run
// side by side, their counts are summed, a failing shard's tests are shown, and the exit status
// says whether any failed. Run against a copy of the script beside a fake `pnpm` (no suite, no
// Docker); and full-check.sh starts its legs before it waits on any of them.
//
//   pnpm exec tsx --test test/run-shards.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT } from "./cli-spawn.ts";

const root = mkdtempSync(join(tmpdir(), "run-shards-"));
after(() => rmSync(root, { recursive: true, force: true }));

// A kit checkout with only the helpers, and a `pnpm` that answers its two calls: the shard's file
// list (a file named by FAKE_<i>, else a passing one) and the test run over those files.
mkdirSync(join(root, "test"));
mkdirSync(join(root, "bin"));
copyFileSync(join(KIT, "test/run-shards.sh"), join(root, "test/run-shards.sh"));
copyFileSync(join(KIT, "test/shard-count.sh"), join(root, "test/shard-count.sh"));
copyFileSync(join(KIT, "test/in-temp.sh"), join(root, "test/in-temp.sh"));
writeFileSync(
  join(root, "bin/pnpm"),
  `#!/usr/bin/env bash
case "$*" in
  *shard.ts) v="FAKE_\${TEST_SHARD%/*}"; echo "test/\${!v:-ok}.test.ts" ;;
  *) echo "$*" >>"$FAKE_CALLS"
     case "$*" in
       *bad.test.ts*) echo "✖ the failing test"; echo "ℹ pass 1"; echo "ℹ fail 1"; exit 1 ;;
       *crash.test.ts*) echo "boom: the runner died"; exit 2 ;;
     esac
     echo "ℹ pass 2"; echo "ℹ fail 0" ;;
esac
`,
);
chmodSync(join(root, "bin/pnpm"), 0o755);

function run(shards: string, env: Record<string, string> = {}) {
  const logs = mkdtempSync(join(root, "logs-"));
  const calls = join(logs, "calls");
  const r = spawnSync("bash", [join(root, "test/run-shards.sh"), join(logs, "out"), shards], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, FAKE_CALLS: calls, ...env },
    timeout: 30_000,
  });
  const called = (() => {
    try {
      return readFileSync(calls, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  })();
  return { ...r, called, logs: readdirSync(join(logs, "out")).sort() };
}

test("every shard runs, and the counts are summed", () => {
  const r = run("3");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "pass 6 fail 0");
  assert.equal(r.called.length, 3);
  assert.deepEqual(r.logs.filter((f) => f.endsWith(".log")), ["shard-1.log", "shard-2.log", "shard-3.log"]);
});

test("a failing shard's tests are shown and the status is 1", () => {
  const r = run("3", { FAKE_2: "bad" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^✖ the failing test$/m);
  assert.match(r.stdout, /pass 5 fail 1/);
});

test("a shard that dies without a failing test shows the end of its log", () => {
  const r = run("2", { FAKE_1: "crash" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /shard-1\.log exited 2:/);
  assert.match(r.stdout, /boom: the runner died/);
});

test("each shard runs one file at a time unless told otherwise", () => {
  assert.ok(run("2").called.every((c) => c.includes("--test-concurrency=1")));
  assert.ok(run("2", { SHARD_CONCURRENCY: "3" }).called.every((c) => c.includes("--test-concurrency=3")));
});

test("FULL_CHECK_SHARDS sets the count when none is given", () => {
  const r = run("", { FULL_CHECK_SHARDS: "4" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.called.length, 4);
});

test("full-check.sh starts every leg before it waits on one, and runs no suite itself", () => {
  const src = readFileSync(join(KIT, "test/full-check.sh"), "utf8").split("\n");
  const code = src.filter((l) => !l.trimStart().startsWith("#"));
  const starts = code.flatMap((l, i) => (/^\s*(\[.*\|\| )?start \w+ leg_\w+/.test(l) ? [i] : []));
  const wait = code.findIndex((l) => /^wait$/.test(l));
  assert.ok(starts.length >= 4, "the types, tests, agent and scan legs start");
  assert.ok(wait > Math.max(...starts), "the one wait comes after the last start");
  assert.ok(code.some((l) => l.includes("test/run-shards.sh")));
  assert.ok(!code.some((l) => /pnpm (run )?test\b|tsx --test/.test(l) && !l.includes("printf")), "no serial suite run");
});

test("full-check.sh counts the Linux container's pass among those sharing the cores", () => {
  const code = readFileSync(join(KIT, "test/full-check.sh"), "utf8");
  assert.match(code, /passes=2\n\[ -n "\$docker_note" \] \|\| passes=3/);
  assert.match(code, /test\/shard-count\.sh "" "\$passes"/);
  assert.match(code, /docker run --rm -i -e FULL_CHECK_SHARDS="\$shards"/);
});

test("without a count, run-shards.sh uses shard-count.sh for one pass on these cores", () => {
  const want = spawnSync("bash", [join(KIT, "test/shard-count.sh")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const r = run("", { FULL_CHECK_SHARDS: "" });
  assert.equal(r.called.length, Number(want.stdout.trim()));
});

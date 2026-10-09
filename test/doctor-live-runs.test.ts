// `sandcastle doctor` names the runs live on the machine, with a note to wait for them before
// pulling the kit: a live run reads prompts/, container/ and status.sh from disk. The runs come
// from the live-runs directory under XDG_CACHE_HOME; a run is a record whose pid is a process
// whose command line holds the kit's entry. Doctor runs as a child against a temp cache; no Docker.
//
//   pnpm test:file test/doctor-live-runs.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";
import { kitLikeProcess } from "./kit-process.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sc-doclive-")));
process.env.XDG_CONFIG_HOME = join(tmp, "config");
const { liveRunLines } = await import("../src/doctor.ts");
const { runFile } = await import("../src/live-runs.ts");

let n = 0;
// A project with a run record of the given pid, registered in a runs directory of the cache.
const register = (cache: string, pid: number | undefined, extra: object = {}) => {
  const root = join(tmp, `project-${++n}`);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ pid, ...extra }));
  const runs = join(cache, "sandcastle-kit", "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(runFile(root, runs), root);
  return { root, runs };
};

const doctor = (cache: string) => {
  const home = join(tmp, `home-${++n}`);
  mkdirSync(join(home, "config"), { recursive: true });
  const r = runKit(["doctor"], {
    encoding: "utf8",
    cwd: home,
    env: {
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: cache,
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: tmp,
    },
  });
  return r.stdout + r.stderr;
};

const kitProbe = () => "node src/cli.ts run";

test("doctor warns of a live run on the machine, names its project and says to wait before pulling the kit", () => {
  const cache = join(tmp, "cache-live");
  const live = kitLikeProcess();
  try {
    const { root } = register(cache, live.pid);
    const out = doctor(cache);
    assert.match(out, /^warn 1 sandcastle run is live on this machine, and a live run reads the kit's `prompts\/`, `container\/` and `status\.sh` from disk$/m, out);
    assert.match(out, /-> Wait for them to finish before pulling the kit/, out);
    assert.ok(out.includes(`       - ${root} (pid ${live.pid})`), out);
    assert.doesNotMatch(out, /^FIX .*live on this machine/m, "a warning, not a failed check");
  } finally {
    live.kill();
  }
});

test("doctor says nothing of runs when none is live", () => {
  const cache = join(tmp, "cache-none");
  register(cache, 2 ** 22 + 1, {});
  assert.doesNotMatch(doctor(cache), /live on this machine/);
});

test("the warning counts every live run and leaves out a finished one", () => {
  const cache = join(tmp, "cache-many");
  const a = register(cache, process.pid);
  const b = register(cache, process.pid);
  register(cache, process.pid, { finishedAt: "2026-01-01T00:00:00Z", exitCode: 0 });
  const lines = liveRunLines(join(cache, "sandcastle-kit", "runs"), kitProbe);
  assert.match(lines[0], /^warn 2 sandcastle runs are live on this machine/);
  assert.equal(lines.filter((l) => l.startsWith("       - ")).length, 2);
  assert.ok(lines.some((l) => l.includes(a.root)) && lines.some((l) => l.includes(b.root)));
});

test("a machine with no live-runs directory gets no lines", () => {
  assert.deepEqual(liveRunLines(join(tmp, "nowhere"), kitProbe), []);
});

// The base gates' timings line carries per-gate times (`gates`) and the slot wait (`waitMs`), as
// verify's does: a green base once came back as `{ peakMib }` alone, so `.sandcastle/logs/timings.jsonl`
// had only `ms` for it. The base gates run for real against a fake docker whose every call
// succeeds (the sandbox starts, each gate exits 0); no Docker or network.
//
//   pnpm test:file test/base-gates-timings.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

// Before the kit's modules load: they read these once. The machine-wide slots live under the cache dir.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-base-timings-")));
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.XDG_CONFIG_HOME = join(dir, "config");
const bin = join(dir, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "docker"), 0o755);
process.env.PATH = [bin, dirname(process.execPath), process.env.PATH].join(delimiter);
// Made-up credentials: a sandbox's environment needs them, and the fake docker never reads them.
mkdirSync(join(dir, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(dir, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
const { gateMs, requireGreenBase } = await import("../src/gates.ts");
const { loadProject } = await import("../src/config.ts");
const { writePlan } = await import("../src/lean.ts");

const root = join(dir, "project");
mkdirSync(join(root, ".sandcastle"), { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
writeFileSync(
  join(root, ".sandcastle/config.ts"),
  `export default { name: "fixture", setup: [], gates: [{ name: "lint", command: "true" }, { name: "test", command: "true" }] };\n`,
);
git("add", ".gitignore");
git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");

test("a green base's timings line has each gate's time and the slot wait", async () => {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    const { result, lines } = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", writePlan(project).file, false));
    // What burndown's `timed` writes on the "base gates" line, from the result it is handed.
    const gates = gateMs(result);
    assert.deepEqual(Object.keys(gates ?? {}).sort(), ["lint", "test"]);
    assert.equal(typeof (result as { waitMs?: unknown }).waitMs, "number");
    assert.ok(lines.includes("Gates on main: lint=pass test=pass"), lines.join("\n"));
  } finally {
    process.chdir(cwd);
  }
});

// burndown's `timed` is too entangled with a live run to call; that it writes the base gates' line from
// this result (`gateMs` for `gates`, `stepTimes` for `waitMs`) is held here instead.
test("the base gates' timings line is written from requireGreenBase's result", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /timed\("", "base gates", \(\) => requireGreenBase\(/);
  assert.match(src, /times = stepTimes\(Date\.now\(\) - since, result\)/);
  assert.match(src, /gateTimes = gateMs\(result\)/);
});

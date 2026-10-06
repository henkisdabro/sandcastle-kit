// `sandcastle init` in a directory with no recognised stack: the placeholder gate and the message
// point at what CI runs and say Python needs uv. The written config must still load, and the
// placeholder must still fail. A throwaway repo, so no Docker and no network. (test/init.test.ts
// covers stack detection and scaffolding.)
//
//   node --test test/init-fallback.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing init.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { init } = await import("../src/init.ts");
const { loadProject } = await import("../src/config.ts");

test("no stack: the placeholder gate points at CI workflows and node --test, parses, and fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const logged: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => void logged.push(args.join(" ")));
  init(root);

  const config = readFileSync(join(root, ".sandcastle/config.ts"), "utf8");
  for (const want of ["gates-not-set", ".github/workflows", "node --test"]) assert.ok(config.includes(want), `config lacks ${want}`);

  const message = logged.join("\n");
  for (const want of ["uv.lock", "poetry", ".github/workflows"]) assert.ok(message.includes(want), `message lacks ${want}`);

  // The escaped text still parses, and there is still exactly the one placeholder gate.
  const project = await loadProject(root);
  assert.deepEqual(project.gates.map((g) => g.name), ["gates-not-set"]);

  // POSIX sh on both platforms: dash in the image, bash or zsh-as-sh on a Mac.
  const r = spawnSync("sh", ["-c", project.gates[0].command], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("No gates yet: set them in .sandcastle/config.ts from what CI runs (.github/workflows)"), r.stderr);
});

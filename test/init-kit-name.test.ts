// `sandcastle init` in a directory named like one of the kit's own image repositories writes a
// name the config check accepts. A throwaway repo, so no Docker and no network.
//
//   pnpm test:file test/init-kit-name.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing init.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { init } = await import("../src/init.ts");
const { loadProject } = await import("../src/config.ts");

/** `init` in a new git repository whose directory is called `dir`; its root. */
const initIn = (t: { after: (fn: () => void) => void }, dir: string): string => {
  const parent = mkdtempSync(join(tmpdir(), "sandcastle-init-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, dir);
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const log = console.log;
  console.log = () => {};
  try {
    init(root);
  } finally {
    console.log = log;
  }
  return root;
};

for (const [dir, name] of [["agents", "agents-project"], ["Base", "base-project"]]) {
  test(`init in a directory named ${dir} writes ${name}, which loads`, async (t) => {
    const root = initIn(t, dir);
    assert.match(readFileSync(join(root, ".sandcastle/config.ts"), "utf8"), new RegExp(`name: "${name}"`));
    assert.equal((await loadProject(root)).name, name);
  });
}

test("init in a directory that only starts like a kit repository keeps its name", async (t) => {
  const root = initIn(t, "basement");
  assert.match(readFileSync(join(root, ".sandcastle/config.ts"), "utf8"), /name: "basement"/);
  assert.equal((await loadProject(root)).name, "basement");
});

// Doctor treats the kit's own checkout as a project when it has a project config (it burns down
// its own issues); only a checkout of the kit with no config is left out, as an unconfigured
// project would print a false FIX. No Docker, no network.
//
//   pnpm test:file test/doctor-kit-project.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { isProjectRoot } = await import("../src/doctor.ts");

const dir = (config: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-kitproj-"));
  if (config) {
    mkdirSync(join(root, ".sandcastle"));
    writeFileSync(join(root, ".sandcastle/config.ts"), "export default {};\n");
  }
  return root;
};

test("the kit's own checkout with a project config is a project", () => {
  const kit = dir(true);
  assert.equal(isProjectRoot(kit, kit), true);
});

test("the kit's own checkout without a project config is not a project", () => {
  const kit = dir(false);
  assert.equal(isProjectRoot(kit, kit), false);
});

test("another repository is a project with or without a config, and no repository is none", () => {
  assert.equal(isProjectRoot(dir(false), dir(false)), true);
  assert.equal(isProjectRoot(dir(true), dir(false)), true);
  assert.equal(isProjectRoot(undefined), false);
});

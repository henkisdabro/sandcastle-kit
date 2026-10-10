// A project named like one of the kit's own image repositories is refused when the config loads.
//
//   pnpm test:file test/project-name-image-repo.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProject } from "../src/config.ts";
import { OperatorError } from "../src/errors.ts";

const load = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), "sc-config-name-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: ${JSON.stringify(name)}, tracker: "files", gates: [{ name: "t", command: "true" }] };\n`);
  return loadProject(root);
};

test("a project named base or agents, in any case, is refused with the fix", async () => {
  for (const name of ["base", "Base", "AGENTS", "agents"]) {
    await assert.rejects(load(name), (e: Error) => e instanceof OperatorError && /`name` ".*" would give the project's image the repository `sandcastle-(base|agents)`.*rename `name` in \.sandcastle\/config\.ts/.test(e.message), name);
  }
});

test("a name that only starts like a kit repository is accepted", async () => {
  for (const name of ["basement", "agents-app", "base2"]) assert.equal((await load(name)).name, name);
});

// A project's .sandcastle/config.ts loads on Node's own type stripping whatever the project's
// package.json says: Node takes a `.ts` file's module type from it, so a project with
// "type": "commonjs" failed on the config's `export default`, and one with no "type" printed a
// MODULE_TYPELESS_PACKAGE_JSON warning on every command. Syntax Node cannot strip is named with
// its place.
//
//   node --test test/config-module-type.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProject } from "../src/config.ts";
import { OperatorError } from "../src/errors.ts";

const project = (packageJson: object | undefined, body: string) => {
  const root = mkdtempSync(join(tmpdir(), "sc-config-type-"));
  mkdirSync(join(root, ".sandcastle"));
  if (packageJson) writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
  writeFileSync(join(root, ".sandcastle/config.ts"), body);
  return root;
};
const config = 'import type { X } from "./types.ts";\nconst gate: { name: string; command: string } = { name: "t", command: "true" };\nexport default { name: "t", tracker: "files", gates: [gate] } satisfies object;\n';

for (const [label, packageJson] of [["no package.json", undefined], ["no type", { name: "p" }], ['"type": "module"', { type: "module" }], ['"type": "commonjs"', { type: "commonjs" }]] as const) {
  test(`a typed config loads in a project with ${label}`, async () => {
    const loaded = await loadProject(project(packageJson, config));
    assert.equal(loaded.name, "t");
    assert.deepEqual(loaded.gates, [{ name: "t", command: "true" }]);
  });
}

test("an enum is refused with the file and its place, not a stack trace", async () => {
  await assert.rejects(
    loadProject(project(undefined, 'enum Land { merge = "merge" }\nexport default { name: "t", tracker: "files", land: Land.merge, gates: [{ name: "t", command: "true" }] };\n')),
    (e: Error) => e instanceof OperatorError && /^\.sandcastle\/config\.ts does not load: \.sandcastle\/config\.ts:1:\d+: ERROR: .*enum/.test(e.message),
  );
});

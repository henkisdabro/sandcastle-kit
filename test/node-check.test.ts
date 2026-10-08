// The kit runs its TypeScript on Node's own type stripping. A Node without it (older than 22.18,
// or stripping turned off in NODE_OPTIONS) failed on the first `.ts` import with
// ERR_UNKNOWN_FILE_EXTENSION, which names neither the cause nor the fix; the launcher's preload
// says both and stops before any TypeScript loads.
//
//   pnpm test:file test/node-check.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIT, LOADER, launcherLines, runNode } from "./cli-spawn.ts";

test("with type stripping off, the preload names the Node and the fix, and exits 1", () => {
  const r = runNode(["--no-experimental-strip-types", "-e", "console.log('ran')"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, new RegExp(`^sandcastle: Node ${process.versions.node.replace(/\./g, "\\.")} cannot run the kit's TypeScript\\. Install Node 22\\.18 or newer`));
  assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
});

test("with type stripping on, the preload says nothing", () => {
  const r = runNode(["-e", "console.log('ran')"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ran\n");
  assert.equal(r.stderr, "");
});

test("both launcher lines preload it, and it is plain JavaScript that any Node loads", () => {
  assert.equal(launcherLines.length, 2);
  for (const line of launcherLines) assert.ok(line.includes(`--import "$KIT/${LOADER.slice(KIT.length)}"`), line);
  assert.match(LOADER, /\.mjs$/);
  assert.doesNotMatch(readFileSync(LOADER, "utf8"), /^import |:\s*(string|number|boolean)\b/m, "no import, no type annotation");
});

test("package.json's engines and doctor ask for the same Node", () => {
  const { engines } = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")) as { engines: { node: string } };
  assert.equal(engines.node, ">=22.18");
  assert.match(readFileSync(join(KIT, "src/doctor.ts"), "utf8"), /major === 22 && minor >= 18/);
});

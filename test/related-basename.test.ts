// `pnpm test:related` matches a file by its basename with the extension, never the bare stem: a
// file named after a common word (`run.ts`) must not select every test that says "run".
//
//   pnpm test:file test/related-basename.test.ts

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KIT, runKit } from "./cli-spawn.ts";

const repo = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-related-"));
  mkdirSync(join(dir, "test"));
  copyFileSync(join(KIT, "test/related.ts"), join(dir, "test/related.ts"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};
const related = (dir: string, ...args: string[]) => {
  const r = runKit(args, { script: join(dir, "test/related.ts"), cwd: dir, encoding: "utf8" });
  return { status: r.status, files: r.stdout.split("\n").filter(Boolean), stderr: r.stderr };
};

test("a file named after a common word does not select tests that only use the word", () => {
  const dir = repo({
    "src/run.ts": "const x = 1;\n",
    "status.sh": "#!/usr/bin/env bash\n",
    "test/prose.test.ts": "// the run reports its status\n",
    "test/by-basename.test.ts": 'import "./run.ts";\n',
    "test/by-path.test.ts": 'import "../src/run.ts";\n',
    "test/by-shell-name.test.ts": 'spawn("bash", ["status.sh"]);\n',
  });
  assert.deepEqual(related(dir, "src/run.ts").files, ["test/by-basename.test.ts", "test/by-path.test.ts"]);
  assert.deepEqual(related(dir, "status.sh").files, ["test/by-shell-name.test.ts"]);
});

test("a file that does not exist selects nothing on a word in its name", () => {
  const dir = repo({ "test/prose.test.ts": "nothing to see here\n" });
  const r = related(dir, "src/nothing.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.files, []);
});

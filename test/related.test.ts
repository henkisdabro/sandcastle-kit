// `pnpm test:related <files...>` finds the test files that cover a change (test/related.ts). The
// script locates the repository from its own place, so each case copies it into a made-up one.
//
//   pnpm test:file test/related.test.ts

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const fixture = () =>
  repo({
    "src/alpha.ts": "export const parseAlpha = () => 1;\nexport async function runAlpha() {}\nexport type AlphaKind = string;\nexport { helper as shared, other };\nconst helper = 1, other = 2;\n",
    "status.sh": "#!/usr/bin/env bash\n",
    "test/by-path.test.ts": 'import "../src/alpha.ts";\n',
    "test/by-name.test.ts": 'import { parseAlpha } from "./x.ts";\n',
    "test/by-type.test.ts": "let k: AlphaKind;\n",
    "test/by-reexport.test.ts": "shared();\n",
    "test/by-stem.test.ts": 'readFileSync("status.sh");\n',
    "test/unrelated.test.ts": "landing parseAlphaBeta alpha-command\n",
  });

test("a source file finds the tests that name its path or anything it exports", () => {
  const r = related(fixture(), "src/alpha.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.files, ["test/by-name.test.ts", "test/by-path.test.ts", "test/by-reexport.test.ts", "test/by-type.test.ts"]);
});

test("a file with no exports is found by its path, in any form the caller gives it", () => {
  const dir = fixture();
  assert.deepEqual(related(dir, "status.sh").files, ["test/by-stem.test.ts"]);
  assert.deepEqual(related(dir, join(dir, "status.sh")).files, ["test/by-stem.test.ts"]);
});

test("a test file given is in the list, and several files add their matches", () => {
  const r = related(fixture(), "test/unrelated.test.ts", "status.sh");
  assert.deepEqual(r.files, ["test/by-stem.test.ts", "test/unrelated.test.ts"]);
});

test("a name that only starts or ends another word is not a match", () => {
  const dir = repo({ "src/alpha.ts": "export const parseAlpha = 1;\n", "test/a.test.ts": "parseAlphaBeta parseAlpha-two alpha-command\n" });
  const r = related(dir, "src/alpha.ts");
  assert.equal(r.status, 0);
  assert.deepEqual(r.files, []);
});

test("no match says so on stderr and exits 0", () => {
  const r = related(fixture(), "src/nothing.ts");
  assert.equal(r.status, 0);
  assert.deepEqual(r.files, []);
  assert.match(r.stderr, /nothing to run/);
});

test("no file given is a usage error", () => {
  const r = related(fixture());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: pnpm test:related/);
});

test("package.json's test:related runs the list through test:file's runner", () => {
  const scripts = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")).scripts;
  const run = (name: string) => scripts[name].replace(/\s+/g, " ");
  for (const flag of ["--import ./test/hermetic-env.ts", "--import ./test/no-stray.ts", "--test-timeout=120000", "--test-force-exit", "bash test/in-temp.sh"]) {
    assert.ok(run("test:related").includes(flag), flag);
    assert.ok(run("test:file").includes(flag), flag);
  }
  assert.match(run("test:related"), /files=\$\(node test\/related\.ts "\$@"\)/);
});

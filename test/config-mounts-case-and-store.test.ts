// The mount check (test/config-mounts-refused.test.ts) sees through a path written in another case
// on a case-insensitive disk, and also covers the `pnpmStore` mount, which the loader adds itself.
//
//   pnpm test:file test/config-mounts-case-and-store.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { loadProject } from "../src/config.ts";
import { OperatorError } from "../src/errors.ts";

const repo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sc-mounts-case-")));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".sandcastle"));
  return root;
};
const write = (root: string, extra: string) =>
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", gates: [{ name: "t", command: "true" }], ${extra} };\n`);

// A disk that stores `.git` and answers to `.GIT` (macOS default); anywhere else this cannot fail.
const caseInsensitive = (root: string) => existsSync(join(root, ".GIT"));

test("a mount written .GIT on a case-insensitive disk is refused as the shared .git", { skip: !caseInsensitive(repo()) && "this disk is case-sensitive" }, async () => {
  const root = repo();
  write(root, `mounts: [{ hostPath: ${JSON.stringify(join(root, ".GIT"))}, sandboxPath: "/mnt/x" }]`);
  await assert.rejects(loadProject(root), (e: Error) => e instanceof OperatorError && /is the shared \.git/.test(e.message));
});

test("a mount written .Sandcastle on a case-insensitive disk is refused as .sandcastle/", { skip: !caseInsensitive(repo()) && "this disk is case-sensitive" }, async () => {
  const root = repo();
  write(root, `mounts: [{ hostPath: ${JSON.stringify(join(root, ".Sandcastle"))}, sandboxPath: "/mnt/x" }]`);
  await assert.rejects(loadProject(root), (e: Error) => e instanceof OperatorError && /is \.sandcastle\//.test(e.message));
});

// A `pnpm` that prints the given store path, first on PATH while `fn` runs.
const withStore = async (store: string, fn: () => Promise<void>) => {
  const bin = mkdtempSync(join(tmpdir(), "sc-fake-pnpm-"));
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(store)}\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    await fn();
  } finally {
    process.env.PATH = path;
  }
};

for (const [what, rel, message] of [["the project root", "", /is the project root/], [".sandcastle", ".sandcastle", /is .sandcastle\//], [".git", ".git", /is the shared \.git/]] as const) {
  test(`a pnpm store that is ${what} is refused`, async () => {
    const root = repo();
    write(root, "pnpmStore: true");
    await withStore(join(root, rel), async () => {
      await assert.rejects(loadProject(root), (e: Error) => e instanceof OperatorError && message.test(e.message) && e.message.includes("pnpmStore"));
    });
  });
}

test("a pnpm store elsewhere is mounted", async () => {
  const root = repo();
  const store = realpathSync(mkdtempSync(join(tmpdir(), "sc-store-")));
  write(root, "pnpmStore: true");
  await withStore(store, async () => {
    assert.deepEqual((await loadProject(root)).mounts.map((m) => m.hostPath), [store]);
  });
});

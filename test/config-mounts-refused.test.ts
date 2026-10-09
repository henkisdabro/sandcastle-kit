// A project mount that reaches the project root, `.sandcastle/` or the shared `.git` would let a
// sandbox rewrite the run's own state (the start baseline, the branch backup, the run lock), so the
// loader refuses it, naming the entry, and doctor reports the same as a FIX.
//
//   pnpm test:file test/config-mounts-refused.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { loadProject } from "../src/config.ts";
import { doctor } from "../src/doctor.ts";
import { OperatorError } from "../src/errors.ts";
import { quietly } from "./quiet.ts";

const repo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sc-mounts-")));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".sandcastle"));
  mkdirSync(join(root, "cache"));
  return root;
};
const write = (root: string, mounts: string) =>
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", gates: [{ name: "t", command: "true" }], mounts: ${mounts} };\n`);
const mount = (hostPath: string) => `[{ hostPath: ${JSON.stringify(hostPath)}, sandboxPath: "/mnt/x" }]`;
// Node caches an imported config by path, so a test refuses one entry per project.
const refuses = async (root: string, hostPath: string, message: RegExp) => {
  write(root, mount(hostPath));
  await assert.rejects(loadProject(root), (e: Error) => e instanceof OperatorError && message.test(e.message) && e.message.includes(JSON.stringify(hostPath)));
};

test("a mount of the project root is refused, naming the entry", async () => {
  const root = repo();
  await refuses(root, root, /is the project root/);
});

test("a mount of a directory above the project root is refused", async () => {
  const root = repo();
  await refuses(root, dirname(root), /contains the project root/);
});

test("a mount of .sandcastle, or a path inside it, is refused", async () => {
  const root = repo();
  await refuses(root, join(root, ".sandcastle"), /is .sandcastle\//);
});

test("a mount inside .sandcastle is refused", async () => {
  const root = repo();
  await refuses(root, join(root, ".sandcastle/.run"), /lies inside .sandcastle\//);
});

test("a mount of .git is refused", async () => {
  const root = repo();
  await refuses(root, join(root, ".git"), /is the shared \.git/);
});

test("a mount inside .git is refused", async () => {
  const root = repo();
  await refuses(root, join(root, ".git/hooks"), /lies inside the shared \.git/);
});

test("a symlink to the project root is refused", async () => {
  const root = repo();
  const link = join(mkdtempSync(join(tmpdir(), "sc-mounts-link-")), "alias");
  symlinkSync(root, link);
  await refuses(root, link, /is the project root/);
});

test("a ~ path that expands to a directory holding the project is refused", async () => {
  const root = repo();
  const home = process.env.HOME;
  process.env.HOME = dirname(root);
  try {
    await refuses(root, "~", /contains the project root/);
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

test("a worktree's mount of the main checkout's .git is refused", async () => {
  const main = repo();
  execFileSync("git", ["-C", main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
  const linked = join(realpathSync(mkdtempSync(join(tmpdir(), "sc-mounts-wt-"))), "wt");
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "b", linked]);
  mkdirSync(join(linked, ".sandcastle"));
  await refuses(linked, join(main, ".git"), /is the shared \.git/);
});

test("a mount elsewhere is allowed, inside the project or not", async () => {
  const root = repo();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "sc-mounts-out-")));
  write(root, `[{ hostPath: ${JSON.stringify(join(root, "cache"))}, sandboxPath: "/mnt/a" }, { hostPath: ${JSON.stringify(outside)}, sandboxPath: "/mnt/b" }]`);
  assert.equal((await loadProject(root)).mounts.length, 2);
});

test("doctor reports a refused mount as a FIX", async () => {
  const root = repo();
  write(root, mount(join(root, ".git")));
  const { lines } = await quietly(() => doctor(root));
  assert.match(lines.join("\n"), /FIX .*mounts stay out of the run's own state\n\s+-> .*is the shared \.git/);
});

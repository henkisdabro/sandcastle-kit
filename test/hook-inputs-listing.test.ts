// hookInputsChanged (src/gates.ts) decides whether a green record's hook checks carry to the next base commit. It
// lists the changes the way protectedChanges does: a hook file renamed out of its directory, or a hook file with a
// non-ASCII name, re-checks the hooks like any other change to one.
//
//   pnpm test:file test/hook-inputs-listing.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { hookInputsChanged } from "../src/gates.ts";

const changedBetween = (base: Record<string, string>, change: (root: string) => void): boolean => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-hook-inputs-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
  const put = (name: string, content: string) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  };
  git("init", "-q", "-b", "main");
  for (const [name, content] of Object.entries({ "README.md": "base\n", ...base })) put(name, content);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const from = git("rev-parse", "HEAD");
  change(root);
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  const plan = join(root, "plan.json");
  writeFileSync(plan, JSON.stringify({ hooks: [] }));
  return hookInputsChanged({ root, baseBranch: "main" } as Project, plan, from, git("rev-parse", "HEAD"));
};

test("a hook renamed out of .husky/ re-checks the hooks", () => {
  assert.equal(
    changedBetween({ ".husky/pre-commit": "pnpm lint\n" }, (root) => {
      mkdirSync(join(root, "docs"), { recursive: true });
      renameSync(join(root, ".husky/pre-commit"), join(root, "docs/pre-commit.off"));
    }),
    true,
  );
});

test("a hook file with a non-ASCII name re-checks the hooks", () => {
  assert.equal(
    changedBetween({}, (root) => {
      mkdirSync(join(root, ".githooks"), { recursive: true });
      writeFileSync(join(root, ".githooks/pré-commit"), "exit 0\n");
    }),
    true,
  );
});

test("a change to an ordinary file does not", () => {
  assert.equal(changedBetween({ "src/a.ts": "1\n" }, (root) => writeFileSync(join(root, "src/a.ts"), "2\n")), false);
});

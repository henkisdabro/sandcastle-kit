// The bypass corpus: one row per reproduction in the guard audit issues, each run against the guard it names in a
// throwaway directory. A ticket that closes a bypass adds its rows here before its fix, so they fail at HEAD; a row
// that later passes a bypass back through fails here, whichever guard changed.
// Row: { guard, input, expect: "refuse" | "allow", code?, issue } (test/fixtures/guard-bypasses.json).
//
//   pnpm test:file test/guard-bypasses.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { KIT } from "../src/sandbox.ts";
import { quietly } from "./quiet.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { protectedAmong, protectedChanges } = await import("../src/guard.ts");
const { apply } = await import("../src/lean.ts");

type Row = { guard: string; input: any; expect: "refuse" | "allow"; code?: string; issue: number; protectedPaths?: string[] };
const rows: Row[] = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/guard-bypasses.json"), "utf8"));

const repo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-bypass-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  return { root, git };
};

const write = (root: string, files: Record<string, string>) => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
};

// Each guard's run of a row: true when it refuses (holds, skips) the input.
const refuses: Record<string, (row: Row) => Promise<boolean> | boolean> = {
  // Held only when the path comes back as given: a hold message and `git show` must name the real file.
  "protected-path": (row) => {
    const { root } = repo();
    const hits = protectedAmong({ root, baseBranch: "main", protectedPaths: row.protectedPaths } as Project, [row.input]);
    if (hits.length) assert.deepEqual(hits, [row.input]);
    return hits.length > 0;
  },
  "protected-changes": (row) => {
    const { root, git } = repo();
    write(root, { "README.md": "base\n", ...row.input.base });
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "agent/issue-1");
    write(root, row.input.change);
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    return protectedChanges({ root, baseBranch: "main", protectedPaths: row.protectedPaths } as Project, "agent/issue-1").length > 0;
  },
  // `input.fs` lays out the worktree ("dir", "file", "dir-noaccess", or "symlink-out" to a directory outside it);
  // the plan hides `input.path`. Refused when lean-apply leaves the path alone and says so.
  "lean-apply": async (row) => {
    const { root } = repo();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-bypass-outside-")));
    writeFileSync(join(outside, "keep"), "the host's own\n");
    const locked: string[] = [];
    for (const [name, kind] of Object.entries(row.input.fs as Record<string, string>)) {
      const full = join(root, name);
      if (kind === "file") writeFileSync(full, "x\n");
      else if (kind === "symlink-out") symlinkSync(outside, full);
      else {
        mkdirSync(full, { recursive: true });
        if (kind === "dir-noaccess") locked.push(full);
      }
    }
    for (const dir of locked) chmodSync(dir, 0o000);
    try {
      const { lines } = await quietly(() => apply({ hide: [row.input.path], write: {}, items: [], hooks: [] }, root));
      assert.ok(existsSync(join(outside, "keep")), "a file outside the worktree was removed");
      return lines.some((l) => l.includes(`left ${row.input.path} alone`));
    } finally {
      for (const dir of locked) chmodSync(dir, 0o755);
    }
  },
  // container/git-guard.sh run as Claude Code runs it (git-guard.test.ts): the agent's cwd and project dir are a
  // linked worktree of `<main>`, whose shared .git is `<shared>`; `<scratch>` is a separate repository. `input.symlink`
  // links worktree paths to a placeholder, `input.alias` sets git aliases in the shared config. A refusal must
  // carry the row's `[git-guard:<code>]`.
  "git-guard": (row) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-bypass-guard-")));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && k !== "CLAUDE_PROJECT_DIR"));
    const at = { main: join(root, "main"), worktree: join(root, "agent-1"), scratch: join(root, "scratch"), shared: join(root, "main/.git") };
    const fill = (s: string) => s.replace(/<(main|worktree|scratch|shared)>/g, (_, k: keyof typeof at) => at[k]);
    const git = (dir: string, ...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
    for (const dir of [at.main, at.scratch]) {
      mkdirSync(dir);
      git(dir, "init", "-q", "-b", "main");
    }
    git(at.main, "commit", "-q", "--allow-empty", "-m", "start");
    git(at.main, "worktree", "add", "-q", "-b", "agent/issue-1", at.worktree);
    for (const [name, target] of Object.entries(row.input.symlink ?? {})) symlinkSync(fill(target as string), join(at.worktree, name));
    for (const [name, value] of Object.entries(row.input.alias ?? {})) git(at.main, "config", `alias.${name}`, value as string);
    const tool_input = row.input.command ? { command: fill(row.input.command) } : { file_path: fill(row.input.file_path) };
    const r = spawnSync("bash", [join(KIT, "container/git-guard.sh")], {
      input: JSON.stringify({ cwd: at.worktree, tool_input }),
      encoding: "utf8",
      env: { ...env, CLAUDE_PROJECT_DIR: at.worktree },
    });
    assert.ok(r.status === 0 || r.status === 2, r.stderr);
    if (r.status === 2 && row.code) assert.ok(r.stderr.includes(`[git-guard:${row.code}]`), r.stderr);
    return r.status === 2;
  },
};

// root reads through a directory with no permissions, so the EACCES row cannot be built as root.
const asRoot = process.getuid?.() === 0;

for (const row of rows) {
  const name = `#${row.issue} ${row.guard}: ${JSON.stringify(row.input)} is ${row.expect === "refuse" ? "refused" : "allowed"}`;
  const skip = asRoot && JSON.stringify(row.input).includes("dir-noaccess") ? "root reads past a mode-000 directory" : false;
  test(name, { skip }, async () => {
    const run = refuses[row.guard];
    assert.ok(run, `no harness for guard ${row.guard}`);
    assert.equal(await run(row), row.expect === "refuse");
  });
}

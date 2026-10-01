// `sandcastle help` prints the header comment of src/cli.ts; the `clean` entry must say that
// `--all` deletes unmerged agent branches without asking (the old "listed first" read as a prompt).
// No repository, Docker or model calls needed.
//
//   pnpm exec tsx --test test/help.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const kit = fileURLToPath(new URL("..", import.meta.url));
const tsx = join(kit, "node_modules", ".bin", "tsx");

test("help says plain clean lists unmerged branches and --all deletes them without asking", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-help-"));
  const r = spawnSync(tsx, [join(kit, "src/cli.ts"), "help"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(r.status, 0, r.stderr);

  const lines = r.stdout.split("\n");
  const start = lines.findIndex((l) => l.includes("clean [--all]"));
  assert.notEqual(start, -1, "help has a clean entry");
  // The entry is the first line plus its indented continuation lines.
  const entry = [lines[start]!];
  for (let i = start + 1; i < lines.length && /^\s{4,}\S/.test(lines[i]!); i++) entry.push(lines[i]!);
  const text = entry.join("\n");

  assert.match(text, /list unmerged/);
  assert.match(text, /--all deletes .*without asking/);
  assert.ok(!r.stdout.includes("(listed first)"), "the misleading wording is gone");
  for (const l of entry) assert.ok(l.length <= 90, `help line fits the terminal: ${l}`);
});

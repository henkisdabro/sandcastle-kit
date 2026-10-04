// The git guard matches the command string, so text that only quotes a refused command (a heredoc
// body, a comment body) is refused like the command itself. The refusal then says how to carry
// such text: in a file. A real command gets the same refusal, so nothing it refuses is let through.
//
//   pnpm exec tsx --test test/git-guard-quoted-text.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "../src/sandbox.ts";

const GUARD = join(KIT, "container/git-guard.sh");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)));
const run = (input: object) =>
  spawnSync("bash", [GUARD], { input: JSON.stringify({ cwd: KIT, ...input }), encoding: "utf8", env });
const bash = (command: string) => run({ tool_input: { command } });

const FILE_HINT = /write the text to a file and pass the file instead: --body-file <file>, -F <file>, git commit -F <file>/;

// Each is refused today, whether the text only quotes the command or the command would run.
const REFUSED = [
  ["a heredoc whose string quotes the command after &&", "python3 - <<'E'\ns = 'cd x && git branch -D agent/y'\nE"],
  ["a comment body that quotes it in backticks", "gh issue comment 1 -F - <<'E'\nrun `git branch -D agent/y` to delete\nE"],
  ["a real git branch -D agent/...", "git branch -D agent/y"],
  ["a real git branch -D agent/... after &&", "cd x && git branch -D agent/y"],
];

for (const [what, command] of REFUSED) {
  test(`refused, and told to carry text in a file: ${what}`, () => {
    const r = bash(command);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /deleting or moving an agent branch/);
    assert.match(r.stderr, /do not retry/);
    assert.match(r.stderr, FILE_HINT);
  });
}

test("allowed: the same text passed by --body-file", () => {
  const r = bash("gh issue comment 1 --body-file body.md");
  assert.equal(r.status, 0, r.stderr);
});

test("a write inside the shared .git is refused without the file hint (no text to move)", () => {
  const common = spawnSync("git", ["-C", KIT, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    env,
  }).stdout.trim();
  const r = run({ tool_input: { file_path: join(common, "hooks/post-merge") } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /writing inside the shared \.git/);
  assert.doesNotMatch(r.stderr, FILE_HINT);
});

// An untracked `.sandcastle/config.local.json` holds a clone's own run settings, merged over the committed
// `.sandcastle/config.ts`: environment > config.local.json > config.ts > default. Plain JSON, an allowlist
// of run settings, refusals that name the file and the dotted key, and kept out of the clean-tree check.
// Temp project directories and temp git repos; no Docker and no model calls.
//
//   pnpm test:file test/config-local.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IMPL_MODEL } from "../src/agents.ts";
import { loadProject, localConfigLine, type Project } from "../src/config.ts";
import { OperatorError } from "../src/errors.ts";
import { init } from "../src/init.ts";
import { assertCleanBase, dirtyFiles } from "../src/run.ts";
import { resolveSettings } from "../src/run-settings.ts";

delete process.env.IMPL_MODEL;
delete process.env.IMPL_EFFORT;

const FILE = ".sandcastle/config.local.json";
const base = 'name: "t", tracker: "files", gates: [{ name: "t", command: "true" }]';

const project = (config: string, local?: string) => {
  const root = mkdtempSync(join(tmpdir(), "sc-local-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { ${base}${config ? `, ${config}` : ""} };\n`);
  if (local !== undefined) writeFileSync(join(root, FILE), local);
  return root;
};
const refused = async (local: string, ...parts: (string | RegExp)[]) => {
  await assert.rejects(loadProject(project("", local)), (e: Error) => {
    assert.ok(e instanceof OperatorError, `not an OperatorError: ${e}`);
    for (const part of parts) assert.match(e.message, typeof part === "string" ? new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : part);
    return true;
  });
};
const settings = (p: Project, env: Record<string, string | undefined> = {}, machine: Record<string, unknown> = {}) => resolveSettings({ env, project: p, machine });

test("the file's values win over config.ts, nested objects merge key by key, and the file's keys are listed", async () => {
  const root = project('autonomy: 1, implement: { model: "from-ts", effort: "low" }', '{ "autonomy": 3, "implement": { "model": "from-json" } }');
  const p = await loadProject(root);
  assert.equal(p.autonomy, 3);
  assert.equal(p.implement.model, "from-json");
  assert.equal(p.implement.effort, "low");
  assert.deepEqual(p.localKeys, ["autonomy", "implement.model"]);
  assert.equal(IMPL_MODEL, "from-json");
  assert.equal(localConfigLine(p), `Local config (${FILE}): autonomy, implement.model`);
});

test("without the file the project is config.ts alone, no keys and no start line", async () => {
  const p = await loadProject(project("autonomy: 1"));
  assert.equal(p.autonomy, 1);
  assert.deepEqual(p.localKeys, []);
  assert.equal(localConfigLine(p), undefined);
});

test("precedence: the environment beats the file, the file beats config.ts, the personal config clamps last", async () => {
  const p = await loadProject(project("autonomy: 1, concurrency: 2, keepWarm: true", '{ "autonomy": 2, "concurrency": 5, "keepWarm": true }'));
  assert.equal(settings(p, { AUTONOMY_LEVEL: "drain" }).autonomy, "drain");
  assert.equal(settings(p).autonomy, 2);
  assert.equal(settings(p).concurrency.asked, 5);
  assert.equal(settings(p, { CONCURRENCY: "1" }).concurrency.asked, 1);
  assert.equal(settings(p).keepWarm, true);
  assert.equal(settings(p, {}, { keepWarm: false }).keepWarm, false);
});

test("a key outside the run settings is refused naming the key and the file", async () => {
  await refused('{ "gates": [{ "name": "x", "command": "true" }] }', FILE, "`gates` cannot be set here");
  await refused('{ "setup": [] }', FILE, "`setup`");
  await refused('{ "mounts": [] }', FILE, "`mounts`");
});

test("an unknown key is refused with the nearest real one", async () => {
  await refused('{ "concurency": 2 }', FILE, "unknown key `concurency` - did you mean `concurrency`?");
  await refused('{ "repair": { "attempt": 2 } }', FILE, "unknown key `repair.attempt` - did you mean `repair.attempts`?");
});

test("wrong types are refused naming the file and the dotted key", async () => {
  await refused('{ "autonomy": 7 }', FILE, "`autonomy` must be 0, 1, 2, 3 or \"drain\"");
  await refused('{ "concurrency": "two" }', FILE, "`concurrency`");
  await refused('{ "herdr": { "panes": "some" } }', FILE, "`herdr.panes`");
  await refused('{ "repair": { "attempts": -1 } }', FILE, "`repair.attempts`");
  await refused('{ "implement": { "maxIterations": "x" } }', FILE, "`implement.maxIterations`");
  await refused('{ "implement": { "model": 3 } }', FILE, "`implement.model`");
  await refused('{ "review": { "effort": 3 } }', FILE, "`review.effort`");
  await refused('{ "review": { "effort": "huge" } }', FILE, "`review.effort`");
  await refused('{ "review": { "idleTimeoutSeconds": "soon" } }', FILE, "`review.idleTimeoutSeconds`");
  await refused('{ "repair": { "maxIterations": 0 } }', FILE, "`repair.maxIterations`");
  await refused('{ "repair": { "idleTimeoutSeconds": "x" } }', FILE, "`repair.idleTimeoutSeconds`");
  await refused('{ "implement": "fast" }', FILE, "`implement` must be an object");
});

test("invalid JSON, or JSON that is not an object, is refused naming the file", async () => {
  await refused("{ autonomy: 2 ", FILE, "not valid JSON");
  await refused("[1, 2]", FILE, "JSON object");
  await refused("null", FILE, "JSON object");
});

test("the same wrong nested types in config.ts itself load as they do today", async () => {
  const p = await loadProject(project('implement: { maxIterations: "x" }, review: { idleTimeoutSeconds: "y" }'));
  assert.equal(p.implement.maxIterations, "x" as unknown as number);
  assert.deepEqual(p.localKeys, []);
});

test("a JSON null unsets the key: the kit default applies, and the key still counts as one the file set", async () => {
  const p = await loadProject(project('autonomy: 3, implement: { model: "from-ts", effort: "low" }', '{ "autonomy": null, "implement": { "model": null } }'));
  assert.equal(p.autonomy, undefined);
  assert.equal(settings(p).autonomy, settings({ autonomy: undefined } as Project).autonomy);
  assert.notEqual(settings(p).autonomy, 3);
  assert.equal(p.implement.model, undefined);
  assert.equal(p.implement.effort, "low");
  assert.equal(IMPL_MODEL, "claude-sonnet-5-5");
  assert.deepEqual(p.localKeys, ["autonomy", "implement.model"]);
});

// A temp git repo with a committed project, as `sandcastle init` writes it.
const repo = (ignored: boolean) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sc-local-repo-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts: {} }));
  const log = console.log;
  console.log = () => {};
  try {
    init(root);
  } finally {
    console.log = log;
  }
  // A clone whose committed ignore file lacks the entry (an older project, or one the user cannot change).
  if (!ignored) writeFileSync(join(root, ".sandcastle/.gitignore"), readFileSync(join(root, ".sandcastle/.gitignore"), "utf8").replace("config.local.json\n", ""));
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  writeFileSync(join(root, FILE), '{ "autonomy": 2 }');
  return { root, git };
};

test("init's ignore file keeps an untracked config.local.json out of the clean-tree check", () => {
  const { root } = repo(true);
  assert.deepEqual(dirtyFiles(root), []);
  assertCleanBase({ root, baseBranch: "main" } as Project);
});

test("a dirty tree with the file untracked and not ignored names both fixes, with the exclude path git resolves", () => {
  const { root } = repo(false);
  let message = "";
  try {
    assertCleanBase({ root, baseBranch: "main" } as Project);
  } catch (e) {
    message = (e as Error).message;
  }
  assert.match(message, /NOT STARTED: the working tree is dirty/);
  assert.match(message, /\?\? \.sandcastle\/config\.local\.json/);
  assert.match(message, /`config\.local\.json` line in \.sandcastle\/\.gitignore/);
  assert.ok(message.includes(`echo ${FILE} >> ${join(root, ".git/info/exclude")}`), message);
});

test("in a linked worktree the exclude path is the worktree's resolved one, and the hint shows beside other dirty files", () => {
  const { root, git } = repo(false);
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "sc-local-wt-"))), "wt");
  git("worktree", "add", "-q", "-b", "other", wt);
  writeFileSync(join(wt, FILE), '{ "autonomy": 2 }');
  writeFileSync(join(wt, "stray.txt"), "x");
  let message = "";
  try {
    assertCleanBase({ root: wt, baseBranch: "other" } as Project);
  } catch (e) {
    message = (e as Error).message;
  }
  const resolved = execFileSync("git", ["-C", wt, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
  assert.equal(resolved, join(root, ".git/info/exclude"));
  assert.ok(message.includes(`>> ${resolved}`), message);
  assert.ok(!message.includes(join(wt, ".git/info/exclude")), message);
  assert.match(message, /stray\.txt/);
});

test("a dirty tree without the file gets no hint about it", () => {
  const { root } = repo(true);
  writeFileSync(join(root, "stray.txt"), "x");
  assert.throws(() => assertCleanBase({ root, baseBranch: "main" } as Project), (e: Error) => /dirty/.test(e.message) && !/config\.local\.json/.test(e.message));
});

test("the run's start line is printed by burndown() only when the file set a key", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(source, /const localLine = localConfigLine\(project\);\n\s+if \(localLine\) console\.log\(localLine\);/);
});

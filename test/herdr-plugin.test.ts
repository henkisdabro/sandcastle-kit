// The Herdr plugin (herdr/, src/herdr-plugin.ts): the block `configure` adds to Herdr's
// config and takes out again, what it refuses to fight, the tab bar's line of live runs,
// which links open, which project an action is about, and the manifest agreeing with
// the code that serves it. No Herdr, no network.
//
//   pnpm exec tsx --test test/herdr-plugin.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-plugin-cache-"));
const { configBlock, configConflicts, contextProject, herdrConfigPath, liveRuns, logOf, PLUGIN_ID, runsLine, withBlock, withoutBlock } = await import(
  "../src/herdr-plugin.ts"
);

const KIT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = readFileSync(join(KIT, "herdr/herdr-plugin.toml"), "utf8");

test("herdrConfigPath: Herdr's own order - HERDR_CONFIG_PATH, then XDG_CONFIG_HOME, then ~/.config", () => {
  assert.equal(herdrConfigPath({ HERDR_CONFIG_PATH: "/x/c.toml", XDG_CONFIG_HOME: "/y" }), "/x/c.toml");
  assert.equal(herdrConfigPath({ XDG_CONFIG_HOME: "/y" }), "/y/herdr/config.toml");
  assert.match(herdrConfigPath({}), /\.config\/herdr\/config\.toml$/);
});

test("the block goes in once, after the user's own config, and comes out leaving it as it was", () => {
  const own = 'onboarding = false\n\n[ui]\nstatus_indicators = "symbols"\n';
  const once = withBlock(own);
  assert.ok(once.startsWith(own.trimEnd() + "\n\n# >>> sandcastle-kit"), once);
  assert.equal(withBlock(once), once, "configure twice adds nothing");
  assert.equal(withoutBlock(once), own.trimEnd() + "\n");
  assert.equal(withoutBlock(withBlock("")), "");
  // Text after the block (added by hand later) is kept.
  const after = `${once}\n[theme]\nname = "x"\n`;
  assert.equal(withoutBlock(after), `${own.trimEnd()}\n\n[theme]\nname = "x"\n`);
});

test("the block extends [ui] from anywhere: no bare `tab_bar_right =`, which would land in the user's last table", () => {
  const block = configBlock("/opt/kit with space");
  assert.match(block, /^\[\[ui\.tab_bar_right\]\]$/m);
  assert.doesNotMatch(block, /^tab_bar_right\s*=/m);
  // The tab bar runs it through `sh -lc`: the kit's path is quoted.
  assert.ok(block.includes(`command = "'/opt/kit with space/bin/sandcastle' herdr line"`), block);
});

test("configConflicts: what the user already sets is theirs to merge, the kit's own block is not", () => {
  assert.deepEqual(configConflicts('[ui]\nstatus_indicators = "symbols"\n'), []);
  assert.deepEqual(configConflicts(withBlock("")), []);
  assert.equal(configConflicts('[ui.sidebar.agents]\nrows = [["agent"]]\n').length, 1);
  assert.equal(configConflicts('[ui]\nsidebar.spaces.rows = [["workspace"]]\n').length, 1);
  assert.equal(configConflicts('[ui]\ntab_bar_right = [{ type = "zoom" }]\n').length, 1);
  assert.equal(configConflicts('[keys]\nsettings = "prefix+shift+s"\n').length, 1);
  // A per-agent override is a table of its own, which the block does not touch.
  assert.deepEqual(configConflicts('[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"]]\n'), []);
});

const project = () => {
  // Real path: git reports one (macOS's temp directory is behind a /var symlink).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-plugin-project-")));
  spawnSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/config.ts"), "export default {}\n");
  return root;
};
const register = (dir: string, root: string, record: object) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, Math.random().toString(16).slice(2)), root);
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify(record));
};

test("the tab bar line: every live run, newest first; a finished or dead run's file is dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-plugin-runs-"));
  const [a, b, c, d] = [project(), project(), project(), project()];
  register(dir, a, { orchestrator: "shop", pid: process.pid, startedAt: "2026-10-02T01:00:00Z", tickets: { 1: { state: "merged" }, 2: { state: "implement" }, 3: { state: "conflict" } } });
  register(dir, b, { orchestrator: "api", pid: process.pid, startedAt: "2026-10-02T02:00:00Z", tickets: { 1: { state: "review" } } });
  register(dir, c, { orchestrator: "done", pid: process.pid, startedAt: "2026-10-02T03:00:00Z", finishedAt: "2026-10-02T04:00:00Z" });
  register(dir, d, { orchestrator: "dead", pid: 2 ** 22 + 12345, startedAt: "2026-10-02T03:00:00Z" });
  assert.equal(runsLine(dir), "🏰 api 0/1 · 1 working  |  shop 1/3 · 1 working · 1 needs you");
  assert.equal(readdirSync(dir).length, 2, "the finished and the dead run are forgotten");
  assert.equal(runsLine(mkdtempSync(join(tmpdir(), "sandcastle-plugin-none-"))), "", "no run, no entry: Herdr hides an empty one");
});

test("logOf: only a log under some project's .sandcastle/logs opens", () => {
  const root = project();
  const log = join(root, ".sandcastle/logs/agent-issue-12-impl-12.log");
  writeFileSync(log, "x\n");
  assert.equal(logOf(pathToFileURL(log).href), log);
  assert.equal(logOf(pathToFileURL(join(root, ".sandcastle/config.ts")).href), undefined);
  assert.equal(logOf(pathToFileURL(join(root, ".sandcastle/logs/missing.log")).href), undefined);
  assert.equal(logOf("https://example.com/.sandcastle/logs/a.log"), undefined);
  assert.equal(logOf(undefined), undefined);
});

test("contextProject: the focused pane's project, else the newest live run's", () => {
  const root = project();
  mkdirSync(join(root, "src/deep"), { recursive: true });
  const ctx = (cwd: string) => JSON.stringify({ focused_pane_cwd: cwd });
  assert.equal(contextProject(ctx(join(root, "src/deep")), () => []), root);
  const elsewhere = mkdtempSync(join(tmpdir(), "sandcastle-plugin-elsewhere-"));
  assert.equal(contextProject(ctx(elsewhere), () => [{ root: "/the/run" }]), "/the/run");
  assert.equal(contextProject(ctx(elsewhere), () => []), undefined);
  assert.equal(contextProject(undefined, () => []), undefined);
});

test("the manifest: Herdr's id, the kit's version, and every command through an executable entry.sh", () => {
  assert.match(MANIFEST, new RegExp(`^id = "${PLUGIN_ID}"$`, "m"));
  const released = /^## \[(\d+\.\d+\.\d+)\]/m.exec(readFileSync(join(KIT, "CHANGELOG.md"), "utf8"))?.[1];
  assert.match(MANIFEST, new RegExp(`^version = "${released}"$`, "m"), "bump herdr/herdr-plugin.toml with each release");
  const commands = [...MANIFEST.matchAll(/^command = \[(.*)\]$/gm)].map((m) => m[1]);
  assert.ok(commands.length >= 8);
  for (const c of commands) assert.match(c, /^"\.\/entry\.sh"/, c);
  accessSync(join(KIT, "herdr/entry.sh"), constants.X_OK);
});

test("the keys the block binds name actions the manifest declares, and the link handler's action exists", () => {
  const actions = new Set([...MANIFEST.matchAll(/^\[\[actions\]\]\nid = "([^"]+)"/gm)].map((m) => m[1]));
  const bound = [...configBlock().matchAll(/^command = "sandcastle-kit\.([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(bound.sort(), ["report", "sandboxes", "status"]);
  for (const a of bound) assert.ok(actions.has(a), a);
  assert.ok(actions.has(/^action = "([^"]+)"$/m.exec(MANIFEST)![1]));
  // Each pane `sandcastle herdr open` asks for is declared.
  const panes = new Set([...MANIFEST.matchAll(/^\[\[panes\]\]\nid = "([^"]+)"/gm)].map((m) => m[1]));
  for (const p of ["status", "report", "log"]) assert.ok(panes.has(p), p);
});

test("the link handler's pattern matches the links the status view prints", () => {
  const pattern = new RegExp(JSON.parse(`"${/^pattern = "(.*)"$/m.exec(MANIFEST)![1]}"`));
  assert.ok(pattern.test("file:///home/me/my%20repo/.sandcastle/logs/agent-issue-12-impl-12.log"));
  assert.ok(!pattern.test("file:///home/me/repo/.sandcastle/logs/archive/agent-issue-12-impl-12.log"));
  assert.ok(!pattern.test("file:///home/me/repo/src/main.ts"));
});

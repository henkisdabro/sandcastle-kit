// The Herdr plugin (herdr/, src/herdr-plugin.ts): the block `configure` adds to Herdr's
// config and takes out again, what it refuses to fight, the tab bar's line of live runs,
// which links open, which project an action is about, and the manifest agreeing with
// the code that serves it. No Herdr, no network.
//
//   pnpm exec tsx --test test/herdr-plugin.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// A fake `herdr` for `configure`: logs every call, lists the plugin as linked from
// $FAKE_ROOT (none when empty), and answers a reload with $FAKE_RELOAD once the config holds
// the kit's block, $FAKE_BASE (clean by default) before.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "--version ") echo "herdr 0.9.3" ;;
  "plugin list") if [ -n "$FAKE_ROOT" ]; then printf '{"result":{"plugins":[{"plugin_id":"sandcastle-kit","plugin_root":"%s"}]}}\\n' "$FAKE_ROOT"; else echo '{"result":{"plugins":[]}}'; fi ;;
  "server reload-config")
    base="$FAKE_BASE"; [ -n "$base" ] || base='{"result":{"status":"applied","diagnostics":[]}}'
    if grep -q '>>> sandcastle-kit' "$HERDR_CONFIG_PATH" 2>/dev/null; then printf '%s\\n' "$FAKE_RELOAD"; else printf '%s\\n' "$base"; fi ;;
  *) echo '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-plugin-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-plugin-cache-"));
const { configBlock, configConflicts, configure, contextProject, herdrConfigPath, liveRuns, logOf, PLUGIN_DIR, PLUGIN_ID, runsLine, withBlock, withoutBlock } =
  await import("../src/herdr-plugin.ts");

const APPLIED = '{"result":{"type":"config_reload","status":"applied","diagnostics":[]}}';
const fakeHerdr = (root: string, reload = APPLIED, base = "") => {
  process.env.FAKE_BASE = base;
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-plugin-config-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  Object.assign(process.env, { FAKE_LOG: log, FAKE_ROOT: root, FAKE_RELOAD: reload, HERDR_CONFIG_PATH: join(dir, "config.toml") });
  return { config: join(dir, "config.toml"), calls: () => readFileSync(log, "utf8").split("\n") };
};
const quietly = async (fn: () => Promise<unknown>) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

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
  // The tab bar runs it through `sh -lc`: the kit's path is quoted, and node starts only
  // when a run is registered.
  assert.ok(block.includes(`&& '/opt/kit with space/bin/sandcastle' herdr line"`), block);
  assert.match(block, /command = "\[ -n \\"\$\(ls -A \\"\$\{XDG_CACHE_HOME:-\$HOME\/\.cache\}\/sandcastle-kit\/runs\\" 2>\/dev\/null\)\\" \] && /);
});

test("the tab bar command runs nothing heavy with no run, and the line with one", () => {
  const cache = mkdtempSync(join(tmpdir(), "sandcastle-plugin-tabcache-"));
  const command = JSON.parse(/^command = (".*herdr line")$/m.exec(configBlock("/nonexistent/kit"))![1]) as string;
  // With no runs directory the check fails: Herdr hides the entry, and node never starts.
  const none = spawnSync("sh", ["-c", command], { env: { ...process.env, XDG_CACHE_HOME: cache }, encoding: "utf8" });
  assert.notEqual(none.status, 0);
  assert.doesNotMatch(none.stderr, /nonexistent/, "the kit was not called");
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
  assert.equal(logOf("file://remote-host/x/.sandcastle/logs/a.log"), undefined);
  assert.equal(logOf(undefined), undefined);
  // An agent's log can print a link too: a `.log` symlink under logs/ to some other file
  // is judged by where it points, not by its name.
  const secret = join(root, "secret.txt");
  writeFileSync(secret, "token\n");
  symlinkSync(secret, join(root, ".sandcastle/logs/innocent.log"));
  assert.equal(logOf(pathToFileURL(join(root, ".sandcastle/logs/innocent.log")).href), undefined);
  // Nor a directory that only looks like a log.
  mkdirSync(join(root, ".sandcastle/logs/dir.log"));
  assert.equal(logOf(pathToFileURL(join(root, ".sandcastle/logs/dir.log")).href), undefined);
});

test("contextProject: the focused pane's project, else the only run, else the run in this workspace, else ask", () => {
  const root = project();
  mkdirSync(join(root, "src/deep"), { recursive: true });
  const ctx = (cwd: string, workspace_id = "w1") => JSON.stringify({ focused_pane_cwd: cwd, workspace_id });
  assert.deepEqual(contextProject(ctx(join(root, "src/deep")), () => []), { root });
  const elsewhere = mkdtempSync(join(tmpdir(), "sandcastle-plugin-elsewhere-"));
  assert.deepEqual(contextProject(ctx(elsewhere), () => [{ root: "/the/run" }]), { root: "/the/run" });
  assert.match(contextProject(ctx(elsewhere), () => [])?.why ?? "", /no run going/);
  // Two runs: the one whose Herdr tab is in this workspace; from a third workspace, neither.
  const [a, b] = [project(), project()];
  writeFileSync(join(a, ".sandcastle/logs/herdr-view.json"), JSON.stringify({ tab: "w1:t3" }));
  writeFileSync(join(b, ".sandcastle/logs/herdr-view.json"), JSON.stringify({ tab: "w2:t1" }));
  const two = () => [{ root: a, orchestrator: "shop" }, { root: b, orchestrator: "api" }];
  assert.deepEqual(contextProject(ctx(elsewhere, "w2"), two), { root: b });
  assert.match(contextProject(ctx(elsewhere, "w9"), two)?.why ?? "", /2 runs going \(shop, api\)/);
});

test("configConflicts: inline tables and arrays the block could not extend", () => {
  assert.equal(configConflicts('ui = { status_indicators = "symbols" }\n').length, 1);
  assert.equal(configConflicts('keys = { prefix = "ctrl+a" }\n').length, 1);
  assert.equal(configConflicts('[keys]\ncommand = [{ key = "prefix+t", type = "popup", command = "sh" }]\n').length, 1);
  assert.equal(configConflicts('ui.sidebar.agents.rows = [["agent"]]\n').length, 1);
  // A user's own `[[keys.command]]` entry is fine: the block's are appended to the same array.
  assert.deepEqual(configConflicts('[[keys.command]]\nkey = "prefix+t"\ntype = "popup"\ncommand = "lazygit"\n'), []);
});

test("configure --remove unlinks only this checkout's plugin", async () => {
  const fake = fakeHerdr("/some/other/checkout/herdr");
  writeFileSync(fake.config, withBlock("[ui]\nx = 1\n"));
  await quietly(() => configure(true, true));
  assert.equal(readFileSync(fake.config, "utf8"), "[ui]\nx = 1\n");
  assert.equal(fake.calls().some((c) => c.startsWith("plugin unlink")), false, fake.calls().join("\n"));
  const here = fakeHerdr(PLUGIN_DIR);
  await quietly(() => configure(true, true));
  assert.ok(here.calls().includes(`plugin unlink ${PLUGIN_ID}`));
});

test("configure puts the config and the old link back unless Herdr reloads it cleanly", async () => {
  for (const reload of [
    '{"result":{"status":"applied","diagnostics":[{"message":"bad"}]}}',
    '{"error":{"code":"internal","message":"boom"}}',
    "not json",
  ]) {
    const fake = fakeHerdr("/some/other/checkout/herdr", reload);
    writeFileSync(fake.config, "[ui]\nx = 1\n");
    await assert.rejects(quietly(() => configure(false, true)), /back as they were/);
    assert.equal(readFileSync(fake.config, "utf8"), "[ui]\nx = 1\n", reload);
    const calls = fake.calls();
    assert.ok(calls.includes("plugin link /some/other/checkout/herdr"), `the other checkout's link is restored: ${calls.join(" | ")}`);
  }
  // A config that did not exist is removed again, not left empty.
  const fresh = fakeHerdr("", '{"error":{"code":"internal","message":"boom"}}');
  await assert.rejects(quietly(() => configure(false, true)));
  assert.equal(existsSync(fresh.config), false);
});

test("configure blames the block only for what Herdr says after it, and wants the file applied whole", async () => {
  const old = '{"result":{"status":"applied","diagnostics":[{"message":"legacy [keys.indexed]"}]}}';
  // The user's own old warning, said before and after: the block is fine.
  const fine = fakeHerdr("", old, old);
  writeFileSync(fine.config, "[ui]\nx = 1\n");
  await quietly(() => configure(false, true));
  assert.equal(readFileSync(fine.config, "utf8"), withBlock("[ui]\nx = 1\n"));
  // Applied only in part: back it goes.
  const partial = fakeHerdr("", '{"result":{"status":"partial","diagnostics":[]}}');
  writeFileSync(partial.config, "[ui]\nx = 1\n");
  await assert.rejects(quietly(() => configure(false, true)), /back as they were/);
  assert.equal(readFileSync(partial.config, "utf8"), "[ui]\nx = 1\n");
});

test("configConflicts: comments set nothing, single quotes count, a half block is refused", () => {
  // `herdr --default-config` writes every key commented out, tab_bar_right included.
  assert.deepEqual(configConflicts("[ui]\n# tab_bar_right = []\n# [ui.sidebar.agents]\n"), []);
  assert.equal(configConflicts("[keys]\nsettings = 'prefix+shift+s'\n").length, 1);
  const block = withBlock("");
  assert.equal(configConflicts(block.replace(/^# <<< sandcastle-kit$/m, "")).length > 0, true, "an END marker deleted by hand");
  // The kit's entries with their markers gone (a tool rewrote the file): named, not duplicated.
  const unmarked = block.replace(/^# >>> .*$/m, "").replace(/^# <<< .*$/m, "");
  assert.ok(configConflicts(unmarked).some((c) => c.includes("outside its marker lines")));
});

test("configure keeps the block when Herdr is not running: it reads it at start", async () => {
  const fake = fakeHerdr("", '{"error":{"code":"server_not_running","message":"no server"}}');
  writeFileSync(fake.config, "[ui]\nx = 1\n");
  await quietly(() => configure(false, true));
  assert.equal(readFileSync(fake.config, "utf8"), withBlock("[ui]\nx = 1\n"));
  assert.equal(readFileSync(`${fake.config}.sandcastle-kit.bak`, "utf8"), "[ui]\nx = 1\n");
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

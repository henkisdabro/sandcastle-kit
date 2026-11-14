// `sandcastle herdr configure`'s two halves (src/herdr-plugin.ts): `--app` the Herdr app mod, `--tui` the Herdr TUI
// plugin. With both products installed a bare `configure` linked the TUI plugin and edited Herdr's config on a machine
// that only used the app, and `--remove` deleted the block and marker before an unlink Herdr refused with its server
// stopped, leaving the plugin linked and a stack trace. A fake `herdr` and `herdr-app` log every call; Herdr's config,
// the kit's marker, the plugin's view flag and the app's home are all temp paths.
//
//   pnpm test:file test/herdr-configure-halves.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runKit } from "./cli-spawn.ts";

const base = mkdtempSync(join(tmpdir(), "sandcastle-halves-"));
// `plugin list` answers from $FAKE_ROOT (none when empty); `plugin unlink` and `plugin link` fail as a stopped server
// does when $FAKE_UNLINK / $FAKE_LINK is `fail`; a reload is applied, or `server_not_running` with $FAKE_DOWN.
const HERDR = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
down='{"id":"cli:plugin","error":{"code":"server_not_running","message":"no herdr server is running"}}'
case "$1 $2" in
  "--version ") echo "herdr 0.9.5" ;;
  "plugin list") if [ -n "$FAKE_ROOT" ]; then printf '{"result":{"plugins":[{"plugin_id":"sandcastle-kit","plugin_root":"%s"}]}}\\n' "$FAKE_ROOT"; else echo '{"result":{"plugins":[]}}'; fi ;;
  "plugin unlink") if [ "$FAKE_UNLINK" = fail ]; then echo "$down"; exit 1; fi; echo '{"result":{"removed":true}}' ;;
  "plugin link") if [ "$FAKE_LINK" = fail ]; then echo '{"id":"cli:plugin","error":{"code":"invalid_plugin","message":"manifest unreadable"}}'; exit 1; fi; echo '{"result":{}}' ;;
  "server reload-config") if [ -n "$FAKE_DOWN" ]; then echo '{"error":{"code":"server_not_running","message":"no server"}}'; else echo '{"result":{"status":"applied","diagnostics":[]}}'; fi ;;
  *) echo '{}' ;;
esac
`;
const binBoth = join(base, "bin-both");
const binTui = join(base, "bin-tui");
const binApp = join(base, "bin-app");
for (const dir of [binBoth, binTui, binApp]) mkdirSync(dir);
for (const dir of [binBoth, binTui]) writeFileSync(join(dir, "herdr"), HERDR, { mode: 0o755 });
for (const dir of [binBoth, binApp]) writeFileSync(join(dir, "herdr-app"), '#!/usr/bin/env bash\necho "herdr-app 0.1.15"\n', { mode: 0o755 });
const PATH = process.env.PATH ?? "";
process.env.XDG_CACHE_HOME = join(base, "cache");
process.env.HERDR_PLUGIN_STATE_DIR = join(base, "plugin-state");
const { configBlock, configure, defaultHalves, PLUGIN_DIR, PLUGIN_ID, withBlock } = await import("../src/herdr-plugin.ts");
const MARKER = join(base, "cache", "sandcastle-kit", "herdr-plugin-linked");
const FLAG = join(base, "plugin-state", "sandboxes-first");
const KIT = fileURLToPath(new URL("..", import.meta.url));

type Machine = "both" | "tui" | "app" | "none";
/** A machine: which of the two is installed, where the plugin is linked from ("" none), the config's text (undefined: no file). */
const machine = (has: Machine, { root = "", config, unlink = "", link = "", down = "" }: { root?: string; config?: string; unlink?: string; link?: string; down?: string } = {}) => {
  const dir = mkdtempSync(join(base, "case-"));
  const kit = join(dir, "kit");
  mkdirSync(join(kit, "herdr-app"), { recursive: true });
  writeFileSync(join(kit, "package.json"), '{"version":"9.9.9"}');
  writeFileSync(join(kit, "herdr-app", "mod.json"), '{"name":"sandcastle"}\n');
  writeFileSync(join(kit, "herdr-app", "main.js"), "// main\n");
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const path = join(dir, "config.toml");
  if (config !== undefined) writeFileSync(path, config);
  rmSync(MARKER, { force: true });
  rmSync(FLAG, { force: true });
  const bin = { both: binBoth, tui: binTui, app: binApp, none: "" }[has];
  process.env.PATH = bin ? `${bin}${delimiter}${PATH}` : PATH;
  const env = { FAKE_LOG: log, FAKE_ROOT: root, FAKE_UNLINK: unlink, FAKE_LINK: link, FAKE_DOWN: down, HERDR_CONFIG_PATH: path, HERDR_APP_HOME: join(dir, "app") };
  Object.assign(process.env, env);
  return {
    kit,
    env,
    config: path,
    mod: join(dir, "app", "mods", "sandcastle"),
    text: () => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
    calls: () => readFileSync(log, "utf8").split("\n").filter((c) => c.startsWith("plugin ")),
  };
};
const quietly = async (fn: () => Promise<unknown>): Promise<{ error?: Error; out: string }> => {
  const log = console.log;
  let out = "";
  console.log = (...a: unknown[]) => void (out += `${a.join(" ")}\n`);
  try {
    await fn();
    return { out };
  } catch (error) {
    return { error: error as Error, out };
  } finally {
    console.log = log;
  }
};
const stampTime = (mod: string) => statSync(join(mod, ".sandcastle-kit")).mtimeMs;
/** The configure verb through the plugin's own entry, as `bin/sandcastle herdr configure` runs it. */
const cli = (m: ReturnType<typeof machine>, args: string[]) =>
  runKit(["herdr", "configure", ...args], {
    script: join(KIT, "src/herdr-plugin.ts"),
    encoding: "utf8",
    env: { ...process.env, ...m.env, PATH: process.env.PATH },
  });

test("the block's first line is the marker every installed block is found by: unchanged, or those blocks are orphaned", () => {
  assert.equal(
    configBlock().split("\n")[0],
    "# >>> sandcastle-kit: added by `sandcastle herdr configure`; `sandcastle herdr configure --remove` takes it out",
  );
});

test("defaultHalves: one product is configured as before; with both, the plugin only where it is set up here", () => {
  const none = { linkedHere: false, block: false };
  assert.deepEqual(defaultHalves(false, true, none), { app: false, tui: true });
  assert.deepEqual(defaultHalves(true, false, none), { app: true, tui: false });
  assert.deepEqual(defaultHalves(true, true, { linkedHere: true, linkedFrom: PLUGIN_DIR, block: false }), { app: true, tui: true });
  assert.deepEqual(defaultHalves(true, true, { linkedHere: false, block: true }), { app: true, tui: true });
  const off = defaultHalves(true, true, none);
  assert.equal(off.tui, false);
  assert.match(off.skipped ?? "", /--tui.*the Herdr app does not need it/);
  const elsewhere = defaultHalves(true, true, { linkedHere: false, linkedFrom: "/other/checkout/herdr", block: true });
  assert.equal(elsewhere.tui, false, "another checkout's link and block are that checkout's");
  assert.match(elsewhere.skipped ?? "", /\/other\/checkout\/herdr.*--tui/);
});

test("both installed, plugin not set up: a bare configure --yes copies the mod and leaves Herdr TUI alone, saying how to add it", async () => {
  const m = machine("both", { config: "[ui]\nx = 1\n" });
  const r = await quietly(() => configure(false, true, false, m.kit));
  assert.equal(r.error, undefined, r.out);
  assert.ok(existsSync(join(m.mod, ".sandcastle-kit")), "the mod is copied");
  assert.equal(m.text(), "[ui]\nx = 1\n", "Herdr's config is untouched");
  assert.deepEqual(m.calls().filter((c) => !c.startsWith("plugin list")), [], "no link or unlink");
  assert.equal(existsSync(MARKER), false);
  assert.match(r.out, /Herdr TUI plugin: not set up here.*`sandcastle herdr configure --tui` adds it/);
  // Run again with the mod current: nothing changes, and it says so.
  const before = stampTime(m.mod);
  const again = await quietly(() => configure(false, true, false, m.kit));
  assert.equal(stampTime(m.mod), before);
  assert.match(again.out, /is current: nothing copied/);
  assert.equal(m.text(), "[ui]\nx = 1\n");
});

test("--tui alone links and writes the block and leaves the mod; --app alone copies the mod and calls no herdr plugin command", async () => {
  const m = machine("both", { config: "[ui]\nx = 1\n" });
  await quietly(() => configure(false, true, false, m.kit, { app: true }));
  assert.deepEqual(m.calls().filter((c) => !c.startsWith("plugin list")), []);
  assert.equal(m.text(), "[ui]\nx = 1\n");
  const before = stampTime(m.mod);
  const r = await quietly(() => configure(false, true, false, m.kit, { tui: true }));
  assert.equal(r.error, undefined, r.out);
  assert.ok(m.calls().includes(`plugin link ${PLUGIN_DIR}`));
  assert.equal(m.text(), withBlock("[ui]\nx = 1\n"), "the user's own [ui] table stays, the block follows it");
  assert.equal(stampTime(m.mod), before, "the mod is not copied again");
  assert.equal(existsSync(MARKER), true);
});

test("--app --tui together set up both, as the one-product default does on its own machine", async () => {
  const m = machine("both");
  await quietly(() => configure(false, true, false, m.kit, { app: true, tui: true }));
  assert.ok(existsSync(join(m.mod, ".sandcastle-kit")));
  assert.match(m.text() ?? "", />>> sandcastle-kit/);
  for (const has of ["tui", "app"] as const) {
    const one = machine(has);
    await quietly(() => configure(false, true, false, one.kit));
    assert.equal(existsSync(join(one.mod, ".sandcastle-kit")), has === "app", `${has}: the mod`);
    assert.equal(/>>> sandcastle-kit/.test(one.text() ?? ""), has === "tui", `${has}: the block`);
  }
});

test("both installed and the plugin set up here: a bare configure --yes refreshes it (update.md's refresh path)", async () => {
  // Linked from this checkout, block missing: the block is written, no second link.
  const linked = machine("both", { root: PLUGIN_DIR, config: "[ui]\nx = 1\n" });
  await quietly(() => configure(false, true, false, linked.kit));
  assert.equal(linked.text(), withBlock("[ui]\nx = 1\n"));
  // The block present, nothing linked: linked again.
  const block = machine("both", { config: withBlock("[ui]\nx = 1\n") });
  await quietly(() => configure(false, true, false, block.kit));
  assert.ok(block.calls().includes(`plugin link ${PLUGIN_DIR}`), block.calls().join(" | "));
});

test("both installed, the plugin linked from another checkout: a bare configure leaves that link and block, naming it", async () => {
  const m = machine("both", { root: "/other/checkout/herdr", config: withBlock("[ui]\nx = 1\n") });
  const r = await quietly(() => configure(false, true, false, m.kit));
  assert.deepEqual(m.calls().filter((c) => !c.startsWith("plugin list")), []);
  assert.equal(m.text(), withBlock("[ui]\nx = 1\n"));
  assert.match(r.out, /linked from another checkout \(\/other\/checkout\/herdr\).*--tui/);
  // On a Herdr TUI-only machine the bare command takes it over, as it always has.
  const tui = machine("tui", { root: "/other/checkout/herdr", config: "[ui]\nx = 1\n" });
  await quietly(() => configure(false, true, false, tui.kit));
  assert.ok(tui.calls().includes(`plugin unlink ${PLUGIN_ID}`) && tui.calls().includes(`plugin link ${PLUGIN_DIR}`), tui.calls().join(" | "));
});

test("--remove --app leaves the plugin, --remove --tui leaves the mod, and a bare --remove takes both", async () => {
  const set = async () => {
    const m = machine("both", { config: "[ui]\nx = 1\n" });
    await quietly(() => configure(false, true, false, m.kit, { app: true, tui: true }));
    process.env.FAKE_ROOT = PLUGIN_DIR;
    mkdirSync(join(base, "plugin-state"), { recursive: true });
    writeFileSync(FLAG, "");
    return m;
  };
  const app = await set();
  await quietly(() => configure(true, true, false, app.kit, { app: true }));
  assert.equal(existsSync(app.mod), false);
  assert.match(app.text() ?? "", />>> sandcastle-kit/);
  assert.equal(existsSync(MARKER), true);
  assert.equal(app.calls().some((c) => c.startsWith("plugin unlink")), false);

  const tui = await set();
  const r = await quietly(() => configure(true, true, false, tui.kit, { tui: true }));
  assert.ok(existsSync(join(tui.mod, ".sandcastle-kit")), "the mod stays");
  assert.equal(tui.text(), "[ui]\nx = 1\n");
  assert.equal(existsSync(MARKER), false);
  assert.equal(existsSync(FLAG), false);
  assert.match(r.out, /`sandcastle herdr configure --tui` adds it again/);

  const both = await set();
  await quietly(() => configure(true, true, false, both.kit));
  assert.equal(existsSync(both.mod), false);
  assert.equal(both.text(), "[ui]\nx = 1\n");
  assert.ok(both.calls().includes(`plugin unlink ${PLUGIN_ID}`));
});

test("an unlink Herdr refuses with its server stopped: exit 1 with the fix, no stack trace, and nothing changed", () => {
  for (const args of [["--remove", "--tui", "--yes"], ["--remove", "--yes"]]) {
    const m = machine("both", { root: PLUGIN_DIR, config: withBlock("[ui]\nx = 1\n"), unlink: "fail" });
    mkdirSync(m.mod, { recursive: true });
    const stamp = JSON.stringify({ version: "9.9.9", hash: "h", files: ["main.js"] });
    writeFileSync(join(m.mod, ".sandcastle-kit"), stamp);
    writeFileSync(join(m.mod, "main.js"), "// main\n");
    mkdirSync(join(base, "cache", "sandcastle-kit"), { recursive: true });
    writeFileSync(MARKER, PLUGIN_DIR);
    mkdirSync(join(base, "plugin-state"), { recursive: true });
    writeFileSync(FLAG, "");
    const r = cli(m, args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Herdr TUI's server is not running, and `herdr plugin unlink sandcastle-kit` needs it: run `herdr server`.*Nothing was changed\./s);
    assert.doesNotMatch(r.stderr, /^\s+at /m, "a stack trace");
    assert.equal(m.text(), withBlock("[ui]\nx = 1\n"), "the block stays");
    assert.equal(existsSync(MARKER), true, "the marker stays");
    assert.equal(existsSync(FLAG), true, "the view flag stays");
    assert.equal(readFileSync(join(m.mod, ".sandcastle-kit"), "utf8"), stamp, "the mod stays, bare --remove included");
  }
});

test("a link Herdr refuses is the operator's error, with the other checkout's link put back", async () => {
  const m = machine("tui", { root: "/other/checkout/herdr", config: "[ui]\nx = 1\n", link: "fail" });
  const r = await quietly(() => configure(false, true, false, m.kit, { tui: true }));
  assert.equal(r.error?.constructor.name, "OperatorError", String(r.error));
  assert.match(r.error?.message ?? "", /`herdr plugin link .*` failed: manifest unreadable\. Nothing in the config was changed\./);
  assert.equal(m.text(), "[ui]\nx = 1\n");
  assert.ok(m.calls().includes("plugin link /other/checkout/herdr"), m.calls().join(" | "));
});

test("a block that cannot be written after the unlink: said, and a second --remove --tui finishes the job", async () => {
  if (process.getuid?.() === 0) return; // root writes a read-only file
  const m = machine("tui", { root: PLUGIN_DIR, config: withBlock("[ui]\nx = 1\n") });
  chmodSync(m.config, 0o444);
  const first = await quietly(() => configure(true, true, false, m.kit, { tui: true }));
  assert.match(first.error?.message ?? "", /The plugin is unlinked, but .* could not be written.*Run `sandcastle herdr configure --remove --tui` again/s);
  chmodSync(m.config, 0o644);
  process.env.FAKE_ROOT = "";
  const second = await quietly(() => configure(true, true, false, m.kit, { tui: true }));
  assert.equal(second.error, undefined, second.out);
  assert.equal(m.text(), "[ui]\nx = 1\n");
});

test("adding a half needs its program; removing one does not, so a mod outlives an uninstalled app", async () => {
  const noTui = machine("app", { config: "[ui]\nx = 1\n" });
  const refused = await quietly(() => configure(false, true, false, noTui.kit, { tui: true }));
  assert.match(refused.error?.message ?? "", /`herdr --version` did not answer/);
  assert.equal(noTui.text(), "[ui]\nx = 1\n");
  const noApp = machine("tui");
  const refusedApp = await quietly(() => configure(false, true, false, noApp.kit, { app: true }));
  assert.match(refusedApp.error?.message ?? "", /`herdr-app --version` did not answer/);
  assert.equal(existsSync(noApp.mod), false);
  // The app uninstalled, its mod left: --remove --app still takes it out.
  const left = machine("app");
  await quietly(() => configure(false, true, false, left.kit));
  process.env.PATH = PATH;
  await quietly(() => configure(true, true, false, left.kit, { app: true }));
  assert.equal(existsSync(left.mod), false);
});

test("an unknown argument is refused with the usage line and changes nothing", () => {
  for (const args of [["--bogus"], ["--apps", "--yes"], ["--app", "--tui", "--yes", "extra"]]) {
    const m = machine("both", { config: "[ui]\nx = 1\n" });
    const r = cli(m, args);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Usage: sandcastle herdr configure \[--app\] \[--tui\] \[--remove\] \[--yes\]/);
    assert.equal(m.text(), "[ui]\nx = 1\n");
    assert.equal(existsSync(m.mod), false);
    assert.deepEqual(m.calls(), []);
  }
});

test("no terminal and no --yes: a stale mod is not copied and the run ends saying so, with the TUI half skipped", async () => {
  const m = machine("both", { config: "[ui]\nx = 1\n" });
  const r = await quietly(() => configure(false, false, false, m.kit));
  assert.match(r.error?.message ?? "", /Not a terminal/);
  assert.equal(existsSync(m.mod), false);
  assert.match(r.out, /not set up here/);
  assert.equal(m.text(), "[ui]\nx = 1\n");
});

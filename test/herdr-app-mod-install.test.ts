// The Herdr app mod's install (src/herdr-plugin.ts `configure`, doctor's `appModLine`): copied, never linked, with a
// stamp doctor compares. A fake `herdr-app` on PATH, `HERDR_APP_HOME` and the kit's `herdr-app/` all temp directories.
//
//   pnpm test:file test/herdr-app-mod-install.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const base = mkdtempSync(join(tmpdir(), "sandcastle-app-mod-"));
const withApp = join(base, "bin-app");
const without = join(base, "bin-none");
for (const dir of [withApp, without]) mkdirSync(dir);
writeFileSync(join(withApp, "herdr-app"), '#!/usr/bin/env bash\necho "herdr-app 0.1.15"\n');
chmodSync(join(withApp, "herdr-app"), 0o755);
const PATH = process.env.PATH ?? "";
const onPath = (dir: string | undefined) => {
  process.env.PATH = dir ? `${dir}${delimiter}${PATH}` : PATH;
};
process.env.XDG_CACHE_HOME = join(base, "cache");
const { appModLine, configure } = await import("../src/herdr-plugin.ts");

const quietly = async <T>(fn: () => Promise<T>): Promise<{ result?: T; error?: Error; out: string }> => {
  const log = console.log;
  let out = "";
  console.log = (...a: unknown[]) => void (out += `${a.join(" ")}\n`);
  try {
    return { result: await fn(), out };
  } catch (error) {
    return { error: error as Error, out };
  } finally {
    console.log = log;
  }
};

const fixture = () => {
  const root = mkdtempSync(join(base, "case-"));
  const kit = join(root, "kit");
  const home = join(root, "home");
  mkdirSync(join(kit, "herdr-app"), { recursive: true });
  writeFileSync(join(kit, "package.json"), '{"version":"9.9.9"}');
  writeFileSync(join(kit, "herdr-app", "mod.json"), '{"name":"sandcastle"}\n');
  writeFileSync(join(kit, "herdr-app", "main.js"), "// main\n");
  writeFileSync(join(kit, "herdr-app", "castle.svg"), "<svg/>\n");
  writeFileSync(join(kit, "herdr-app", ".gitignore"), "jsconfig.json\ngpui-kit.d.ts\n");
  // What the app writes into a mod folder it loads: never copied.
  writeFileSync(join(kit, "herdr-app", "jsconfig.json"), "{}");
  writeFileSync(join(kit, "herdr-app", "gpui-kit.d.ts"), "declare const x: 1;\n");
  process.env.HERDR_APP_HOME = home;
  return { kit, home, mod: join(home, "mods", "sandcastle") };
};
const tree = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name])).sort();

test("configure --yes copies the tracked files and the stamp, not the app's generated ones", async () => {
  onPath(withApp);
  const { kit, mod } = fixture();
  const { error } = await quietly(() => configure(false, true, false, kit));
  assert.equal(error, undefined);
  assert.deepEqual(tree(mod), [".gitignore", ".sandcastle-kit", "castle.svg", "main.js", "mod.json"]);
  assert.equal(readFileSync(join(mod, "main.js"), "utf8"), "// main\n");
  const stamp = JSON.parse(readFileSync(join(mod, ".sandcastle-kit"), "utf8"));
  assert.equal(stamp.version, "9.9.9");
  assert.match(stamp.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(stamp.files, [".gitignore", "castle.svg", "main.js", "mod.json"]);
});

test("a second configure --yes with no kit change rewrites no file", async () => {
  onPath(withApp);
  const { kit, mod } = fixture();
  await quietly(() => configure(false, true, false, kit));
  const past = new Date("2020-01-01T00:00:00Z");
  for (const f of tree(mod)) utimesSync(join(mod, f), past, past);
  const { out, error } = await quietly(() => configure(false, true, false, kit));
  assert.equal(error, undefined);
  assert.match(out, /nothing copied/);
  for (const f of tree(mod)) assert.equal(statSync(join(mod, f)).mtimeMs, past.getTime(), f);
});

test("doctor warns when a tracked file changed, and configure --yes makes it ok", async () => {
  onPath(withApp);
  const { kit } = fixture();
  await quietly(() => configure(false, true, false, kit));
  assert.match(appModLine(kit) ?? "", /^ok /);
  writeFileSync(join(kit, "herdr-app", "main.js"), "// main, edited\n");
  assert.match(appModLine(kit) ?? "", /^warn .*\n.*sandcastle herdr configure --yes/);
  await quietly(() => configure(false, true, false, kit));
  assert.match(appModLine(kit) ?? "", /^ok /);
});

test("doctor offers the mod as optional when the app is installed and there is no copy", () => {
  onPath(withApp);
  const { kit } = fixture();
  assert.match(appModLine(kit) ?? "", /^opt /);
});

test("a file the kit dropped is removed by the next configure --yes, and --remove then leaves no directory", async () => {
  onPath(withApp);
  const { kit, home, mod } = fixture();
  await quietly(() => configure(false, true, false, kit));
  rmSync(join(kit, "herdr-app", "castle.svg"));
  await quietly(() => configure(false, true, false, kit));
  assert.equal(existsSync(join(mod, "castle.svg")), false);
  assert.equal(existsSync(join(mod, "main.js")), true);
  await quietly(() => configure(true, true, false, kit));
  assert.equal(existsSync(mod), false);
  assert.deepEqual(tree(join(home, "mods")), []);
});

test("--remove leaves another mod and a file the app wrote beside the kit's", async () => {
  onPath(withApp);
  const { kit, home, mod } = fixture();
  mkdirSync(join(home, "mods", "other"), { recursive: true });
  writeFileSync(join(home, "mods", "other", "mod.json"), "{}");
  await quietly(() => configure(false, true, false, kit));
  writeFileSync(join(mod, "jsconfig.json"), "{}");
  await quietly(() => configure(true, true, false, kit));
  assert.deepEqual(tree(join(home, "mods")), ["other/mod.json", "sandcastle/jsconfig.json"]);
  rmSync(join(mod, "jsconfig.json"));
  await quietly(() => configure(false, true, false, kit));
  await quietly(() => configure(true, true, false, kit));
  assert.deepEqual(tree(join(home, "mods")), ["other/mod.json"]);
});

test("an unstamped mods/sandcastle is refused and left in place, and doctor says it is not the kit's", async () => {
  onPath(withApp);
  const { kit, mod } = fixture();
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, "foo.js"), "mine");
  const { error } = await quietly(() => configure(false, true, false, kit));
  assert.match(error?.message ?? "", /not the kit's/);
  assert.ok(error?.message.includes(mod));
  assert.deepEqual(tree(mod), ["foo.js"]);
  assert.match(appModLine(kit) ?? "", /^warn .*not the kit's/);
  await quietly(() => configure(true, true, false, kit));
  assert.deepEqual(tree(mod), ["foo.js"]);
});

test("the mod is copied with no herdr on PATH, and a missing terminal prints the plan and copies nothing", async () => {
  onPath(withApp);
  const { kit, mod } = fixture();
  const stopped = await quietly(() => configure(false, false, false, kit));
  assert.match(stopped.error?.message ?? "", /Not a terminal/);
  assert.match(stopped.out, /This will copy the Herdr app mod/);
  assert.equal(existsSync(mod), false);
  const { error } = await quietly(() => configure(false, true, false, kit));
  assert.equal(error, undefined);
  assert.equal(existsSync(join(mod, "main.js")), true);
});

test("with no herdr-app on PATH, configure and doctor say nothing about the app mod", async () => {
  onPath(undefined);
  const { kit, mod } = fixture();
  assert.equal(appModLine(kit), undefined);
  const { error } = await quietly(() => configure(false, true, false, kit));
  assert.match(error?.message ?? "", /Herdr is not installed/);
  assert.equal(existsSync(mod), false);
});

test("doctor prints the app mod's line", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/doctor.ts", import.meta.url)), "utf8");
  assert.match(source, /const appMod = appModLine\(\);\n\s+if \(appMod\) console\.log\(appMod\);/);
});

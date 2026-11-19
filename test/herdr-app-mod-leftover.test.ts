// The app mod's leftover (#987): after `configure --remove --app` on a machine where the Herdr app loaded the mod,
// `mods/sandcastle/` keeps the app's own `jsconfig.json` and `gpui-kit.d.ts` and no stamp. That folder is the kit's
// leftover, not a stranger's: `configure --app` copies into it and doctor offers the mod rather than warning.
//
//   pnpm test:file test/herdr-app-mod-leftover.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const base = mkdtempSync(join(tmpdir(), "sandcastle-app-leftover-"));
const bin = join(base, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "herdr-app"), '#!/usr/bin/env bash\necho "herdr-app 0.1.15"\n');
chmodSync(join(bin, "herdr-app"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
process.env.XDG_CACHE_HOME = join(base, "cache");
const { appModLine, configure } = await import("../src/herdr-plugin.ts");
const { appModState } = await import("../src/herdr-app.ts");

const quietly = async <T>(fn: () => Promise<T>): Promise<{ error?: Error; out: string }> => {
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

const fixture = () => {
  const root = mkdtempSync(join(base, "case-"));
  const kit = join(root, "kit");
  const home = join(root, "home");
  mkdirSync(join(kit, "herdr-app"), { recursive: true });
  writeFileSync(join(kit, "package.json"), '{"version":"9.9.9"}');
  writeFileSync(join(kit, "herdr-app", "mod.json"), '{"name":"sandcastle"}\n');
  writeFileSync(join(kit, "herdr-app", "main.js"), "// main\n");
  writeFileSync(join(kit, "herdr-app", ".gitignore"), "# the app's\njsconfig.json\ngpui-kit.d.ts\n");
  process.env.HERDR_APP_HOME = home;
  return { kit, home, mod: join(home, "mods", "sandcastle") };
};

// What the app writes into a mod folder it loads.
const appLoads = (mod: string) => {
  writeFileSync(join(mod, "jsconfig.json"), "{}");
  writeFileSync(join(mod, "gpui-kit.d.ts"), "declare const x: 1;\n");
};

test("after --remove leaves the app's own files, configure --app copies into the folder again", async () => {
  const { kit, home, mod } = fixture();
  mkdirSync(join(home, "mods", "other"), { recursive: true });
  writeFileSync(join(home, "mods", "other", "jsconfig.json"), "{}");
  assert.equal((await quietly(() => configure(false, true, false, kit))).error, undefined);
  appLoads(mod);
  await quietly(() => configure(true, true, false, kit));
  assert.deepEqual(readdirSync(mod).sort(), ["gpui-kit.d.ts", "jsconfig.json"]);

  assert.equal(appModState(kit, () => true), "absent");
  assert.match(appModLine(kit) ?? "", /^opt /);

  const { error } = await quietly(() => configure(false, true, false, kit));
  assert.equal(error, undefined);
  assert.equal(existsSync(join(mod, ".sandcastle-kit")), true);
  assert.equal(existsSync(join(mod, "main.js")), true);
  assert.equal(existsSync(join(mod, "jsconfig.json")), true);
  assert.match(appModLine(kit) ?? "", /^ok /);
  assert.deepEqual(readdirSync(join(home, "mods", "other")), ["jsconfig.json"]);
});

test("a stampless folder with the app's files and anything else is still not the kit's", async () => {
  const { kit, mod } = fixture();
  mkdirSync(mod, { recursive: true });
  appLoads(mod);
  writeFileSync(join(mod, "foo.js"), "mine");
  assert.equal(appModState(kit, () => true), "foreign");
  const { error } = await quietly(() => configure(false, true, false, kit));
  assert.match(error?.message ?? "", /not the kit's/);
  assert.deepEqual(readdirSync(mod).sort(), ["foo.js", "gpui-kit.d.ts", "jsconfig.json"]);
});

test("a directory named like an app file is not taken for the app's leftover", async () => {
  const { kit, mod } = fixture();
  mkdirSync(join(mod, "jsconfig.json"), { recursive: true });
  assert.equal(appModState(kit, () => true), "foreign");
  const { error } = await quietly(() => configure(false, true, false, kit));
  assert.match(error?.message ?? "", /not the kit's/);
});

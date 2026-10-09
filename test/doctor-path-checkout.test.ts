// Doctor reports a `sandcastle` on PATH that is another checkout of the kit as an info line, not a
// FIX to relink PATH (which would hijack the installed kit); nothing on PATH, or a non-kit, keeps
// the FIX. No Docker, no network.
//
//   pnpm test:file test/doctor-path-checkout.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";
import { dockerStub } from "./docker-stub.ts";

const KIT = join(import.meta.dirname, "..");
const docker = dockerStub();
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-pathkit-")));
/** A directory with `bin/sandcastle` and the given extra files, and a PATH directory linking to the script. */
const onPath = (files: Record<string, string>) => {
  const root = scratch();
  for (const [name, body] of Object.entries({ "bin/sandcastle": "#!/bin/sh\n", ...files })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  chmodSync(join(root, "bin/sandcastle"), 0o755);
  const link = scratch();
  symlinkSync(join(root, "bin/sandcastle"), join(link, "sandcastle"));
  return { root, link };
};
const doctor = (pathDir?: string) => {
  const cwd = scratch();
  // Without the host's own `sandcastle` (an installed kit), which would stand in for "nothing on PATH".
  const base = (process.env.PATH ?? "").split(delimiter).filter((d) => !existsSync(join(d, "sandcastle"))).join(delimiter);
  return runKit(["doctor"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: docker.first(pathDir ? `${pathDir}${delimiter}${base}` : base), XDG_CONFIG_HOME: scratch(), GIT_CEILING_DIRECTORIES: tmpdir() },
  }).stdout;
};
const fix = /^FIX\s+`sandcastle` on PATH points at this kit/m;

test("another kit checkout on PATH is an info line naming both, not a FIX", () => {
  const { root, link } = onPath({ "package.json": '{ "name": "sandcastle-kit" }\n', "src/cli.ts": "" });
  const out = doctor(link);
  assert.doesNotMatch(out, fix);
  const line = out.split("\n").find((l) => l.startsWith("info `sandcastle` on PATH runs another kit checkout")) ?? "";
  assert.ok(line.includes(root), line);
  assert.ok(line.includes(realpathSync(KIT)), line);
  assert.match(line, /`\.\/bin\/sandcastle` runs this checkout/);
});

test("a sandcastle on PATH that is not a kit checkout keeps the FIX", () => {
  const { link } = onPath({});
  const out = doctor(link);
  assert.match(out, fix);
  assert.doesNotMatch(out, /runs another kit checkout/);
});

test("with no sandcastle on PATH the FIX stays", () => {
  assert.match(doctor(), fix);
});

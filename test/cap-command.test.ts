// `sandcastle cap`, spawned: `cap N`, `cap off`, the bare read-out, `--project` from any directory,
// and each refusal with its message. A live run is a registration in the pool's runs directory
// (what a run writes) under a process that looks like the kit to `ps`. No Docker, model calls or network.
//
//   pnpm exec tsx --test test/cap-command.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runKit } from "./cli-spawn.ts";
import { kitLikeProcess } from "./kit-process.ts";

const kit = fileURLToPath(new URL("..", import.meta.url));
const cache = mkdtempSync(join(tmpdir(), "sandcastle-cap-cache-"));
const config = mkdtempSync(join(tmpdir(), "sandcastle-cap-cfg-"));
const runs = join(cache, "sandcastle-kit", "slots", "runs");
mkdirSync(runs, { recursive: true });

const cap = (cwd: string, ...args: string[]) =>
  runKit(["cap", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: config, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, SANDCASTLE_MAX_SANDBOXES: "6", GIT_CEILING_DIRECTORIES: tmpdir() },
  });

const project = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-cap-project-"));
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: ${JSON.stringify(name)}, gates: [{ name: "g", command: "true" }], tracker: "files" };\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
};

const live = kitLikeProcess();
after(() => live.kill());
const register = (name: string, demand: number, concurrency: number) =>
  writeFileSync(join(runs, `${name}.run`), JSON.stringify({ pid: live.pid, run: name, project: name, demand, concurrency, since: 1, shares: true }) + "\n");
const registration = (name: string) => JSON.parse(readFileSync(join(runs, `${name}.run`), "utf8"));

test("cap N caps this project's live run; cap off lifts it; bare cap prints demand, share and cap", () => {
  const root = project("alpha");
  register("alpha", 5, 4);
  let r = cap(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha: demand 5, share 5, holds 0, cap off/);
  r = cap(root, "2");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Capped alpha at 2 sandbox slot/);
  assert.match(r.stdout, /alpha: demand 5, share 2, holds 0, cap 2/);
  assert.equal(registration("alpha").cap, 2, "the cap is in the run's registration");
  assert.equal(registration("alpha").demand, 5, "the rest of it is as the run wrote it");
  r = cap(root);
  assert.match(r.stdout, /share 2, holds 0, cap 2/);
  r = cap(root, "off");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Cap lifted for alpha/);
  assert.match(r.stdout, /share 5, holds 0, cap off/);
  assert.equal("cap" in registration("alpha"), false);
});

test("--project acts on another project's run from any directory, even outside a repository", () => {
  register("beta", 3, 3);
  const elsewhere = mkdtempSync(join(tmpdir(), "sandcastle-cap-elsewhere-"));
  let r = cap(elsewhere, "1", "--project", "beta");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /beta: demand 3, share 1, holds 0, cap 1/);
  r = cap(elsewhere, "--project", "beta");
  assert.match(r.stdout, /cap 1/);
  r = cap(project("alpha"), "off", "--project", "beta");
  assert.match(r.stdout, /Cap lifted for beta/, "a project's own directory is no reason to act on its own run");
  assert.equal("cap" in registration("beta"), false);
});

test("refusals: each with its message, nothing changed", () => {
  const root = project("gamma");
  const elsewhere = mkdtempSync(join(tmpdir(), "sandcastle-cap-elsewhere-"));
  const refused = (r: ReturnType<typeof cap>, message: RegExp) => {
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, message);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "a message, not a stack trace");
  };
  refused(cap(root, "2"), /No live sandcastle run of project "gamma"/);
  refused(cap(root), /No live sandcastle run of project "gamma"/);
  register("gamma", 4, 4);
  refused(cap(root, "5"), /A cap of 5 is above this run's concurrency of 4/);
  for (const bad of ["0", "-1", "1.5", "many"]) refused(cap(root, bad), /expected a whole number of 1 or more, or "off"/);
  refused(cap(root, "1", "2"), /Usage: sandcastle cap/);
  refused(cap(root, "--project"), /--project needs the project's name/);
  refused(cap(elsewhere, "2"), /Not inside a git repository\. Give the project's name with `--project NAME`/);
  refused(cap(elsewhere, "2", "--project", "nobody"), /No live sandcastle run of project "nobody"/);
  assert.equal("cap" in registration("gamma"), false, "no refusal set a cap");
});

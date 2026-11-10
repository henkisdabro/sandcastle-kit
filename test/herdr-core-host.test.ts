// herdr-core beside the rest of the kit: doctor names the host, the Herdr TUI plugin's verbs and tab-bar line leave a
// core run alone, ticket links stay Herdr TUI's, and `--detach` hands its host to the child, which adopts it without
// probing. A stub `hc` and a stub `herdr` on PATH log every call; no real core, no Herdr, no Docker.
//
//   pnpm test:file test/herdr-core-host.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runKit } from "./cli-spawn.ts";
import { kitLikeProcess } from "./kit-process.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-core-host-")));
const bin = join(tmp, "bin");
mkdirSync(bin);
const log = join(tmp, "calls.log");
// `hc get t-in` is this process's terminal (its parent is the root), `hc get t-kid` a child's (this process is).
writeFileSync(
  join(bin, "hc"),
  `#!/bin/sh
echo "hc $*" >> '${log}'
case "$1" in
  --version) echo 'hc 9.9.9' ;;
  get) case "$2" in
         t-in) echo '{"address":"t-in","pid":${process.ppid},"state":"live","labels":{}}' ;;
         t-kid) echo '{"address":"t-kid","pid":${process.pid},"state":"live","labels":{}}' ;;
         *) echo '{"error":{"kind":"not_found"}}' >&2; exit 3 ;;
       esac ;;
  *) echo '{}' ;;
esac
`,
);
writeFileSync(
  join(bin, "herdr"),
  `#!/bin/sh
echo "herdr $*" >> '${log}'
case "$1" in
  --version) echo 'herdr 0.9.5' ;;
  plugin) echo '{"result":{"plugins":[]}}' ;;
  *) exit 1 ;;
esac
`,
);
chmodSync(join(bin, "hc"), 0o755);
chmodSync(join(bin, "herdr"), 0o755);
const cache = join(tmp, "cache");
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: join(tmp, "config") });
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const herdrCalls = () => calls().filter((c) => c.startsWith("herdr "));

const { adoptHost, HOST_ENV, parseHost, terminalHost } = await import("../src/terminal-host.ts");
const { runsLine, replaceDeadTab } = await import("../src/herdr-plugin.ts");
const { restartStatusView } = await import("../src/herdr.ts");
const { awaitingDir, PLUGIN_MARKER, runFile } = await import("../src/live-runs.ts");
const { snapshotOf } = await import("../src/status-snapshot.ts");
const { livePid, startDetached } = await import("../src/detach.ts");

const KIT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ENTRY = join(KIT, "src/herdr-plugin.ts");

test("a snapshot round-trips the host it was written from, and anything else reads as none", () => {
  const core = { kind: "core", terminal: { address: "t7", pid: 42, labels: { "herdr.space": "s1" } } } as const;
  assert.deepEqual(parseHost(JSON.stringify(core)), core);
  assert.deepEqual(parseHost(JSON.stringify({ kind: "herdr1" })), { kind: "herdr1" });
  assert.deepEqual(parseHost(JSON.stringify({ kind: "none" })), { kind: "none" });
  for (const bad of [undefined, "", "stale", "{}", JSON.stringify({ kind: "core" }), JSON.stringify({ kind: "core", terminal: { address: "t7", pid: "42", labels: {} } })]) {
    assert.equal(parseHost(bad), undefined, String(bad));
  }
});

test("doctor in a herdr-core terminal names herdr-core and hc's version, and the Herdr TUI plugin as information", () => {
  const home = join(tmp, "home-doctor");
  mkdirSync(join(home, "config"), { recursive: true });
  const r = runKit(["doctor"], {
    encoding: "utf8",
    cwd: home,
    env: {
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: tmp,
      HC_TERMINAL_ID: "t-kid",
      // Stale beside a live core terminal: never used.
      HERDR_ENV: "1",
    },
  });
  const out = r.stdout + r.stderr;
  assert.match(out, /^ok {3}herdr-core \(hc 9\.9\.9\): opens the status view beside this terminal \(terminal t-kid\)$/m, out);
  assert.match(out, /^info Herdr TUI plugin: not linked \(`sandcastle herdr configure` links it\) - it serves Herdr TUI tabs, and this is a herdr-core terminal$/m, out);
  assert.doesNotMatch(out, /Herdr \(optional: opens the status pane automatically\)|Herdr plugin and sidebar rows/, "no Herdr TUI checks in a core tab");
});

test("doctor outside both hosts checks the Herdr TUI plugin when Herdr TUI is installed, and says nothing of it when not", () => {
  const home = join(tmp, "home-plain");
  mkdirSync(join(home, "config"), { recursive: true });
  const doctor = (path: string[]) => {
    const r = runKit(["doctor"], {
      encoding: "utf8",
      cwd: home,
      env: { PATH: path.join(":"), HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: tmp },
    });
    return r.stdout + r.stderr;
  };
  const before = calls().length;
  const installed = doctor([bin, dirname(process.execPath), "/usr/bin", "/bin"]);
  assert.match(installed, /^opt  Herdr \(optional: opens the status pane automatically\)$/m, installed);
  assert.match(installed, /^info Herdr TUI plugin: not linked \(`sandcastle herdr configure` links it\) - it serves Herdr TUI tabs, and this is not a Herdr tab$/m, installed);
  assert.match(installed, /^info herdr-core is installed, but this terminal is not one of its own: start a run from a terminal in the Herdr app to see it there\.$/m, installed);
  assert.ok(!calls().slice(before).some((c) => c.startsWith("hc ") && c !== "hc --version"), "only hc --version: no core is started");
  const absent = doctor([dirname(process.execPath), "/usr/bin", "/bin"]);
  assert.doesNotMatch(absent, /Herdr TUI plugin|herdr-core is installed/, absent);
});

test("doctor's herdr-core version floor: older than the checked version warns, newer or unreadable does not", async () => {
  const { HC_VERIFIED, olderThan } = await import("../src/doctor.ts");
  assert.equal(HC_VERIFIED, "0.1.19");
  assert.equal(olderThan("hc 0.1.18", HC_VERIFIED), true);
  assert.equal(olderThan("hc 0.0.99", "0.1.17"), true);
  for (const v of ["hc 0.1.17", "hc 0.1.19", "hc 0.2.0", "hc 1.0.0", "hc dev"]) assert.equal(olderThan(v, "0.1.17"), false, v);
});

test("the plugin's verbs in a herdr-core terminal say they are Herdr TUI's and exit 0, asking Herdr nothing", () => {
  for (const verb of ["line", "open", "card", "view", "startup"]) {
    writeFileSync(log, "");
    const r = runKit(["herdr", verb], { encoding: "utf8", script: PLUGIN_ENTRY, env: { ...process.env, HC_TERMINAL_ID: "t-kid" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `\`sandcastle herdr ${verb}\` is a Herdr TUI plugin verb, and this is a herdr-core terminal: nothing to do here.\n`);
    assert.deepEqual(herdrCalls(), []);
  }
  // Outside a core terminal the tab bar's line is what it always was: here no run, so nothing.
  const r = runKit(["herdr", "line"], { encoding: "utf8", script: PLUGIN_ENTRY, env: { ...process.env, HC_TERMINAL_ID: "", HERDR_ENV: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("the Herdr TUI tab bar shows a live core run and never acts on it, alive or dead", async () => {
  const root = join(tmp, "core project");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const runs = join(tmp, "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(runFile(root, runs), root);
  // The plugin is linked, and the run retired a Herdr TUI run's record before opening its own core one.
  mkdirSync(dirname(PLUGIN_MARKER), { recursive: true });
  writeFileSync(PLUGIN_MARKER, "");
  const herdrView = JSON.stringify({ tab: "w1:t2", status: "w1:p3", adopted: false, reported: true }) + "\n";
  const coreView = JSON.stringify({ status: "t9", instance: "i1", slots: ["t10"] }) + "\n";
  writeFileSync(join(root, ".sandcastle/logs/herdr-view.json"), herdrView);
  writeFileSync(join(root, ".sandcastle/logs/core-view.json"), coreView);
  const kit = kitLikeProcess();
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "core-demo", pid: kit.pid, startedAt: "2026-11-03T00:00:00Z", tickets: { "12": { state: "implement" } } }));
  writeFileSync(log, "");
  const tick = () => runsLine(runs, undefined, undefined, replaceDeadTab, (r) => void restartStatusView(r));
  try {
    assert.match(tick(), /^♜ core-demo 0\/1/);
  } finally {
    kit.kill("SIGKILL");
    await new Promise((r) => kit.once("exit", r));
  }
  assert.equal(tick(), "", "a dead run drops out");
  assert.ok(!existsSync(runFile(root, runs)), "its file goes");
  assert.deepEqual(existsSync(awaitingDir(runs)) ? readdirSync(awaitingDir(runs)) : [], [], "and is not parked for a Herdr TUI tab it never had");
  assert.deepEqual(herdrCalls(), []);
  assert.equal(readFileSync(join(root, ".sandcastle/logs/herdr-view.json"), "utf8"), herdrView);
  assert.equal(readFileSync(join(root, ".sandcastle/logs/core-view.json"), "utf8"), coreView);
});

test("ticket links stay Herdr TUI's: a core terminal with the plugin linked gets none unless SANDCASTLE_LINKS asks", () => {
  mkdirSync(dirname(PLUGIN_MARKER), { recursive: true });
  writeFileSync(PLUGIN_MARKER, "");
  const dir = join(tmp, "links/.sandcastle");
  mkdirSync(dir, { recursive: true });
  const loading = { status: "loading" } as const;
  const readings = { record: loading, git: loading, docker: loading, queue: loading, pool: loading };
  const links = (env: NodeJS.ProcessEnv) => snapshotOf(dir, readings, { env, terminal: true }).links;
  // Stale HERDR_ENV beside the core terminal this process runs in.
  assert.equal(links({ HC_TERMINAL_ID: "t-in", HERDR_ENV: "1" }), false);
  assert.equal(links({ HC_TERMINAL_ID: "t-in", HERDR_ENV: "1", SANDCASTLE_LINKS: "1" }), true);
  assert.equal(links({ HERDR_ENV: "1" }), true, "Herdr TUI as before");
});

// The stand-in for a detached run: it takes the run lock, says what host it was handed, prints the core status line.
const FAKE_RUN = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const logs = join(process.cwd(), ".sandcastle/logs");
mkdirSync(logs, { recursive: true });
writeFileSync(join(logs, "run.lock"), process.pid + " token fake\\n");
console.log("host=" + process.env.SANDCASTLE_TERMINAL_HOST);
console.log("Status view: terminal t9");
setTimeout(() => process.exit(0), 5000);
`;

test("--detach hands the child its parent's host in place of any inherited one, and waits for the core status line", async () => {
  // Under a directory named for the kit's entry, so the lock's pid reads as the kit's.
  const fake = join(tmp, "scripts/src/cli.ts/fake-run.mjs");
  mkdirSync(dirname(fake), { recursive: true });
  writeFileSync(fake, FAKE_RUN);
  const host = JSON.stringify({ kind: "core", terminal: { address: "t-kid", pid: 1, labels: {} } });
  process.env[HOST_ENV] = "stale";
  try {
    for (const [given, seen] of [
      [host, host],
      [undefined, "undefined"],
    ] as const) {
      const root = join(tmp, `detach-${seen.length}`);
      mkdirSync(root, { recursive: true });
      const r = await startDetached(root, [], { entry: [fake], inHerdr: true, timeoutMs: 15_000, host: given });
      const pid = livePid(root);
      if (pid) process.kill(pid, "SIGKILL");
      assert.equal(r.code, 0, r.lines.join("\n"));
      assert.match(r.lines.join("\n"), /Status view: terminal t9\./);
      assert.ok(readFileSync(join(root, ".sandcastle/logs/run-output.log"), "utf8").split("\n").includes(`host=${seen}`));
    }
  } finally {
    delete process.env[HOST_ENV];
  }
});

// Last: adopting sets this process's host for good.
test("the detached child adopts a valid snapshot without probing, and removes it from its environment either way", () => {
  const env: NodeJS.ProcessEnv = { [HOST_ENV]: "not json" };
  adoptHost(true, env);
  assert.equal(env[HOST_ENV], undefined);
  assert.equal(terminalHost({}).kind, "none", "a bad snapshot is dropped: the child detects for itself");
  const parent: NodeJS.ProcessEnv = { [HOST_ENV]: JSON.stringify({ kind: "core", terminal: { address: "t-kid", pid: 1, labels: {} } }) };
  adoptHost(false, parent);
  assert.equal(parent[HOST_ENV], undefined, "a process that is not the child drops an inherited one");
  assert.equal(terminalHost({}).kind, "none");
  writeFileSync(log, "");
  const child: NodeJS.ProcessEnv = { [HOST_ENV]: JSON.stringify({ kind: "core", terminal: { address: "t-gone", pid: 1, labels: { "herdr.tab": "tb" } } }) };
  adoptHost(true, child);
  assert.equal(child[HOST_ENV], undefined);
  const probe = { core: () => assert.fail("probed"), ancestors: () => assert.fail("probed") };
  assert.deepEqual(terminalHost({ HC_TERMINAL_ID: "t-other" }, probe), { kind: "core", terminal: { address: "t-gone", pid: 1, labels: { "herdr.tab": "tb" } } });
  assert.deepEqual(calls(), []);
});

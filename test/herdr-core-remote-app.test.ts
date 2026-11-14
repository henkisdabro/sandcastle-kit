// A run started in a herdr-core terminal that the Herdr app shows from another machine (the app's labels, no
// `herdr-app` here) opens the terminal status view and says why: in the start's line, in a detached start's message
// and in doctor, with no process beyond the one `herdr-app --version` probe (#978, the first piece of #975).
//
//   pnpm test:file test/herdr-core-remote-app.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runKit } from "./cli-spawn.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-remote-app-")));
const bin = join(tmp, "bin");
const log = join(tmp, "calls.log");
mkdirSync(bin, { recursive: true });
Object.assign(process.env, { XDG_CACHE_HOME: join(tmp, "cache"), XDG_CONFIG_HOME: join(tmp, "config") });

const { coreStatusLine, openCoreStatus, remoteApp } = await import("../src/herdr-core.ts");
const { livePid, startDetached } = await import("../src/detach.ts");
type CoreTerminal = import("../src/terminal-host.ts").CoreTerminal;
type AppPorts = import("../src/herdr-app.ts").AppPorts;

const KIT = fileURLToPath(new URL("..", import.meta.url));
const REMOTE = "Status view: terminal t9 (the Herdr app shows this machine remotely: its app pane needs a run started on the app's machine, #975)";
const INFO = "info Herdr app: shows this terminal from another machine - a run here opens the terminal status view; the app pane needs the run on the app's machine";

const caller = (labelled: boolean): CoreTerminal => ({ address: "t-kid", pid: 1, labels: labelled ? { "herdr.space": "s1", "herdr.tab": "tb1" } : {} });
const project = (name: string) => {
  const root = join(tmp, name);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  return root;
};

// An app that is, or is not, installed: its probe is counted, and nothing else of it may be asked in a remote case.
const fakeApp = (installed: boolean) => {
  const asked: string[] = [];
  const no = (what: string) => () => {
    asked.push(what);
    throw new Error(`${what} asked`);
  };
  const app: AppPorts = {
    installed: () => (asked.push("installed"), installed),
    modCurrent: () => (asked.push("modCurrent"), false),
    paneOf: no("paneOf") as AppPorts["paneOf"],
    focused: no("focused") as AppPorts["focused"],
    modPanes: () => (asked.push("modPanes"), []),
    split: no("split") as AppPorts["split"],
    close: no("close") as AppPorts["close"],
    focus: no("focus") as AppPorts["focus"],
  };
  return { app, asked };
};
const hcCalls: string[][] = [];
const hc = (args: string[]) => {
  hcCalls.push(args);
  if (args[0] === "get") throw new Error("not_found");
  return JSON.stringify({ address: "t9" });
};
const startLine = (name: string, labelled: boolean, installed: boolean) => {
  const root = project(name);
  const { app } = fakeApp(installed);
  const status = openCoreStatus(root, caller(labelled), { kit: KIT, hc, app, instance: name });
  assert.equal(status, "t9");
  return coreStatusLine(root, status!);
};

test("labels and no app: the case is remote, the start line says why", () => {
  assert.equal(remoteApp(caller(true), () => false), true);
  assert.equal(startLine("labelled-no-app", true, false), REMOTE);
});

test("labels and the app installed: not remote, the line is as before", () => {
  assert.equal(remoteApp(caller(true), () => true), false);
  assert.equal(startLine("labelled-app", true, true), "Status view: terminal t9");
});

test("no labels and no app: not remote, the line is as before", () => {
  assert.equal(remoteApp(caller(false), () => false), false);
  assert.equal(startLine("plain-no-app", false, false), "Status view: terminal t9");
});

test("no labels and the app installed: not remote, the line is as before", () => {
  assert.equal(remoteApp(caller(false), () => true), false);
  assert.equal(startLine("plain-app", false, true), "Status view: terminal t9");
});

test("a remote start asks the app's probe and nothing else of it, and hc nothing for the case", () => {
  hcCalls.length = 0;
  const root = project("probe-once");
  const { app, asked } = fakeApp(false);
  openCoreStatus(root, caller(true), { kit: KIT, hc, app, instance: "probe-once" });
  assert.ok(asked.every((a) => a === "installed" || a === "modCurrent"), asked.join(","));
  assert.equal(asked.filter((a) => a === "installed").length, 1, "the probe is asked once per start");
  assert.deepEqual(hcCalls.map((c) => c[0]).filter((v) => v !== "get" && v !== "run"), []);
});

test("with a stub herdr-app on PATH, a remote start's real ports call it with --version only", () => {
  writeFileSync(join(bin, "herdr-app"), `#!/bin/sh\necho "herdr-app $*" >> '${log}'\nexit 1\n`);
  chmodSync(join(bin, "herdr-app"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before}`;
  try {
    const root = project("real-ports");
    assert.equal(openCoreStatus(root, caller(true), { kit: KIT, hc, instance: "real-ports" }), "t9");
    assert.equal(coreStatusLine(root, "t9"), REMOTE);
  } finally {
    process.env.PATH = before;
  }
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.ok(calls.length >= 1);
  assert.deepEqual([...new Set(calls)], ["herdr-app --version"]);
  assert.equal(calls.length, 1, "asked once per start");
});

// The stand-in for a detached run, as test/herdr-core-host.test.ts has it.
const FAKE_RUN = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const logs = join(process.cwd(), ".sandcastle/logs");
mkdirSync(logs, { recursive: true });
writeFileSync(join(logs, "run.lock"), process.pid + " token fake\\n");
console.log(process.env.FAKE_STATUS_LINE);
setTimeout(() => process.exit(0), 5000);
`;

test("--detach carries the remote start line whole, not 'not reported'", async () => {
  const fake = join(tmp, "scripts/src/cli.ts/fake-run.mjs");
  mkdirSync(dirname(fake), { recursive: true });
  writeFileSync(fake, FAKE_RUN);
  process.env.FAKE_STATUS_LINE = REMOTE;
  try {
    const root = project("detach-remote");
    const r = await startDetached(root, [], { entry: [fake], inHerdr: true, timeoutMs: 15_000, host: JSON.stringify({ kind: "core", terminal: caller(true) }) });
    const pid = livePid(root);
    if (pid) process.kill(pid, "SIGKILL");
    assert.equal(r.code, 0, r.lines.join("\n"));
    const text = r.lines.join("\n");
    assert.ok(text.includes(`${REMOTE}.`), text);
    assert.doesNotMatch(text, /not reported/);
  } finally {
    delete process.env.FAKE_STATUS_LINE;
  }
});

// Doctor, in a core terminal whose `hc get` carries the app's labels (or not), with an hc older than the floor.
const doctor = (name: string, labelled: boolean) => {
  const home = join(tmp, name);
  const stubs = join(home, "bin");
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(stubs, { recursive: true });
  const labels = JSON.stringify(labelled ? { "herdr.space": "s1", "herdr.tab": "tb1" } : {});
  writeFileSync(
    join(stubs, "hc"),
    `#!/bin/sh
case "$1" in
  --version) echo 'hc 0.1.18' ;;
  get) echo '{"address":"t-kid","pid":${process.pid},"state":"live","labels":${labels}}' ;;
  *) echo '{}' ;;
esac
`,
  );
  chmodSync(join(stubs, "hc"), 0o755);
  const r = runKit(["doctor"], {
    encoding: "utf8",
    cwd: home,
    env: {
      PATH: [stubs, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: tmp,
      HC_TERMINAL_ID: "t-kid",
    },
  });
  return (r.stdout + r.stderr).split("\n");
};

test("doctor says the app shows this terminal remotely, as info after the hc version warning", () => {
  const out = doctor("doctor-remote", true);
  const ok = out.findIndex((l) => l.startsWith("ok   herdr-core"));
  const warn = out.findIndex((l) => l.startsWith("warn herdr-core hc 0.1.18 is older than"));
  const info = out.indexOf(INFO);
  assert.ok(ok >= 0 && warn > ok && info > warn, out.join("\n"));
});

test("doctor says nothing new for a terminal the app does not show", () => {
  const out = doctor("doctor-local", false);
  assert.ok(out.some((l) => l.startsWith("ok   herdr-core")), out.join("\n"));
  assert.equal(out.some((l) => l.startsWith("info Herdr app:")), false, out.join("\n"));
});

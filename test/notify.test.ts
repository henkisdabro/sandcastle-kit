// The `notify` command in the personal config.json: run once when a run ends - normal end,
// non-zero exit, signal - with the summary in the environment, and a notifier that fails
// never changes the run's result. One real process per case; no Docker, network or model.
//
//   pnpm test:file test/notify.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { TicketRecord } from "../mod/hooks/run-record.ts";
import { runNode, startNode } from "./cli-spawn.ts";

const KIT = join(import.meta.dirname, "..");
// runNode and startNode run the CLI in one process, as bin/sandcastle does: a wrapper's child (tsx's
// binary had one) is SIGKILLed on a slow answer to SIGTERM, and the notifier with it.
const dir = mkdtempSync(join(tmpdir(), "sandcastle-notify-"));
const cache = join(dir, "cache");
const href = (f: string) => JSON.stringify(pathToFileURL(join(KIT, f)).href);

const fixture = join(dir, "fixture.mts");
writeFileSync(
  fixture,
  `import { exitOnSignal, recordRun } from ${href("src/run.ts")};
import { notifyCommand, runNotify } from ${href("src/notify.ts")};
const notify = notifyCommand();
const project = { root: process.env.FIXTURE_ROOT, name: "fixture" } as any;
const r = recordRun(project, { dryRun: false }, notify && ((run) => runNotify(notify, project.name, run)));
for (const [id, state] of [["1", "merged"], ["2", "held"], ["3", "red"], ["4", "blocked"]]) r.ticket(id, { state });
if (process.env.END === "exit3") process.exit(3);
if (process.env.END === "signal") {
  exitOnSignal();
  console.log("ready");
  setInterval(() => {}, 1000);
}
`,
);

let n = 0;
const setup = (notify: unknown) => {
  const base = join(dir, `case-${++n}`);
  const root = join(base, "root");
  const config = join(base, "config");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
  const out = join(base, "out.json");
  const cmd = notify === "writer" ? [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], JSON.stringify({ n: process.env.SANDCASTLE_NAME, s: process.env.SANDCASTLE_SUMMARY, e: process.env.SANDCASTLE_EXIT }))", out] : notify;
  if (cmd !== undefined) writeFileSync(join(config, "sandcastle-kit/config.json"), JSON.stringify({ notify: cmd }));
  const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, FIXTURE_ROOT: root };
  return { root, out, env };
};
const logs = (root: string) => join(root, ".sandcastle/logs");

test("a normal end runs the notifier with name, summary and exit, blocked tickets left out", () => {
  const { root, out, env } = setup("writer");
  const res = runNode([fixture], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { n: "fixture", s: "run finished - 1 merged, 1 need you, 1 need fixing, of 3", e: "0" });
  assert.ok(existsSync(join(logs(root), "history.jsonl")));
});

test("process.exit(3) notifies with the exit and keeps the exit status", () => {
  const { out, env } = setup("writer");
  const res = runNode([fixture], { encoding: "utf8", env: { ...env, END: "exit3" }, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(res.status, 3, res.stderr);
  const got = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(got.s.startsWith("run ended with exit 3"), got.s);
  assert.equal(got.e, "3");
});

test("a SIGTERM ends the run through the exit handler and notifies with 143", async () => {
  const { out, env } = setup("writer");
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = startNode([fixture], { env: { ...env, END: "signal" }, stdio: ["ignore", "pipe", "inherit"] });
    let seen = "";
    let sent = false;
    child.stdout!.on("data", (d) => {
      seen += d;
      if (!sent && seen.includes("ready")) {
        sent = true;
        child.kill("SIGTERM");
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("fixture still running 15 s after SIGTERM"));
    }, 15_000);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  // The process ends by the signal itself, after its exit handlers; the shell reads that as 143.
  assert.equal(ended.signal, "SIGTERM");
  assert.equal(JSON.parse(readFileSync(out, "utf8")).e, "143");
});

test("a notifier that does not exist leaves the run's result alone", () => {
  const { root, env } = setup(["/nonexistent/notify"]);
  const res = runNode([fixture], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /notify: \/nonexistent\/notify failed/);
  assert.equal(JSON.parse(readFileSync(join(logs(root), "run.json"), "utf8")).exitCode, 0);
  assert.equal(readFileSync(join(logs(root), "history.jsonl"), "utf8").split("\n").filter(Boolean).length, 1);
});

test("a notifier that exits 1 is reported and the run still exits 0", () => {
  const { env } = setup([process.execPath, "-e", "process.exit(1)"]);
  const res = runNode([fixture], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /failed \(exit 1\)/);
});

test("no notify key: nothing is run and nothing is printed", () => {
  const { env } = setup(undefined);
  const res = runNode([fixture], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, "");
});

test("notifyCommand refuses a shell string, an empty list and a non-string element", () => {
  const message = (config: string) =>
    `NOT STARTED: "notify" in ${join(config, "sandcastle-kit", "config.json")} must be a list of strings - the command and its arguments, for example ["notify-send", "Sandcastle"] - not a shell string.`;
  for (const bad of ["notify-send hi", [], ["ok", 3]]) {
    const { env } = setup(bad);
    const probe = join(dir, "probe.mts");
    writeFileSync(probe, `import { notifyCommand } from ${href("src/notify.ts")};\ntry { notifyCommand(); console.log("no throw"); } catch (e) { console.log(JSON.stringify({ name: (e as Error).constructor.name, message: (e as Error).message })); }\n`);
    const res = runNode([probe], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    const got = JSON.parse(res.stdout.trim());
    assert.equal(got.name, "OperatorError");
    assert.equal(got.message, message(env.XDG_CONFIG_HOME));
  }
});

test("endSummary: stopped, dry run, and a merged ticket whose close failed", async () => {
  const { endSummary } = await import("../src/notify.ts");
  const tickets: Record<string, TicketRecord> = { 1: { state: "merged" }, 2: { state: "merged", closeFailed: "boom" }, 3: { state: "crashed" }, 4: { state: "blocked" } };
  assert.equal(endSummary({ exitCode: 0, tickets }), "run finished - 2 merged, 1 need you, 1 need fixing, of 3");
  assert.equal(endSummary({ exitCode: 0, tickets, stopped: "usage" }), "run STOPPED before landing - 2 merged, 1 need you, 1 need fixing, of 3");
  assert.equal(endSummary({ exitCode: 0, tickets, dryRun: true }), "run finished (dry run) - 2 merged, 1 need you, 1 need fixing, of 3");
  assert.equal(endSummary({ exitCode: 2, tickets }), "run ended with exit 2 - 2 merged, 1 need you, 1 need fixing, of 3");
});

// `sandcastle usage`: the plan's usage between runs, read-only. A fresh reading in the run record or the
// history is printed with its age and nothing is asked; with none, the usage endpoint is asked once (a
// stubbed fetch, through a preload that counts its calls); with an API key in use it says the sandboxes
// spend credits, not a plan. A temp git repo and made-up tokens; no network, no model calls.
//
//   node --test test/usage-command.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-usage-command-")));
after(() => rmSync(TMP, { recursive: true, force: true }));

const nowSeconds = () => Math.floor(Date.now() / 1000);
const claude = (at: number, five = 14, week = 93) => ({
  provider: "claude",
  windows: { fiveHour: { percent: five, resetsAt: nowSeconds() + 3600 }, week: { percent: week, resetsAt: nowSeconds() + 86_400 } },
  at,
});

let n = 0;
/** A project with `.sandcastle/.env` credentials, a run record and a history; the stubbed endpoint counts its asks in `asks`. */
const project = ({ env, runRecord, history = [], answer }: { env: string; runRecord?: unknown; history?: unknown[]; answer?: { status: number; body: unknown } }) => {
  const dir = join(TMP, `case-${n++}`);
  const root = join(dir, "project");
  const xdg = join(dir, "xdg");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".sandcastle/config.ts"), 'export default { name: "usage-command-test", tracker: "files", gates: [{ name: "t", command: "true" }] };\n');
  writeFileSync(join(root, ".sandcastle/.env"), env, { mode: 0o600 });
  if (runRecord) writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify(runRecord));
  for (const line of history) appendFileSync(join(root, ".sandcastle/logs/history.jsonl"), JSON.stringify(line) + "\n");
  const asks = join(dir, "asks");
  const preload = join(dir, "stub.mjs");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";\n` +
      `globalThis.fetch = async () => { appendFileSync(${JSON.stringify(asks)}, "x"); return new Response(${JSON.stringify(JSON.stringify(answer?.body ?? {}))}, { status: ${answer?.status ?? 500} }); };\n`,
  );
  // No host login: an empty config dir, and a `security` that finds nothing ahead of the real one on a Mac.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
  const run = (...args: string[]) =>
    runKit(["usage", ...args], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        CLAUDE_CONFIG_DIR: join(dir, "claude"),
        NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
        XDG_CONFIG_HOME: xdg,
        GIT_CEILING_DIRECTORIES: tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  return { run, asked: () => (existsSync(asks) ? readFileSync(asks, "utf8").length : 0) };
};

const OAUTH = "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-made-up\n";
const KEY = "ANTHROPIC_API_KEY=sk-ant-api03-made-up\n";

test("a fresh reading in the run record is printed with its age, and no request is made", () => {
  const p = project({ env: OAUTH, runRecord: { usage: [claude(nowSeconds() - 120)] } });
  const r = p.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Plan usage \(Claude\): 5h 14% - resets \S+ · week 93% - resets \S+ \S* ?\S* \(read 2m ago, from the run record\)$/m, r.stdout);
  assert.equal(p.asked(), 0);
});

test("a fresh reading in the history counts, and the newest of record and history is the one printed", () => {
  const p = project({
    env: OAUTH,
    runRecord: { usage: [claude(nowSeconds() - 400, 50, 60)] },
    history: [{ usage: claude(nowSeconds() - 30, 71, 72) }, { usage: claude(nowSeconds() - 500, 10, 11) }],
  });
  const r = p.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /5h 71% .* week 72% .* \(read 3\ds ago, from the run record\)/, r.stdout);
  assert.equal(p.asked(), 0);
});

test("with no reading on record the usage endpoint is asked once and its windows are printed", () => {
  const p = project({ env: OAUTH, answer: { status: 200, body: { five_hour: { utilization: 41 }, seven_day: { utilization: 88 } } } });
  const r = p.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Plan usage: five_hour 41% · seven_day 88% \(read just now, from the usage endpoint\)\./m, r.stdout);
  assert.equal(p.asked(), 1);
});

test("a reading older than ten minutes is not used: the endpoint is asked", () => {
  const p = project({
    env: OAUTH,
    runRecord: { usage: [claude(nowSeconds() - 11 * 60)] },
    answer: { status: 200, body: { five_hour: { utilization: 5 }, seven_day: { utilization: 6 } } },
  });
  const r = p.run();
  assert.match(r.stdout, /five_hour 5% · seven_day 6%/, r.stdout);
  assert.equal(p.asked(), 1);
});

test("an endpoint that refuses is one request, says why and exits 1", () => {
  const p = project({ env: OAUTH, answer: { status: 429, body: {} } });
  const r = p.run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^Plan usage: unknown \(no reading on record, and the usage endpoint answered HTTP 429, rate-limited\)\./m, r.stdout);
  assert.equal(p.asked(), 1);
});

test("with an API key in use it says the sandboxes spend credits, not a plan, and asks nothing", () => {
  // Beside a token and with a fresh reading on record: Claude Code spends the key first, so the reading is no plan of these sandboxes.
  const p = project({ env: OAUTH + KEY, runRecord: { usage: [claude(nowSeconds() - 5)] } });
  const r = p.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /the sandboxes spend ANTHROPIC_API_KEY \(API credits, no plan\)/, r.stdout);
  assert.doesNotMatch(r.stdout, /5h/);
  assert.equal(p.asked(), 0);
});

test("with no credential and no reading it says the plan cannot be asked, without a request", () => {
  const p = project({ env: "GH_TOKEN=github_pat_made_up\n" });
  const r = p.run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /no CLAUDE_CODE_OAUTH_TOKEN/, r.stdout);
  assert.equal(p.asked(), 0);
});

test("it takes no arguments and has a help entry", () => {
  const p = project({ env: OAUTH });
  const bad = p.run("--all");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown argument "--all" for sandcastle usage: it takes none\./);
  const help = p.run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^  usage {12}the plan's usage, read-only/m, help.stdout);
  assert.equal(p.asked(), 0);
});

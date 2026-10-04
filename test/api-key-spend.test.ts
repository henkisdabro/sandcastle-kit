// Spending an API key is never silent: whenever ANTHROPIC_API_KEY would reach the sandboxes - alone or
// beside an OAuth token, from either .env - doctor says so in red, a run's start line and its settings
// say so, and a run (preflight, lean --measure) asks first; with no terminal only `--api-key` or
// SANDCASTLE_API_KEY=1 lets it go ahead. Made-up keys in temp files and a temp git repo whose queue is
// empty, so a run that goes ahead ends before Docker; no network, no model calls.
//
//   pnpm exec tsx --test test/api-key-spend.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-api-key-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
process.env.XDG_CONFIG_HOME = join(TMP, "xdg-in-process");
const { apiKeySpend, credentialSource, USER_CONFIG } = await import("../src/sandbox.ts");
const { confirmApiKey, doctorApiKeyLine, red, runApiKeyLine } = await import("../src/api-key.ts");
const { usageToken } = await import("../src/usage.ts");
const { resolveSettings, settingsGroup } = await import("../src/run-settings.ts");
const { render, settingsLines } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;
const { OperatorError } = await import("../src/errors.ts");

const KIT = join(import.meta.dirname, "..");
const KEY = "ANTHROPIC_API_KEY=sk-ant-api03-made-up\n";
const OAUTH = "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-made-up\n";

let n = 0;
/** A personal config dir and a project, each with its own .env (or none, for undefined). */
const setup = (user: string | undefined, local: string | undefined) => {
  const dir = join(TMP, `case-${n++}`);
  const xdg = join(dir, "xdg");
  const root = join(dir, "project");
  mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  const userFile = join(xdg, "sandcastle-kit/.env");
  const projectFile = join(root, ".sandcastle/.env");
  if (user !== undefined) writeFileSync(userFile, user, { mode: 0o600 });
  if (local !== undefined) writeFileSync(projectFile, local, { mode: 0o600 });
  return { xdg, root, userFile, projectFile, files: [userFile, projectFile] };
};

// The four ways credentials reach the sandboxes, and what the kit makes of each.
test("an API key alone is spent, named by its file", () => {
  const c = setup(KEY, undefined);
  assert.deepEqual(apiKeySpend(c.files), { file: c.userFile, files: [c.userFile] });
});

test("both keys in one file: the API key is spent and the OAuth token beside it is ignored", () => {
  const c = setup(OAUTH + KEY, undefined);
  const spend = apiKeySpend(c.files);
  assert.deepEqual(spend, { file: c.userFile, files: [c.userFile], oauth: c.userFile });
  assert.match(doctorApiKeyLine(spend!), new RegExp(`^warn API credits: the sandboxes spend ANTHROPIC_API_KEY from ${c.userFile}; CLAUDE_CODE_OAUTH_TOKEN in ${c.userFile} is ignored`));
});

test("both keys across the two files, either way round: the API key is still spent", () => {
  const projectKey = setup(OAUTH, KEY);
  assert.deepEqual(apiKeySpend(projectKey.files), { file: projectKey.projectFile, files: [projectKey.projectFile], oauth: projectKey.userFile });
  const userKey = setup(KEY, OAUTH);
  assert.deepEqual(apiKeySpend(userKey.files), { file: userKey.userFile, files: [userKey.userFile], oauth: userKey.projectFile });
  // Set in both: the project's value is spent, and removing it means removing it from both.
  const both = setup(KEY, KEY);
  const spend = apiKeySpend(both.files)!;
  assert.equal(spend.file, both.projectFile);
  assert.match(runApiKeyLine(spend), new RegExp(`spend ANTHROPIC_API_KEY from ${both.projectFile}\\.$`));
  assert.match(doctorApiKeyLine(spend), new RegExp(`remove ANTHROPIC_API_KEY from ${both.userFile} and ${both.projectFile}`));
});

test("the OAuth token alone spends no API key", () => {
  assert.equal(apiKeySpend(setup(OAUTH, undefined).files), undefined);
  assert.equal(apiKeySpend(setup(undefined, OAUTH).files), undefined);
  assert.equal(apiKeySpend(setup(undefined, undefined).files), undefined);
});

test("credentialSource and the usage guard put the API key first, as Claude Code does", () => {
  const root = join(TMP, "credential-source");
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  mkdirSync(USER_CONFIG, { recursive: true });
  writeFileSync(join(USER_CONFIG, ".env"), OAUTH);
  writeFileSync(join(root, ".sandcastle/.env"), KEY);
  assert.deepEqual(credentialSource({ root } as Parameters<typeof credentialSource>[0]), { key: "ANTHROPIC_API_KEY", file: join(root, ".sandcastle/.env") });
  assert.deepEqual(usageToken({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }, "linux", { keychain: () => undefined, file: () => undefined }), { source: "api key" });
});

test("red only on a terminal without NO_COLOR; the words are the same either way", () => {
  const was = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    assert.equal(red("x", { isTTY: true }), "\x1b[31mx\x1b[0m");
    assert.equal(red("x", { isTTY: false }), "x");
    process.env.NO_COLOR = "1";
    assert.equal(red("x", { isTTY: true }), "x");
  } finally {
    if (was === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = was;
  }
});

test("the confirmation: asked on a terminal, refused without one, skipped with the opt-in or no key", async () => {
  const c = setup(KEY, undefined);
  const spend = apiKeySpend(c.files);
  const asked: string[] = [];
  const answer = (yes: boolean | undefined) => async (q: string) => (asked.push(q), yes);

  await confirmApiKey(spend, "This run", { env: {}, ask: answer(true) });
  assert.deepEqual(asked, [`This run bills API credits (ANTHROPIC_API_KEY from ${c.userFile}). Go ahead? [y/N] `]);

  await assert.rejects(confirmApiKey(spend, "This run", { env: {}, ask: answer(false) }), (e) => e instanceof OperatorError && /^Not started: this run bills API credits/.test(e.message));

  // No terminal: `confirm` answers undefined, and the refusal names the flag and the key's removal.
  for (const options of [{ env: {}, ask: answer(undefined) }, { env: {}, terminal: false }]) {
    await assert.rejects(confirmApiKey(spend, "This run", options), (e) => {
      assert.ok(e instanceof OperatorError);
      assert.match(e.message, /no terminal to ask on/);
      assert.match(e.message, /--api-key \(or SANDCASTLE_API_KEY=1\)/);
      assert.ok(e.message.includes(`remove ANTHROPIC_API_KEY from ${c.userFile}`), e.message);
      return true;
    });
  }

  asked.length = 0;
  await confirmApiKey(spend, "This run", { env: { SANDCASTLE_API_KEY: "1" }, ask: answer(false), terminal: false });
  await confirmApiKey(undefined, "This run", { env: {}, ask: answer(false), terminal: false });
  assert.deepEqual(asked, [], "nothing is asked with the opt-in, or with no key");
});

test("the run settings, the closing summary's Settings line and the status row say a run bills API credits", () => {
  const group = settingsGroup(resolveSettings({ env: {}, project: {}, machine: {}, apiKey: true }), 1);
  assert.equal(group.apiKey, true);
  assert.equal("apiKey" in settingsGroup(resolveSettings({ env: {}, project: {}, machine: {} }), 1), false, "a subscription run's record is as it was");
  const facts: Facts = {
    base: "main", tracker: "github", started: "2026-10-04T06:41:00.000Z", finished: "2026-10-04T08:29:00.000Z", live: false, dryRun: false,
    verify: { green: true, line: "ok" }, gateCount: 1, tickets: { "7": { state: "merged", title: "a" } }, runnable: [], blocked: [], standing: [], keptWorktrees: [], changed: {},
    settings: group,
  };
  assert.match(settingsLines(facts, true)[0] ?? "", /^Settings: .* · billing API credits \(ANTHROPIC_API_KEY\)$/);
  assert.match(render(facts, true), /\nSettings: .* · billing API credits \(ANTHROPIC_API_KEY\)\n/);

  const repo = join(TMP, "status-repo");
  const bin = join(TMP, "status-bin");
  mkdirSync(join(repo, ".sandcastle/logs"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [["sandcastle", "#!/usr/bin/env bash\nprintf '[]\\n'\n"], ["docker", "#!/bin/sh\nexit 1\n"]]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base"]);
  const row = (settings: object, cols: number) => {
    const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
      env: {
        ...process.env, PATH: [bin, process.env.PATH].join(":"), SANDCASTLE_PROJECT: repo, SANDCASTLE_BIN: join(bin, "sandcastle"), SANDCASTLE_BASE: "main",
        SANDCASTLE_NAME: "fixture", TERM_COLS: String(cols), TERM_ROWS: "200", XDG_CACHE_HOME: join(TMP, "status-cache"), SANDCASTLE_SETTINGS: JSON.stringify(settings),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return r.stdout.replace(/\u001b\[[0-9;]*m/g, "");
  };
  assert.match(row(group, 140), /● API credits \(ANTHROPIC_API_KEY\)/);
  // Every width keeps it: it is a warning, not a detail.
  assert.match(row(group, 60), /● API credits/);
  assert.doesNotMatch(row({ autonomy: 0, turn: 1, cap: 1 }, 140), /API credits/);
});

/** A committed project with an empty ticket-file queue: a run that goes ahead ends at "Queue drained", before Docker. */
const project = (user: string | undefined, local: string | undefined) => {
  const c = setup(user, local);
  writeFileSync(join(c.root, ".sandcastle/config.ts"), 'export default { name: "demo", tracker: "files", gates: [{ name: "t", command: "true" }] };\n');
  writeFileSync(join(c.root, ".gitignore"), ".sandcastle/logs/\n.sandcastle/.env\n.sandcastle/.run/\n");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { cwd: c.root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return c;
};
const kit = (c: { root: string; xdg: string }, args: string[], env: Record<string, string> = {}) =>
  runKit(args, {
    cwd: c.root,
    encoding: "utf8",
    // No terminal: stdin is not one, as under --detach, a script or the Herdr plugin.
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, XDG_CONFIG_HOME: c.xdg, XDG_CACHE_HOME: join(TMP, "cache"), GIT_CEILING_DIRECTORIES: tmpdir(),
      HERDR_ENV: "", SANDCASTLE_DETACH: "", SANDCASTLE_DETACHED: "", AUTONOMY_LEVEL: "", SANDCASTLE_API_KEY: "", NO_COLOR: "", ...env,
    },
  });

test("a run with no terminal is refused without the opt-in, before anything starts", () => {
  const c = project(OAUTH, KEY);
  const r = kit(c, ["run"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(`This run bills API credits (ANTHROPIC_API_KEY from ${c.projectFile}), and there is no terminal to ask on.`), r.stderr);
  assert.match(r.stderr, /--api-key \(or SANDCASTLE_API_KEY=1\)/);
  assert.doesNotMatch(r.stdout, /Queue drained/);
  assert.equal(existsSync(join(c.root, ".sandcastle/logs/run.lock")), false, "the run took no lock");
  // Detached, it is refused before a process starts, terminal or not: the child would have none.
  const d = kit(c, ["run", "--detach"]);
  assert.equal(d.status, 1);
  assert.match(d.stderr, /no terminal to ask on/);
  assert.equal(existsSync(join(c.root, ".sandcastle/logs/run-output.log")), false, "no process was started");
});

test("a run with no terminal goes ahead with --api-key or SANDCASTLE_API_KEY=1", () => {
  const c = project(KEY, undefined);
  for (const [args, env] of [[["run", "--api-key"], {}], [["run"], { SANDCASTLE_API_KEY: "1" }]] as const) {
    const r = kit(c, [...args], env);
    assert.doesNotMatch(r.stderr, /bills API credits/, r.stderr);
    assert.match(r.stdout, /Queue drained/, r.stdout + r.stderr);
  }
});

test("the OAuth token alone: no question, no warning, and doctor says nothing of API credits", () => {
  const c = project(OAUTH, undefined);
  const r = kit(c, ["run"]);
  assert.doesNotMatch(r.stdout + r.stderr, /API credits/);
  assert.match(r.stdout, /Queue drained/, r.stdout + r.stderr);
  assert.doesNotMatch(kit(c, ["doctor"]).stdout, /API credits/);
});

test("doctor warns of an API key from either file, naming it and an ignored OAuth token", () => {
  const alone = project(KEY, undefined);
  assert.ok(kit(alone, ["doctor"]).stdout.includes(`warn API credits: the sandboxes spend ANTHROPIC_API_KEY from ${alone.userFile}. Every run asks before it starts.`));
  const across = project(OAUTH, KEY);
  const out = kit(across, ["doctor"]).stdout;
  assert.ok(out.includes(`warn API credits: the sandboxes spend ANTHROPIC_API_KEY from ${across.projectFile}; CLAUDE_CODE_OAUTH_TOKEN in ${across.userFile} is ignored`), out);
  assert.doesNotMatch(out, /\x1b\[/, "no colour into a pipe");
});

test("preflight and lean --measure ask the same, and are refused without a terminal before any image", () => {
  const c = project(KEY, undefined);
  for (const [args, what] of [[["preflight"], "Preflight"], [["lean", "--measure"], "lean --measure"]] as const) {
    const r = kit(c, [...args]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stderr.includes(`${what} bills API credits (ANTHROPIC_API_KEY from ${c.userFile}), and there is no terminal to ask on.`), r.stderr);
  }
});

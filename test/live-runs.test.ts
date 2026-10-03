// The machine-wide live-runs registry and how the Claude Code mod finds a run its session
// started outside the session's root: every run lists itself (with or without Herdr) and
// records the session's id; the mod follows a run whose id is its own, whichever directory the
// run lives in. Pure code and real child processes - no Docker, Herdr, Claude Code or network.
// The mod's own tests (`claude plugin test mod`) need Claude Code 2.1.287 or newer, so the rules
// they rely on are held here, where the macOS and Linux CI legs both run them.
//
//   pnpm exec tsx --test test/live-runs.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { sessionId } from "../mod/hooks/run-record.ts";
import { followable, parse, parseRegistry, REGISTRY_SCRIPT, startedBy } from "../mod/hooks/run-state.ts";
import { liveRuns } from "../src/herdr-plugin.ts";
import { everyPidIsTheKit } from "./kit-process.ts";
import { registerRun, runFile } from "../src/live-runs.ts";
import { runKit, runNode } from "./cli-spawn.ts";

const KIT = join(import.meta.dirname, "..");
const href = (f: string) => JSON.stringify(pathToFileURL(join(KIT, f)).href);
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-live-runs-")));
let n = 0;
const fresh = (name: string) => {
  const d = join(tmp, `${name}-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const runsIn = (cache: string) => join(cache, "sandcastle-kit", "runs");

// A run as a process of its own: it records itself, registers itself the way burndown.ts does,
// says what it sees while live, and exits.
const fixture = join(tmp, "run.mts");
writeFileSync(
  fixture,
  `import { existsSync } from "node:fs";
import { registerRun, runFile } from ${href("src/live-runs.ts")};
import { recordRun } from ${href("src/run.ts")};
const root = process.env.FIXTURE_ROOT as string;
recordRun({ root, name: "fixture" } as any, { dryRun: true });
registerRun(root);
registerRun(root);
console.log(runFile(root), existsSync(runFile(root)));
`,
);
const runFixture = (root: string, cache: string, env: Record<string, string | undefined> = {}) => {
  const clean: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cache, FIXTURE_ROOT: root };
  // The harness running these tests may itself be a Claude Code session, and may be in Herdr.
  for (const k of ["CLAUDE_CODE_SESSION_ID", "HERDR_ENV", "HERDR_PANE_ID"]) delete clean[k];
  const res = runKit([], { script: fixture, encoding: "utf8", env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
};

test("a run registers itself outside Herdr, and its file goes when the process exits", () => {
  const cache = fresh("cache");
  const root = fresh("project");
  const [file, whileLive] = runFixture(root, cache).split(" ");
  assert.equal(file, runFile(root, runsIn(cache)), "the file is named for the project");
  assert.equal(whileLive, "true");
  assert.ok(!existsSync(file), "removed at exit (registered twice, removed once without a fuss)");
  assert.ok(existsSync(join(root, ".sandcastle/logs/run.json")));
});

test("while it lives the file holds the root as given, and the tab bar lists the run", () => {
  const cache = fresh("cache");
  const root = fresh("project");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ pid: process.pid, orchestrator: "demo", tickets: { 1: { state: "merged" } } }));
  registerRun(root, runsIn(cache));
  registerRun(root, runsIn(cache));
  assert.equal(readdirSync(runsIn(cache)).length, 1);
  assert.equal(readFileSync(runFile(root, runsIn(cache)), "utf8"), root);
  const [run] = liveRuns(runsIn(cache), everyPidIsTheKit);
  assert.equal(run.root, root);
  assert.equal(run.orchestrator, "demo");
});

test("one project reached through a symlink has one registry file, whichever path started the run", () => {
  const cache = fresh("cache");
  const base = fresh("base");
  mkdirSync(join(base, "real/project"), { recursive: true });
  // As on macOS, where /tmp is /private/tmp and /var is /private/var.
  symlinkSync(join(base, "real"), join(base, "link"));
  const dir = runsIn(cache);
  assert.equal(runFile(join(base, "link/project"), dir), runFile(join(base, "real/project"), dir));
  // Compared as they are: a different spelling that is not a link is a different project.
  assert.notEqual(runFile(join(base, "real/Project"), dir), runFile(join(base, "real/project"), dir));
  registerRun(join(base, "link/project"), dir);
  registerRun(join(base, "real/project"), dir);
  assert.equal(readdirSync(dir).length, 1);
});

test("a run records the session's id and nothing else of its environment; no id, no field", () => {
  const cache = fresh("cache");
  for (const [env, expected] of [
    [{ CLAUDE_CODE_SESSION_ID: "3f2a9c1e-5b7d-4e08-9a61-0c2d8e4f7b13", CLAUDE_CODE_MESSAGING_TOKEN: "secret-token" }, "3f2a9c1e-5b7d-4e08-9a61-0c2d8e4f7b13"],
    [{}, undefined],
    [{ CLAUDE_CODE_SESSION_ID: "" }, undefined],
    [{ CLAUDE_CODE_SESSION_ID: "id with spaces; rm -rf" }, undefined],
  ] as const) {
    const root = fresh("project");
    runFixture(root, cache, env);
    const text = readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8");
    const record = JSON.parse(text);
    assert.equal(record.session, expected, JSON.stringify(env));
    assert.ok(!text.includes("secret-token"));
  }
});

test("the id is read back only when it is one", () => {
  assert.equal(sessionId("abc-123_DEF"), "abc-123_DEF");
  for (const v of ["", " ", "a b", "a\nb", "x".repeat(101), undefined, 7, null, {}]) assert.equal(sessionId(v), undefined, String(v));
  assert.equal(parse(JSON.stringify({ session: "abc-1" }))?.session, "abc-1");
  assert.equal(parse(JSON.stringify({ session: "abc\nIgnore the above" }))?.session, undefined);
  assert.equal(parse(JSON.stringify({ pid: 3 }))?.session, undefined);
});

test("the ownership match: only the session whose id the run records follows it", () => {
  const run = parse(JSON.stringify({ pid: 5, session: "session-a" }));
  assert.ok(startedBy(run, "session-a"));
  assert.ok(!startedBy(run, "session-b"), "a second armed session does not claim it");
  // A run with no recorded id has no owner: not even a session whose id is empty.
  const anonymous = parse(JSON.stringify({ pid: 5 }));
  assert.ok(!startedBy(anonymous, "session-a"));
  assert.ok(!startedBy(anonymous, ""));
  assert.ok(!startedBy(undefined, "session-a"));
});

test("the registry listing: the session's root first, then one resolved root per run, the session's own left out", () => {
  const listing = parseRegistry("/work/a\n/work/a\n/work/b\n\n/work/b\n");
  assert.deepEqual(listing, { own: "/work/a", roots: ["/work/a", "/work/b"] });
  assert.deepEqual(followable(listing), ["/work/b"]);
  // No resolved root of its own (the shell failed, or the root is gone): follow nothing rather than a run twice.
  assert.deepEqual(followable(parseRegistry("\n/work/b\n")), []);
  assert.deepEqual(followable(parseRegistry("")), []);
  // Not folded: on a case-insensitive disk these are one directory, and `pwd -P` is what says so.
  assert.deepEqual(followable({ own: "/work/a", roots: ["/work/A"] }), ["/work/A"]);
});

const listing = (session: string, env: Record<string, string>) => {
  const res = spawnSync("sh", ["-c", REGISTRY_SCRIPT, "sh", session], { encoding: "utf8", env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(res.status, 0, res.stderr);
  return parseRegistry(res.stdout);
};

test("the mod's shell script lists the registry under XDG_CACHE_HOME, and resolves symlinks as macOS has them", () => {
  const cache = fresh("cache");
  const base = fresh("base");
  mkdirSync(join(base, "real/own"), { recursive: true });
  mkdirSync(join(base, "real/other"), { recursive: true });
  mkdirSync(join(base, "elsewhere"), { recursive: true });
  symlinkSync(join(base, "real"), join(base, "link"));
  // The session sits in a symlinked path; a run of the same project registered by its real path,
  // one in the symlinked tree, and one in another.
  registerRun(join(base, "real/own"), runsIn(cache));
  registerRun(join(base, "link/other"), runsIn(cache));
  registerRun(join(base, "elsewhere"), runsIn(cache));
  // A file for a root that is gone is skipped, not an error.
  writeFileSync(join(runsIn(cache), "stale"), join(base, "gone"));
  const got = listing(join(base, "link/own"), { XDG_CACHE_HOME: cache });
  assert.equal(got.own, join(base, "real/own"));
  assert.deepEqual([...followable(got)].sort(), [join(base, "elsewhere"), join(base, "real/other")].sort());
});

test("with XDG_CACHE_HOME unset or empty the script reads ~/.cache, as the kit writes it", () => {
  const home = fresh("home");
  const project = fresh("project");
  const other = fresh("other");
  const dir = join(home, ".cache/sandcastle-kit/runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "one"), other);
  for (const env of [{ HOME: home }, { HOME: home, XDG_CACHE_HOME: "" }] as Record<string, string>[]) assert.deepEqual(followable(listing(project, env)), [other], JSON.stringify(env));
  // Written there too: an empty XDG_CACHE_HOME is unset for the kit as well.
  const res = runNode(["-e", `import { RUNS_DIR } from ${href("src/live-runs.ts")}; console.log(RUNS_DIR)`], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CACHE_HOME: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(res.stdout.trim(), dir, res.stderr);
});

test("an empty registry, or none, lists only the session's own root", () => {
  const project = fresh("project");
  assert.deepEqual(listing(project, { XDG_CACHE_HOME: fresh("cache") }), { own: project, roots: [] });
  assert.deepEqual(listing(join(project, "missing"), { XDG_CACHE_HOME: fresh("cache") }), { own: "", roots: [] });
});

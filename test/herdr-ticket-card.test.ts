// The ticket card a Ctrl-click opens in Herdr (src/herdr-plugin.ts): its text, built by a pure
// function from made-up run records - a green ticket, a red one with its gate tail, a held one with
// its files, one still implementing, one the last run did not take - its keys, the tracker link `t`
// prints, the per-ticket timings reader it reads (src/report.ts), and the link handler opening the
// card for the clicked log's ticket and project. A fake `herdr` and `less` on PATH; no Herdr, no
// terminal, no network.
//
//   pnpm exec tsx --test test/herdr-ticket-card.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { HERDR_PLUGIN, KIT, runKit } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-card-config-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-card-cache-"));
const { cardKey, githubIssueUrl, ticketCard, ticketFileOf, trackerLink } = await import("../src/herdr-plugin.ts");
const { ticketPasses } = await import("../src/report.ts");
const { slug } = await import("../src/tracker.ts");
type CardFacts = import("../src/herdr-plugin.ts").CardFacts;

const RUN = "2026-10-04T08:00:00.000Z";
const NOW = Date.parse("2026-10-04T10:00:00.000Z") / 1000;
const line = (issue: string, phase: string, ms: number, ok: boolean, more: object = {}, run = RUN) => JSON.stringify({ ts: RUN, run, project: "shop", issue, phase, ms, ok, ...more });
const logsOf = (id: string, ...kinds: string[]) => kinds.map((k) => `agent-issue-${id}-${k}-${id}.log`);
const card = (f: Partial<CardFacts> & { id: string }) => ticketCard({ passes: [], logs: [], now: NOW, ...f });

test("ticketPasses: one ticket's passes in the run given, in order, without its setup or other tickets'", () => {
  const text = [
    line("12", "implement", 1000, true, {}, "2026-10-01T00:00:00.000Z"),
    line("12", "setup", 5000, true),
    line("12", "implement", 600_000, true),
    line("13", "implement", 1, true),
    "not json",
    line("", "base gates", 1, true),
    line("12", "review", 300_000, true),
    line("12", "gates", 90_000, false, { red: ["test"] }),
    line("12", "repair", 200_000, true),
    line("12", "gates", 80_000, true),
    line("12", "landing gates", 70_000, true),
  ].join("\n");
  assert.deepEqual(ticketPasses(text, "12", RUN), [
    { phase: "implement", ms: 600_000, ok: true },
    { phase: "review", ms: 300_000, ok: true },
    { phase: "gates", ms: 90_000, ok: false, red: ["test"] },
    { phase: "repair", ms: 200_000, ok: true },
    { phase: "gates", ms: 80_000, ok: true },
    { phase: "landing gates", ms: 70_000, ok: true },
  ]);
  // No run given: the latest run whose lines name the ticket.
  assert.equal(ticketPasses(text, "12").length, 6);
  assert.deepEqual(ticketPasses(text, "12", "2026-10-01T00:00:00.000Z"), [{ phase: "implement", ms: 1000, ok: true }]);
  assert.deepEqual(ticketPasses(text, "99", RUN), []);
});

test("a green ticket: its passes with outcome and time, a digit for each pass's log, and the footer", () => {
  const { text, logs } = card({
    id: "12",
    ticket: { state: "merged", since: NOW - 300, title: "Add rate limiter" },
    passes: [
      { phase: "implement", ms: 604_000, ok: true },
      { phase: "review", ms: 310_000, ok: true },
      { phase: "gates", ms: 95_000, ok: true },
      { phase: "landing gates", ms: 70_000, ok: true },
    ],
    logs: logsOf("12", "impl", "review", "gates"),
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "#12  Add rate limiter");
  assert.equal(lines[1], "merged for 5m 00s");
  assert.ok(lines.includes("  1  impl           ok     10m 04s"), text);
  assert.ok(lines.includes("  2  review         ok     5m 10s"), text);
  assert.ok(lines.includes("  3  gates          green  1m 35s"), text);
  assert.ok(lines.includes("  4  landing gates  green  1m 10s"), text);
  assert.equal(lines.at(-1), "1-4 log · t tracker · q close");
  assert.deepEqual(logs, logsOf("12", "impl", "review", "gates", "gates"));
});

test("a red ticket: the red gates named, and the end of its gates log", () => {
  const { text, logs } = card({
    id: "7",
    ticket: { state: "red", since: NOW - 3600 * 2 - 120, title: "Fix date parsing", failing: ["dates > parses ISO"] },
    passes: [
      { phase: "implement", ms: 60_000, ok: true },
      { phase: "gates", ms: 30_000, ok: false, red: ["test"] },
      { phase: "repair", ms: 45_000, ok: true },
      { phase: "gates", ms: 31_000, ok: false, red: ["test", "lint"] },
    ],
    logs: logsOf("7", "impl", "gates", "repair"),
    gateTail: ["not ok 3 - parses ISO", "\x1b[31mexpected 2026\x1b[0m"],
  });
  assert.match(text, /^gate red for 2h 02m$/m);
  const lines = text.split("\n");
  assert.ok(lines.includes("  2  gates   red: test        30s"), text);
  assert.ok(lines.includes("  4  gates   red: test, lint  31s"), text);
  assert.match(text, /^failing: dates > parses ISO$/m);
  assert.match(text, /The gates log ends:\n {2}not ok 3 - parses ISO\n {2}expected 2026$/m);
  assert.doesNotMatch(text, /\x1b/, "a colour code in a log is not drawn");
  assert.equal(logs.length, 4);
});

test("a held ticket: the hold's reason, its files and its requeue", () => {
  const { text } = card({
    id: "15",
    ticket: { state: "held", since: NOW - 60, title: "Rework hooks", note: "changes how the repo executes", files: [".githooks/pre-commit", "package.json"], requeued: "requeued after conflict with #3" },
    passes: [{ phase: "implement", ms: 1000, ok: true }],
    logs: [],
  });
  assert.match(text, /^held for 1m 00s$/m);
  assert.match(text, /^ {5}impl {2}ok {2}1s$/m, "a pass with no log gets no digit");
  assert.match(text, /\n\nchanges how the repo executes\nfiles: \.githooks\/pre-commit, package\.json\nrequeued after conflict with #3\n/);
  assert.match(text, /\nt tracker · q close$/, "no digits to offer");
});

test("a ticket still implementing: the running pass, with its log, and how long it has run", () => {
  const { text, logs } = card({ id: "20", ticket: { state: "implement", since: NOW - 250, title: "Add export" }, passes: [], logs: logsOf("20", "impl") });
  assert.match(text, /^impl for 4m 10s$/m);
  assert.match(text, /^ {2}1 {2}impl {2}running {2}4m 10s$/m);
  assert.deepEqual(logs, logsOf("20", "impl"));
  assert.match(text, /\n1 log · t tracker · q close$/);
});

test("a ticket missing from run.json: its log list, and that it was not in the last run", () => {
  const { text, logs } = card({ id: "31", logs: logsOf("31", "gates", "review", "impl") });
  assert.match(text, /^#31\nNot in the last run/);
  assert.deepEqual(logs, logsOf("31", "impl", "review", "gates"));
  assert.match(text, /^ {2}1 {2}agent-issue-31-impl-31\.log$/m);
  assert.match(text, /\n1-3 log · t tracker · q close$/);
  assert.match(card({ id: "31" }).text, /It has no logs here\.\n\nt tracker · q close$/);
});

test("a title or note cannot drive the terminal, and `t`'s answer is shown under the footer", () => {
  const { text } = card({ id: "feature-01", ticket: { state: "held", title: "Evil\x1b]8;;file:///x\x1b\\ title\x07", note: "a\x1b[2Jb" }, tracker: "/repo/.scratch/feature/issues/01-x.md" });
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f]/);
  assert.match(text, /^feature-01 {2}Evil.*title$/m);
  assert.match(text, /\ntracker: \/repo\/\.scratch\/feature\/issues\/01-x\.md$/);
});

test("keys: a digit with a log pages it, t the tracker, q, Esc and Ctrl-C close; anything else does nothing", () => {
  assert.deepEqual(cardKey("1", 3), { kind: "page", index: 0 });
  assert.deepEqual(cardKey("3", 3), { kind: "page", index: 2 });
  assert.equal(cardKey("4", 3), undefined);
  assert.equal(cardKey("0", 3), undefined);
  assert.deepEqual(cardKey("t", 0), { kind: "tracker" });
  for (const k of ["q", "\x1b", "\x03"]) assert.deepEqual(cardKey(k, 0), { kind: "close" }, JSON.stringify(k));
  assert.equal(cardKey("\x1b[A", 3), undefined, "an arrow key is not Esc");
  assert.equal(cardKey("x", 3), undefined);
});

test("the tracker link: a GitHub issue from the origin remote's URL in any form, a ticket file by its id", () => {
  for (const remote of ["git@github.com:acme/shop.git", "https://github.com/acme/shop", "https://github.com/acme/shop.git\n", "ssh://git@github.com/acme/shop.git", "https://user:secret@github.com/acme/shop.git", "ssh://git@ssh.github.com:443/acme/shop.git"]) {
    assert.equal(githubIssueUrl(remote, "12"), "https://github.com/acme/shop/issues/12", remote);
  }
  assert.equal(githubIssueUrl("git@gitlab.com:acme/shop.git", "12"), undefined);
  assert.equal(githubIssueUrl("/srv/git/shop.git", "12"), undefined);
  const paths = ["README.md", ".scratch/Billing Flow/issues/01-add-invoices.md", ".scratch/billing-flow/issues/2-refunds.md", "docs/issues/01-x.md"];
  assert.equal(ticketFileOf(paths, "billing-flow-01", slug), ".scratch/Billing Flow/issues/01-add-invoices.md");
  assert.equal(ticketFileOf(paths, "billing-flow-02", slug), ".scratch/billing-flow/issues/2-refunds.md");
  assert.equal(ticketFileOf(paths, "billing-flow-03", slug), undefined);
});

// A fake `herdr` that records each call, and a fake `less` that records what it was given.
const bin = mkdtempSync(join(tmpdir(), "sandcastle-card-bin-"));
const fake = (name: string, body: string) => {
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
};
fake("herdr", `#!/bin/sh\nprintf '%s\\n' "$@" >> "$FAKE_LOG"\necho '{}'\n`);
fake("less", `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_LESS_OUT"\n`);
const project = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-card-project-")));
mkdirSync(join(project, ".sandcastle/logs"), { recursive: true });
const log = join(project, ".sandcastle/logs/agent-issue-12-review-12.log");
writeFileSync(log, "review\n");

test("a Ctrl-click opens the card pane on the clicked log's project, with that log", () => {
  const calls = join(bin, "calls.log");
  writeFileSync(calls, "");
  const r = runKit(["herdr", "open-log"], {
    script: HERDR_PLUGIN,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_LOG: calls, HERDR_PLUGIN_CLICKED_URL: pathToFileURL(log).href },
  });
  assert.equal(r.status, 0, r.stderr);
  const args = readFileSync(calls, "utf8").trimEnd().split("\n");
  assert.deepEqual(args, ["plugin", "pane", "open", "--plugin", "sandcastle-kit", "--entrypoint", "log", "--cwd", project, "--env", `SANDCASTLE_LOG=${log}`]);
  // The pane it opens runs the card.
  const manifest = readFileSync(join(KIT, "herdr/herdr-plugin.toml"), "utf8");
  assert.match(manifest, /\[\[panes\]\]\nid = "log"\n[^[]*command = \["\.\/entry\.sh", "card"\]/);
});

test("with no terminal to read keys from, the card pages the clicked log as the log popup did", () => {
  const out = join(bin, "less.out");
  const r = runKit(["herdr", "card"], {
    script: HERDR_PLUGIN,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, SANDCASTLE_LOG: log, FAKE_LESS_OUT: out },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, "utf8").trimEnd().split("\n").at(-1), log);
});

test("the card refuses a file that is not a sandcastle log", () => {
  const r = runKit(["herdr", "card"], { script: HERDR_PLUGIN, encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, SANDCASTLE_LOG: join(project, "README.md") } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a sandcastle log/);
});

test("t on a ticket file's card runs nothing from the clicked repo's own git config", () => {
  // A repo an agent made under its worktree, with a log it can print a link to.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-card-fsmonitor-")));
  const ran = join(repo, "fsmonitor-ran");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0, args.join(" "));
  git("init", "-q");
  const hook = join(repo, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch '${ran}'\n`);
  chmodSync(hook, 0o755);
  git("config", "core.fsmonitor", hook);
  trackerLink(repo, "x-1", slug);
  assert.equal(existsSync(ran), false, "the repo's fsmonitor hook ran");
});

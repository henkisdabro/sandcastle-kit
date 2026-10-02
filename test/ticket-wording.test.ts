// Everything a person or an agent reads says "ticket", not the GitHub word "issue": the closing
// summary, `sandcastle help`, the printed run strings and the prompts. "Issue" stays where it
// really means GitHub ("GitHub issue", the token's "Issues: read") and in names on disk
// (`agent/issue-N`, `agent-issue-N-*.log`). `TICKETS` is the documented variable for choosing
// tickets; `ISSUES` still works, and `TICKETS` wins when both are set.
//
// Made-up facts, a temp repo with ticket files and the kit started as a child process through
// node and the kit's own tsx loader (not bin/sandcastle or the tsx binary, which find `node` on
// PATH: a mise or asdf shim on a Mac). No Docker, gh, model calls or network; paths come from
// node:path and os.tmpdir(), so macOS and Linux behave alike.
//
//   pnpm exec tsx --test test/ticket-wording.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { namedTickets } = await import("../src/burndown.ts");
const { render } = await import("../src/report.ts");
const { namedTicketsFromEnv } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Facts = import("../src/report.ts").Facts;
type Project = import("../src/config.ts").Project;

const kit = fileURLToPath(new URL("..", import.meta.url));

// What may say "issue": GitHub's own words, and the names on disk that stay.
const ALLOWED = [/GitHub issues?/gi, /Issues: read/gi, /agent[/-]issue-[\w.*<>-]*/g];
const stray = (text: string) =>
  text
    .split("\n")
    .filter((line) => {
      let rest = line;
      for (const a of ALLOWED) rest = rest.replace(a, "");
      // The variable name ISSUES is all capitals and stays documented as the older name.
      return /\b[Ii]ssues?\b/.test(rest);
    });

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  tokens: "97.5M in / 725k out",
  verify: { green: true, line: "ruff=pass pytest=pass" },
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

test("the closing summary says ticket, never issue, outside GitHub phrases", () => {
  const mixed = render(
    facts({
      tickets: {
        "208": { state: "merged", title: "a" },
        "207": { state: "merged", title: "b" },
        "206": { state: "held", title: "pre-push check", files: [".githooks/pre-push"] },
        "203": { state: "conflict", title: "c", note: "with #204: tests/test_totals.py", files: ["tests/test_totals.py"] },
        "201": { state: "red", title: "d", note: "pytest red, 1 repair(s)", failing: ["tests/test_totals.py::test_rounding"] },
        "205": { state: "nochange", title: "e" },
        "209": { state: "blocked", title: "f" },
        "210": { state: "blocked", title: "g" },
        "211": { state: "skipped", title: "never started" },
      },
      runnable: ["209"],
      blocked: [{ id: "210", on: ["#206"] }],
      standing: ["agent/issue-201", "agent/issue-203", "agent/issue-206"],
      changed: { "206": 3 },
    }),
  );
  // The two lines the old wording lived on.
  assert.match(mixed, /Run again for the 1 ticket\(s\) this run unblocked/);
  assert.match(mixed, /Run again for the 1 ticket\(s\) that never started/);
  assert.deepEqual(stray(mixed), []);
  // Branch names stay as they are on disk.
  assert.match(mixed, /agent\/issue-206/);

  assert.deepEqual(stray(render(facts())), []);
  assert.deepEqual(stray(render(facts({ tracker: "files", dryRun: true, tickets: { "7": { state: "ready" } } }))), []);
});

test("`sandcastle help` says ticket, and names TICKETS rather than ISSUES", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-help-"));
  const r = spawnSync(process.execPath, [join(kit, "node_modules/tsx/dist/cli.mjs"), join(kit, "src/cli.ts"), "help"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CEILING_DIRECTORIES: cwd },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stray(r.stdout), []);
  assert.match(r.stdout, /the same as TICKETS, DRY_RUN and CONCURRENCY/);
  assert.match(r.stdout, /Models, effort, TICKETS/);
});

test("printed run strings, prompts and the status view carry no issue wording", () => {
  // What a run prints that needs Docker to render: read from the source instead.
  const files = ["src", "prompts"].flatMap((d) => readdirSync(join(kit, d)).map((f) => join(kit, d, f)));
  const banned = /issue\(s\)|per issue|queued issue|each issue|issue tracker:|the issue\b|\bthis issue\b|\bthe issue's\b/;
  for (const f of [...files, join(kit, "status.sh")]) {
    const bad = readFileSync(f, "utf8")
      .split("\n")
      // Comments are for the kit's developers; a printed or read string is not a comment.
      .filter((l) => !/^\s*(\/\/|\/?\*|#)/.test(l))
      .filter((l) => banned.test(l.replace(/GitHub issues?/g, "")));
    assert.deepEqual(bad, [], `${f} still says issue in a string a person or agent reads`);
  }
  const status = readFileSync(join(kit, "status.sh"), "utf8");
  assert.match(status, /\$\{head\}TICKET\$\{off\}/);
  assert.doesNotMatch(status, /\$\{head\}ISSUE\$\{off\}/);
});

// ---------------------------------------------------------------------------
// TICKETS and ISSUES
// ---------------------------------------------------------------------------

test("TICKETS selects tickets, ISSUES still does, and TICKETS wins with one line saying so", () => {
  assert.deepEqual(namedTicketsFromEnv({}), {});
  assert.deepEqual(namedTicketsFromEnv({ TICKETS: "" }), {});
  assert.deepEqual(namedTicketsFromEnv({ TICKETS: "12,15" }), { list: "12,15" });
  assert.deepEqual(namedTicketsFromEnv({ ISSUES: "12,15" }), { list: "12,15" });
  const both = namedTicketsFromEnv({ TICKETS: "3", ISSUES: "12,15" });
  assert.equal(both.list, "3");
  assert.match(both.note ?? "", /^TICKETS and ISSUES are both set; using TICKETS/);
  assert.ok(!(both.note ?? "").includes("\n"), "one line");
  // Both naming the same tickets is still a clash worth one line: the shell has a stale name.
  assert.ok(namedTicketsFromEnv({ TICKETS: "3", ISSUES: "3" }).note);
});

test("either variable's list picks the same tickets from the tracker", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-ticket-wording-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const dir = join(root, ".scratch/shop/issues");
  mkdirSync(dir, { recursive: true });
  const ticket = (title: string) => `# ${title}\n\nStatus: ready-for-agent\n\nDo it.\n\n## Comments\n`;
  writeFileSync(join(dir, "01-first.md"), ticket("First"));
  writeFileSync(join(dir, "02-second.md"), ticket("Second"));
  const project = {
    name: "demo",
    root,
    baseBranch: "main",
    label: "ready-for-agent",
    gates: [],
    tracker: fakeTracker({ kind: "files" }),
  } as unknown as Project;
  const tracker = makeTracker(project);
  const pick = (env: NodeJS.ProcessEnv) => namedTickets(tracker, namedTicketsFromEnv(env).list!).map((t) => t.id);
  assert.deepEqual(pick({ TICKETS: "shop-02" }), ["shop-02"]);
  assert.deepEqual(pick({ ISSUES: "shop-01" }), ["shop-01"]);
  assert.deepEqual(pick({ TICKETS: "shop-02", ISSUES: "shop-01" }), ["shop-02"]);
});

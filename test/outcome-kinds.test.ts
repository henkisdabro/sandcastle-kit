// Each outcome in outcomes.json carries a kind from one closed set (mod/hooks/run-record.ts), and
// every reader - the report, the autonomy loop, the status view - decides on the kind, never on
// the line. A reader that matched the line's words read a red at landing as ready once, for want of
// a prefix; the source test below fails if one does again.
//
//   pnpm exec tsx --test test/outcome-kinds.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isOutcomeKind, OUTCOME_KINDS } from "../mod/hooks/run-record.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { readOutcomes, recordOutcomes } = await import("../src/run.ts");
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = Parameters<typeof recordOutcomes>[0];

const KIT = fileURLToPath(new URL("..", import.meta.url));

test("recordOutcomes writes the kind beside the line, and readOutcomes drops a kind outside the set", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-outcomes-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const file = join(root, ".sandcastle/logs/outcomes.json");
  // An older kit's entry (no kind, its line under "outcome") and a hand edit beside it.
  writeFileSync(file, JSON.stringify({ 7: { run: "r0", outcome: "merge conflict: a.ts" }, 8: { run: "r0", kind: "shipped", text: "shipped" } }));
  recordOutcomes({ root } as Project, "r1", {
    1: { kind: "red", with: ["2", "3"], text: "red when merged with #2, #3" },
    2: { kind: "merged", with: [], text: "merged" },
  });
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(raw["1"]), ["run", "kind", "with", "text", "at"]);
  assert.deepEqual({ ...raw["1"], at: undefined }, { run: "r1", kind: "red", with: ["2", "3"], text: "red when merged with #2, #3", at: undefined });
  // No collision, no `with`.
  assert.equal("with" in raw["2"], false);
  const read = readOutcomes(root);
  assert.equal(read["1"].kind, "red");
  assert.equal(read["7"].kind, undefined);
  assert.equal(read["8"].kind, undefined);
  assert.equal(read["8"].text, "shipped");
  assert.ok(OUTCOME_KINDS.every(isOutcomeKind));
  assert.equal(isOutcomeKind("ready"), false);
});

test("the report tells red together from a red gate by this run's outcome kind, not by the note", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-outcomes-report-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "t"], { cwd: root });
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const started = "2026-01-01T00:00:00Z";
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({
      pid: 2 ** 22 + 1,
      startedAt: started,
      finishedAt: "2026-01-01T01:00:00Z",
      exitCode: 0,
      stage: "report",
      tickets: {
        "13": { state: "red", title: "together", note: "red with #11" },
        "14": { state: "red", title: "earlier", note: "red with #11" },
        "15": { state: "red", title: "kindless", note: "red with #11" },
        "16": { state: "held", title: "taken", note: "marked for a human during the run" },
      },
    }),
  );
  writeFileSync(
    join(root, ".sandcastle/logs/outcomes.json"),
    JSON.stringify({
      13: { run: started, kind: "red", with: ["11"], text: "red when merged with #11" },
      // Another run's kind says nothing about this run's ticket.
      14: { run: "2025-12-31T00:00:00Z", kind: "red", text: "red when merged with #11" },
      // No kind: its line is never parsed for one.
      15: { run: started, text: "red when merged with #11" },
      16: { run: started, kind: "taken back", text: "needs a human: marked for a human during the run" },
    }),
  );
  const project = { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const facts = await gather(project);
  assert.deepEqual(facts.outcomes, { 13: "red", 16: "taken back" });
  const out = render(facts, true);
  assert.match(out, /#13 together - red together with #11 \(green on its own branch\)/);
  assert.match(out, /#14 earlier - gate red with #11/);
  assert.match(out, /#15 kindless - gate red with #11/);
  assert.match(out, /#16 taken - marked for a human during the run - branch agent\/issue-16 has the agents' work/);
});

// How an outcome's line, or the note a reader once used in its place, begins. A reader that
// matches any of these by regex or prefix is deciding on prose.
const LINE_STARTS = [
  "green - waiting to land", "merged-earlier", "dry run:", "merged", "merge conflict", "conflicted again", "red when merged", "red again", "red with",
  "red on the merged", "gate red", "needs a human", "marked for a human", "marked needs-human", "uncommitted", "crashed", "failed to land",
  "not merged", "withdrawn", "stopped", "nochange",
];

// The literal start of a regex body: up to its first metacharacter.
const literal = (body: string) => body.replace(/\\(.)/g, "$1").split(/[()[\]{}|.*+?$\\]/)[0];

/** Prefix matches in TypeScript: `/^…/.test(…)`, `.exec`, `.match(/^…/)`, and `.startsWith("…")`. */
const tsPrefixes = (src: string): string[] => [
  ...[...src.matchAll(/\/\^((?:\\.|[^/\\\n])*)\/[a-z]*\.(?:test|exec)\(/g)].map((m) => literal(m[1])),
  ...[...src.matchAll(/\.match\(\/\^((?:\\.|[^/\\\n])*)\//g)].map((m) => literal(m[1])),
  ...[...src.matchAll(/\.startsWith\((["'`])([^"'`]*)\1/g)].map((m) => m[2]),
];

/** Prefix matches in shell: a case arm or `[[ == ]]` pattern ending in `*`, and a quoted `^…` regex (grep, awk, `=~`). */
const shPrefixes = (src: string): string[] => [
  ...[...src.matchAll(/(?:^|[|(\s])("?)([A-Za-z][^"|()*\n]*)\1\*(?=[|)\s\]])/gm)].map((m) => m[2]),
  ...[...src.matchAll(/['"]\^([^'"\n]*)/g)].map((m) => literal(m[1])),
];

const matchesALine = (prefix: string) => prefix.length > 1 && LINE_STARTS.some((s) => s.startsWith(prefix) || prefix.startsWith(s));

const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(join(KIT, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && ext.test(e.name))
    .map((e) => relative(KIT, join(e.parentPath, e.name)));

test("the scan finds a reader that matches outcome text, so its silence below means something", () => {
  assert.ok(tsPrefixes(`o.run === run && /^merge conflict/.test(o.outcome ?? "")`).some(matchesALine));
  assert.ok(tsPrefixes(`t.state === "red" && /^red (with|on the merged)/.test(t.note ?? "")`).some(matchesALine));
  assert.ok(tsPrefixes(`held.filter((id) => /^marked (for a human|needs-human)/.test(f.tickets[id].note ?? ""))`).some(matchesALine));
  assert.ok(tsPrefixes(`text.startsWith("gate red")`).some(matchesALine));
  assert.ok(shPrefixes(`    "gate red"*|"red when merged"*|"red again"*) printf 'gate red';;`).some(matchesALine));
  assert.ok(shPrefixes(`    uncommitted*) printf 'uncommitted';;`).some(matchesALine));
  assert.ok(shPrefixes(`grep -q '^merge conflict' <<<"$x"`).some(matchesALine));
  // A kind compared whole is no prefix.
  assert.ok(!shPrefixes(`    red|"gate red") printf 'gate red';;`).some(matchesALine));
});

test("no reader in src/, mod/ or status.sh matches an outcome's text with a regex or prefix", () => {
  const found: string[] = [];
  for (const f of [...files("src", /\.ts$/), ...files("mod", /\.tsx?$/)]) {
    for (const p of tsPrefixes(readFileSync(join(KIT, f), "utf8")).filter(matchesALine)) found.push(`${f}: ${p}`);
  }
  for (const p of shPrefixes(readFileSync(join(KIT, "status.sh"), "utf8")).filter(matchesALine)) found.push(`status.sh: ${p}`);
  assert.deepEqual(found, [], "read the outcome's kind (mod/hooks/run-record.ts), not its line");
});

test("status.sh's outcome_state has a case for every outcome kind, and every case is one", () => {
  const sh = readFileSync(join(KIT, "status.sh"), "utf8");
  const body = sh.slice(sh.indexOf("outcome_state() {"), sh.indexOf("\n}", sh.indexOf("outcome_state() {")));
  const cases = [...body.matchAll(/^[ \t]+([^#\s(][^)\n]*)\)\s/gm)].flatMap((m) => m[1].split("|").map((c) => c.trim().replace(/^"|"$/g, "")));
  assert.deepEqual([...cases].sort(), [...OUTCOME_KINDS].sort());
});

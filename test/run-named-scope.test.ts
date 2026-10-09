// A run whose operator named tickets lists, records and reports only those, in every autonomy turn:
// a queued ticket they left out (and its waits) never joins the plan. A bare run keeps the whole
// queue (test/autonomy-waiting.test.ts). Ticket files in a temp repo; no Docker, gh, model calls
// or network. Paths come from node:path and os.tmpdir(), so macOS and Linux behave alike.
//
//   pnpm test:file test/run-named-scope.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { namedTickets, scopeIds, waitingTickets, wholeQueue } = await import("../src/burndown.ts");
const { lateQueueLines } = await import("../src/autonomy.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const KIT = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "sandcastle-named-scope-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
const dir = join(root, ".scratch/shop/issues");
mkdirSync(dir, { recursive: true });
const ticket = (title: string, status: string, head = "") => `# ${title}\n\nStatus: ${status}\n${head}\nDo it.\n\n## Comments\n`;
// 01 is named; 02 (named) waits for 01; 03 (named) waits for the unnamed 04; 05 is unnamed and waits for 01.
writeFileSync(join(dir, "01-base.md"), ticket("Base", "ready-for-agent"));
writeFileSync(join(dir, "02-first.md"), ticket("First", "ready-for-agent", "Blocked by: 01"));
writeFileSync(join(dir, "03-third.md"), ticket("Third", "ready-for-agent", "Blocked by: 04"));
writeFileSync(join(dir, "04-outside.md"), ticket("Outside", "ready-for-agent"));
writeFileSync(join(dir, "05-other.md"), ticket("Other", "ready-for-agent", "Blocked by: 01"));
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { cwd: root });
git("add", "-A");
git("commit", "-qm", "t");
const project = { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
const tracker = makeTracker(project);

const list = "shop-01,shop-02,shop-03";
const scope = () => scopeIds(tracker, list);
const ids = (tickets: { id: string }[]) => tickets.map((t) => t.id).sort();

test("a run that names tickets plans only those, not a queued ticket it left out", async () => {
  const whole = wholeQueue(tracker, namedTickets(tracker, list), scope());
  assert.deepEqual(ids(whole), ["shop-01", "shop-02", "shop-03"]);
  const waiting = await waitingTickets(project, tracker, whole);
  // The named #03 still waits, on the unnamed #04; the unnamed #05 is not on the list at all.
  assert.deepEqual(waiting.map((w) => w.issue).sort(), ["shop-02", "shop-03"]);
  assert.ok(!waiting.some((w) => w.issue === "shop-05"));
});

test("a later turn that names only its re-runnable ticket keeps the operator's scope", async () => {
  const whole = wholeQueue(tracker, namedTickets(tracker, "shop-01"), scope());
  assert.deepEqual(ids(whole), ["shop-01", "shop-02", "shop-03"]);
  assert.deepEqual((await waitingTickets(project, tracker, whole)).map((w) => w.issue).sort(), ["shop-02", "shop-03"]);
});

test("a bare run keeps the whole queue", () => {
  assert.deepEqual(ids(wholeQueue(tracker, namedTickets(tracker, "shop-01"))), ["shop-01", "shop-02", "shop-03", "shop-04", "shop-05"]);
});

test("a ticket in the scope that is closed or unknown keeps its id as typed", () => {
  assert.deepEqual([...scopeIds(tracker, "shop-01, shop-99")].sort(), ["shop-01", "shop-99"]);
});

test("the drain's late-queue lines name no ticket outside a named run's scope", async () => {
  const known = new Set(["shop-01"]);
  const none = async () => new Set<string>();
  assert.deepEqual(await lateQueueLines(tracker, known, none, scope()), ["shop-02 was queued after this run started: `sandcastle run` takes it", "shop-03 was queued after this run started: `sandcastle run` takes it"]);
  assert.equal((await lateQueueLines(tracker, known, none)).length, 4);
});

test("the run loop hands every turn the operator's list, and burndown applies it to the whole queue", () => {
  const cli = readFileSync(join(KIT, "src/cli.ts"), "utf8");
  assert.match(cli, /const operatorList = namedTicketsFromEnv\(\)\.list;/);
  assert.match(cli, /burndown\(project, \{ settings, turn, \.\.\.\(scope \? \{ scope \} : \{\}\)/);
  assert.match(cli, /async \(late\) => new Set\(\(await openOnQueue\(project, tracker, late\)\)\.keys\(\)\), scope\?\.ids\)/);
  const burndown = readFileSync(join(KIT, "src/burndown.ts"), "utf8");
  assert.match(burndown, /const whole = named\.list \? wholeQueue\(tracker, queued, scope\) : queued;/);
});

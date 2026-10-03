// `sandcastle queue --lint`: the queue's shape before a run - the longest blocker chain, edges that
// only order overlapping work against real ones, wide tickets, hot files, a lockfile two tickets
// share, the blocker problems and a rough turn count. Ticket files in a temp repo (files tracker);
// no Docker, gh, model calls or network. The CLI case starts the kit with the running node and the
// kit's own tsx loader, so it does not depend on a `node` shim on PATH (macOS version managers).
//
//   pnpm exec tsx --test test/queue-lint.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const KIT = fileURLToPath(new URL("..", import.meta.url));
const XDG = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = XDG;
delete process.env.LINEAR_API_KEY;
const { lintQueue } = await import("../src/lint.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const GIT = ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const ticket = (title: string, head = "", status = "ready-for-agent") => `# ${title}\n\nStatus: ${status}\n${head}\nDo it.\n\n## Comments\n`;

const repo = (tickets: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-lint-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  for (const [name, text] of Object.entries(tickets)) writeFileSync(join(root, ".scratch/shop/issues", name), text);
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  writeFileSync(join(root, "app.ts"), "export {};\n");
  execFileSync("git", [...GIT, "add", "-A"], { cwd: root });
  execFileSync("git", [...GIT, "commit", "-qm", "t"], { cwd: root });
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const tracker = makeTracker(project);
  return { root, project, tracker };
};

const lint = async (tickets: Record<string, string>) => {
  const { project, tracker } = repo(tickets);
  return (await lintQueue(project, tracker, tracker.queued(false))).join("\n");
};

const many = Array.from({ length: 11 }, (_, i) => `src/part${i}.ts`).join(", ");

test("a depth-3 chain is printed as the chain, and the estimate counts it", async () => {
  const text = await lint({
    "01-a.md": ticket("A"),
    "02-b.md": ticket("B", "Blocked by: 01"),
    "03-c.md": ticket("C", "Blocked by: 02"),
    "04-d.md": ticket("D"),
  });
  assert.match(text, /blocker depth: 3 - shop-01 -> shop-02 -> shop-03/);
  assert.match(text, /rough estimate: one run; 3 tickets one after another in it \(blocker depth 3\)/);
  assert.ok(!/turn/.test(text.split("rough estimate")[1]), text);
  assert.match(text, /rough/);
});

test("an edge between tickets with overlapping Touches is counted; one without is listed as real", async () => {
  const text = await lint({
    "01-a.md": ticket("A", "Touches: src/a.ts, src/shared.ts"),
    "02-b.md": ticket("B", "Blocked by: 01\nTouches: src/shared.ts"),
    "03-c.md": ticket("C", "Blocked by: 01\nTouches: src/other.ts"),
  });
  assert.match(text, /blocked-by edges: 2, 1 between tickets whose Touches overlap .*, 1 that do not/);
  assert.match(text, /real: shop-03 waits for shop-01/);
  assert.ok(!text.includes("real: shop-02"), text);
});

test("a ticket declaring more than 10 files is wide, with the count; 10 is not", async () => {
  const text = await lint({ "01-a.md": ticket("A", `Touches: ${many}`), "02-b.md": ticket("B", "Touches: src/part0.ts, src/b.ts") });
  assert.match(text, /wide tickets \(more than 10 declared files\): shop-01 \(11\)/);
  const ten = await lint({ "01-a.md": ticket("A", `Touches: ${many.split(", ").slice(0, 10).join(", ")}`) });
  assert.match(ten, /wide tickets \(more than 10 declared files\): none/);
});

test("a file four tickets declare is hot, with the tickets; three is not", async () => {
  const touch = (...f: string[]) => `Touches: ${f.join(", ")}`;
  const text = await lint({
    "01-a.md": ticket("A", touch("src/hub.ts", "src/x.ts")),
    "02-b.md": ticket("B", touch("src/hub.ts", "src/x.ts")),
    "03-c.md": ticket("C", touch("src/hub.ts", "src/x.ts")),
    "04-d.md": ticket("D", touch("src/hub.ts")),
  });
  assert.match(text, /src\/hub\.ts: shop-01, shop-02, shop-03, shop-04/);
  assert.ok(!/src\/x\.ts: shop/.test(text.split("unmergeable")[0]), text);
});

test("a lockfile two tickets declare is listed and may add one turn; one ticket's does not", async () => {
  const text = await lint({ "01-a.md": ticket("A", "Touches: pnpm-lock.yaml"), "02-b.md": ticket("B", "Touches: pnpm-lock.yaml, app.ts") });
  assert.match(text, /pnpm-lock\.yaml: shop-01, shop-02/);
  assert.match(text, /rough estimate: one run; no ticket waits for another \(blocker depth 1\), maybe one more turn for a shared unmergeable file/);
  const alone = await lint({ "01-a.md": ticket("A", "Touches: pnpm-lock.yaml"), "02-b.md": ticket("B", "Touches: app.ts") });
  assert.match(alone, /unmergeable files declared by 2\+ tickets: none/);
  assert.match(alone, /rough estimate: one run; no ticket waits for another \(blocker depth 1\); a guess/);
});

test("every blockerProblems line appears", async () => {
  const text = await lint({ "01-a.md": ticket("A", "Blocked by: 09") });
  assert.match(text, /problems:\n\s+shop-01 waits for shop-09, which does not exist/);
});

test("blockers listed under a Blocked by heading are a problem; on the line itself, or in code, they are not", async () => {
  const text = await lint({ "01-a.md": ticket("A"), "02-b.md": ticket("B", "## Blocked by\n\n- #1\n") });
  assert.match(text, /problems:\n\s+shop-02 lists its blockers under a "Blocked by" heading, which is not read/);
  const fine = await lint({ "01-a.md": ticket("A"), "02-b.md": ticket("B", "Blocked by: 01\n\n```\n## Blocked by\n- #1\n```\n") });
  assert.match(fine, /problems: none/);
});

test("a cycle does not hang the chain search", async () => {
  const text = await lint({ "01-a.md": ticket("A", "Blocked by: 02"), "02-b.md": ticket("B", "Blocked by: 01") });
  assert.match(text, /blocker depth: 2/);
  assert.match(text, /wait for each other/);
});

test("an empty queue prints one line", async () => {
  const { project, tracker } = repo({ "01-a.md": ticket("A", "", "done") });
  assert.equal((await lintQueue(project, tracker, tracker.queued(false))).length, 1);
});

test("the CLI runs --lint read-only and exits 0 even with problems", () => {
  const { root } = repo({ "01-a.md": ticket("A", "Blocked by: 09"), "02-b.md": ticket("B", "Blocked by: 01") });
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), 'export default { name: "t", gates: [{ name: "g", command: "true" }], tracker: "files" };\n');
  const before = execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: root, encoding: "utf8" });
  const r = spawnSync(process.execPath, [join(KIT, "node_modules/tsx/dist/cli.mjs"), join(KIT, "src/cli.ts"), "queue", "--lint"], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: XDG, GIT_CEILING_DIRECTORIES: tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /blocker depth: 2 - shop-01 -> shop-02/);
  assert.match(r.stdout, /shop-09, which does not exist/);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: root, encoding: "utf8" }), before);
});

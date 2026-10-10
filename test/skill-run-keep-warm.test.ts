// The skill's fallback for a session without the mod: run.md's step 3 schedules a 55-minute tick
// that keeps the session's prompt cache warm, only when the mod's note does not, `keepWarm` is not
// false and the harness can schedule; step 4 stops the loop; pause.md says a pause keeps the tick.
//
//   pnpm test:file test/skill-run-keep-warm.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const run = read("skill", "run.md");
const pause = read("skill", "pause.md");

const flat = (text: string) => text.replace(/\s+/g, " ");
const step = (n: number) => run.match(new RegExp(`^${n}\\. \\*\\*[\\s\\S]*?(?=^${n + 1}\\. \\*\\*|^## )`, "m"))?.[0] ?? "";
const step3 = flat(step(3));
const step4 = flat(step(4));
const tick = run.match(/^ *(node -e '.*')$/m)?.[1] ?? "";

test("step 3 names the 55-minute tick, its three conditions and the harness without a scheduler", () => {
  assert.match(step3, /every 55 minutes/);
  assert.match(step3, /only when \*\*all\*\* of these hold/);
  assert.match(step3, /mod's note in SKILL\.md does not say the mod keeps the cache warm/);
  assert.match(step3, /`settings\.keepWarm` is not `false`/);
  assert.match(step3, /schedule a recurring prompt .*`\/loop`/);
  assert.match(step3, /no scheduler skips the tick: say so to the user once/);
});

test("the mod's note in SKILL.md and the skill's condition name the same sentence", () => {
  assert.match(read("mod", "hooks", "register.tsx"), /keeps this session's prompt cache warm while the run is live, so skip the skill's keep-warm tick/);
});

test("the tick is one node command that prints the stage and the ticket counts", () => {
  assert.ok(tick, "run.md holds the node command");
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-keep-warm-tick-"));
  mkdirSync(join(dir, ".sandcastle", "logs"), { recursive: true });
  const tickets = { 1: { state: "merged" }, 2: { state: "merged" }, 3: { state: "queued" }, 4: { state: "review" } };
  writeFileSync(join(dir, ".sandcastle", "logs", "run.json"), JSON.stringify({ stage: "running", tickets }));
  const args = tick.replace(/^node /, "");
  const out = spawnSync(process.execPath, ["-e", args.replace(/^-e '/, "").replace(/'$/, "")], { cwd: dir, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "running · merged 2, queued 1, review 1\n");
});

test("run.md's keep-warm text names no jq", () => {
  const text = step3.slice(step3.indexOf("Keep the session's prompt cache warm"));
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /\bjq\b/);
  assert.doesNotMatch(tick, /\bjq\b/);
});

test("step 4 starts by stopping the loop, and a tick that finds the run ended goes on to it", () => {
  assert.match(step4, /Start by stopping the keep-warm loop of step 3/);
  assert.match(step3, /finds the run ended .* stops the loop and goes on to step 4/);
  assert.match(step3, /A paused run keeps its ticks/);
});

// Every turn ends on `report` (burndown.ts), and the autonomy loop may then ask or start another turn:
// a tick that read `report` as the end would stop the loop and close a run still going.
test("a tick reads the end from `sandcastle wait`, never from the stage `report` alone", () => {
  const ended = step3.match(/finds the run ended \(([^)]*)\)/)?.[1] ?? "";
  assert.match(ended, /`sandcastle wait` .*reported back/);
  assert.doesNotMatch(ended, /`report`/);
  assert.match(step3, /stage `report` alone is no end/);
});

test("pause.md says a paused run keeps its keep-warm tick", () => {
  assert.match(flat(pause), /keep-warm tick .* keeps running through the pause/);
});

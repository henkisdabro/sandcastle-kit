// The pause and resume actions are skill-only text: SKILL.md routes to skill/pause.md, which tells
// an agent to hold a run with `sandcastle pause` (never `sandcastle stop`, which ends the passes in
// flight) and to confirm before a stop. This pins the routing - frontmatter, table rows, router
// sections, the AGENTS.md row - the rules pause.md must keep, the lines it quotes from the kit's
// own output, and the pointers status.md and run.md hold to a paused run.
//
//   node --test test/skill-pause.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Normalise line endings so the test reads the same checked out on either platform.
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const skill = read("skill", "SKILL.md");
const pause = read("skill", "pause.md");
const status = read("skill", "status.md");
const run = read("skill", "run.md");
const agents = read("AGENTS.md");
const cli = read("src", "cli.ts");
const statusView = read("status.sh");

const flat = (text: string) => text.replace(/\s+/g, " ");
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
const sectionOf = (text: string, name: string) =>
  text.match(new RegExp(`^## ${name}\\b[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m"))?.[0] ?? "";

test("the frontmatter names pause and resume and keeps OpenCode's limit", () => {
  const description = frontmatter.match(/^description: "(.*)"$/m)?.[1] ?? "";
  assert.ok(description.length > 0 && description.length < 1024, String(description.length));
  assert.match(description, /pause/);
  assert.match(description, /resume/);
  assert.match(frontmatter, /^argument-hint: .*pause\|resume/m);
});

test("the action table has a pause row and a resume row", () => {
  assert.match(skill, /^\| `pause` \| .* \| .* \|$/m);
  assert.match(skill, /^\| `resume` \| .* \| .* \|$/m);
  // The row says what a hold is, so a router that reads only the table still avoids a stop.
  assert.match(skill.match(/^\| `pause` \| .*$/m)?.[0] ?? "", /never a `stop`/);
});

test("the router has a short pause section and a resume section, each pointing at pause.md", () => {
  for (const name of ["pause", "resume"]) {
    const section = sectionOf(skill, name);
    assert.ok(section, `no ## ${name} heading`);
    assert.ok(section.includes("pause.md"), `## ${name} does not name pause.md`);
    const lines = section.split("\n").filter((l) => l.trim() !== "").length;
    assert.ok(lines <= 5, `## ${name} is ${lines} lines: the steps belong in pause.md`);
  }
});

test("pause.md holds the pause and resume steps, and nothing of them is left in SKILL.md", () => {
  for (const name of ["pause", "resume"]) assert.ok(sectionOf(pause, name), `pause.md has no ## ${name}`);
  for (const command of ["sandcastle pause", "sandcastle resume"]) {
    assert.ok(!skill.includes(command), `SKILL.md holds a step that runs ${command}`);
  }
});

test("pause runs sandcastle pause, then sandcastle status 0, and says what keeps going", () => {
  const section = flat(sectionOf(pause, "pause"));
  assert.ok(section.indexOf("`sandcastle pause`") >= 0);
  assert.ok(section.indexOf("`sandcastle status 0`") > section.indexOf("`sandcastle pause`"));
  assert.match(section, /No run is live\./);
  assert.match(section, /still finishing/);
  assert.match(section, /Green branches keep landing/);
  assert.match(section, /Nothing is lost/);
  assert.match(section, /How to resume/);
  assert.match(section, /`sandcastle resume`/);
});

test("resume runs sandcastle resume and confirms the status view no longer reads PAUSED", () => {
  const section = flat(sectionOf(pause, "resume"));
  assert.ok(section.indexOf("`sandcastle resume`") >= 0);
  assert.ok(section.indexOf("`sandcastle status 0`") > section.indexOf("`sandcastle resume`"));
  assert.match(section, /no longer reads `PAUSED`/);
});

test("pause.md sends requests that mean a hold to pause, and keeps stop for ending the run", () => {
  const hold = flat(sectionOf(pause, "Pause, not stop"));
  for (const phrase of ["hold the run", "stop starting new tickets", "pause it until tomorrow"]) {
    assert.ok(hold.includes(`"${phrase}"`), `no mention of "${phrase}"`);
  }
  assert.match(hold, /prefer `sandcastle pause`/);
  assert.match(hold, /`sandcastle stop`, and only after the user has confirmed that the passes in flight end mid-way/);
  assert.match(hold, /run `sandcastle stop` only on a yes/);
});

test("pause.md is portable: a question tool is named by what it does, with Claude Code's name as an example", () => {
  assert.match(flat(pause), /the harness's question tool \(`AskUserQuestion` in Claude Code\)/);
  for (const tool of ["run_in_background", "Monitor", "TodoWrite", "ScheduleWakeup"]) {
    assert.ok(!pause.includes(tool), `pause.md names a harness-only tool: ${tool}`);
  }
});

test("pause.md quotes only lines the kit prints", () => {
  for (const quoted of ["No run is live.", "is already paused", "Pausing the run", "is not paused", "Resuming the run"]) {
    assert.ok(pause.includes(quoted), `pause.md does not quote "${quoted}"`);
    assert.ok(cli.includes(quoted), `src/cli.ts prints no "${quoted}"`);
  }
  assert.ok(statusView.includes("PAUSED since"), "status.sh does not print PAUSED since");
  assert.ok(pause.includes("PAUSED since"));
});

test("status.md names the pause and how to resume it", () => {
  const text = flat(status);
  assert.match(text, /A paused run is still live, and its run cell reads `PAUSED since 15:40/);
  assert.match(text, /`sandcastle resume`/);
  assert.match(text, /pause\.md/);
});

test("run.md says a paused run is still live, so the mod sends no end prompt until it ends", () => {
  const step = flat(run.match(/^3\. \*\*Arrange to hear when it ends\.\*\*[\s\S]*?(?=^4\. )/m)?.[0] ?? "");
  assert.ok(step, "run.md has no 'Arrange to hear when it ends' step");
  assert.match(step, /A paused run \(pause\.md\) is still live, so the mod sends no end prompt until the run ends/);
});

test("AGENTS.md's skill row names pause.md", () => {
  const row = agents.split("\n").find((l) => l.startsWith("| `skill/` |")) ?? "";
  assert.ok(row.includes("pause.md"), row);
});

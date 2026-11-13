// A later turn of one run prints a start line only when it differs from the one an earlier turn printed under
// the same name: the versions, the CPU limit, the pauses and the rest are the same in turns 2-4. The helper is
// held by calling it; burndown() needs Docker, so its call sites are held by a source match, as
// drain-turn-refused.test.ts holds the run loop.
//
//   pnpm test:file test/start-lines-once.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { sayStart } = await import("../src/run.ts");

const collect = () => {
  const lines: string[] = [];
  return { lines, print: (line: string) => void lines.push(line) };
};

test("a later turn says a start line again only when its text changed", () => {
  const memo = new Map<string, string>();
  const { lines, print } = collect();
  assert.equal(sayStart(memo, "cpus", "Sandbox CPUs: 8 each", print), true);
  assert.equal(sayStart(memo, "cpus", "Sandbox CPUs: 8 each", print), false);
  assert.deepEqual(lines, ["Sandbox CPUs: 8 each"]);
  assert.equal(sayStart(memo, "cpus", "Sandbox CPUs: 4 each", print), true);
  assert.deepEqual(lines, ["Sandbox CPUs: 8 each", "Sandbox CPUs: 4 each"]);
  // A name of its own: the same text under another key is another line.
  assert.equal(sayStart(memo, "memory", "Sandbox CPUs: 4 each", print), true);
});

test("a single turn with no memo says every start line", () => {
  const { lines, print } = collect();
  assert.equal(sayStart(undefined, "cpus", "Sandbox CPUs: 8 each", print), true);
  assert.equal(sayStart(undefined, "cpus", "Sandbox CPUs: 8 each", print), true);
  assert.equal(lines.length, 2);
});

test("a start line printed with no print argument goes to the console", () => {
  const original = console.log;
  const seen: unknown[] = [];
  console.log = (...args: unknown[]) => void seen.push(...args);
  try {
    assert.equal(sayStart(new Map(), "k", "a line"), true);
  } finally {
    console.log = original;
  }
  assert.deepEqual(seen, ["a line"]);
});

const burndown = readFileSync(join(KIT, "src/burndown.ts"), "utf8");
const run = readFileSync(join(KIT, "src/run.ts"), "utf8");
const cli = readFileSync(join(KIT, "src/cli.ts"), "utf8");

// The text of every statement-level call of `name(`, parentheses balanced (template literals and strings skipped).
const calls = (src: string, name: string) => {
  const found: string[] = [];
  for (let at = src.indexOf(name); at >= 0; at = src.indexOf(name, at + 1)) {
    if (/[\w.]/.test(src[at - 1] ?? "")) continue;
    let depth = 0;
    let i = at + name.length - 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
      else if (c === '"' || c === "'" || c === "`") {
        // Skip a literal; `${` inside a template is not entered, which is enough for these lines.
        for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      }
    }
    found.push(src.slice(at, i + 1));
  }
  return found;
};

test("every repeated start line goes through sayStart and none through a bare console.log", () => {
  const said = calls(burndown, "sayStart(").join("\n");
  const bare = calls(burndown, "console.log(").join("\n");
  for (const part of ["versionsLine(", "localLine", "cpusLine(", "memoryLine(", "`Keep awake:", "baseIsTheRunsLine(", "Status view: ", "loadPauseLine(", "usagePauseLine(", "Lean: hiding"]) {
    assert.ok(said.includes(part), `${part} is an argument of sayStart(`);
    assert.ok(!bare.includes(part), `${part} is in no bare console.log(`);
  }
});

test("the API-credits line stays in a bare console.log, said on every turn", () => {
  assert.ok(calls(burndown, "console.log(").some((c) => c.includes("runApiKeyLine(")));
  assert.ok(!calls(burndown, "sayStart(").some((c) => c.includes("runApiKeyLine(")));
});

test("the preflight's ok line goes through the turn's memo, and the command keeps console.log", () => {
  const call = calls(burndown, "preflight(").find((c) => c.includes("extraModels"));
  assert.ok(call, "burndown calls preflight with the extra models");
  assert.match(call, /preflight\(project, image, extraModels, \(line\) => .*sayStart\(memo, "preflight", line\)/);
  assert.match(run, /say\(`Preflight ok: /);
  assert.ok(!/console\.log\(`Preflight ok/.test(run));
  assert.match(run, /say: \(line: string\) => void = console\.log\) =>/);
});

test("a turn tells how many start lines it left out, and the run loop hands every turn one memo", () => {
  assert.ok(burndown.includes("start line(s) unchanged from an earlier turn"));
  assert.match(cli, /const startLines = new Map<string, string>\(\);/);
  assert.match(cli, /burndown\(project, \{[^\n]*\bstartLines\b/);
  assert.ok(cli.indexOf("const startLines") < cli.indexOf("for (let turn = 1; ; turn++)"), "made once, before the loop");
});

// The readers of an agent's final message (ungatedOf, unmetOf, changelogOf) count a tag only
// on lines of its own: one named in inline code, a fenced block or mid-sentence is prose. No repo,
// Docker, model or network.
//
//   node --test test/own-line-tags.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing burndown.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { ungatedOf, unmetOf, changelogOf } = await import("../src/burndown.ts");

const prose = (tag: string) =>
  [
    `The reader of \`<${tag}>\` takes the first opening tag, so explaining it here used to leak.`,
    "",
    "```",
    `<${tag}>a fenced example`,
    "that runs on</" + tag + ">",
    "```",
    "",
    `A line that mentions <${tag}> mid-sentence and, much later, </${tag}>`,
    "ends the same way.",
    "",
  ].join("\n");

test("ungatedOf ignores a tag named in prose and reads the real one", () => {
  assert.equal(ungatedOf(`${prose("ungated")}\n<ungated>open the page</ungated>\n`), "open the page");
  assert.equal(ungatedOf(prose("ungated")), undefined);
});

test("unmetOf ignores a tag named in prose and reads the real one", () => {
  assert.equal(unmetOf(`${prose("unmet")}\n<unmet>skipped the export</unmet>\n`), "skipped the export");
  assert.equal(unmetOf(prose("unmet")), undefined);
});

test("changelogOf ignores a tag named in prose and reads the real ones", () => {
  assert.deepEqual(changelogOf(`${prose("changelog")}\n<changelog>Fixed: a</changelog>\n<changelog>Added: b</changelog>\n`), ["Fixed: a", "Added: b"]);
  assert.deepEqual(changelogOf(prose("changelog")), []);
});

test("a tag indented, wrapped over lines, or after an unclosed fence still counts", () => {
  assert.equal(ungatedOf("  <ungated>open\n  the page</ungated>  \n"), "open the page");
  assert.equal(unmetOf("```\nstray\n<unmet>real</unmet>\n"), "real");
});

test("two tags on one line are not read as one", () => {
  assert.equal(ungatedOf("<ungated>a</ungated> then <ungated>b</ungated>"), undefined);
});

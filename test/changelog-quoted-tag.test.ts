// A changelog line that quotes a tag in inline code is a line: the own-line reader refused any tag holding
// another opening tag, so ``Fixed: an agent answering `<changelog>none</changelog>` ...`` was lost, neither
// kept nor counted as dropped (#663). A tag quoted in prose, not on its own line, is still no tag.
//
//   pnpm test:file test/changelog-quoted-tag.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { changelogScan, ungatedOf } = await import("../src/burndown.ts");

test("a changelog line quoting the tag in backticks is kept whole", () => {
  const line = "Fixed: an agent answering `<changelog>none</changelog>` is no longer printed as a changelog line.";
  assert.deepEqual(changelogScan(`Done.\n\n<changelog>${line}</changelog>\n`).lines, [line]);
});

test("a tag quoted in inline code within prose is still not read as a tag", () => {
  assert.deepEqual(changelogScan("I left out the `<changelog>none</changelog>` tag on purpose.\n").lines, []);
  assert.equal(ungatedOf("See `<ungated>x</ungated>` in the prompt.\n"), undefined);
});

test("a quoted tag of another kind inside a line is kept too", () => {
  assert.equal(ungatedOf("<ungated>Nothing gates the `<unmet>` reader on a real agent's message.</ungated>\n"), "Nothing gates the `<unmet>` reader on a real agent's message.");
});

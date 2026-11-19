// Agent-written text - a follow-up's title and evidence, a ticket's note, a filed issue's title - and the titles the
// tracker lists reach the user's real terminal through the closing summary and `sandcastle report` (in Herdr, through
// `less -R`). An escape sequence in any of them could write the clipboard (OSC 52), set the title or clear the screen,
// so both read them as plain text, as the status view does; the report's own colours stay. A made-up run record and a
// fake `gh` first on PATH (plain sh); no network.
//
//   pnpm test:file test/report-escape-sequences.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { followUpsOf } = await import("../src/burndown.ts");
const { fakeTracker } = await import("./fixtures.ts");

const OSC52 = "\x1b]52;c;QUJD\x07";
const CLEAR = "\x1b[2J";
const HOSTILE = `${OSC52}x${CLEAR}`;
// oxlint-disable-next-line no-control-regex -- control characters are what the test looks for
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
// The kit's own colouring: SGR codes, nothing else.
// oxlint-disable-next-line no-control-regex -- the escape byte is what the pattern matches
const OWN_COLOUR = /\x1b\[[0-9;]*m/g;

test("a follow-up's title and evidence are stored with no escape sequence or control character", () => {
  const [f] = followUpsOf(`<followup>Fix X ${OSC52}now${CLEAR} - src/a.ts:1 ${HOSTILE} breaks\x07</followup>\n`);
  assert.equal(f.title, "Fix X now");
  assert.equal(f.evidence, "src/a.ts:1 x breaks");
  for (const s of [f.title, f.evidence]) assert.doesNotMatch(s, CONTROL);
});

const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
const gh = join(dir, "gh");
writeFileSync(gh, `#!/bin/sh\n[ "$1 $2" = "issue list" ] && printf '%s\\n' "$FAKE_GH_ISSUES"\nexit 0\n`);
chmodSync(gh, 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;

const report = async (plain: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({
      startedAt: "2026-09-30T06:00:00Z",
      finishedAt: "2026-09-30T07:00:00Z",
      exitCode: 1,
      stage: "report",
      pid: 1,
      stopped: `STOPPED: the ledger ${HOSTILE}`,
      tickets: {
        "5": { state: "held", title: `held one ${HOSTILE}`, note: `human merge: ${HOSTILE}`, unmet: `criterion ${HOSTILE}` },
        "6": { state: "merged", title: `merged one ${HOSTILE}` },
      },
      followUps: [
        { title: `unfiled ${HOSTILE}`, evidence: `evidence ${HOSTILE}`, from: "5", phase: "review" },
        { title: `filed ${HOSTILE}`, evidence: `evidence ${HOSTILE}`, from: "5", phase: "review", id: "50" },
      ],
    }),
  );
  process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 41, title: `opened ${HOSTILE}`, createdAt: "2026-09-30T06:30:00Z" }]);
  const project = { root, baseBranch: "main", tracker: fakeTracker(), gates: [] } as any;
  return render(await gather(project, () => undefined), plain);
};

test("the report prints agent and tracker text with no escape sequence but the kit's own colours", async () => {
  const out = await report(false);
  for (const word of ["held one x", "human merge: x", "unfiled x", "evidence x", "filed x", "opened x"]) assert.ok(out.includes(word), `${word} in:\n${out}`);
  assert.doesNotMatch(out.replace(OWN_COLOUR, ""), CONTROL);
  assert.ok(!out.replace(OWN_COLOUR, "").includes("\x1b"));
});

test("with NO_COLOR the report holds no escape byte at all", async () => {
  const out = await report(true);
  assert.ok(out.includes("unfiled x"), out);
  assert.ok(!out.includes("\x1b"));
  assert.doesNotMatch(out, CONTROL);
});

// What a Claude pass said of its work (#820): `saidOf` reads the schema-validated report when one came and the
// own-line tags otherwise, `gapOf`'s guard follows it, and `reportTiming` says for the step's timings line whether
// the report came. burndown() needs Docker, so the call sites are held by source-match tests at the end.
//
//   pnpm test:file test/report-said.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-rsd-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-rsd-"));
const { gapOf, reportTiming, saidOf, UNGATED_MAX } = await import("../src/burndown.ts");
const { COMPLETION_SIGNAL } = await import("../src/agents.ts");
const { PERSON_MARK } = await import("../src/autonomy.ts");
type Report = import("../src/agents.ts").Report;
type ReportFacts = import("../src/agents.ts").ReportFacts;

const reportOf = (over: Partial<Report> = {}): Report => ({
  signal: COMPLETION_SIGNAL,
  unmet: { assessed: true, items: [] },
  changelog: [],
  followups: [],
  ungated: [],
  ...over,
});
/** The facts a capture gives: the report and the last iteration's output (the whole text of a one-iteration pass). */
const factsOf = (report: Report | undefined, output: string, over: Partial<ReportFacts> = {}): ReportFacts => ({
  ...(report ? { report } : { missing: "no structured_output" }),
  output,
  tries: report ? 1 : 0,
  ...over,
});

const TAGS = [
  "All done.",
  "",
  "<unmet>the README still lacks the flag</unmet>",
  "<changelog>Added: a tag line.</changelog>",
  "<followup>tag follow-up - tag evidence</followup>",
  "<ungated>tag ungated note</ungated>",
  "",
].join("\n");

test("with no report, a pass is read exactly as the tag readers always read it", () => {
  const expected = {
    unmet: "the README still lacks the flag",
    ungated: "tag ungated note",
    changelog: { lines: ["Added: a tag line."], why: [] },
    followups: [{ title: "tag follow-up", evidence: "tag evidence" }],
  };
  assert.deepEqual(saidOf(TAGS), expected);
  // A missing report falls back to the tags, whatever the capture saw.
  assert.deepEqual(saidOf(TAGS, factsOf(undefined, TAGS)), expected);
  assert.deepEqual(saidOf("Nothing to report.\n"), { unmet: undefined, ungated: undefined, changelog: { lines: [], why: [] }, followups: [] });
});

test("a report wins over tags that contradict it", () => {
  const said = saidOf(TAGS, factsOf(reportOf({ changelog: ["Fixed: the report's line."], ungated: ["report ungated"], followups: ["report follow-up - report evidence"] }), TAGS));
  assert.equal(said.unmet, undefined);
  assert.equal(said.ungated, "report ungated");
  assert.deepEqual(said.changelog.lines, ["Fixed: the report's line."]);
  assert.deepEqual(said.followups, [{ title: "report follow-up", evidence: "report evidence" }]);
});

test("unmet is the items' texts joined, cleaned as a tag's text is, with the person mark when one is a person's", () => {
  const unmet = (items: Report["unmet"]["items"], assessed = true) => saidOf("", factsOf(reportOf({ unmet: { assessed, items } }), "")).unmet;
  assert.equal(unmet([{ who: "agent", text: "  the flag\n  is missing " }, { who: "agent", text: "" }, { who: "agent", text: "..." }, { who: "agent", text: "the docs" }]), "the flag is missing; the docs");
  assert.equal(unmet([{ who: "agent", text: "the code" }, { who: "person", text: "the deploy" }]), `${PERSON_MARK}the code; the deploy`);
  assert.equal(unmet([{ who: "person", text: `${PERSON_MARK}the deploy` }]), `${PERSON_MARK}the deploy`);
  // A person's item that is dropped marks nothing.
  assert.equal(unmet([{ who: "person", text: "..." }, { who: "agent", text: "the code" }]), "the code");
  assert.equal(unmet([], true), undefined);
  assert.equal(unmet([], false), undefined);
  assert.equal(unmet([{ who: "agent", text: " " }, { who: "agent", text: "..." }]), undefined);
  const long = unmet([{ who: "agent", text: "word ".repeat(600) }]);
  assert.ok(long && long.length <= UNGATED_MAX && long.endsWith("…"));
});

test("ungated is the items joined with '; ', cleaned and cut like a tag's text", () => {
  const ungated = (items: string[]) => saidOf("", factsOf(reportOf({ ungated: items }), "")).ungated;
  assert.equal(ungated(["  the look\n of it ", "", "...", "the sound"]), "the look of it; the sound");
  assert.equal(ungated([]), undefined);
  assert.equal(ungated(["", "..."]), undefined);
  const long = ungated(["word ".repeat(600)]);
  assert.ok(long && long.length <= UNGATED_MAX && long.endsWith("…"));
});

test("changelog items are judged by the rules a tag's text is, and an empty list is the answer none", () => {
  const read = (items: string[]) => saidOf("", factsOf(reportOf({ changelog: items }), "")).changelog;
  assert.deepEqual(read(["Added: a thing.", "  Fixed:   another\n thing. "]), { lines: ["Added: a thing.", "Fixed: another thing."], why: [] });
  assert.deepEqual(read([]), { lines: [], why: [], none: true });
  assert.deepEqual(read(["none"]), { lines: [], why: [], none: true });
  assert.deepEqual(read(["Added: x.", "N/A."]), { lines: ["Added: x."], why: [], none: true });
  assert.deepEqual(read(["", "..."]), { lines: [], why: [] });
  assert.deepEqual(read(["Added: " + "x".repeat(500)]), { lines: [], why: ["too long (507 characters)"] });
  assert.deepEqual(read(["- one\n- two"]), { lines: [], why: ["spans list items"] });
  assert.deepEqual(read(["Fixed: merged as 1a2b3c4d5e."]), { lines: [], why: ["holds a commit sha"] });
});

test("follow-ups are split into title and evidence as a tag's text is", () => {
  const read = (items: string[]) => saidOf("", factsOf(reportOf({ followups: items }), "")).followups;
  assert.deepEqual(read(["short title - the evidence - with a dash", "title only", "", "...", "title - one line of evidence", ' "quoted - title" - e']), [
    { title: "short title", evidence: "the evidence - with a dash" },
    { title: "title only", evidence: "" },
    { title: '"quoted - title"', evidence: "e" },
  ]);
  const [cut] = read([`${"word ".repeat(60)}- e`]);
  assert.ok(cut.title.length <= 120 && cut.title.endsWith("…"));
});

test("a pass of two iterations keeps the first one's follow-ups and changelog lines beside the report's, not its unmet", () => {
  const first = "Started.\n<unmet>first iteration's criterion</unmet>\n<changelog>Added: first.</changelog>\n<followup>first problem - first evidence</followup>\n<ungated>first ungated</ungated>\n";
  const last = "Finished.\n<unmet>last tag</unmet>\n<followup>last tag follow-up - e</followup>\n";
  const report = reportOf({ changelog: ["Fixed: second."], followups: ["second problem - second evidence"], ungated: ["last ungated"] });
  const said = saidOf(first + last, factsOf(report, last));
  assert.equal(said.unmet, undefined);
  assert.equal(said.ungated, "last ungated");
  assert.deepEqual(said.changelog.lines, ["Added: first.", "Fixed: second."]);
  assert.deepEqual(said.followups.map((f) => f.title), ["first problem", "second problem"]);
  // Without a report the whole text is read, as before.
  assert.equal(saidOf(first + last, factsOf(undefined, last)).unmet, "last tag");
  // An output the text does not end with cannot be taken off it: the whole text is read, a line twice rather than lost.
  assert.deepEqual(saidOf(first, factsOf(report, "something else")).followups.map((f) => f.title), ["first problem", "second problem"]);
});

const GAP = "Fine.\n\nOne small inaccuracy\nremains in the README. It is minor.\n";

test("gapOf's guard follows the report: tags with a follow-up and a report with none, and the reverse", () => {
  const tagged = `${GAP}\n<followup>the inaccuracy - evidence</followup>\n`;
  assert.equal(gapOf(tagged), undefined);
  assert.equal(gapOf(tagged, saidOf(tagged, factsOf(undefined, tagged))), undefined);
  // The report says there is no follow-up: the tag in the text no longer files the gap, so the prose gap is still read.
  assert.equal(gapOf(tagged, saidOf(tagged, factsOf(reportOf(), tagged))), "One small inaccuracy remains in the README.");
  // The reverse: no tag, a follow-up in the report.
  assert.equal(gapOf(GAP), "One small inaccuracy remains in the README.");
  assert.equal(gapOf(GAP, saidOf(GAP, factsOf(reportOf({ followups: ["the inaccuracy - evidence"] }), GAP))), undefined);
  // The same for unmet.
  assert.equal(gapOf(GAP, saidOf(GAP, factsOf(reportOf({ unmet: { assessed: true, items: [{ who: "agent", text: "the README" }] } }), GAP))), undefined);
  const unmetTag = `${GAP}\n<unmet>the README</unmet>\n`;
  assert.equal(gapOf(unmetTag), undefined);
  assert.equal(gapOf(unmetTag, saidOf(unmetTag, factsOf(reportOf(), unmetTag))), "One small inaccuracy remains in the README.");
});

// ---- the timings line

test("reportTiming: a report that came", () => {
  assert.deepEqual(reportTiming(factsOf(reportOf(), "x", { turns: 3, gapMs: 1200, silenceMs: 800 })), { came: "report", tries: 1, turns: 3, gapMs: 1200, silenceMs: 800 });
  assert.deepEqual(reportTiming(factsOf(reportOf(), "x")), { came: "report", tries: 1 });
});

test("reportTiming: no report but own-line tags in the last iteration's output are tags, and the reason is kept", () => {
  assert.deepEqual(reportTiming(factsOf(undefined, TAGS, { turns: 2, gapMs: 50, silenceMs: 50, cutOff: true })), {
    came: "tags",
    missing: "no structured_output",
    tries: 0,
    turns: 2,
    gapMs: 50,
    silenceMs: 50,
    cutOff: true,
  });
  for (const tag of ["unmet", "changelog", "followup", "ungated"]) assert.equal(reportTiming(factsOf(undefined, `Done.\n<${tag}>x</${tag}>\n`)).came, "tags", tag);
  assert.equal(reportTiming(factsOf(undefined, '<unmet who="person">x</unmet>\n')).came, "tags");
});

test("reportTiming: no report and no tag is missing, and a tag named in prose is no tag", () => {
  assert.deepEqual(reportTiming(factsOf(undefined, "Done.\n")), { came: "missing", missing: "no structured_output", tries: 0 });
  assert.equal(reportTiming(factsOf(undefined, "I wrote a <followup>x - y</followup> in prose.\n")).came, "missing");
  assert.equal(reportTiming({ output: "", tries: 0, missing: "no result line" }).missing, "no result line");
  assert.equal(reportTiming(factsOf(undefined, "Done.\n", { missing: "invalid: signal is not the completion signal" })).missing, "invalid: signal is not the completion signal");
});

test("reportTiming: tags are read from the last iteration's output only", () => {
  const earlier = "<followup>x - y</followup>\n";
  const last = "Finished.\n";
  // The capture hands `last` as the output: the earlier iteration's tags are not in it.
  assert.equal(reportTiming(factsOf(undefined, last)).came, "missing");
  assert.equal(reportTiming(factsOf(undefined, earlier + last)).came, "tags");
});

test("reportTiming: a pass that threw is missing, with its failure, unless the retries ran out", () => {
  assert.deepEqual(reportTiming(factsOf(undefined, TAGS, { missing: "no result line" }), "claude-code exited with code 1 - rate limit"), {
    came: "missing",
    missing: "failed: claude-code exited with code 1 - rate limit",
    tries: 0,
  });
  assert.deepEqual(reportTiming(factsOf(undefined, "", { missing: "retries exhausted", tries: 5 }), "claude-code exited with code 1"), { came: "missing", missing: "retries exhausted", tries: 5 });
  // A thrown pass never counts as having its report.
  assert.equal(reportTiming(factsOf(reportOf(), "x"), "boom").came, "missing");
});

// ---- the call sites (burndown() needs Docker)

const source = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");

test("every pass reads what it said through saidOf, and the readers take it from the result", () => {
  assert.match(source, /const said = saidOf\(r\.stdout \?\? "", facts\);/);
  assert.match(source, /for \(const f of said\.followups\) ctx\.followUps\?\.push\(/);
  assert.match(source, /return Object\.assign\(r, \{ said \}\);/);
  // No reader of a Claude pass's message takes the tags from its text any more.
  assert.doesNotMatch(source, /\b(?:unmetOf|ungatedOf|followUpsOf)\((?:r|impl|resolved|merged|after|review|cross)\??\.stdout\)/);
  for (const who of ["impl", "resolved", "merged", "after"]) assert.match(source, new RegExp(`\\b${who}\\.said\\.unmet`));
  assert.match(source, /gapOf\(r\.stdout, r\.said\)/);
  assert.match(source, /gapOf\(after\.stdout, after\.said\)/);
  assert.match(source, /noteChangelog\(impl\.said\)/);
  assert.match(source, /noteChangelog\(r\?\.said\)/);
});

test("the pass records whether its report came, and timed puts it on the step's line", () => {
  assert.match(source, /capture\?\.finish\(\)/);
  assert.match(source, /ctx\.reportTimings\?\.set\(issue\.id, reportTiming\(facts\)\)/);
  assert.match(source, /ctx\.reportTimings\?\.set\(issue\.id, reportTiming\(facts, agentFailure\(error\)\)\)/);
  assert.match(source, /const reported = reportTimings\.get\(issue\);\n\s+reportTimings\.delete\(issue\);/);
  assert.match(source, /\.\.\.\(reported \? \{ report: reported \} : \{\}\),/);
  assert.match(source, /tickets: candidates,\n\s+reportTimings,/);
});

test("REPORT_SCHEMA is read once in agents.ts and scrubbed from the tests' environment", () => {
  const agents = readFileSync(join(import.meta.dirname, "../src/agents.ts"), "utf8");
  assert.match(agents, /export const REPORT_SCHEMA = process\.env\.REPORT_SCHEMA === "1";/);
  assert.match(readFileSync(join(import.meta.dirname, "hermetic-env.ts"), "utf8"), /"REPORT_SCHEMA"/);
  assert.match(readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8"), /CROSS_REVIEW, REPORT_SCHEMA,/);
});

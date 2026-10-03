// The ledger (src/ledger.ts) is the only voice of what became of a ticket: the only writer of a
// ticket state a run ends on, and the only caller of `recordOutcomes`. Progress stays a plain write
// anywhere - the phases a pipeline steps through (`timed`), the landing stage, the queued and
// blocked a ticket waits in, notes, tokens. A verdict written beside the ledger is one the ledger
// cannot word, and one a requeue had to undo; this source test fails on the first one added.
//
//   pnpm exec tsx --test test/ledger-guard.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GROUPS, TICKET_STATES, type TicketState } from "../mod/hooks/run-record.ts";

const KIT = fileURLToPath(new URL("..", import.meta.url));

// Progress: the working group's states (the phases and the landing stage), and the two a ticket
// waits in before it begins. Every other ticket state is one a run ends on, so a state added to the
// closed set is an ending until it is placed here.
const PROGRESS = new Set<TicketState>([...TICKET_STATES.filter((s) => GROUPS[s] === "working"), "queued", "blocked"]);
const ENDING = new Set<string>(TICKET_STATES.filter((s) => !PROGRESS.has(s)));

// A state written from a variable is a progress write only where it is named here: `timed` writes
// the phase it is given, and the scan below holds every phase passed to it.
const VARIABLE_STATES: Record<string, string[]> = { "src/burndown.ts": ["phase"] };

/** The source without its comment lines, so a comment that quotes a write is not one. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");

/** The fields argument of every `.ticket(id, fields)` call: the text after the first top-level comma, to the call's closing bracket. */
const ticketWrites = (body: string): string[] =>
  [...body.matchAll(/\.ticket\(/g)].map((m) => {
    let depth = 0;
    let comma = -1;
    for (let i = m.index + m[0].length; i < body.length; i++) {
      const c = body[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c) && depth-- === 0) return comma < 0 ? "" : body.slice(comma + 1, i).trim();
      else if (c === "," && depth === 0 && comma < 0) comma = i;
    }
    return "";
  });

/** What in one file writes a verdict outside the ledger, each as a line naming it. */
const strays = (file: string, src: string): string[] => {
  const body = code(src);
  const out: string[] = [];
  for (const m of body.matchAll(/\bstate\s*:\s*(["'`])([^"'`]*)\1/g)) if (ENDING.has(m[2])) out.push(`${file}: state "${m[2]}"`);
  for (const fields of ticketWrites(body)) {
    // A record handed over whole can carry any state: a ticket write outside the ledger spells its fields out.
    if (!fields.startsWith("{")) out.push(`${file}: .ticket(...) with a record that is not spelt out (${fields.slice(0, 40)})`);
    for (const m of fields.matchAll(/\bstate\s*:\s*([A-Za-z_$][\w$.]*)/g)) if (!VARIABLE_STATES[file]?.includes(m[1])) out.push(`${file}: state from ${m[1]}`);
    if (/[{,]\s*state\s*[,}]/.test(fields)) out.push(`${file}: state from a variable named state`);
  }
  for (const m of body.matchAll(/\.update\(\s*\{[^}]*\btickets\s*:/g)) out.push(`${file}: tickets rewritten whole (${m[0].replace(/\s+/g, " ")}...)`);
  // `timed` writes its phase as the ticket's state: a phase is a literal, and never an ending.
  for (const m of body.matchAll(/\btimed\(\s*[^,()]+,\s*(?:(["'`])([^"'`]*)\1|([^\s,)]+))/g)) {
    if (m[3] !== undefined) out.push(`${file}: timed(...) with a phase from ${m[3]}`);
    else if (ENDING.has(m[2])) out.push(`${file}: timed(..., "${m[2]}")`);
  }
  // outcomes.json: written by `recordOutcomes` (src/run.ts), which the ledger alone calls.
  if (file !== "src/run.ts" && /\brecordOutcomes\b/.test(body)) out.push(`${file}: recordOutcomes`);
  if (file === "src/run.ts" && (body.match(/\brecordOutcomes\b/g) ?? []).length > 1) out.push(`${file}: recordOutcomes used beside its definition`);
  if (file !== "src/run.ts" && /outcomes\.json/.test(body)) out.push(`${file}: names outcomes.json`);
  return out;
};

const sources = (): string[] =>
  readdirSync(join(KIT, "src"), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => relative(KIT, join(e.parentPath, e.name)).split(sep).join("/"));

test("the ending states are the closed set's, less progress", () => {
  for (const s of ["merged", "conflict", "red", "held", "ready", "nochange", "uncommitted", "crashed", "not landed", "withdrawn", "stopped", "skipped"]) {
    assert.ok(ENDING.has(s), `${s} is a state a run ends on`);
  }
  for (const s of ["queued", "blocked", "setup", "implement", "review", "cross-review", "gates", "repair", "landing"]) assert.ok(!ENDING.has(s), `${s} is progress`);
});

test("the scan finds a verdict written outside the ledger, so its silence below means something", () => {
  const found = (src: string) => strays("src/landing.ts", src);
  assert.deepEqual(found(`run.ticket(o.issue, { state: "merged", note: "merged and closed" });`), ['src/landing.ts: state "merged"']);
  assert.deepEqual(found(`const held = (reason: string): TicketRecord => ({ state: 'held', note: reason });`), ['src/landing.ts: state "held"']);
  assert.deepEqual(found(`run.ticket(id, { state: verdict });`), ["src/landing.ts: state from verdict"]);
  assert.equal(found(`run.ticket(id, { note, state });`).length, 1);
  assert.equal(found(`run.ticket(id, record);`).length, 1);
  assert.equal(found(`bookkeep(id, () => run.ticket(id, withdrawnRecord(reason)));`).length, 1);
  assert.equal(found(`run.update({ stage: "x", tickets: {} });`).length, 1);
  assert.deepEqual(found(`await timed(issue.id, "crashed", () => 0);`), ['src/landing.ts: timed(..., "crashed")']);
  assert.equal(found(`await timed(issue.id, step, () => 0);`).length, 1);
  assert.deepEqual(found(`const ledger = createLedger({ outcomes: (o) => recordOutcomes(project, runId, o) });`), ["src/landing.ts: recordOutcomes"]);
  assert.equal(found(`writeFileSync(join(root, ".sandcastle/logs/outcomes.json"), "{}");`).length, 1);
  // Progress, and a comment quoting a write, pass.
  assert.deepEqual(found(`run.ticket(o.issue, { state: "landing" });\nrun.ticket(id, { state: "queued", note: null });\n  // run.ticket(id, { state: "merged" })`), []);
  assert.deepEqual(found(`await timed(\n  issue.id,\n  "review",\n  () => 0,\n);\nawait timed("", "base gates", () => 0);`), []);
  assert.deepEqual(strays("src/burndown.ts", `run.ticket(issue, { state: phase, ...(note ? { note } : {}) });`), []);
});

test("only src/ledger.ts writes a ticket state a run ends on, or the outcomes", () => {
  const files = sources();
  assert.ok(files.includes("src/ledger.ts") && files.includes("src/burndown.ts") && files.includes("src/landing.ts"), "found the kit's sources");
  const found = files.filter((f) => f !== "src/ledger.ts").flatMap((f) => strays(f, readFileSync(join(KIT, f), "utf8")));
  assert.deepEqual(found, [], "record a verdict through the ledger (src/ledger.ts): describe the ending, and let the writer record it");
  // The ledger itself does write them: the scan would see it.
  assert.ok(strays("src/ledger.ts", readFileSync(join(KIT, "src/ledger.ts"), "utf8")).some((s) => s.includes("recordOutcomes")));
  // The one variable state stays in use, or its exception goes.
  for (const [file, names] of Object.entries(VARIABLE_STATES)) {
    for (const n of names) assert.match(code(readFileSync(join(KIT, file), "utf8")), new RegExp(`\\bstate\\s*:\\s*${n}\\b`), `${file} no longer writes state: ${n}; drop it from VARIABLE_STATES`);
  }
});

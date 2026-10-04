// The status view stays in shell, with its own grouping (it needs one for derived states, and a
// group stored in the run record would go stale once a run dies). These tests hold it to the
// shared run record schema instead, reading status.sh and its fixtures as text the way
// test/mod.test.ts reads its glyphs and colours: a field it reads is a run record field, its
// grouping puts every ticket state where the shared table does, no grouping arm is dead, its
// outcome_state has a case for every outcome kind and none beside, and no fixture records a ticket
// state the kit never writes. No session, no model calls.
//
//   pnpm exec tsx --test test/status-contract.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DERIVED_STATES, GROUPS, isTicketState, OUTCOME_KINDS, TICKET_STATES, WORDS, type Group, type TicketState } from "../mod/hooks/run-record.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const status = read("status.sh");
const record = read("mod", "hooks", "run-record.ts");

/** The field names of a type declared as `export type <name> = { ... };` in run-record.ts. */
const fieldsOf = (name: string): string[] => {
  const body = record.match(new RegExp(`export type ${name} = \\{\\n([\\s\\S]*?)\\n\\};`))?.[1] ?? "";
  return [...body.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]);
};
const RUN_FIELDS = fieldsOf("RunRecord");
const TICKET_FIELDS = fieldsOf("TicketRecord");
const SETTINGS_FIELDS = fieldsOf("RunSettings");
// A waiting entry is declared inline on the run record: `waiting?: { issue: string; on: string[] }[]`.
const WAITING_FIELDS = [...(record.match(/^  waiting\?: \{([^}]*)\}/m)?.[1] ?? "").matchAll(/(\w+)\??:/g)].map((m) => m[1]);

// A run written before `tickets` carried `active`, a map of issue to { phase, since }; the view
// still reads it for a live run of an older kit, which no current kit writes and the schema does
// not hold. Named here so that reading it is a decision and every other stray field fails.
const LEGACY_RUN_FIELDS = ["active"];
const LEGACY_ACTIVE_FIELDS = ["phase", "since"];

/** Every jq program status.sh runs on the run record: `jq ... '<program>' "$f"` or `logs/run.json`. */
const runRecordPrograms = (): string[] => {
  const calls = [...status.matchAll(/\bjq\b[^'\n]*(?:\\\n[^'\n]*)?'([^']*)'\s*(?:2>\/dev\/null\s*)?("\$f"|logs\/[\w.]+|<<<)/g)];
  return calls.filter((m) => m[2] === '"$f"' || m[2] === "logs/run.json").map((m) => m[1]);
};

/** The `.a.b` chains of a jq program, outside a longer word, a `$variable` or a closing bracket. */
const chains = (program: string): string[][] =>
  [...program.matchAll(/(?<![\w$)\]"])((?:\.[A-Za-z_]\w*)+)/g)].map((m) => m[1].slice(1).split("."));

/** What a program reads, as strings naming the offending chain when it is not a run record field. */
const strays = (program: string): string[] => {
  // The collections the program walks: `(.tickets // {})[]`, `(.waiting // [])[]`, `.tickets[]`.
  const walked = [...program.matchAll(/\(\.(\w+) \/\/ [{[]/g)].map((m) => m[1]);
  const itemFields = walked.flatMap((c) => (c === "tickets" ? TICKET_FIELDS : c === "waiting" ? WAITING_FIELDS : c === "settings" ? SETTINGS_FIELDS : c === "active" ? LEGACY_ACTIVE_FIELDS : []));
  const out: string[] = [];
  for (const [first, second] of chains(program)) {
    if (first === "key") continue;
    if (first === "value") {
      // to_entries over a collection: `.value` is an item, so its next name is an item field.
      if (second && !itemFields.includes(second)) out.push(`.value.${second}`);
      continue;
    }
    if (RUN_FIELDS.includes(first) || LEGACY_RUN_FIELDS.includes(first)) continue;
    if (itemFields.includes(first)) continue;
    out.push(`.${first}`);
  }
  return out;
};

test("every field the status view reads from the run record is a run record field", () => {
  const programs = runRecordPrograms();
  assert.ok(programs.length >= 10, `found the run record reads in status.sh (${programs.length})`);
  const read = new Set(programs.flatMap((p) => chains(p).map((c) => c[0])));
  for (const field of ["tickets", "pid", "startedAt", "finishedAt", "concurrency", "typical", "stage", "models", "tokens", "dryRun", "settings"]) {
    assert.ok(read.has(field), `the harvest finds status.sh reading .${field}`);
  }
  assert.ok(RUN_FIELDS.includes("tickets") && TICKET_FIELDS.includes("state") && WAITING_FIELDS.includes("on"), "the schema's fields were found");
  // The settings group's own fields: the row reads each of them, and each is one the record holds.
  assert.deepEqual(SETTINGS_FIELDS, ["autonomy", "turn", "cap", "repair", "concurrency", "asked", "crossReview", "crossReviewModel", "crossReviewEffort", "usageGuard", "usageStop", "usageReading", "apiKey"], "the settings group's fields were found");
  for (const field of SETTINGS_FIELDS) assert.ok(read.has(field), `the harvest finds status.sh reading .${field}`);
  for (const p of programs) assert.deepEqual(strays(p), [], `status.sh reads fields the run record does not hold, in: ${p.replace(/\s+/g, " ").trim()}`);
  // The legacy field stays a known exception only while the view still reads it.
  for (const f of LEGACY_RUN_FIELDS) assert.ok(read.has(f), `status.sh no longer reads .${f}: drop it from LEGACY_RUN_FIELDS`);
});

// The case in status.sh that turns a ticket's recorded state into the word its row shows.
const wordArms = (): Map<string, string> => {
  const body = status.match(/case "\$tstate" in ((?:[\w-]+\) state=(?:"[^"]*"|\w+);; )+)\*\) state="\$tstate";; esac/)?.[1] ?? "";
  const arms = [...body.matchAll(/([\w-]+)\) state=(?:"([^"]*)"|(\w+));;/g)];
  assert.ok(arms.length > 0, "status.sh maps a ticket state to its word");
  return new Map(arms.map((m) => [m[1], m[2] ?? m[3]]));
};

/** The arms of style_of: each word it names, with the shell group it sets. */
const groupArms = (): { word: string; group: string }[] => {
  const body = status.match(/^style_of\(\) \{\n  case "\$1" in\n([\s\S]*?)\n  esac\n\}/m)?.[1] ?? "";
  const arms = [...body.matchAll(/^    (.+?)\) glyph=.*? grp=("[^"]+"|\w+);;$/gm)];
  assert.ok(arms.length >= 7, "status.sh groups states in style_of");
  return arms.flatMap((m) =>
    m[1] === "*" ? [{ word: "*", group: m[2].replace(/"/g, "") }] : m[1].split("|").map((w) => ({ word: w.replace(/"/g, ""), group: m[2].replace(/"/g, "") })),
  );
};

// The status view's `left over` and `idle` are the shared table's `other`; the rest share names.
const SHARED_GROUP: Record<string, Group> = {
  working: "working",
  "needs you": "needs you",
  ready: "ready",
  queued: "queued",
  blocked: "blocked",
  merged: "merged",
  "left over": "other",
  idle: "other",
};

test("the status view's word mapping and grouping put every ticket state in the shared table's group", () => {
  const words = wordArms();
  const arms = groupArms();
  const viewGroup = (word: string) => arms.find((a) => a.word === word)?.group ?? arms.find((a) => a.word === "*")?.group;
  // The words the view uses are the shared table's.
  for (const state of TICKET_STATES) assert.equal(words.get(state) ?? state, WORDS[state] ?? state, `the view's word for ${state}`);
  for (const [state, word] of words) assert.ok(isTicketState(state) && WORDS[state as TicketState] === word, `the view words ${state} as "${word}", the shared table does not`);
  for (const state of TICKET_STATES) {
    const group = viewGroup(words.get(state) ?? state);
    assert.ok(group && SHARED_GROUP[group], `the view has a group for ${state} (${group})`);
    assert.equal(SHARED_GROUP[group], GROUPS[state], `${state} falls in "${group}" in status.sh, "${GROUPS[state]}" in the shared table`);
  }
});

test("every arm of the status view's grouping is a ticket state's word or a derived state", () => {
  const words = new Set<string>(TICKET_STATES.map((s) => WORDS[s] ?? s));
  const derived = new Set<string>(DERIVED_STATES);
  const seen = new Set<string>();
  for (const { word } of groupArms()) {
    if (word === "*") continue;
    assert.ok(words.has(word) || derived.has(word), `status.sh groups "${word}", which is neither a ticket state's word nor a derived state`);
    // A case takes its first match, so a word named again in a later arm is dead there.
    assert.ok(!seen.has(word), `status.sh groups "${word}" in two arms of style_of; the later one never matches`);
    seen.add(word);
  }
});

/**
 * The patterns of status.sh's outcome_state, the case that turns this run's outcome kind into the
 * word its row shows. Every line of the case is an arm or a comment: a line read as neither fails,
 * so an arm the harvest cannot parse is never skipped as silence.
 */
const outcomeArms = (sh: string): string[] => {
  const body = sh.match(/^outcome_state\(\) \{\n  case "\$1" in\n([\s\S]*?)\n  esac\n\}/m)?.[1];
  assert.ok(body !== undefined, "status.sh has an outcome_state case");
  return body.split("\n").flatMap((line) => {
    if (/^\s*(#|$)/.test(line)) return [];
    const arm = line.match(/^    (.+?)\) printf '[^']*';;$/);
    assert.ok(arm, `an outcome_state line that is neither an arm nor a comment: ${line}`);
    return arm[1].split("|").map((p) => p.replace(/^"|"$/g, ""));
  });
};

/** Where status.sh's outcome_state and the closed set of outcome kinds disagree, each way. */
const outcomeContract = (arms: string[], kinds: readonly string[]) => ({
  /** An outcome kind the view has no case for: its row would read as an earlier run's leftover. */
  missing: kinds.filter((k) => !arms.includes(k)),
  /** A case for no outcome kind: never matched, or matched by a kind the kit does not write. */
  extra: arms.filter((a) => !kinds.includes(a)),
});

test("status.sh's outcome_state has a case for every outcome kind, and every case is one", () => {
  const arms = outcomeArms(status);
  const { missing, extra } = outcomeContract(arms, OUTCOME_KINDS);
  assert.deepEqual(missing, [], "outcome kinds (mod/hooks/run-record.ts) with no case in status.sh's outcome_state");
  assert.deepEqual(extra, [], "cases in status.sh's outcome_state that are no outcome kind (mod/hooks/run-record.ts)");
  // A case takes its first match, so a kind named again in a later arm is dead there.
  assert.equal(new Set(arms).size, arms.length, "status.sh names an outcome kind in two arms of outcome_state");
});

test("the outcome_state contract fails in both directions", () => {
  const arms = outcomeArms(status);
  // A kind added on the run record's side only.
  assert.deepEqual(outcomeContract(arms, [...OUTCOME_KINDS, "shipped"]), { missing: ["shipped"], extra: [] });
  // A case added on status.sh's side only, as its own arm or beside a kind.
  const added = status.replace(/^(outcome_state\(\) \{\n  case "\$1" in\n)/m, "$1    shipped) printf 'merged';;\n");
  assert.deepEqual(outcomeContract(outcomeArms(added), OUTCOME_KINDS), { missing: [], extra: ["shipped"] });
  const beside = status.replace("    merged) printf 'merged';;", "    merged|\"merged earlier\") printf 'merged';;");
  assert.deepEqual(outcomeContract(outcomeArms(beside), OUTCOME_KINDS), { missing: [], extra: ["merged earlier"] });
  // A case dropped from status.sh: its kind is missing.
  const dropped = status.replace("    crashed) printf 'crashed';;\n", "");
  assert.deepEqual(outcomeContract(outcomeArms(dropped), OUTCOME_KINDS), { missing: ["crashed"], extra: [] });
  for (const changed of [added, beside, dropped]) assert.notEqual(changed, status, "the self-check's edit of status.sh applies");
  // An arm the harvest cannot read fails rather than passing unseen.
  assert.throws(() => outcomeArms(status.replace("    crashed) printf 'crashed';;", "    crashed) echo crashed;;")), /neither an arm nor a comment/);
});

test("every ticket state in the status view's shell fixtures is a ticket state", () => {
  const fixtures = read("test", "status.test.sh");
  const states = [...fixtures.matchAll(/"state":\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(states.length >= 20, `found the fixtures' ticket states (${states.length})`);
  for (const s of states) assert.ok(isTicketState(s), `a status.test.sh fixture records "${s}", a ticket state the kit never writes`);
  // A requeued ticket is a queued one that carries the line, never a state of its own.
  assert.match(fixtures, /"state": "queued"[^}\n]*"requeued": "[^"]+"/, "a fixture holds a queued ticket with a requeued line");
});

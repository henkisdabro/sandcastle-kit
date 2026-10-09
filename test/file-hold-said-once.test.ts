import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHoldRecord } from "../src/burndown.ts";

const ref = (id: string) => `#${id}`;
const parked = [{ ticket: { id: "2" }, file: { with: "1", file: "pnpm-lock.yaml" }, shares: [] }] as never;

test("a file hold the plan's ticket list already says is not said again by the start", () => {
  const said: string[] = [];
  const waiting: { issue: string; on: string[] }[] = [];
  createHoldRecord({ waiting, ref, say: (l) => void said.push(l.trim()), listed: new Set(["2"]) }).start(parked);
  assert.deepEqual(said, []);
  assert.deepEqual(waiting, [{ issue: "2", on: ["#1"] }], "the hold is still on record");
});

test("a file hold no plan list says is said by the start", () => {
  const said: string[] = [];
  createHoldRecord({ waiting: [], ref, say: (l) => void said.push(l.trim()) }).start(parked);
  assert.deepEqual(said, ["#2 waits for #1: both change pnpm-lock.yaml (git cannot merge it)"]);
});

test("a ticket freed from a file is said released, to start at the next free slot", () => {
  const said: string[] = [];
  const record = { ticket: () => {}, update: () => {} } as never;
  createHoldRecord({ waiting: [], ref, say: (l) => void said.push(l.trim()) }).tell(record, {
    kind: "started",
    id: "2",
    after: { kind: "file", freed: "1" },
    shares: [],
  } as never);
  assert.deepEqual(said, ["#2 released: #1 is done with the file they both change; it starts at the next free slot"]);
});

test("burndown() hands the ticket list's file holds to the hold record", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /createHoldRecord\(\{\s*waiting,\s*ref,\s*listed,/);
  assert.match(src, /if \(later\) listed\.add\(i\.id\);/);
});

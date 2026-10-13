// A stdout the exec tail cut with one very long line is not whole, though what remains is under half of the cap:
// Sandcastle's tail drops whole stdout lines and reports no drop, so `runGates` counts the lines `onLine` was given
// against what came back. No Docker, model or network.
//
//   pnpm test:file test/stdout-cut-by-long-line.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The machine-wide slots and the sandbox's directories derive from these at import.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
writeFileSync(join(xdg, "sandcastle-kit", ".env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n");
const { runGates } = await import("../src/gates.ts");
const { EXEC_TAIL_CHARS } = await import("../src/sandbox.ts");
type Failure = import("../src/gates.ts").Failure;

const project = { name: "fixture", gates: [{ name: "test", command: "run-tests" }] } as Parameters<typeof runGates>[0];
const MIB = 1024 * 1024;

// Sandcastle's stdout tail (`BoundedTail` with a "\n" separator), which a fake of the sandbox's exec has to be: it
// streams each line to `onLine`, keeps whole lines up to the cap and drops the oldest first.
const tailOf = (lines: string[], onLine?: (line: string) => void) => {
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    onLine?.(line);
    const item = line.length > EXEC_TAIL_CHARS ? line.slice(line.length - EXEC_TAIL_CHARS) : line;
    total += item.length + (kept.length > 0 ? 1 : 0);
    kept.push(item);
    while (total > EXEC_TAIL_CHARS && kept.length > 1) total -= kept.shift()!.length + 1;
  }
  return kept.join("\n");
};
const sandbox = (lines: string[]) => ({
  exec: async (_cmd: string, opts?: { onLine?: (line: string) => void }) => ({ exitCode: 1, stdout: tailOf(lines, opts?.onLine), stderr: "" }),
});
const redOf = async (lines: string[]) => {
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "gates.log");
  return (await runGates(project, sandbox(lines), "fixture gates", false, { log })).failure as Failure;
};

const failing = (id: string) => `not ok 1 - ${id}`;
const more = (chars: number) => Array.from({ length: Math.ceil(chars / 100) }, () => "x".repeat(99));

test("a stdout cut by a line of 6 MiB followed by 3 MiB more leaves the failing tests unset", async () => {
  const lines = [failing("first"), "y".repeat(6 * MIB), ...more(3 * MIB)];
  const kept = tailOf(lines);
  assert.ok(kept.length < EXEC_TAIL_CHARS / 2, "the premise: under the old rule's half-the-cap threshold");
  assert.ok(!kept.includes("first"));
  assert.equal((await redOf(lines)).tests, undefined);
});

test("a stdout cut by one line longer than the cap leaves the failing tests unset", async () => {
  const lines = [failing("first"), "y".repeat(EXEC_TAIL_CHARS + 10), failing("last")];
  assert.equal((await redOf(lines)).tests, undefined);
});

test("a stdout the tail kept whole has its failing tests read", async () => {
  assert.deepEqual((await redOf([failing("a"), "y".repeat(MIB), failing("b")])).tests, ["a", "b"]);
});

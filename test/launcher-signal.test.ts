// bin/sandcastle runs the CLI so that a SIGTERM reaches its exit handler even while the process is
// stalled in a synchronous call. Through the tsx binary it did not: tsx runs the script in a child
// and SIGKILLs it when it does not answer the signal within ~60 ms, so a run busy in a git or
// docker call died with no recorded end, no notify, and its sandboxes left working.
// The launcher's own exec line runs a fixture that stalls; no Docker, network or model calls.
//
//   pnpm exec tsx --test test/launcher-signal.test.ts

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const KIT = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sandcastle-launcher-"));

test("a SIGTERM during a 1.5 s stall still runs the exit handler", async () => {
  const fixture = join(dir, "busy.ts");
  const out = join(dir, "out");
  writeFileSync(
    fixture,
    'import { writeFileSync } from "node:fs";\n' +
      "process.on(\"SIGTERM\", () => process.exit(143));\n" +
      'process.on("exit", (c) => writeFileSync(process.env.OUT!, String(c)));\n' +
      'console.log("ready");\n' +
      "const end = Date.now() + 1500; while (Date.now() < end) {}\n" +
      "setTimeout(() => {}, 5000);\n",
  );
  // The launcher's last line, with the fixture in place of the CLI.
  const exec = readFileSync(join(KIT, "bin/sandcastle"), "utf8").trim().split("\n").at(-1)!;
  assert.match(exec, /^exec node --import /, "the launcher runs one node process with tsx's loader");
  const script = exec.replace('"$KIT/src/cli.ts"', JSON.stringify(fixture));
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn("bash", ["-c", `KIT=${JSON.stringify(KIT)}; ${script}`], { env: { ...process.env, OUT: out }, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (d) => String(d).includes("ready") && setTimeout(() => child.kill("SIGTERM"), 200));
    child.on("exit", (c) => resolve(c));
  });
  assert.equal(code, 143);
  assert.ok(existsSync(out), "the exit handler did not run");
  assert.equal(readFileSync(out, "utf8"), "143");
});

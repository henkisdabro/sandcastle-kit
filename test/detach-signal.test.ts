// `startDetached` (src/detach.ts): a run that dies by a signal before it is going - the way
// `exitOnSignal` now ends one, by re-raising SIGINT or SIGTERM - is reported with the code a shell
// would show, 128 + the signal's number, not a bare 128. A plain-JS stand-in, no Docker, no model.
//
//   pnpm test:file test/detach-signal.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startDetached } from "../src/detach.ts";

const dir = mkdtempSync(join(tmpdir(), "sandcastle-detach-signal-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fake = join(dir, "fake-run.mjs");
writeFileSync(fake, `console.log("stopped before it was going"); process.kill(process.pid, process.env.FAKE_SIGNAL);\nsetInterval(() => {}, 1000);\n`);

for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  test(`a run that dies by ${sig} before it is going is reported as exit ${code}`, async () => {
    process.env.FAKE_SIGNAL = sig;
    try {
      const r = await startDetached(dir, [], { entry: [fake], inHerdr: true, timeoutMs: 15_000 });
      assert.equal(r.code, code);
      assert.match(r.lines.join("\n"), new RegExp(`The run ended at once \\(exit ${code}\\)`));
    } finally {
      delete process.env.FAKE_SIGNAL;
    }
  });
}

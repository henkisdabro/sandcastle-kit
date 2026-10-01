// CROSS_REVIEW=1 on a host with no Codex CLI: refused before any probe, with the install command.
// It used to say only "spawn codex ENOENT", after the Claude probes had spent; with preflight
// skipped, every ticket's cross-review failed one by one.
//
//   pnpm exec tsx --test test/cross-review-codex.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// Read at import: the flags, and a PATH with node but no codex. Node alone, linked into a directory
// of its own: in the sandbox image node's directory, /usr/local/bin, holds codex too.
process.env.CROSS_REVIEW = "1";
process.env.SKIP_PREFLIGHT = "1";
const bin = mkdtempSync(join(tmpdir(), "sandcastle-nocodex-"));
symlinkSync(process.execPath, join(bin, "node"));
process.env.PATH = [bin, "/usr/bin", "/bin"].join(":");
const { preflight } = await import("../src/run.ts");
const { OperatorError } = await import("../src/errors.ts");

test("no codex on PATH with CROSS_REVIEW=1 is refused before any probe, even with preflight skipped", async () => {
  await assert.rejects(
    preflight({ root: "/nonexistent" } as Project, "image"),
    (e: Error) => e instanceof OperatorError && /CROSS_REVIEW=1 needs the Codex CLI on this machine: `npm install -g @openai\/codex && codex login`/.test(e.message),
  );
});

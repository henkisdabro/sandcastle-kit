// What preflight prints for a model the CLI does not know: the CLI's reason, not its whole JSON
// reply. A fake `docker` replays the Claude CLI's output for `--model bogus-model`.
//
//   pnpm exec tsx --test test/preflight-reply.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = join(home, "cache");
process.env.XDG_CONFIG_HOME = join(home, "config");
delete process.env.SKIP_PREFLIGHT;
delete process.env.CROSS_REVIEW;
const { preflight } = await import("../src/run.ts");
const { OperatorError } = await import("../src/errors.ts");

const reason = "There's an issue with the selected model (bogus-model). It may not exist or you may not have access to it.";

test("an unknown model's refusal prints the CLI's reason, not its JSON", async () => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-bin-"));
  const out = JSON.stringify({ type: "result", is_error: true, api_error_status: 404, usage: { input_tokens: 0 }, result: reason });
  // As the CLI does: the JSON result on stdout, the tag line on stderr, exit 1 - only for the bogus model.
  writeFileSync(join(bin, "reply.json"), `${out}\n`);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\ncase "$*" in *bogus-model*) cat '${join(bin, "reply.json")}'; echo '[claude-code:unrecognized_model] {"model":"bogus-model"}' >&2; exit 1;; esac\necho '{"is_error":false,"result":"OK"}'\n`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const root = mkdtempSync(join(tmpdir(), "sandcastle-test-project-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/.env"), "CLAUDE_CODE_OAUTH_TOKEN=tok-project\n");
  const project = { root, tracker: { kind: "files", held: "ready-for-human", triage: "needs-triage" } } as Parameters<typeof preflight>[0];

  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    await assert.rejects(preflight(project, "sandcastle-test", [{ model: "bogus-model", from: "#43 label" }]), (error: Error) => {
      assert.ok(error instanceof OperatorError);
      assert.ok(error.message.includes(`bogus-model (#43 label): ${reason}`), error.message);
      assert.ok(!error.message.includes("api_error_status"), error.message);
      assert.ok(!error.message.includes("[claude-code:"), error.message);
      return true;
    });
  } finally {
    process.env.PATH = path;
  }
});

// Preflight's model calls (src/run.ts) overlap instead of queueing, and a failure message lists
// models in a fixed order. A fake `docker` on PATH answers, so no Docker or model is needed.
//
//   pnpm exec tsx --test test/preflight-parallel.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-preflight-"));
mkdirSync(join(tmp, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(tmp, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=x\nGH_TOKEN=github_pat_x\n");
// POSIX sh with an integer sleep, so it runs the same under GNU and BSD userlands. FAKE_MODE picks
// the answer per model: ok (both slow, fine), failb (model-b slow, bad), fastfail (model-a fails
// at once, model-b fails after the sleep), slowfail (the reverse).
mkdirSync(join(tmp, "bin"));
writeFileSync(
  join(tmp, "bin/docker"),
  `#!/bin/sh
model=
while [ $# -gt 0 ]; do
  if [ "$1" = "--model" ]; then model=$2; fi
  shift
done
bad='{"is_error":true,"result":"bad"}'
case "$FAKE_MODE:$model" in
  fastfail:model-a) echo "$bad" ;;
  fastfail:model-b) sleep 2; echo "$bad" ;;
  slowfail:model-a) sleep 2; echo "$bad" ;;
  slowfail:model-b) echo "$bad" ;;
  failb:model-b) sleep 2; echo "$bad" ;;
  *) sleep 2; echo '{"is_error":false,"result":"OK"}' ;;
esac
`,
);
chmodSync(join(tmp, "bin/docker"), 0o755);

process.env.XDG_CONFIG_HOME = join(tmp, "config");
process.env.PATH = `${join(tmp, "bin")}${delimiter}${process.env.PATH}`;
process.env.IMPL_MODEL = "model-a";
process.env.REVIEW_MODEL = "model-b";
delete process.env.SKIP_PREFLIGHT;
delete process.env.CROSS_REVIEW;
const { configureModels } = await import("../src/agents.ts");
const { preflight } = await import("../src/run.ts");
configureModels();
const project = { root: tmp, tracker: { kind: "github", held: "ready-for-human", triage: "needs-triage" } } as unknown as Parameters<typeof preflight>[0];

test("both models are asked at once: two 2 s replies take well under 4 s", async () => {
  process.env.FAKE_MODE = "ok";
  const since = Date.now();
  await preflight(project, "image");
  assert.ok(Date.now() - since < 3500, `took ${Date.now() - since} ms`);
});

test("a failing model rejects with a message naming it and not the model that passed", async () => {
  process.env.FAKE_MODE = "failb";
  await assert.rejects(preflight(project, "image"), (e: Error) => {
    assert.match(e.message, /Preflight failed/);
    assert.match(e.message, /model-b/);
    assert.doesNotMatch(e.message, /model-a/);
    return true;
  });
});

test("failures are listed in model order, not the order they finish", async () => {
  process.env.FAKE_MODE = "fastfail";
  await assert.rejects(preflight(project, "image"), (e: Error) => {
    // Both reply "bad", so the shared-reply line names every model in order.
    assert.match(e.message, /model-a, model-b: bad/);
    return true;
  });
});

test("the order holds when the first model is the last to fail", async () => {
  process.env.FAKE_MODE = "slowfail";
  await assert.rejects(preflight(project, "image"), /model-a, model-b: bad/);
});

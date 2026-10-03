// A ticket's `model:` and `effort:` labels pick its implementer (src/agents.ts), the GitHub adapter
// hands the labels over (src/tracker.ts) and preflight names the ticket behind an override model
// (src/run.ts). Fake `gh` and `docker` (POSIX sh) first on PATH: no Docker, model or network.
//
//   pnpm exec tsx --test test/ticket-model.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-ticket-model-"));
mkdirSync(join(tmp, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(tmp, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=x\nGH_TOKEN=github_pat_x\n");
mkdirSync(join(tmp, "bin"));
const dockerLog = join(tmp, "docker.log");
// Logs each model it is asked about; claude-nope is the one that fails.
writeFileSync(
  join(tmp, "bin/docker"),
  `#!/bin/sh
model=
while [ $# -gt 0 ]; do
  if [ "$1" = "--model" ]; then model=$2; printf '%s\\n' "$2" >> "${dockerLog}"; fi
  shift
done
case "$model" in
  claude-nope) echo '{"is_error":true,"result":"model not found"}' ;;
  *) echo '{"is_error":false,"result":"OK"}' ;;
esac
`,
);
const issue = `{"number":12,"title":"t","body":"","updatedAt":"2026-10-01T00:00:00Z","labels":[{"name":"ready-for-agent"},{"name":"model:claude-opus-5-5"}]}`;
writeFileSync(
  join(tmp, "bin/gh"),
  `#!/bin/sh
case "$1 $2" in
  "issue list") printf '%s\\n' '[${issue}]' ;;
  "issue view") printf '%s\\n' '${issue.slice(0, -1)},"state":"OPEN","comments":[]}' ;;
esac
`,
);
chmodSync(join(tmp, "bin/docker"), 0o755);
chmodSync(join(tmp, "bin/gh"), 0o755);

process.env.XDG_CONFIG_HOME = join(tmp, "config");
process.env.XDG_CACHE_HOME = join(tmp, "cache");
process.env.PATH = `${join(tmp, "bin")}${delimiter}${process.env.PATH}`;
process.env.IMPL_MODEL = "model-a";
process.env.IMPL_EFFORT = "medium";
process.env.REVIEW_MODEL = "model-b";
delete process.env.SKIP_PREFLIGHT;
delete process.env.CROSS_REVIEW;
const { configureModels, implAgent, ticketOverride } = await import("../src/agents.ts");
const { OperatorError } = await import("../src/errors.ts");
const { preflight } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
configureModels();
const project = { root: tmp, label: "ready-for-agent", tracker: fakeTracker() } as any;

test("model: and effort: labels make the override; other labels are ignored", () => {
  assert.deepEqual(ticketOverride("#12", ["bug", "model:claude-opus-5-5", "effort:xhigh"]), { model: "claude-opus-5-5", effort: "xhigh" });
  assert.deepEqual(ticketOverride("#12", ["bug"]), {});
  assert.deepEqual(ticketOverride("#12", ["Model:whatever", "effort-high"]), {});
  assert.deepEqual(ticketOverride("#12", ["model:a", "model:a"]), { model: "a" });
});

test("a bad label is refused with the ticket and the label in the message", () => {
  const refused = (labels: string[], message: string) =>
    assert.throws(
      () => ticketOverride("#12", labels),
      (e: unknown) => {
        assert.ok(e instanceof OperatorError);
        assert.equal(e.message, message);
        assert.match(e.message, /#12/);
        return true;
      },
    );
  refused(
    ["effort:huge"],
    `NOT STARTED: #12 has the label "effort:huge" - expected effort:low, effort:medium, effort:high, effort:xhigh or effort:max. Fix or remove the label.`,
  );
  const noModel = (label: string) =>
    `NOT STARTED: #12 has the label "${label}" - it names no usable model. Use a model id such as model:claude-opus-5-5, or remove the label.`;
  refused(["model:"], noModel("model:"));
  refused(["model:opus; rm -rf /"], noModel("model:opus; rm -rf /"));
  refused(["model:a", "model:b"], `NOT STARTED: #12 has the labels "model:a" and "model:b" - keep one.`);
  refused(["effort:low", "effort:high"], `NOT STARTED: #12 has the labels "effort:low" and "effort:high" - keep one.`);
});

test("implAgent takes the override, and with none is the configured agent", () => {
  const command = (a: ReturnType<typeof implAgent>) => a.buildPrintCommand({ prompt: "x", dangerouslySkipPermissions: true }).command;
  const own = command(implAgent({ model: "claude-opus-5-5", effort: "xhigh" }));
  assert.match(own, /--model '?claude-opus-5-5'?/);
  assert.match(own, /--effort '?xhigh'?/);
  const plain = command(implAgent());
  assert.match(plain, /--model '?model-a'?/);
  assert.match(plain, /--effort '?medium'?/);
});

test("the GitHub adapter returns each ticket's labels", () => {
  const t = makeTracker(project);
  assert.ok(t.queued()[0]!.labels!.includes("model:claude-opus-5-5"));
  assert.ok(t.get("12").labels!.includes("model:claude-opus-5-5"));
});

test("preflight names the ticket behind an override model that fails", async () => {
  await assert.rejects(preflight(project, "img", [{ model: "claude-nope", from: "label model:claude-nope on #12" }]), (e: Error) => {
    assert.ok(e instanceof OperatorError);
    assert.ok(e.message.includes("claude-nope (label model:claude-nope on #12)"), e.message);
    return true;
  });
});

test("with no extra, preflight probes only the two configured models", async () => {
  writeFileSync(dockerLog, "");
  await quietly(() => preflight(project, "img"));
  assert.deepEqual(readFileSync(dockerLog, "utf8").split("\n").filter(Boolean).sort(), ["model-a", "model-b"]);
});

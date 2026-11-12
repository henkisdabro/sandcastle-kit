// Permanent refusals can contain transient words in a repository name or request URL.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { GH_READ_RETRY, makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-bin-"));
const counter = join(bin, "calls");
const answer = join(bin, "stderr");
writeFileSync(join(bin, "gh"), `#!/bin/sh\necho x >> '${counter}'\ncat '${answer}' >&2\nexit 1\n`);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
const project = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
const tracker = makeTracker(project);

for (const stderr of [
  "HTTP 404: Not Found (https://api.github.com/repos/acme/timeout-lib/issues/9)",
  "HTTP 403: Forbidden (https://api.github.com/repos/acme/timeout-lib/issues/9)",
  "HTTP 401: Bad credentials (https://timeout.example/api/graphql)",
  "GraphQL: Could not resolve to a Repository with the name 'acme/timeout-lib'.",
  "authentication failed for https://timeout.example/api/graphql",
  "none of the git remotes point to a known GitHub host (timeout.example)",
]) {
  test(`a permanent refusal is not retried despite transient words: ${stderr}`, async () => {
    writeFileSync(counter, "");
    writeFileSync(answer, `${stderr}\n`);
    const said: string[] = [];
    GH_READ_RETRY.waitsMs = [10, 10];
    GH_READ_RETRY.say = (line) => said.push(line);
    await assert.rejects(tracker.getAsync!("9", 5000), (e: Error) => e.message.startsWith(`gh issue view failed: ${stderr}`));
    assert.equal(readFileSync(counter, "utf8"), "x\n");
    assert.deepEqual(said, []);
  });
}

test("a 503 stays transient when its request URL names authentication", async () => {
  writeFileSync(counter, "");
  writeFileSync(answer, "HTTP 503: Service Unavailable (https://api.github.com/repos/acme/authentication/issues/9)\n");
  const said: string[] = [];
  GH_READ_RETRY.waitsMs = [10, 10];
  GH_READ_RETRY.say = (line) => said.push(line);
  await assert.rejects(tracker.getAsync!("9", 5000), /HTTP 503: Service Unavailable/);
  assert.equal(readFileSync(counter, "utf8"), "x\nx\nx\n");
  assert.equal(said.length, 1);
});

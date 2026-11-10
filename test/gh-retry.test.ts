// A prompt's ticket reads (`gh issue view N [--comments]`, expanded in the sandbox) retry a GitHub 5xx or
// timeout and fail at once on a 4xx, and a review whose prompt cannot be expanded does not fall back to
// the implementer's model. A fake `gh` and `sleep` on PATH; no network, Docker or model calls.
//
//   pnpm test:file test/gh-retry.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { KIT } = await import("../src/sandbox.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { reviewWithFallback } = await import("../src/agents.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

// A `gh` that answers each call with the next of `answers` (the last one repeats): "<exit> <stdout>|<stderr>".
// Every call, and every `sleep`, is logged in `calls`.
const fakes = (answers: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-retry-"));
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  writeFileSync(join(dir, "answers"), answers.join("\n") + "\n");
  const script = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  script(
    "gh",
    `echo "gh $*" >> '${calls}'
n=$(grep -c '^gh ' '${calls}')
total=$(wc -l < '${dir}/answers')
[ "$n" -le "$total" ] || n=$total
line=$(sed -n "\${n}p" '${dir}/answers')
code=\${line%% *}; rest=\${line#* }
printf '%s' "\${rest%%|*}"
printf '%s\\n' "\${rest#*|}" >&2
exit "$code"`,
  );
  script("sleep", `echo "sleep $*" >> '${calls}'`);
  return { dir, log: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) };
};

const run = (f: ReturnType<typeof fakes>, command: string) =>
  spawnSync("sh", ["-c", command], { encoding: "utf8", env: { ...process.env, PATH: `${f.dir}${delimiter}${process.env.PATH}` } });

const viewCommand = (words: string, n: string) => words.match(/!`([^`]+)`/)![1]!.replace("{{ISSUE_NUMBER}}", n).replace("/etc/claude-code", join(KIT, "container"));

test("a ticket read that gets a 502 twice and then succeeds is read on the third try, after two waits", () => {
  const f = fakes(["1 |HTTP 502: Bad Gateway (https://api.example.com/graphql)", "1 |HTTP 502: Bad Gateway (https://api.example.com/graphql)", "0 title: the ticket|"]);
  const r = run(f, `sh '${join(KIT, "container/gh-retry.sh")}' issue view 7`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "title: the ticket");
  assert.equal(r.stderr, "");
  assert.deepEqual(f.log(), ["gh issue view 7", "sleep 15", "gh issue view 7", "sleep 45", "gh issue view 7"]);
});

test("a failed try's error body never reaches the output: only the try that succeeded is printed", () => {
  const f = fakes(['1 {"message":"Server Error"}|HTTP 502: Bad Gateway (https://api.example.com/repos/o/r/issues/7/comments)', "0 [1,2]|"]);
  const r = run(f, `sh '${join(KIT, "container/gh-retry.sh")}' api repos/o/r/issues/7/comments`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "[1,2]");
});

test("a wait that would end past GH_RETRY_UNTIL is not taken, and the last error is given at once", () => {
  const f = fakes(["1 |HTTP 503: Service Unavailable (https://api.example.com/graphql)"]);
  const r = run(f, `GH_RETRY_UNTIL=$(($(date +%s) + 20)) sh '${join(KIT, "container/gh-retry.sh")}' issue view 7`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HTTP 503/);
  assert.deepEqual(f.log(), ["gh issue view 7", "sleep 15", "gh issue view 7"]);
});

test("a ticket read that gets a 404 fails at once, with one call, no wait and gh's own words", () => {
  const f = fakes(["1 |GraphQL: Could not resolve to an issue or pull request with the number of 999. (repository.issue)"]);
  const r = run(f, `sh '${join(KIT, "container/gh-retry.sh")}' issue view 999`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not resolve to an issue/);
  assert.deepEqual(f.log(), ["gh issue view 999"]);
});

test("a ticket read that times out every time gives up after three tries with the last error", () => {
  const f = fakes(["1 |Post \"https://api.example.com/graphql\": context deadline exceeded"]);
  const r = run(f, `sh '${join(KIT, "container/gh-retry.sh")}' issue view 3 --comments`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /deadline exceeded/);
  assert.equal(f.log().filter((l) => l.startsWith("gh ")).length, 3);
});

test("the prompt's ticket read goes through the retry, and a 404 in it still fails at once", () => {
  const project = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
  const { words } = makeTracker(project);
  const f = fakes(["1 |HTTP 503: Service Unavailable", "0 body|"]);
  const r = run(f, viewCommand(words.TICKET_VIEW, "5"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.log(), ["gh issue view 5", "sleep 15", "gh issue view 5"]);
  const g = fakes(["1 |HTTP 404: Not Found"]);
  assert.equal(run(g, viewCommand(words.TICKET_VIEW, "5")).status, 1);
  assert.deepEqual(g.log(), ["gh issue view 5"]);
});

// The comments view reads through the retry too (container/comments-view.sh); its successful output is test/comments-view.test.ts's.
test("the prompt's comments read goes through the retry, and a 404 in it still fails at once", () => {
  const project = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
  const { words } = makeTracker(project);
  const ticket = "gh api repos/{owner}/{repo}/issues/5 --jq .user.login // \"\"";
  const f = fakes(["1 |HTTP 503: Service Unavailable", "1 |HTTP 404: Not Found"]);
  const r = run(f, viewCommand(words.COMMENTS_VIEW, "5"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HTTP 404/);
  assert.deepEqual(f.log(), [ticket, "sleep 15", ticket]);
});

const expansionError = () => Object.assign(new Error("Command `sh /etc/claude-code/gh-retry.sh issue view 5` exited with code 1: HTTP 502: Bad Gateway"), { name: "(FiberFailure) PromptError" });

test("a review whose prompt cannot be expanded is not run again on the implementer's model", async () => {
  const models: string[] = [];
  await assert.rejects(
    reviewWithFallback("#5", async (_agent, model) => {
      models.push(model);
      throw expansionError();
    }),
    (e: Error) => /HTTP 502/.test(e.message),
  );
  assert.equal(models.length, 1);
});

test("a review that fails any other way is still run again on the implementer's model", async () => {
  const models: string[] = [];
  const { result, lines } = await quietly(() =>
    reviewWithFallback("#5", async (_agent, model) => {
      models.push(model);
      if (models.length === 1) throw new Error("claude-code exited with code 1");
      return "reviewed";
    }),
  );
  assert.equal(result, "reviewed");
  assert.match(lines.join("\n"), /Reviewing with/);
  assert.equal(models.length, 2);
  assert.notEqual(models[0], models[1]);
});

test("the patched Sandcastle gives a prompt's shell expression room for every retry wait", () => {
  const dist = readFileSync(join(KIT, "node_modules", "@ai-hero", "sandcastle", "dist", "index.js"), "utf8");
  const cap = dist.match(/PROMPT_EXPANSION_TIMEOUT_MS = (\d+(?:e\d+)?);/);
  assert.ok(cap, "Sandcastle's prompt expansion limit was not found in its dist; read it again and update the test");
  const waits = readFileSync(join(KIT, "container", "gh-retry.sh"), "utf8").match(/^RETRY_WAITS="([\d ]+)"/m)![1]!;
  const waited = waits.split(" ").reduce((sum, s) => sum + Number(s) * 1000, 0);
  // Half the limit left for the three gh calls themselves; unpatched (30 s) this fails, as the waits alone are 60 s.
  assert.ok(Number(cap[1]) >= 2 * waited, `the limit is ${cap[1]} ms for ${waited} ms of waits: the pnpm patch for #782 is not applied (run pnpm install, and re-make the patch on an upgrade)`);
});

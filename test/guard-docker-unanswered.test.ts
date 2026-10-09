// The stop before a sandbox's close (src/guard.ts: `checkBeforeClose`, src/sandbox.ts: `stopSandboxContainer`) when
// Docker gives no answer: a `docker ps` that fails or lists something unreadable, a `docker ps` or `docker stop`
// that hangs. None of those is "nothing is running", so the check fails as a refused stop does - the container is
// removed if it can be, the close is not called, the error names Docker's - and no `.git` check runs behind a
// container that may still be alive. A fake `docker` on PATH, and the clock mocked for the time limits (30 s for `ps`
// and `inspect`, the stop's 3 s grace plus 30 s): no Docker, model or network. A missing `docker` program is not
// such a failure, and the check goes ahead.
//
//   pnpm test:file test/guard-docker-unanswered.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, beforeEach, mock, test } from "node:test";
import type { Project } from "../src/config.ts";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-docker-unanswered-")));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
process.env.XDG_CONFIG_HOME = join(TMP, "config");
mkdirSync(join(TMP, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(TMP, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\n");
after(() => rmSync(TMP, { recursive: true, force: true }));

// One container, `sandcastle-made-up`, running and mounting WORKTREE. A file of the same name as a mode makes that
// call misbehave: `ps-fails` (`ps -q` exits 1 with a message), `ps-unreadable` (it prints a line with spaces),
// `ps-hangs` and `stop-hangs` (the call never ends, as a hung daemon's). `rm -f` and `ps -aq` always work.
const DOCKER = join(TMP, "docker");
const WORKTREE = join(TMP, "worktrees", "agent-issue-7");
mkdirSync(join(DOCKER, "bin"), { recursive: true });
mkdirSync(WORKTREE, { recursive: true });
writeFileSync(
  join(DOCKER, "bin", "docker"),
  `#!/bin/sh
echo "$*" >> "$FAKE_DOCKER/calls"
case "$1" in
  ps)
    case "$2" in
      -aq) echo sandcastle-made-up ;;
      -q)
        if [ -e "$FAKE_DOCKER/ps-fails" ]; then echo "Cannot connect to the Docker daemon: is it restarting?" >&2; exit 1; fi
        if [ -e "$FAKE_DOCKER/ps-unreadable" ]; then echo "not an id at all"; exit 0; fi
        if [ -e "$FAKE_DOCKER/ps-hangs" ]; then exec sleep 600; fi
        [ -e "$FAKE_DOCKER/stopped" ] || echo sandcastle-made-up ;;
    esac ;;
  inspect) echo "$FAKE_DOCKER_WORKTREE" ;;
  stop)
    if [ -e "$FAKE_DOCKER/stop-hangs" ]; then exec sleep 600; fi
    : > "$FAKE_DOCKER/stopped" ;;
esac
exit 0
`,
);
chmodSync(join(DOCKER, "bin", "docker"), 0o755);
process.env.PATH = [join(DOCKER, "bin"), dirname(process.execPath), process.env.PATH].join(delimiter);
process.env.FAKE_DOCKER = DOCKER;
process.env.FAKE_DOCKER_WORKTREE = WORKTREE;

const { checkBeforeClose, GuardStop } = await import("../src/guard.ts");

const calls = () => readFileSync(join(DOCKER, "calls"), "utf8").split("\n").filter(Boolean);
const project = { root: TMP } as unknown as Project;

beforeEach(() => {
  mock.timers.reset();
  for (const f of ["calls", "stopped", "ps-fails", "ps-unreadable", "ps-hangs", "stop-hangs"]) rmSync(join(DOCKER, f), { force: true });
  writeFileSync(join(DOCKER, "calls"), "");
});

/** What the pipeline sees of a close: the check's rejection, whether the `.git` check ran. */
const attempt = async () => {
  let checked = false;
  const error = await checkBeforeClose(project, WORKTREE, "after #7", () => void (checked = true)).then(
    () => undefined,
    (e: unknown) => e,
  );
  return { error: error as Error | undefined, checked };
};

/** Waits, on the real clock, until the fake `docker` has been asked `call`. */
const until = async (call: string) => {
  for (let i = 0; i < 1000 && !calls().some((c) => c.startsWith(call)); i++) await new Promise((r) => setImmediate(r));
  assert.ok(calls().some((c) => c.startsWith(call)), calls().join("\n"));
};

/** The stop failed as it should: the run stops naming Docker's words, the container is removed, the .git check never ran. */
const stoppedNaming = (r: { error?: Error; checked: boolean }, said: RegExp) => {
  assert.ok(r.error instanceof GuardStop, String(r.error));
  assert.match(r.error.message, /^STOPPED after #7: /);
  assert.match(r.error.message, said);
  assert.equal(r.checked, false, "the .git check ran with the container possibly alive");
  assert.ok(calls().includes("rm -f sandcastle-made-up"), calls().join("\n"));
};

test("a docker ps that fails stops the run naming Docker's error, removes the container and checks nothing", async () => {
  writeFileSync(join(DOCKER, "ps-fails"), "");
  const r = await attempt();
  stoppedNaming(r, /Docker did not say whether the container of agent-issue-7 is stopped \(docker ps: Cannot connect to the Docker daemon: is it restarting\?\)/);
  assert.ok(!calls().some((c) => c.startsWith("stop ")), "stopped nothing");
});

test("a docker ps that lists something that is not a container id stops the run the same way", async () => {
  writeFileSync(join(DOCKER, "ps-unreadable"), "");
  stoppedNaming(await attempt(), /docker ps: unreadable output \("not an id at all"\)/);
});

test("a docker ps that hangs stops the run after 30 seconds", async () => {
  writeFileSync(join(DOCKER, "ps-hangs"), "");
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = attempt();
  await until("ps -q");
  mock.timers.tick(29_999);
  await new Promise((r) => setImmediate(r));
  assert.ok(!calls().includes("rm -f sandcastle-made-up"), "gave up before 30 s");
  mock.timers.tick(1);
  stoppedNaming(await pending, /docker ps: docker ps gave no answer in 30 s/);
});

test("a docker stop that hangs stops the run after the grace plus 30 seconds, and the container is removed", async () => {
  writeFileSync(join(DOCKER, "stop-hangs"), "");
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = attempt();
  await until("stop -t 3 sandcastle-made-up");
  mock.timers.tick(32_999);
  await new Promise((r) => setImmediate(r));
  assert.ok(!calls().includes("rm -f sandcastle-made-up"), "gave up before the grace plus 30 s");
  mock.timers.tick(1);
  stoppedNaming(await pending, /the container of agent-issue-7 could not be stopped \(docker stop gave no answer in 33 s\)/);
});

test("with no docker program on PATH the .git check still runs: the kit started no container through it", async () => {
  const path = process.env.PATH;
  process.env.PATH = join(TMP, "no-docker-here");
  try {
    const r = await attempt();
    assert.equal(r.checked, true, `the .git check did not run: ${r.error}`);
    assert.doesNotMatch(String(r.error ?? ""), /Docker/);
  } finally {
    process.env.PATH = path;
  }
});

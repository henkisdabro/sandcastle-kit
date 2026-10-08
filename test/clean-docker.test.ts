// What `sandcastle clean` does about Docker leftovers, against a fake `docker` on PATH (no Docker,
// network or model calls): exited sandbox containers of this project, or whose worktree is gone, are
// removed and another project's live one is kept; the kit's dangling images go and an image in use
// stays; the build argv labels the kit's images; doctor's build-cache line reads `docker system df`.
// The fake is a shell script run by `sh`, so it works the same with macOS's bash 3.2 and BSD tools.
//
//   pnpm test:file test/clean-docker.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { buildCacheLine, buildCacheNote } from "../src/doctor.ts";
import { buildArgs, KIT_LABEL, removeDanglingImages, removeExitedSandboxes } from "../src/sandbox.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-cleandocker-")));

// A docker that answers from files: `containers` (id per line), `mounts/<id>`, `images` (ids), and
// `busy` (images `rm` refuses); everything it is asked to remove is appended to `removed`, and each
// call's arguments to `calls`, so a test holds the filters the real daemon would apply.
const fakeDocker = (state: string) => {
  const bin = join(state, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "docker");
  writeFileSync(
    script,
    `#!/bin/sh
state="${state}"
echo "$*" >> "$state/calls"
case "$1 $2" in
  "ps -aq") cat "$state/containers" ;;
  "image ls") cat "$state/images" ;;
  "image rm") grep -qx "$3" "$state/busy" && exit 1; echo "$3" >> "$state/removed" ;;
  "rm "*) echo "$2" >> "$state/removed" ;;
  inspect*) cat "$state/mounts/$2" ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(script, 0o755);
  writeFileSync(join(state, "removed"), "");
  writeFileSync(join(state, "busy"), "");
  writeFileSync(join(state, "calls"), "");
  mkdirSync(join(state, "mounts"), { recursive: true });
  const lines = (file: string) => readFileSync(join(state, file), "utf8").split("\n").filter(Boolean);
  return { bin, removed: () => lines("removed"), calls: () => lines("calls") };
};

const withPath = <T>(bin: string, fn: () => T): T => {
  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before}`;
  try {
    return fn();
  } finally {
    process.env.PATH = before;
  }
};

test("exited containers of this project, or with a worktree that no longer exists, are removed", () => {
  const state = tmp();
  const root = tmp();
  const other = tmp(); // another project, still on disk
  mkdirSync(join(other, ".sandcastle/worktrees/agent-issue-9"), { recursive: true });
  const docker = fakeDocker(state);
  writeFileSync(join(state, "containers"), "mine\ngone\nlive\nplain\n");
  const mount = (id: string, ...sources: string[]) => writeFileSync(join(state, "mounts", id), sources.map((s) => `${s}\n`).join(""));
  mount("mine", join(root, ".sandcastle/worktrees/agent-issue-1"), join(root, ".git"));
  mount("gone", join(tmp(), "deleted/.sandcastle/worktrees/agent-issue-2/"));
  mount("live", join(other, ".sandcastle/worktrees/agent-issue-9"));
  mount("plain", "/etc/claude-code"); // no agent worktree: not ours to say

  const removed = withPath(docker.bin, () => removeExitedSandboxes({ root, name: "demo" } as Project));
  assert.deepEqual(removed.sort(), ["gone", "mine"]);
  assert.deepEqual(docker.removed().sort(), ["gone", "mine"]);
  // Running containers are reapOrphans' business, and only the sandcastle library's are listed.
  const ps = docker.calls().find((c) => c.startsWith("ps "));
  assert.match(ps ?? "", /--filter status=exited/);
  assert.match(ps ?? "", /--filter name=\^sandcastle-/);
});

test("a missing worktree directory below a mount with a subpath still counts as gone", () => {
  const state = tmp();
  const root = tmp();
  const docker = fakeDocker(state);
  writeFileSync(join(state, "containers"), "a\n");
  writeFileSync(join(state, "mounts/a"), `${join(tmp(), "x/.sandcastle/worktrees/agent-issue-3/sub")}\n`);
  assert.deepEqual(withPath(docker.bin, () => removeExitedSandboxes({ root, name: "demo" } as Project)), ["a"]);
});

test("dangling kit images are removed, one in use is kept, and the query is limited to the kit's label", () => {
  const state = tmp();
  const docker = fakeDocker(state);
  writeFileSync(join(state, "images"), "img1\nimg2\nimg1\n");
  writeFileSync(join(state, "busy"), "img2\n");
  const removed = withPath(docker.bin, () => removeDanglingImages());
  assert.deepEqual(removed, ["img1"]);
  assert.deepEqual(docker.removed(), ["img1"]);
  const ls = docker.calls().find((c) => c.startsWith("image ls "));
  assert.match(ls ?? "", /--filter dangling=true/);
  assert.match(ls ?? "", /--filter label=sandcastle-kit=1/, "another project's dangling image is never listed");
});

test("without Docker, there is nothing to remove and no error", () => {
  const root = tmp();
  const before = process.env.PATH;
  process.env.PATH = join(root, "empty");
  try {
    assert.deepEqual(removeExitedSandboxes({ root, name: "demo" } as Project), []);
    assert.deepEqual(removeDanglingImages(), []);
  } finally {
    process.env.PATH = before;
  }
});

test("every image build carries the kit's label", () => {
  assert.equal(KIT_LABEL, "sandcastle-kit=1");
  const argv = buildArgs("t:1", { A: "1" }, false);
  assert.equal(argv[argv.indexOf("--label") + 1], KIT_LABEL);
  assert.equal(argv.at(-1), "-", "the Dockerfile still comes on stdin");
});

test("doctor's build-cache line gives the size, what is reclaimable and the prune hint", () => {
  const df = [
    '{"Type":"Images","Size":"12GB","Reclaimable":"3GB (25%)"}',
    '{"Type":"Build Cache","Size":"34GB","Reclaimable":"26GB"}',
  ].join("\n");
  assert.equal(buildCacheNote(df), "Docker build cache is 34GB (26GB reclaimable) - `docker builder prune` frees it");
});

test("the build-cache line is silent for output it does not understand", () => {
  assert.equal(buildCacheNote(""), undefined);
  assert.equal(buildCacheNote("TYPE SIZE\nBuild Cache 34GB"), undefined);
  assert.equal(buildCacheNote('{"Type":"Images","Size":"1GB"}'), undefined);
});

test("doctor's build-cache line gives up on a slow docker instead of holding doctor", () => {
  const bin = tmp();
  // exec: the timeout kills docker itself, as with the real CLI, not a shell left holding the pipe.
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexec sleep 30\n");
  chmodSync(join(bin, "docker"), 0o755);
  const started = Date.now();
  assert.equal(withPath(bin, () => buildCacheLine(300)), undefined);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

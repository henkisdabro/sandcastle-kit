// What a sandbox container drops of Linux's capabilities: `NET_RAW` only. Not `ALL`: Sandcastle's docker provider runs
// `mkdir -p "$dir" && chown <uid> "$dir"` as root (`docker exec --user 0:0`) for the parent directory of every file
// mount under the sandbox home - the Codex auth file with CROSS_REVIEW=1, or a project's own file mount - and with every
// capability dropped root has no CHOWN or DAC_OVERRIDE, so every sandbox open failed there. This reads the options the
// kit hands Sandcastle and the provider's own root exec in the installed dist. No Docker, model or network.
//
//   pnpm test:file test/sandbox-cap-drop.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
writeFileSync(join(xdg, "sandcastle-kit", ".env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n");
const { dockerOptions } = await import("../src/sandbox.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const project = { root: mkdtempSync(join(tmpdir(), "sandcastle-cap-drop-")), tracker: fakeTracker(), mounts: [] } as unknown as Project;

test("a sandbox drops NET_RAW, and keeps what Sandcastle's own root exec needs (so not ALL)", () => {
  assert.deepEqual(dockerOptions(project, "img").capDrop, ["NET_RAW"]);
});

test("Sandcastle's docker provider still chowns a file mount's parent directory as root: the reason ALL is not dropped", () => {
  const dist = dirname(fileURLToPath(import.meta.resolve("@ai-hero/sandcastle")));
  const all = readdirSync(dist).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dist, f), "utf8")).join("\n");
  assert.match(
    all,
    /"--user",\s*"0:0",[\s\S]{0,120}`mkdir -p "\$1" && chown "\$2" "\$1"`/,
    "Sandcastle no longer runs the root mkdir/chown for a file mount's parent: dropping ALL may work now - " +
      "check with `sandcastle gates` under CROSS_REVIEW=1, then update capDrop in dockerOptions (src/sandbox.ts) and this test",
  );
});

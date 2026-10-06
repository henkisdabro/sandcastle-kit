// Gates run without the kit's credentials, and a credential value that turns up in their output
// anyway is cut out. A gate that printed its environment put GH_TOKEN and the Claude token in the
// gate log, the terminal and the repair agent's prompt. A fake sandbox that runs the command for
// real; made-up token values; no Docker or network.
//
//   node --test test/gate-secrets.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { execGate, hideFromGates } from "../src/worktree-lock.ts";

const GH = "github_pat_FAKE0000000000000000000000";
const OAUTH = "sk-ant-oat01-FAKE000000000000000000";
// What a container would run, with the credentials in its environment as the sandbox has them.
const box = {
  exec: async (cmd: string, options?: { onLine?: (line: string) => void }) => {
    const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: GH, CLAUDE_CODE_OAUTH_TOKEN: OAUTH, PROJECT_SECRET: "kept-for-the-tests" },
    });
    for (const line of r.stdout.split("\n").filter(Boolean)) options?.onLine?.(line);
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  },
};

test("a gate does not see the kit's credentials, and keeps the project's own variables", async () => {
  const r = await execGate(box, 'printf "gh=%s oauth=%s project=%s\\n" "${GH_TOKEN:-unset}" "${CLAUDE_CODE_OAUTH_TOKEN:-unset}" "$PROJECT_SECRET"');
  assert.equal(r.stdout.trim(), "gh=unset oauth=unset project=kept-for-the-tests");
});

test("a credential value in gate output is redacted in the result and in each streamed line", async () => {
  hideFromGates([GH, OAUTH, undefined, "short"]);
  const lines: string[] = [];
  // Echoed from a file, as a test that read a leaked .env would: the environment no longer has it.
  const r = await execGate(box, `echo "token ${GH} and ${OAUTH}"; echo "short stays"; exit 1`, { onLine: (l) => lines.push(l) });
  assert.equal(r.exitCode, 1);
  assert.ok(!r.stdout.includes(GH) && !r.stdout.includes(OAUTH), r.stdout);
  assert.match(r.stdout, /token <redacted> and <redacted>/);
  assert.match(r.stdout, /short stays/);
  assert.ok(!lines.join("\n").includes(GH), lines.join("\n"));
});

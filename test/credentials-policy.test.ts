// The run-time token rules of credentials(): what reaches an unattended sandbox. Each rule is
// checked through credentials() itself, not through the helper it calls, so a rule dropped from
// credentials() turns a test red. Temp config and project dirs, no Docker, no network.
//
//   pnpm test:file test/credentials-policy.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
const { credentials } = await import("../src/sandbox.ts");
const { OperatorError } = await import("../src/errors.ts");
const { redact } = await import("../src/worktree-lock.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const CLAUDE = "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-policy-fake\n";
const priorBroad = process.env.SANDCASTLE_ALLOW_BROAD_TOKEN;
afterEach(() => {
  if (priorBroad === undefined) delete process.env.SANDCASTLE_ALLOW_BROAD_TOKEN;
  else process.env.SANDCASTLE_ALLOW_BROAD_TOKEN = priorBroad;
});

/** A project whose two credentials files hold `user` and `local` (the project's .sandcastle/.env). */
const setup = (user: string, local?: string): Project => {
  writeFileSync(join(xdg, "sandcastle-kit", ".env"), user);
  const root = mkdtempSync(join(tmpdir(), "sandcastle-policy-"));
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  if (local !== undefined) writeFileSync(join(root, ".sandcastle/.env"), local);
  return { root, tracker: fakeTracker() } as Project;
};

test("a classic GH_TOKEN is refused with a message naming fine-grained tokens", () => {
  delete process.env.SANDCASTLE_ALLOW_BROAD_TOKEN;
  const project = setup(`${CLAUDE}GH_TOKEN=ghp_classicfaketoken0000000000\n`);
  assert.throws(
    () => credentials(project),
    (e: unknown) => e instanceof OperatorError && /not a fine-grained token/.test(e.message),
  );
});

test("a classic GH_TOKEN passes when SANDCASTLE_ALLOW_BROAD_TOKEN=1", () => {
  process.env.SANDCASTLE_ALLOW_BROAD_TOKEN = "1";
  const project = setup(`${CLAUDE}GH_TOKEN=ghp_classicfaketoken0000000000\n`);
  assert.equal(credentials(project).GH_TOKEN, "ghp_classicfaketoken0000000000");
});

test("a fine-grained GH_TOKEN passes without the override", () => {
  delete process.env.SANDCASTLE_ALLOW_BROAD_TOKEN;
  const project = setup(`${CLAUDE}GH_TOKEN=github_pat_finegrainedfake000000\n`);
  assert.equal(credentials(project).GH_TOKEN, "github_pat_finegrainedfake000000");
});

test("LINEAR_API_KEY in the user .env is left out of the sandbox env", () => {
  const project = setup(`${CLAUDE}GH_TOKEN=github_pat_finegrainedfake000000\nLINEAR_API_KEY=lin_api_hostonly\n`);
  const env = credentials(project);
  assert.ok(!("LINEAR_API_KEY" in env), Object.keys(env).join(","));
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-policy-fake");
});

test("LINEAR_API_KEY in the project's .sandcastle/.env is refused", () => {
  const project = setup(`${CLAUDE}GH_TOKEN=github_pat_finegrainedfake000000\n`, "LINEAR_API_KEY=lin_api_hostonly\n");
  assert.throws(
    () => credentials(project),
    (e: unknown) => e instanceof OperatorError && /LINEAR_API_KEY/.test(e.message) && /would reach the sandbox/.test(e.message),
  );
});

test("gate output holding a credential value comes back redacted once credentials() has run", () => {
  const token = "github_pat_REDACTIONONLYTOKEN123456";
  const claude = "sk-ant-oat01-REDACTIONONLYCLAUDE123456";
  const project = setup(`CLAUDE_CODE_OAUTH_TOKEN=${claude}\nGH_TOKEN=${token}\n`);
  const text = `before ${token} middle ${claude} after`;
  assert.equal(redact(text), text, "nothing is redacted before credentials() registers the values");
  credentials(project);
  assert.equal(redact(text), "before <redacted> middle <redacted> after");
});

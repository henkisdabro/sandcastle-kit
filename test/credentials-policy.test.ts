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
const { credentials, dockerOptions, sandboxEnvFor, setupWithheldKeys } = await import("../src/sandbox.ts");
const { OperatorError } = await import("../src/errors.ts");
const { redact, withheldFromGates } = await import("../src/worktree-lock.ts");
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

// #996: a sandbox's environment is an allowlist. A gate is the branch's code, so a gate-only sandbox
// gets no `.env` key unless `gateEnv` names it; a ticket's gets the agents' credentials and the keys
// `agentEnv` and `gateEnv` name (its gates and its `setup` run there too).
const NPM = "npm_xxxxxxxxxxxx";
const envFiles = `${CLAUDE}GH_TOKEN=github_pat_finegrainedfake000000\nNPM_TOKEN=${NPM}\nSERVICE_KEY=service-key-fake-0000\n`;
const dotenvKeys = ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "NPM_TOKEN", "SERVICE_KEY"];

test("a gate-only sandbox's options hold no .env key, and keep the base environment", () => {
  const env = dockerOptions({ ...setup(envFiles), mounts: [] } as Project, "img", "gate").env;
  assert.deepEqual(dotenvKeys.filter((k) => k in env), []);
  assert.equal(env.GIT_COMMITTER_NAME, "Sandcastle agent");
  assert.equal(env.CLAUDE_CODE_TMPDIR, "/home/agent/.claude-tmp");
});

test("a gate-only sandbox gets the keys gateEnv names, and nothing else from .env", () => {
  const project = { ...setup(envFiles), gateEnv: ["NPM_TOKEN"] } as Project;
  const env = sandboxEnvFor(project, "gate");
  assert.equal(env.NPM_TOKEN, NPM);
  assert.deepEqual(dotenvKeys.filter((k) => k in env), ["NPM_TOKEN"]);
});

test("a ticket's sandbox keeps the agents' credentials, and other keys only when agentEnv or gateEnv names them", () => {
  const plain = sandboxEnvFor(setup(envFiles), "ticket");
  assert.equal(plain.GH_TOKEN, "github_pat_finegrainedfake000000");
  assert.equal(plain.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-policy-fake");
  assert.ok(!("NPM_TOKEN" in plain) && !("SERVICE_KEY" in plain), Object.keys(plain).join(","));
  const named = sandboxEnvFor({ ...setup(envFiles), agentEnv: ["SERVICE_KEY"], gateEnv: ["NPM_TOKEN"] } as Project, "ticket");
  assert.equal(named.SERVICE_KEY, "service-key-fake-0000");
  assert.equal(named.NPM_TOKEN, NPM);
});

test("every forwarded value is redacted, and gates are kept from every .env key gateEnv does not name", () => {
  const project = { ...setup(envFiles), gateEnv: ["NPM_TOKEN"] } as Project;
  credentials(project);
  assert.equal(redact(`a ${NPM} b service-key-fake-0000`), "a <redacted> b <redacted>");
  assert.deepEqual(withheldFromGates().sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "SERVICE_KEY"]);
});

test("doctor's setup check: the credentials-file keys a setup step names that gateEnv does not", () => {
  const setupSteps = ["pnpm config set //npm.example.com/:_authToken $NPM_TOKEN", "pnpm install", "echo ${SERVICE_KEY}x"];
  assert.deepEqual(setupWithheldKeys({ ...setup(envFiles), setup: setupSteps } as Project), ["NPM_TOKEN", "SERVICE_KEY"]);
  assert.deepEqual(setupWithheldKeys({ ...setup(envFiles), setup: setupSteps, gateEnv: ["NPM_TOKEN", "SERVICE_KEY"] } as Project), []);
  // A name inside a longer word is no mention: MY_NPM_TOKEN_PATH is not NPM_TOKEN.
  assert.deepEqual(setupWithheldKeys({ ...setup(envFiles), setup: ["echo $MY_NPM_TOKEN_PATH"] } as Project), []);
});

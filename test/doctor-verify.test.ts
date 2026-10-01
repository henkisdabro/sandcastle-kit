// The pure helpers behind `sandcastle doctor --verify`: what a token's
// fingerprint may show, and what an HTTP status says about the token. No
// network is used.
//
//   pnpm exec tsx --test test/doctor-verify.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing doctor.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { fingerprint, verdict } = await import("../src/doctor.ts");

const day = 86_400_000;
const now = Date.UTC(2026, 0, 10);

test("an OAuth token shows its prefix, length and file age, and nothing of the rest", () => {
  const value = "sk-ant-oat01-SECRETTAILabcdef123456";
  const line = fingerprint("CLAUDE_CODE_OAUTH_TOKEN", value, join(tmpdir(), "x.env"), now - 3 * day, now);
  assert.match(line, /^CLAUDE_CODE_OAUTH_TOKEN from .*x\.env, sk-ant-oat01-\.\.\., 35 chars, file written 3 days ago$/);
  assert.ok(!line.includes("SECRETTAIL") && !line.includes("123456"));
});

test("a fine-grained GitHub token shows github_pat_ only; one day is singular", () => {
  const line = fingerprint("GH_TOKEN", "github_pat_11ABCDEFG0hidden", join(tmpdir(), "x.env"), now - day, now);
  assert.ok(line.includes("github_pat_..., 27 chars, file written 1 day ago"));
  assert.ok(!line.includes("11ABCDEFG") && !line.includes("hidden"));
});

test("an unrecognised value shows no character of itself", () => {
  const line = fingerprint("ANTHROPIC_API_KEY", "zzqqxxyy-private", join(tmpdir(), "x.env"), now, now);
  assert.ok(line.includes("unknown prefix, 16 chars, file written 0 days ago"));
  assert.ok(!line.includes("zzqq") && !line.includes("private"));
});

test("a file under the home directory is shown with ~", () => {
  const line = fingerprint("GH_TOKEN", "github_pat_x", join(homedir(), ".config/sandcastle-kit/.env"), now, now);
  assert.ok(line.includes(" from ~/.config/sandcastle-kit/.env,"));
  assert.ok(!line.includes(homedir()));
});

test("verdict: 2xx ok, 401 and 403 rejected, everything else proves nothing", () => {
  assert.equal(verdict(200), "ok");
  assert.equal(verdict(204), "ok");
  assert.equal(verdict(401), "rejected");
  assert.equal(verdict(403), "rejected");
  for (const s of [429, 500, 503, 302, undefined]) assert.equal(verdict(s), "not checked");
});

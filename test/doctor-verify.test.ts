// The pure helpers behind `sandcastle doctor --verify`: what a token's
// fingerprint may show, and what an HTTP status says about the token. No
// network is used.
//
//   pnpm test:file test/doctor-verify.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing doctor.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { fingerprint, probeApiKey, verdict } = await import("../src/doctor.ts");

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
  const line = fingerprint("ANTHROPIC_API_KEY", "zzqqxxyy-mystery", join(tmpdir(), "x.env"), now, now);
  assert.ok(line.includes("unknown prefix, 16 chars, file written 0 days ago"));
  assert.ok(!line.includes("zzqq") && !line.includes("mystery"));
});

test("a file under the home directory is shown with ~", () => {
  const line = fingerprint("GH_TOKEN", "github_pat_x", join(homedir(), ".config/sandcastle-kit/.env"), now, now);
  assert.ok(line.includes(" from ~/.config/sandcastle-kit/.env,"));
  assert.ok(!line.includes(homedir()));
});

test("verdict: 2xx ok, 401 rejected, everything else (403 included) proves nothing", () => {
  assert.equal(verdict(200), "ok");
  assert.equal(verdict(204), "ok");
  assert.equal(verdict(401), "rejected");
  for (const s of [403, 429, 500, 503, 302, undefined]) assert.equal(verdict(s), "not checked");
});

test("an API key is probed on the free model list, sent as x-api-key; no connection is undefined", async () => {
  const realFetch = globalThis.fetch;
  const seen: { url: string; headers: Record<string, string> }[] = [];
  try {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return new Response("{}", { status: 401 });
    }) as typeof fetch;
    assert.equal(await probeApiKey("sk-ant-api03-x"), 401);
    assert.match(seen[0]!.url, /^https:\/\/api\.anthropic\.com\/v1\/models/);
    assert.equal(seen[0]!.headers["x-api-key"], "sk-ant-api03-x");
    globalThis.fetch = (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    assert.equal(await probeApiKey("sk-ant-api03-x"), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("probeGithubWrite asks to create a ref at a commit that cannot exist, and returns GitHub's status", async () => {
  const { createServer } = await import("node:http");
  const { probeGithubWrite } = await import("../src/doctor.ts");
  const seen: { method?: string; url?: string; body: string }[] = [];
  for (const status of [422, 403]) {
    const api = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body });
        res.statusCode = status;
        res.end("{}");
      });
    });
    await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
    process.env.SANDCASTLE_TEST_GITHUB_API = `http://127.0.0.1:${(api.address() as import("node:net").AddressInfo).port}`;
    try {
      assert.equal(await probeGithubWrite("t", "o/r"), status);
    } finally {
      delete process.env.SANDCASTLE_TEST_GITHUB_API;
      api.close();
    }
  }
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/repos/o/r/git/refs");
  // Nothing can be written: the sha names no object.
  assert.deepEqual(JSON.parse(seen[0].body), { ref: "refs/heads/sandcastle-doctor-probe-never-created", sha: "0".repeat(40) });
});

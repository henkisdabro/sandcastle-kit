// The live GitHub token check `sandcastle setup` uses for both a saved and a
// pasted token: a made-up fetch stands in for GitHub, so no network is touched.
//
//   pnpm exec tsx --test test/setup-token.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing doctor.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { probeGithubToken } = await import("../src/doctor.ts");

const realFetch = globalThis.fetch;
const stub = (reply: () => Response | Promise<Response>) => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return reply();
  }) as typeof fetch;
  return seen;
};

test("a valid token reports its login, sent as a bearer token", async () => {
  const seen = stub(() => Response.json({ login: "octo" }));
  assert.deepEqual(await probeGithubToken("github_pat_x"), { ok: true, status: 200, login: "octo" });
  assert.equal(seen[0]!.url, "https://api.github.com/user");
  assert.equal(seen[0]!.headers.Authorization, "Bearer github_pat_x");
  assert.equal(seen[0]!.headers["User-Agent"], "sandcastle-kit");
});

test("a revoked token is a 401, not a missing answer", async () => {
  stub(() => new Response("{}", { status: 401 }));
  const r = await probeGithubToken("github_pat_x");
  assert.equal(r?.ok, false);
  assert.equal(r?.status, 401);
});

test("no connection is undefined, so it is never read as a rejection", async () => {
  stub(() => Promise.reject(new TypeError("fetch failed")));
  assert.equal(await probeGithubToken("github_pat_x"), undefined);
});

test.after(() => {
  globalThis.fetch = realFetch;
});

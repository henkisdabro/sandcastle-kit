// Codex is never resolved to a release npm marks deprecated, one unpublished (a `time` entry with
// no `versions` entry), or one above `dist-tags.latest`. An injected fetcher and a temp
// XDG_CACHE_HOME: no network, no Docker.
//
//   pnpm exec tsx --test test/versions-codex-published.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-codex-"));
const { resolveVersions } = await import("../src/versions.ts");

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const resolve = async (packument: object) => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-codex-"));
  delete process.env.CLAUDE_CODE_VERSION;
  delete process.env.CODEX_VERSION;
  const lines: string[] = [];
  const fetcher = async (url: string) =>
    url.startsWith("https://registry.npmjs.org/")
      ? { ok: true, text: async () => JSON.stringify(packument), json: async () => packument }
      : { ok: true, text: async () => "2.2.0", json: async () => ({}) };
  const v = await resolveVersions({}, fetcher, (l) => lines.push(l));
  return { v, lines };
};

test("a deprecated release past the cooldown is skipped for the one before it", async () => {
  const { v } = await resolve({
    "dist-tags": { latest: "0.160.0" },
    versions: { "0.158.0": {}, "0.159.0": {}, "0.160.0": { deprecated: "broken, use 0.160.1" } },
    time: { "0.158.0": ago(300), "0.159.0": ago(200), "0.160.0": ago(100), "0.160.1": ago(10) },
  });
  assert.equal(v.codex, "0.159.0");
  assert.equal(v.source, "network");
});

test("an unpublished release (a publish time and no version entry) is skipped", async () => {
  const { v } = await resolve({
    "dist-tags": { latest: "0.159.0" },
    versions: { "0.158.0": {}, "0.159.0": {} },
    time: { "0.158.0": ago(300), "0.159.0": ago(200), "0.160.0": ago(100) },
  });
  assert.equal(v.codex, "0.159.0");
});

test("a plain release above dist-tags.latest is not chosen", async () => {
  const { v } = await resolve({
    "dist-tags": { latest: "0.158.0" },
    versions: { "0.158.0": {}, "0.159.0": {}, "0.160.0": {} },
    time: { "0.158.0": ago(300), "0.159.0": ago(200), "0.160.0": ago(100) },
  });
  assert.equal(v.codex, "0.158.0");
});

test("when every release past the cooldown is deprecated, the Dockerfile's default is used as before", async () => {
  const { v, lines } = await resolve({
    "dist-tags": { latest: "0.160.0" },
    versions: { "0.160.0": { deprecated: "broken" } },
    time: { "0.160.0": ago(100) },
  });
  assert.equal(v.source, "fallback");
  assert.match(lines.join("\n"), /Codex: could not reach the npm registry/);
});

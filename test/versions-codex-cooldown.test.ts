// Codex is resolved as the newest plain release at least 72 hours old, from npm's packument `time`.
// An injected fetcher and a temp XDG_CACHE_HOME: no network, no Docker.
//
//   node --test test/versions-codex-cooldown.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-codex-"));
const { resolveVersions } = await import("../src/versions.ts");

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const fetcherFor = (time: Record<string, string> | undefined, urls: string[] = []) => async (url: string) => {
  urls.push(url);
  if (url.startsWith("https://registry.npmjs.org/")) {
    if (!time) return { ok: false, text: async () => "", json: async () => ({}) };
    // A real packument has a `versions` entry for every published release.
    const versions = Object.fromEntries(Object.keys(time).map((v) => [v, {}]));
    const body = { versions, time: { created: ago(9999), modified: ago(1), ...time } };
    return { ok: true, text: async () => JSON.stringify(body), json: async () => body };
  }
  return { ok: true, text: async () => "2.2.0", json: async () => ({}) };
};

const resolve = async (time: Record<string, string> | undefined) => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-codex-"));
  delete process.env.CLAUDE_CODE_VERSION;
  delete process.env.CODEX_VERSION;
  const lines: string[] = [];
  const urls: string[] = [];
  const v = await resolveVersions({}, fetcherFor(time, urls), (l) => lines.push(l));
  return { v, lines, urls };
};

test("a release under 72 hours old is skipped for the newest older plain one", async () => {
  const { v, urls } = await resolve({ "0.150.0": ago(500), "0.159.2": ago(100), "0.160.0": ago(71) });
  assert.equal(v.codex, "0.159.2");
  assert.equal(v.source, "network");
  assert.ok(urls.includes("https://registry.npmjs.org/@openai/codex"));
});

test("a release just past 72 hours old is used", async () => {
  const { v } = await resolve({ "0.159.2": ago(100), "0.160.0": ago(72.01) });
  assert.equal(v.codex, "0.160.0");
});

test("pre-releases and platform builds never count, however old", async () => {
  const { v } = await resolve({
    "0.159.2": ago(100),
    "0.161.0-alpha.3": ago(200),
    "0.160.0-linux-x64": ago(200),
    "0.160.0-darwin-arm64": ago(200),
  });
  assert.equal(v.codex, "0.159.2");
});

test("the newest by version wins, not the last published", async () => {
  const { v } = await resolve({ "0.159.2": ago(100), "0.158.9": ago(80), "0.99.0": ago(300) });
  assert.equal(v.codex, "0.159.2");
});

test("a packument with no release past the cooldown falls back to the Dockerfile's default", async () => {
  const { v, lines } = await resolve({ "0.160.0": ago(1) });
  assert.equal(v.source, "fallback");
  assert.match(lines.join("\n"), /Codex: could not reach the npm registry/);
});

test("a failed fetch falls back as before", async () => {
  const { v } = await resolve(undefined);
  assert.equal(v.source, "fallback");
});

test("CODEX_VERSION skips npm", async () => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-codex-"));
  process.env.CODEX_VERSION = "0.1.2";
  const urls: string[] = [];
  try {
    const v = await resolveVersions({}, fetcherFor({ "0.160.0": ago(1) }, urls), () => {});
    assert.equal(v.codex, "0.1.2");
    assert.ok(!urls.some((u) => u.startsWith("https://registry.npmjs.org/")));
  } finally {
    delete process.env.CODEX_VERSION;
  }
});

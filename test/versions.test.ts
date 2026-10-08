// Which Claude Code and Codex the image gets: channel and version resolution, the six-hour cache,
// the offline fallbacks, and the versions being part of the image tag. An injected fetcher and a
// temp XDG_CACHE_HOME: no network, no Docker.
//
//   pnpm test:file test/versions.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cache = mkdtempSync(join(tmpdir(), "sandcastle-versions-"));
process.env.XDG_CACHE_HOME = cache;
const { resolveVersions } = await import("../src/versions.ts");
const { baseImage } = await import("../src/sandbox.ts");
const { loadProject } = await import("../src/config.ts");

const kit = fileURLToPath(new URL("..", import.meta.url));
const dockerfile = readFileSync(join(kit, "docker/base.Dockerfile"), "utf8");
const arg = (name: string) => dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)`, "m"))![1];
const cacheFile = join(cache, "sandcastle-kit", "versions.json");

// A fetcher that answers each URL from a table and records what it was asked.
const fake = (claude: Record<string, string>, codex = "0.200.0") => {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    // The Codex packument: the one release, published long ago, so it is past the cooldown.
    const body = url.startsWith("https://registry.npmjs.org/") ? JSON.stringify({ versions: { [codex]: {} }, time: { [codex]: "2020-01-01T00:00:00.000Z" } }) : claude[url.split("/").pop()!];
    if (body === undefined) throw new Error("not found");
    return { ok: true, text: async () => body, json: async () => JSON.parse(body) };
  };
  return { fetcher, urls };
};
const down = async () => {
  throw new Error("offline");
};

const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
};

// Every test starts with no cache and no env override.
const fresh = () => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-versions-"));
  delete process.env.CLAUDE_CODE_VERSION;
  delete process.env.CODEX_VERSION;
  return join(process.env.XDG_CACHE_HOME, "sandcastle-kit", "versions.json");
};

test("the stable channel is the default; it resolves from the fetched body, Codex from npm", async () => {
  fresh();
  const { fetcher, urls } = fake({ stable: "2.2.0\n" });
  const v = await resolveVersions({}, fetcher);
  assert.deepEqual(v, { claude: "2.2.0", codex: "0.200.0", channel: "stable", source: "network" });
  assert.deepEqual(urls, ["https://downloads.claude.ai/claude-code-releases/stable", "https://registry.npmjs.org/@openai/codex"]);
});

test("stable hits the /stable URL", async () => {
  fresh();
  const { fetcher, urls } = fake({ stable: "2.1.100" });
  const v = await resolveVersions({ claudeCode: "stable" }, fetcher);
  assert.equal(v.claude, "2.1.100");
  assert.equal(v.channel, "stable");
  assert.ok(urls.includes("https://downloads.claude.ai/claude-code-releases/stable"));
});

test("an exact version is used without a fetch for Claude Code", async () => {
  fresh();
  const { fetcher, urls } = fake({});
  const v = await resolveVersions({ claudeCode: "2.1.200" }, fetcher);
  assert.equal(v.claude, "2.1.200");
  assert.equal(v.channel, "pinned");
  assert.ok(!urls.some((u) => u.includes("claude-code-releases")));
});

test("CLAUDE_CODE_VERSION overrides the config; CODEX_VERSION skips npm", async () => {
  fresh();
  process.env.CLAUDE_CODE_VERSION = "2.0.5";
  process.env.CODEX_VERSION = "0.1.2";
  const { fetcher, urls } = fake({ latest: "9.9.9" });
  const v = await resolveVersions({ claudeCode: "latest" }, fetcher);
  assert.equal(v.claude, "2.0.5");
  assert.equal(v.codex, "0.1.2");
  assert.deepEqual(urls, []);
  process.env.CLAUDE_CODE_VERSION = "stable";
  assert.equal((await resolveVersions({ claudeCode: "2.1.200" }, fake({ stable: "2.1.1" }).fetcher)).claude, "2.1.1");
});

test("a second call within six hours fetches nothing; after six hours it fetches again", async () => {
  const file = fresh();
  const { fetcher, urls } = fake({ stable: "2.2.0" });
  await resolveVersions({}, fetcher);
  assert.equal(urls.length, 2);
  const again = await resolveVersions({}, fetcher);
  assert.equal(urls.length, 2);
  assert.deepEqual([again.claude, again.codex, again.source], ["2.2.0", "0.200.0", "network"]);

  // Age the entries to just under, then just over, six hours.
  const age = (hours: number) => {
    const c = JSON.parse(readFileSync(file, "utf8"));
    const at = Date.now() - hours * 3_600_000;
    c.claude.stable.at = at;
    c.codex.at = at;
    writeFileSync(file, JSON.stringify(c));
  };
  age(5.9);
  await resolveVersions({}, fetcher);
  assert.equal(urls.length, 2);
  age(6.1);
  const next = fake({ stable: "2.3.0" });
  assert.equal((await resolveVersions({}, next.fetcher)).claude, "2.3.0");
  assert.equal(next.urls.length, 2);
});

test("channels are cached separately", async () => {
  fresh();
  const { fetcher } = fake({ stable: "2.2.0", latest: "2.3.0" });
  await resolveVersions({}, fetcher);
  assert.equal((await resolveVersions({ claudeCode: "latest" }, fetcher)).claude, "2.3.0");
});

test("a failing fetch serves the cache whatever its age, and says so", async () => {
  const file = fresh();
  await resolveVersions({}, fake({ stable: "2.2.0" }).fetcher);
  const c = JSON.parse(readFileSync(file, "utf8"));
  c.claude.stable.at = 1;
  c.codex.at = 1;
  writeFileSync(file, JSON.stringify(c));
  const { lines, log } = quiet();
  const v = await resolveVersions({}, down, log);
  assert.deepEqual([v.claude, v.codex, v.source], ["2.2.0", "0.200.0", "cache"]);
  assert.equal(lines[0], "Claude Code: could not reach the release channel - using 2.2.0 from cache.");
});

test("no cache and no network gives the Dockerfile's defaults", async () => {
  fresh();
  const { lines, log } = quiet();
  const v = await resolveVersions({}, down, log);
  assert.deepEqual([v.claude, v.codex, v.source], [arg("CLAUDE_CODE_VERSION"), arg("CODEX_VERSION"), "fallback"]);
  assert.equal(lines[0], `Claude Code: could not reach the release channel - using ${arg("CLAUDE_CODE_VERSION")} from the Dockerfile's default.`);
});

test("a network success prints nothing", async () => {
  fresh();
  const { lines, log } = quiet();
  await resolveVersions({}, fake({ stable: "2.2.0" }).fetcher, log);
  assert.deepEqual(lines, []);
});

test("a body that is not a version is a failure", async () => {
  for (const body of ["<html><body>Not found</body></html>", "", "latest", "2.1"]) {
    fresh();
    const v = await resolveVersions({}, fake({ stable: body }).fetcher, () => {});
    assert.equal(v.source, "fallback", JSON.stringify(body));
    assert.equal(v.claude, arg("CLAUDE_CODE_VERSION"));
  }
});

test("an HTTP error status is a failure", async () => {
  fresh();
  const fetcher = async () => ({ ok: false, text: async () => "2.9.9", json: async () => ({ version: "9.9.9" }) });
  assert.equal((await resolveVersions({}, fetcher, () => {})).source, "fallback");
});

test("a pre-release version is a version", async () => {
  fresh();
  assert.equal((await resolveVersions({}, fake({ stable: "2.2.0-beta.1" }).fetcher)).claude, "2.2.0-beta.1");
});

test("a bad CLAUDE_CODE_VERSION is refused, naming the variable", async () => {
  fresh();
  process.env.CLAUDE_CODE_VERSION = "newest";
  await assert.rejects(resolveVersions({}, fake({}).fetcher), /CLAUDE_CODE_VERSION/);
});

test("the image tag follows the versions", () => {
  const a = baseImage({ claude: "2.1.1", codex: "0.1.0" });
  assert.equal(a.tag, baseImage({ claude: "2.1.1", codex: "0.1.0" }).tag);
  assert.notEqual(a.tag, baseImage({ claude: "2.1.2", codex: "0.1.0" }).tag);
  assert.notEqual(a.tag, baseImage({ claude: "2.1.1", codex: "0.2.0" }).tag);
  assert.equal(a.ids.CLAUDE_CODE_VERSION, "2.1.1");
  assert.equal(a.ids.CODEX_VERSION, "0.1.0");
});

test("config validation refuses claudeCode: \"newest\" and accepts a channel or a version", async () => {
  const project = (claudeCode: string) => {
    const root = mkdtempSync(join(tmpdir(), "sandcastle-project-"));
    mkdirSync(join(root, ".sandcastle"));
    writeFileSync(
      join(root, ".sandcastle/config.ts"),
      `export default { name: "p", tracker: "files", claudeCode: ${JSON.stringify(claudeCode)}, gates: [{ name: "t", command: "true" }] };\n`,
    );
    return loadProject(root);
  };
  await assert.rejects(project("newest"), /\bclaudeCode\b/);
  for (const ok of ["latest", "stable", "2.1.285"]) assert.equal((await project(ok)).claudeCode, ok);
});

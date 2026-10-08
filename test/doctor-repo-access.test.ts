// A fine-grained GitHub token whose Repository access leaves the project's repo out passes `/user`, then
// every ticket crashes on its first `gh issue view`. Doctor (--verify) and the start of a run read the
// repo with the token and say so; a 403 on the write probe still means only "cannot push". A stubbed
// GitHub on a local port and a fake `gh`; no Docker, no network, no model call.
//
//   pnpm test:file test/doctor-repo-access.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { startKit } from "./cli-spawn.ts";

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-repo-access-"));
const config = join(tmp, "config");
mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
writeFileSync(join(config, "sandcastle-kit/.env"), "GH_TOKEN=github_pat_fake\n", { mode: 0o600 });
process.env.XDG_CONFIG_HOME = config;
process.env.XDG_CACHE_HOME = join(tmp, "cache");

// A fake gh: names the repo, and succeeds at anything else.
const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), '#!/bin/sh\n[ "$1 $2" = "repo view" ] && echo octo/demo\nexit 0\n');
chmodSync(join(bin, "gh"), 0o755);

// The project: a git repository that is not the kit.
const repo = join(tmp, "project");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
// A project that keeps its tickets in files: GH_TOKEN is never read for them there.
const filesRepo = join(tmp, "files-project");
mkdirSync(join(filesRepo, ".sandcastle"), { recursive: true });
execFileSync("git", ["init", "-q", filesRepo]);
writeFileSync(join(filesRepo, ".sandcastle/config.ts"), 'export default { name: "demo", tracker: "files", gates: [{ name: "t", command: "true" }] };\n');

// The token is accepted at /user (hard-wired to api.github.com), so that one URL is answered by a preload.
const preload = join(tmp, "stub.mjs");
writeFileSync(
  preload,
  'const real = globalThis.fetch;\n' +
    'globalThis.fetch = async (url, init) => String(url) === "https://api.github.com/user" ? new Response(JSON.stringify({ login: "octo" }), { status: 200 }) : real(url, init);\n',
);

// A GitHub that answers the repo's issue list with `read` and the ref probe with `write`.
const github = async (read: number, write: number, body: (url: string) => Promise<void>) => {
  const seen: string[] = [];
  const api = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.statusCode = req.method === "POST" ? write : req.url?.startsWith("/repos/octo/demo/issues") ? read : 200;
    res.end("{}");
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const before = process.env.SANDCASTLE_TEST_GITHUB_API;
  process.env.SANDCASTLE_TEST_GITHUB_API = url;
  try {
    await body(url);
  } finally {
    if (before === undefined) delete process.env.SANDCASTLE_TEST_GITHUB_API;
    else process.env.SANDCASTLE_TEST_GITHUB_API = before;
    api.close();
  }
  return seen;
};

// Not runKit: the stub above has to answer while doctor runs.
const doctorVerify = (url: string, cwd = repo) =>
  new Promise<string>((done) => {
    const child = startKit(["doctor", "--verify"], {
      cwd,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        HOME: tmp,
        NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
        SANDCASTLE_TEST_GITHUB_API: url,
        GIT_CEILING_DIRECTORIES: tmp,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    child.on("close", () => done(out));
  });

const lineWith = (out: string, text: string) => {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.includes(text));
  return i < 0 ? "(missing)" : lines.slice(i, i + 2).join("\n");
};

test("doctor --verify gives a FIX naming Repository access when the token gets 404 for the repo", async () => {
  let out = "";
  const seen = await github(404, 404, async (url) => {
    out = await doctorVerify(url);
  });
  assert.ok(seen.includes("GET /repos/octo/demo/issues?per_page=1"), seen.join("\n"));
  assert.match(lineWith(out, "GH_TOKEN cannot see octo/demo"), /^FIX  GH_TOKEN cannot see octo\/demo \(HTTP 404\)\n\s+-> .*Repository access, include octo\/demo/, out);
  assert.doesNotMatch(out, /GH_TOKEN cannot push/, out);
});

test("doctor --verify keeps its line for a token that sees the repo but cannot push (403)", async () => {
  let out = "";
  await github(200, 403, async (url) => {
    out = await doctorVerify(url);
  });
  assert.match(out, /^ok\s+GH_TOKEN cannot push to octo\/demo \(no Contents: write\)$/m, out);
  assert.doesNotMatch(out, /cannot see octo\/demo/, out);
});

test("doctor --verify says the token cannot see the repo when only the write probe answers 404", async () => {
  let out = "";
  await github(200, 404, async (url) => {
    out = await doctorVerify(url);
  });
  assert.match(out, /^FIX\s+GH_TOKEN cannot see octo\/demo/m, out);
  assert.doesNotMatch(out, /cannot push to octo\/demo \(no Contents/, out);
});

test("doctor --verify gives no FIX for a 404 in a project whose tickets are in files", async () => {
  let out = "";
  await github(404, 404, async (url) => {
    out = await doctorVerify(url, filesRepo);
  });
  assert.match(out, /^opt\s+GH_TOKEN cannot see octo\/demo \(HTTP 404\) \(not needed: this project keeps tickets in files\)$/m, out);
  assert.doesNotMatch(out, /^FIX\s+GH_TOKEN cannot see/m, out);
});

// The run's start (cli.ts calls this before the billing question, an image or any sandbox).
const { requireRepoAccess } = await import("../src/doctor.ts");
const { fakeTracker } = await import("./fixtures.ts");
const project = (kind: "github" | "files" = "github") => ({ root: repo, tracker: fakeTracker({ kind }) }) as Parameters<typeof requireRepoAccess>[0];

test("the run's start refuses, with doctor's words, when the token gets 404 for the repo", async () => {
  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before}`;
  try {
    await github(404, 404, async () => {
      await assert.rejects(requireRepoAccess(project()), /GH_TOKEN cannot see octo\/demo \(HTTP 404\): .*Repository access, include octo\/demo/);
    });
    // Anything but a 404 proves nothing about the token: the run goes ahead.
    for (const status of [200, 403, 429, 500]) await github(status, 403, async () => void (await requireRepoAccess(project())));
    // Tickets in files need no GitHub token at all.
    await github(404, 404, async () => void (await requireRepoAccess(project("files"))));
  } finally {
    process.env.PATH = before;
  }
});

test("a run reads the repo before the billing question and before burndown", () => {
  const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8");
  const start = cli.indexOf('case "run": {');
  const calls = [...cli.slice(start).matchAll(/await requireRepoAccess\(project\);/g)].map((m) => start + m.index!);
  assert.equal(calls.length, 2, "the detach pre-checks and the attached run each make the check");
  assert.ok(calls[0]! < cli.indexOf("startDetached(", start), "a detached run is refused before its process starts");
  assert.ok(calls[1]! < cli.indexOf('"This run", { ask:', start), "the check comes before the billing question");
  assert.ok(calls[1]! < cli.indexOf("await burndown(project", start));
});

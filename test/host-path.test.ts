// src/host-path.ts: the normaliser and matcher every protected-path guard goes through. Properties over seeded
// spellings: whatever case, Unicode form, HFS+-ignorable code point or trailing dot a branch spells a protected path
// with, a macOS or Windows host opens the protected file, so the matcher must hold it; and the kit's own tree keeps
// the verdicts the raw prefix match gave it.
//
//   pnpm test:file test/host-path.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { hostKey, matchRules } = await import("../src/host-path.ts");
const { protectedAmong, protectedRules } = await import("../src/guard.ts");
type PathRule = import("../src/host-path.ts").PathRule;

// mulberry32: a fixed seed, so a failure names a spelling that fails again on the next run.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const IGNORABLE = ["\u200c", "\u200d", "\u200e", "\u200f", "\u202a", "\u202e", "\u206a", "\u206f", "\ufeff"];

// One spelling of `path` that a case-insensitive, HFS+ or NTFS host resolves to the same file.
const respell = (path: string, rand: () => number) => {
  let s = [...path].map((c) => (rand() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join("");
  if (rand() < 0.5) s = s.normalize("NFD");
  if (rand() < 0.5) {
    const at = Math.floor(rand() * (s.length + 1));
    s = s.slice(0, at) + IGNORABLE[Math.floor(rand() * IGNORABLE.length)] + s.slice(at);
  }
  if (rand() < 0.5) {
    const parts = s.split("/");
    const i = Math.floor(rand() * parts.length);
    parts[i] += rand() < 0.5 ? "." : " .";
    s = parts.join("/");
  }
  return s;
};

// Paths a rule must match: the bare entry and something under it for a directory, an extension for a prefix.
const samples = (rule: PathRule): string[] => {
  const v = rule.value.replace(/\/$/, "");
  switch (rule.kind) {
    case "dir":
      return [v, `${v}/x/y.txt`];
    case "prefix":
      return [`${v}x`];
    case "file":
      return [v];
    case "basename":
      return [v, `pkg/${v}`, `pkg/${v}/x`];
  }
};

const project = (protectedPaths?: string[]) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-host-path-")));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  return { root, baseBranch: "main", protectedPaths } as Project;
};

test("every respelling of every protected rule's path is held, and comes back as spelled", () => {
  const p = project(["infrå/", "Ünïcode.cfg"]);
  const rules = protectedRules(p);
  const rand = prng(991);
  // One protectedAmong call for every spelling: each call reads the repository's `core.hooksPath`.
  const spelled = rules.flatMap((rule) => samples(rule).flatMap((path) => Array.from({ length: 50 }, () => respell(path, rand))));
  const held = new Set(protectedAmong(p, spelled));
  assert.deepEqual(spelled.filter((s) => !held.has(s)), []);
});

test("every respelling matches each kind of rule", () => {
  const rules: PathRule[] = [
    { kind: "dir", value: ".codex/", runner: "t" },
    { kind: "file", value: "bunfig.toml", runner: "t" },
    { kind: "prefix", value: ".pnpmfile.", runner: "t" },
    { kind: "basename", value: "package.json", runner: "t" },
  ];
  const rand = prng(995);
  for (const rule of rules)
    for (const path of samples(rule.kind === "prefix" ? { ...rule, value: ".pnpmfile.c" } : rule))
      for (let n = 0; n < 50; n++) {
        const spelled = respell(path, rand);
        assert.deepEqual(matchRules([spelled], [rule]), [spelled], `${JSON.stringify(spelled)} under ${rule.kind} ${rule.value}`);
      }
});

test("near misses stay unmatched", () => {
  const rules: PathRule[] = [
    { kind: "dir", value: ".codex/", runner: "t" },
    { kind: "file", value: "bunfig.toml", runner: "t" },
    { kind: "prefix", value: "lefthook.", runner: "t" },
    { kind: "basename", value: "package.json", runner: "t" },
  ];
  assert.deepEqual(matchRules([".codexrc", "src/.codex", "bunfig.toml.bak", "lefthookery.yml", "src/package.json.ts", "a/b"], rules), []);
});

test("hostKey folds a path to the form the host opens", () => {
  assert.equal(hostKey(".Husky/Pre-Commit"), ".husky/pre-commit");
  assert.equal(hostKey("./.github./workflows /ci.yml"), ".github/workflows/ci.yml");
  assert.equal(hostKey(".g\u200cit/config"), ".git/config");
  assert.equal(hostKey("Infra\u030a/x"), "infrå/x");
  assert.equal(hostKey("a//b/"), "a/b");
});

test("a path that cannot be normalised is unknown, and the matcher holds it", () => {
  for (const bad of ["../x", "a/../b", "a/b\nc", "a\u0000", "/etc/passwd", "a/.../b", "", "./"]) {
    const key = hostKey(bad);
    assert.equal(typeof key, "object", JSON.stringify(bad));
    assert.equal((key as { kind: string }).kind, "unknown");
  }
  assert.deepEqual(matchRules(["src/../.husky/x"], []), ["src/../.husky/x"]);
});

test("the kit's own tree keeps the verdicts the raw prefix match gave it", () => {
  const p = project();
  const values = protectedRules(p).map((r) => r.value);
  const files = execFileSync("git", ["-C", join(import.meta.dirname, ".."), "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  // Paths the normalised match holds that the raw one did not: root dot entries, which the rule table holds by default.
  const expectedNewHolds = [".env.example", ".oxlintrc.json"];
  const held = new Set(protectedAmong(p, files));
  const changed = files.filter((f) => values.some((v) => f === v || f.startsWith(v)) !== held.has(f));
  assert.deepEqual(changed, expectedNewHolds);
});

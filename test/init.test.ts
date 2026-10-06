// `sandcastle init`'s stack detection and scaffolding, against throwaway project
// directories: which gates and setup each stack gets, which Dockerfile layer is
// written, and what the fallback says when nothing is recognised. Nothing is
// built, so no Docker and no network.
//
//   node --test test/init.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

// Importing init.ts must not read the real user config.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));

// A fake `pnpm` first on PATH, so init never depends on the host's pnpm: it writes `pnpmStore: true`
// and no path, whatever the host's pnpm or platform.
const bin = mkdtempSync(join(tmpdir(), "sandcastle-bin-"));
writeFileSync(join(bin, "pnpm"), '#!/bin/sh\n[ "$1" = store ] && [ "$2" = path ] && echo /fake/pnpm-store/v11\n');
chmodSync(join(bin, "pnpm"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;

const { init } = await import("../src/init.ts");

const NO_TEST = 'echo "Error: no test specified" && exit 1';
const FALLBACK_GATE = '{ name: "gates-not-set"';

// A fresh project directory holding `files`, initialised; returns what init wrote.
const run = (t: TestContext, files: Record<string, string>) => {
  t.mock.method(console, "log", () => {});
  const root = mkdtempSync(join(tmpdir(), "sandcastle-init-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  init(root);
  const dockerfilePath = join(root, ".sandcastle/Dockerfile");
  return {
    root,
    config: readFileSync(join(root, ".sandcastle/config.ts"), "utf8"),
    dockerfile: existsSync(dockerfilePath) ? readFileSync(dockerfilePath, "utf8") : undefined,
  };
};

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "fixture", scripts });

test("npm: a lockfile gives npm ci and the scripts as gates in order, with no Dockerfile", (t) => {
  const { config, dockerfile } = run(t, {
    "package.json": pkg({ test: "node --test", build: "tsc", lint: "eslint ." }),
    "package-lock.json": "{}",
  });
  assert.ok(config.includes("npm ci"));
  const gates = ['{ name: "lint", command: "npm run lint" }', '{ name: "build", command: "npm run build" }', '{ name: "test", command: "npm run test" }'];
  for (const gate of gates) assert.ok(config.includes(gate), gate);
  const at = gates.map((g) => config.indexOf(g));
  assert.deepEqual([...at].sort((a, b) => a - b), at, "gates in lint, build, test order");
  assert.equal(dockerfile, undefined);
});

test("npm: the placeholder test script is no gate, and no lockfile means no lockfile is written", (t) => {
  const { config } = run(t, { "package.json": pkg({ test: NO_TEST }) });
  assert.ok(config.includes('{ name: "test", command: "npm test" }'));
  // The commented `generated` example names `pnpm run`, so look at gate commands only.
  assert.ok(!config.includes('command: "npm run'));
  assert.ok(config.includes("npm install --no-package-lock"));
});

test("pnpm: a lockfile gives a frozen install and asks for the host store, naming no path", (t) => {
  const { config } = run(t, { "package.json": pkg({ test: "vitest" }), "pnpm-lock.yaml": "" });
  assert.ok(config.includes("pnpm install --frozen-lockfile"));
  assert.ok(config.includes("pnpmStore: true"));
  assert.ok(!config.includes("hostPath") && !config.includes("/fake/pnpm-store") && !config.includes("store-dir"));
});

test("yarn: a Berry lockfile gets --immutable", (t) => {
  const { config } = run(t, { "package.json": pkg({ test: "jest" }), "yarn.lock": "__metadata:\n  version: 8\n" });
  assert.ok(config.includes("yarn install --immutable"));
});

test("bun: a lockfile writes a Dockerfile layer with bun", (t) => {
  const { config, dockerfile } = run(t, { "package.json": pkg({ test: "bun test" }), "bun.lock": "" });
  assert.ok(config.includes("bun install --frozen-lockfile"));
  assert.ok(dockerfile?.includes("oven/bun"));
});

test("python: pyproject.toml with uv.lock gets uv gates, a frozen sync and a uv layer", (t) => {
  const { config, dockerfile } = run(t, {
    "pyproject.toml": '[project]\nname = "fixture"\n\n[tool.ruff]\n\n[tool.pytest.ini_options]\n',
    "uv.lock": "",
  });
  assert.ok(config.includes("uv run ruff check ."));
  assert.ok(config.includes("uv run pytest -q"));
  assert.ok(config.includes("uv sync --frozen"));
  assert.ok(dockerfile?.includes("astral-sh/uv"));
});

test("python: pyproject.toml without uv.lock is not detected", (t) => {
  const { config, dockerfile } = run(t, { "pyproject.toml": '[project]\nname = "fixture"\n[tool.ruff]\n' });
  assert.ok(config.includes(FALLBACK_GATE));
  assert.equal(dockerfile, undefined);
});

test("go: go.mod gives vet, build and test", (t) => {
  const { config, dockerfile } = run(t, { "go.mod": "module fixture\n" });
  for (const gate of ["go vet ./...", "go build ./...", "go test ./..."]) assert.ok(config.includes(gate), gate);
  assert.ok(config.indexOf("go vet") < config.indexOf("go build") && config.indexOf("go build") < config.indexOf("go test"));
  assert.ok(dockerfile?.includes("golang"));
});

test("rust: Cargo.toml gives clippy and cargo test", (t) => {
  const { config, dockerfile } = run(t, { "Cargo.toml": '[package]\nname = "fixture"\n' });
  assert.ok(config.includes("cargo clippy"));
  assert.ok(config.includes("cargo test"));
  assert.ok(dockerfile?.includes("rustup"));
});

test("an empty directory gets the failing placeholder gate, the rules and the ignore file; a second init refuses", (t) => {
  const { root, config, dockerfile } = run(t, {});
  assert.ok(config.includes(FALLBACK_GATE));
  assert.equal(dockerfile, undefined);
  assert.ok(existsSync(join(root, ".sandcastle/rules.md")));
  const ignored = readFileSync(join(root, ".sandcastle/.gitignore"), "utf8").split("\n");
  for (const entry of [".env", "logs/", "worktrees/", ".run/"]) assert.equal(ignored.filter((l) => l === entry).length, 1, entry);
  assert.throws(() => init(root), /already exists/);
});

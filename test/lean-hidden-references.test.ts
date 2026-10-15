// A hidden path named by a file a gate may read is worth a warning at every run's start; one named
// only by CODEOWNERS or the project's own .sandcastle config is not, and used to print it every run.
//
//   pnpm test:file test/lean-hidden-references.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// The kit's config dir is read at import; a test must not touch the real one.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { hiddenReferences, plan } = await import("../src/lean.ts");

const repo = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-lean-refs-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  const all = { ".mcp.json": JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" } } }), ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git("add", "-f", ...Object.keys(all));
  git("commit", "-q", "-m", "start");
  return { name: "fixture", root, lean: { keep: [], dropHooks: [] }, hookTests: [] } as unknown as Project;
};

const refs = (project: Project) => hiddenReferences(project.root, plan(project), []);

test("a hidden .mcp.json named only by CODEOWNERS and the project's .sandcastle config is not reported", () => {
  const project = repo({
    ".github/CODEOWNERS": "/.mcp.json @owner\n",
    "CODEOWNERS": "/.mcp.json @owner\n",
    ".sandcastle/config.ts": "// .mcp.json stays hidden\nexport default {};\n",
  });
  assert.deepEqual(refs(project), []);
});

test("a hidden .mcp.json named by a script is still reported, and CODEOWNERS is not listed beside it", () => {
  const project = repo({
    ".github/CODEOWNERS": "/.mcp.json @owner\n",
    "scripts/check.sh": "test -f .mcp.json\n",
  });
  assert.deepEqual(refs(project), [{ path: ".mcp.json", by: ["scripts/check.sh"] }]);
});

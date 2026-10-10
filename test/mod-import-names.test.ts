// A mod hook file declares no top-level name it also imports. The kit's own `tsc` does not cover
// `mod/` (its types come from a live Claude Code session), and type stripping erases a type-only
// import, so a clash between an imported type and a local one runs without a word while the
// local one silently types the imported module's values. This holds what `tsc` would.
//
//   pnpm test:file test/mod-import-names.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const HOOKS = join(import.meta.dirname, "..", "mod", "hooks");

/** The local names a file's imports bind: `a`, `type B`, `c as d` give a, B and d. */
const imported = (source: string): string[] =>
  [...source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from/gm)].flatMap((m) =>
    m[1]
      .split(",")
      .map((part) => part.trim().replace(/^type\s+/, ""))
      .filter(Boolean)
      .map((part) => part.split(/\s+as\s+/).pop()!.trim()),
  );

/** The names a file declares at its top level. */
const declared = (source: string): string[] =>
  [...source.matchAll(/^(?:export\s+)?(?:declare\s+)?(?:type|interface|const|let|var|class|(?:async\s+)?function\*?)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);

test("the name readers see imports and declarations", () => {
  const source = 'import { a, type B, c as d } from "./x.ts";\nimport type { E } from "./y.ts";\ntype B = 1;\nexport const f = 2;\nasync function g() {}\n';
  assert.deepEqual(imported(source), ["a", "B", "d", "E"]);
  assert.deepEqual(declared(source), ["B", "f", "g"]);
});

test("no mod hook file declares a name it also imports", () => {
  const files = readdirSync(HOOKS).filter((f) => /\.tsx?$/.test(f));
  assert.ok(files.includes("register.tsx"), "mod/hooks/register.tsx is where it was");
  for (const file of files) {
    const source = readFileSync(join(HOOKS, file), "utf8");
    const local = new Set(declared(source));
    const clashes = imported(source).filter((name) => local.has(name));
    assert.deepEqual(clashes, [], `mod/hooks/${file} imports and declares ${clashes.join(", ")}`);
  }
});

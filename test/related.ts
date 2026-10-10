// Prints the test files that cover a change: every test/*.test.ts that mentions any given file -
// by its repo-relative path, or its basename without the extension - or any name that file
// exports. `pnpm test:related <files...>` runs what this prints through the same runner as
// `test:file`. A test file given as an argument is itself in the list.
//
//   node test/related.ts src/land.ts status.sh
//
// The list is on stdout, one path per line, and a note on stderr. A match is a guess in the
// generous direction: a name that is also an ordinary word picks up a test too many, which costs
// seconds, where a test too few is the failure this exists to prevent (a test that pins source text
// or wording fails in the ticket's gate, not in the file the agent ran). `-` counts as part of a
// word, so `land` does not match `land-command`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const standalone = (term: string) => new RegExp(`(?<![\\w$-])${escape(term)}(?![\\w$-])`);

/** Names a module exports: declarations, and the names a `export { a, b as c }` list gives. */
const exportedNames = (source: string): string[] => {
  const names = new Set<string>();
  for (const m of source.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|abstract\s+class|type|interface)\s+([\w$]+)/gm)) names.add(m[1]!);
  for (const m of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const item of m[1]!.split(",")) {
      const name = item.trim().split(/\s+as\s+/).pop()!.trim();
      if (/^[\w$]+$/.test(name) && name !== "default") names.add(name);
    }
  }
  return [...names];
};

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: pnpm test:related <file>...  (a path in the repository: src/land.ts, status.sh)");
  process.exit(2);
}

const terms: RegExp[] = [];
const given = new Set<string>();
for (const arg of files) {
  const abs = resolve(arg);
  const rel = relative(root, abs).split("\\").join("/");
  const inside = !rel.startsWith("../") && rel !== "..";
  const path = inside ? rel : arg;
  if (/^test\/[^/]+\.test\.ts$/.test(path) && existsSync(abs)) given.add(path);
  terms.push(standalone(path));
  const stem = basename(path, extname(path));
  if (stem) terms.push(standalone(stem));
  if (existsSync(abs) && /\.[cm]?[jt]sx?$/.test(path)) {
    for (const name of exportedNames(readFileSync(abs, "utf8"))) terms.push(standalone(name));
  }
}

const dir = join(root, "test");
const related = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `test/${f}`)
  .filter((f) => given.has(f) || ((text) => terms.some((t) => t.test(text)))(readFileSync(join(root, f), "utf8")))
  .sort();

if (related.length === 0) console.error(`No test file mentions ${files.join(", ")} (or what it exports): nothing to run.`);
else console.error(`${related.length} test file${related.length === 1 ? "" : "s"} mention ${files.join(", ")} or what it exports:\n${related.map((f) => `  ${f}`).join("\n")}`);
console.log(related.join("\n"));

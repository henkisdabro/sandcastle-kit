// The status view loads none of the run's modules: it starts in a pane, and `test/status.test.sh` starts it once per
// frame, so a module the view reaches by a value import is paid on every start. The drain's end line (src/autonomy.ts,
// which src/status-rows.ts imports for `needsDecision`) words its time, span and tokens with src/figures.ts for that
// reason: taking them from src/run.ts made every start load the run's modules, about four times the view's own.
// The walk follows the static imports the runtime keeps (not `import type`), from the view's entry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

/** The repository paths `entry` reaches through the static value imports and re-exports of the kit's own modules. */
const reached = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const walk = (file: string) => {
    const path = relative(ROOT, file);
    if (seen.has(path)) return;
    seen.add(path);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\s)(?:[^;"']*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm)) walk(join(dirname(file), m[1]));
  };
  walk(join(ROOT, entry));
  return seen;
};

test("the status view's imports reach none of the run's modules", () => {
  const graph = reached("src/status-view.ts");
  // The walk does find the view's own modules, so an empty graph cannot pass.
  for (const own of ["src/status-rows.ts", "src/autonomy.ts", "src/figures.ts"]) assert.ok(graph.has(own), `${own} not reached: ${[...graph].join(", ")}`);
  for (const heavy of ["src/run.ts", "src/report.ts", "src/gates.ts", "src/burndown.ts"]) {
    assert.ok(!graph.has(heavy), `the status view loads ${heavy}: ${[...graph].sort().join(", ")}`);
  }
});

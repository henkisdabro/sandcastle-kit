// macOS CI runs `bash` 3.2, which cannot `source <(...)`: the function is never defined and the test
// fails there alone, while Linux and a Homebrew bash 5 pass it. A test that reads functions out of
// status.sh uses `eval "$(sed ...)"`, which every bash does.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("no test sources a process substitution (bash 3.2 on macOS cannot)", () => {
  const here = import.meta.dirname;
  const sourcing = new RegExp(["source", "\\s+<\\("].join(""));
  const offenders = readdirSync(here)
    .filter((f) => /\.(ts|sh)$/.test(f) && f !== "bash32-source.test.ts")
    .filter((f) => sourcing.test(readFileSync(join(here, f), "utf8")));
  assert.deepEqual(offenders, [], `use eval "$(...)" instead of sourcing a process substitution in: ${offenders.join(", ")}`);
});

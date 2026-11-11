// `sandcastle doctor` warns on a git that runs the kit (2.31 or newer) but cannot check a conflict resolution
// against git's own merge (that needs 2.38): such a run lets every resolution go on unchecked, and doctor says so
// before any run. Below 2.31 the git check itself prints a FIX, so the warning stays out. No Docker, model or network.
//
//   pnpm test:file test/doctor-git-stray-check.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

const { gitStrayCheckLine } = await import("../src/doctor.ts");

test("doctor warns on git 2.31 to 2.37 that conflict resolutions are not checked, with the install hint", () => {
  for (const [answer, version] of [
    ["git version 2.37.1", "2.37"],
    ["git version 2.37.1 (Apple Git-137.1)", "2.37"],
    ["git version 2.31.0", "2.31"],
  ]) {
    const line = gitStrayCheckLine(answer, false);
    assert.ok(line, `a warning for ${answer}`);
    assert.match(line, new RegExp(`^warn git ${version.replace(".", "\\.")}: conflict resolutions are not checked against git's own merge below 2\\.38`));
    assert.match(line, /Install git 2\.38 or newer: `sudo apt install git`/);
  }
  assert.match(gitStrayCheckLine("git version 2.37.1 (Apple Git-137.1)", true) ?? "", /Install git 2\.38 or newer: `xcode-select --install` or `brew install git`/);
});

test("doctor gives no stray-check warning on git 2.38 or newer, nor below 2.31, where the git check's FIX speaks", () => {
  for (const answer of ["git version 2.38.0", "git version 2.43.0", "git version 3.0.0", "git version 2.30.0", "no version here"]) {
    assert.equal(gitStrayCheckLine(answer, false), undefined, answer);
  }
});

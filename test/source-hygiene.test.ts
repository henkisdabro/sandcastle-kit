// Two checks over every tracked file, so neither depends on a hand-kept list:
// - every shell script parses: the `bash -n` lists in the docs and CI had drifted, and a script
//   added later (herdr/entry.sh) was never checked; the host's scripts parse under bash 3.2 as
//   well, where there is one;
// - no invisible character sits raw in a source file: an editor tool once wrote `\u200b` and
//   `\u202e` as the characters themselves, and esbuild failed on a regex it could no longer read.
//   Write them as escapes.
// Reads the git index of this checkout (or walks it); no Docker, gh, model calls or network.
//
//   pnpm exec tsx --test test/source-hygiene.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const KIT = dirname(dirname(fileURLToPath(import.meta.url)));
// A checkout whose git cannot be read (a worktree mounted into a container without its main
// repository) is walked instead, so the gate stays green there.
const walk = (dir: string): string[] =>
  readdirSync(join(KIT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return [".git", "node_modules", ".sandcastle", ".claude"].includes(e.name) ? [] : walk(p);
    return e.isFile() ? [p] : [];
  });
const listed = () => {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: KIT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  } catch {
    return walk("");
  }
};
const tracked = listed();
const text = (path: string) => {
  try {
    return readFileSync(join(KIT, path), "utf8");
  } catch {
    return ""; // deleted in the working tree but still in the index
  }
};

const shellScripts = tracked.filter((p) => p.endsWith(".sh") || /^#!.*\b(ba)?sh\b/.test(text(p).split("\n")[0]));

test("the shell scripts are found", () => {
  for (const p of ["status.sh", "bin/sandcastle", ".githooks/pre-commit", "container/git-guard.sh", "herdr/entry.sh"]) {
    assert.ok(shellScripts.includes(p), `${p} not found among ${shellScripts.join(", ")}`);
  }
});

test("every shell script parses", () => {
  for (const p of shellScripts) execFileSync("bash", ["-n", join(KIT, p)], { stdio: "pipe" });
});

// The `bash` on PATH is bash 5 on Linux and on a Mac with Homebrew's, so it is no 3.2 check; the
// host's scripts run under 3.2 on a Mac without it. macOS's own /bin/bash is 3.2, and this
// repository's sandbox image builds it as bash32. `container/` runs only in the Linux sandbox.
const isBash32 = (bash: string) => {
  try {
    return /version 3\.2\./.test(execFileSync(bash, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return false;
  }
};
const bash32s = ["/bin/bash", "/usr/local/bin/bash32"].filter((b) => existsSync(b) && isBash32(b));

test("every host shell script parses under bash 3.2", { skip: bash32s.length === 0 && "no bash 3.2 here (macOS's /bin/bash, or bash32 in this repository's sandbox image)" }, () => {
  for (const bash of bash32s) {
    for (const p of shellScripts.filter((p) => !p.startsWith("container/"))) execFileSync(bash, ["-n", join(KIT, p)], { stdio: "pipe" });
  }
});

// C0 controls but tab, newline, carriage return and escape (status.sh's colours are written as
// ESC bytes in places); C1 controls; zero-width and joiner characters; bidi embeddings, overrides
// and isolates; the byte-order mark. A zero-width joiner between two emoji is how a person
// emoji is spelt (the README's), so only that use is let through.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const SOURCE = /\.(ts|tsx|js|mjs|sh|md|json|toml|html|css|yml|yaml)$|^bin\/|^\.githooks\//;

test("no source file holds a raw invisible character", () => {
  const found: string[] = [];
  for (const p of tracked.filter((p) => SOURCE.test(p))) {
    text(p)
      .split("\n")
      .forEach((line, i) => {
        const m = line.replace(/(?<=\p{Extended_Pictographic}\ufe0f?)\u200d(?=\p{Extended_Pictographic})/gu, "").match(INVISIBLE);
        if (m) found.push(`${p}:${i + 1} U+${m[0].codePointAt(0)!.toString(16).padStart(4, "0")}`);
      });
  }
  assert.deepEqual(found, []);
});

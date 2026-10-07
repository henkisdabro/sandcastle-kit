// Three checks over every tracked file, so none depends on a hand-kept list:
// - every shell script parses: the `bash -n` lists in the docs and CI had drifted, and a script
//   added later (herdr/entry.sh) was never checked; the host's scripts parse under bash 3.2 as
//   well, where there is one;
// - no invisible character sits raw in a source file: an editor tool once wrote `\u200b` and
//   `\u202e` as the characters themselves, and esbuild failed on a regex it could no longer read.
//   Write them as escapes;
// - no tracked file names a real home directory: only the outbound scan in test/full-check.sh
//   caught one, and that never runs in a sandbox gate.
// Reads the git index of this checkout (or walks it); no Docker, gh, model calls or network.
//
//   node --test test/source-hygiene.test.ts

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

// A real home directory in a tracked file (a name under `/Users` or `/home`) is a leak, and the
// outbound scan in test/full-check.sh (`home_paths`) is where the rule comes from: it runs on a
// contributor's machine before a push, never in a sandbox gate, so an agent's fixture with one
// passed every gate and landed. Run here, the same rule fails the gate. `home` must start a path
// (a repo path such as `site/home/index.html` is no home); the placeholder homes are fine, and a
// line naming one is skipped whole, as `grep -v` does there.
const HOME_PATH = "(/Users|(^|[^A-Za-z0-9_.-])/home)/[a-z]";
const PLACEHOLDER_HOME = "/home/(user|node|agent)\\b";
const homePathHits = (paths: string[], read: (path: string) => string): string[] => {
  const real = new RegExp(HOME_PATH);
  const placeholder = new RegExp(PLACEHOLDER_HOME);
  return paths.flatMap((p) => {
    const body = read(p);
    if (body.includes("\0")) return []; // an image or other binary
    return body
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => real.test(line) && !placeholder.test(line))
      .map(({ line, n }) => `${p}:${n}: ${line.trim()}`);
  });
};

test("a home-directory path names its file and line", () => {
  // Built from parts: this file is itself scanned.
  const alice = "/" + "Users/alice/x";
  const linux = "/" + "home/bob/.config";
  const files: Record<string, string> = {
    "test/fixture.ts": `const a = 1;\nconst p = "${alice}";\n`,
    "docs/x.md": `see ${linux}\n`,
    "ok.md": "/home/user/x, /home/node/y and site/home/index.html and " + "/" + "Users/<name>\n",
  };
  assert.deepEqual(homePathHits(Object.keys(files), (p) => files[p]), [`test/fixture.ts:2: const p = "${alice}";`, `docs/x.md:1: see ${linux}`]);
});

test("a binary file is not read for home paths", () => {
  assert.deepEqual(homePathHits(["a.gif"], () => "\0/" + "Users/alice/x"), []);
});

test("the home-path rule is the one test/full-check.sh scans with", () => {
  const scan = text("test/full-check.sh");
  assert.ok(scan.includes(`'${HOME_PATH}'`), "test/full-check.sh's home_paths drifted from HOME_PATH");
  assert.ok(scan.includes(`'${PLACEHOLDER_HOME}'`), "test/full-check.sh's home_paths drifted from PLACEHOLDER_HOME");
});

test("no tracked file names a real home directory", () => {
  assert.deepEqual(homePathHits(tracked, text), [], "a real home directory in a tracked file (the rule is home_paths in test/full-check.sh): write a placeholder such as /home/user");
});

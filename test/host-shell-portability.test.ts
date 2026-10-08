// The host's shell scripts run on users' Macs, where `#!/usr/bin/env bash` is bash 3.2 unless
// Homebrew's bash comes first, and the tools are BSD's. Only status.sh is run under 3.2 by CI, and
// shellcheck has no 3.2 dialect, so a bash 4 construct or a GNU-only flag in another script
// (bin/sandcastle, herdr/entry.sh, test/in-temp.sh...) passed every check on Linux and broke on a
// Mac. This lint reads every tracked shell script outside `container/` (which runs only in the
// Linux sandbox) for them. A comment is not read; a line that must keep one says why in an allow
// comment on the same line: `# portability-ok: <reason>`.
// Reads the git index of this checkout (or walks it); no Docker, gh, model calls or network.
//
//   pnpm test:file test/host-shell-portability.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const KIT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASH32 = "/usr/local/bin/bash32";

// A checkout whose git cannot be read (a worktree mounted into a container without its main
// repository) is walked instead, as test/source-hygiene.test.ts does.
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
const text = (path: string) => {
  try {
    return readFileSync(join(KIT, path), "utf8");
  } catch {
    return ""; // deleted in the working tree but still in the index
  }
};
const hostScripts = listed()
  .filter((p) => !p.startsWith("container/"))
  .filter((p) => p.endsWith(".sh") || /^#!.*\b(ba)?sh\b/.test(text(p).split("\n")[0]));

// Option clusters before the one that matters (`sed -n -r`, `date -u -d`); a non-option argument
// ends the chain, so a later command's flag on the same line is not read as this one's.
const opts = String.raw`(?:\s+-[A-Za-z][^\s;|&)]*)*\s+`;
const RULES: [name: string, pattern: RegExp, fine?: RegExp][] = [
  // bash 4 and later
  ["declare -A", /\b(?:declare|typeset|local)(?:\s+-[A-Za-z]+)*\s+-[A-Za-z]*A/],
  ["declare -n/-g", /\b(?:declare|typeset|local)(?:\s+-[A-Za-z]+)*\s+-[A-Za-z]*[ng]/],
  ["mapfile/readarray", /(?:^|[\s;&|(])(?:mapfile|readarray)\b/],
  ["case modification", /\$\{[#!]?[A-Za-z_][A-Za-z_0-9]*(?:\[[^\]]*\])?(?:,|\^)/],
  ["|&", /\|&/],
  [";& or ;;&", /;;?&/],
  ["[[ -v", /\[\[?\s+-v\s/],
  ["wait -n", /\bwait\s+-n\b/],
  ["EPOCHSECONDS/EPOCHREALTIME", /\bEPOCH(?:SECONDS|REALTIME)\b/],
  ["globstar", /\bshopt\s+-s\b.*\bglobstar\b/],
  ["negative substring length", /\$\{[A-Za-z_][A-Za-z_0-9]*(?:\[[^\]]*\])?:(?![-=?+])[^:}]*:\s*-/],
  // Built from parts so test/bash32-source.test.ts, which reads this file, does not see it.
  ["source of a process substitution", new RegExp(String.raw`(?:^|[\s;&|(])(?:source|\.)\s+<\(`)],
  // GNU-only flags
  ["sed -i with no suffix", new RegExp(String.raw`\bsed${opts}-[A-Za-z]*i(?:\s|$)`)],
  ["sed -r", new RegExp(String.raw`\bsed${opts}-[A-Za-z]*r`)],
  ["date -d", new RegExp(String.raw`\bdate${opts}(?:-[A-Za-z]*d|--date\b)`), /\|\|.*\bdate\b.*\s-[jrf]\b|\bdate\b.*\s-[jrf]\b.*\|\|/],
  ["stat -c", new RegExp(String.raw`\bstat${opts}(?:-[A-Za-z]*c|--(?:format|printf)\b)`), /\|\|.*\bstat\b.*\s-f\b|\bstat\b.*\s-f\b.*\|\|/],
  ["readlink -f", new RegExp(String.raw`\breadlink${opts}-[A-Za-z]*[fem]`)],
  ["grep -P", new RegExp(String.raw`\b[ef]?grep${opts}(?:-[A-Za-z]*P|--perl-regexp\b)`)],
  ["xargs -r", new RegExp(String.raw`\bxargs${opts}(?:-[A-Za-z]*r|--no-run-if-empty\b)`)],
  ["find -printf", /\bfind\b.*\s-f?printf\b/],
  ["du -b", new RegExp(String.raw`\bdu${opts}(?:-[A-Za-z]*b|--bytes\b)`)],
  ["base64 -w", new RegExp(String.raw`\bbase64${opts}(?:-[A-Za-z]*w|--wrap\b)`)],
  // Command position: after a separator, a keyword that runs a command (`if timeout 5 x; then`)
  // or a command that runs one, and any `NAME=value` prefixes.
  ["bare timeout", /(?:^|[;&|(`{!]|\b(?:if|elif|while|until|then|do|else|exec|time|command|env|nohup)\s)\s*(?:[A-Za-z_][A-Za-z_0-9]*=\S*\s+)*timeout(?:\s|$)/],
];

/** A line with its comment cut off: a `#` that starts a word outside quotes (not `$#` or `${#x}`). */
const code = (line: string) => {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
    } else if (c === "\\") i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
};

const ALLOW = /#\s*portability-ok:\s*\S/;

/** `name:line rule` for each bash 4 construct or GNU-only flag in a host script's text. */
const lint = (name: string, script: string) =>
  script.split("\n").flatMap((line, i) => {
    if (ALLOW.test(line)) return [];
    const c = code(line);
    return RULES.filter(([, pattern, fine]) => pattern.test(c) && !(fine && fine.test(c))).map(([rule]) => `${name}:${i + 1} ${rule}`);
  });

test("the host's shell scripts are found, and the sandbox's are not among them", () => {
  for (const p of ["status.sh", "bin/sandcastle", ".githooks/pre-commit", "herdr/entry.sh", "test/in-temp.sh", "test/run-shards.sh"]) {
    assert.ok(hostScripts.includes(p), `${p} not found among ${hostScripts.join(", ")}`);
  }
  assert.ok(!hostScripts.includes("container/git-guard.sh"));
});

test("no host shell script uses a bash 4 construct or a GNU-only flag", () => {
  assert.deepEqual(hostScripts.flatMap((p) => lint(p, text(p))), []);
});

// One line per rule, each written the way a script would write it.
const CASES: [rule: string, line: string][] = [
  ["declare -A", "declare -A seen=()"],
  ["declare -A", "local -A seen"],
  ["declare -n/-g", "declare -n ref=$1"],
  ["declare -n/-g", "declare -g total=0"],
  ["mapfile/readarray", "mapfile -t lines < file"],
  ["mapfile/readarray", "readarray -t lines < file"],
  ["case modification", 'echo "${name,,}"'],
  ["case modification", 'echo "${name^^}"'],
  ["|&", "make |& tee log"],
  [";& or ;;&", "  a) echo a ;&"],
  [";& or ;;&", "  a) echo a ;;&"],
  ["[[ -v", 'if [[ -v HOME ]]; then echo set; fi'],
  ["wait -n", "wait -n"],
  ["EPOCHSECONDS/EPOCHREALTIME", 'now=$EPOCHSECONDS'],
  ["EPOCHSECONDS/EPOCHREALTIME", 'now=${EPOCHREALTIME}'],
  ["globstar", "shopt -s globstar"],
  ["negative substring length", 'echo "${line:1:-1}"'],
  ["negative substring length", 'echo "${line::-1}"'],
  ["source of a process substitution", ["source", "<(sed -n 1p f)"].join(" ")],
  ["source of a process substitution", [".", "<(sed -n 1p f)"].join(" ")],
  ["sed -i with no suffix", "sed -i 's/a/b/' f"],
  ["sed -i with no suffix", "sed -n -i -e 's/a/b/' f"],
  ["sed -r", "sed -r 's/(a)+/b/' f"],
  ["sed -r", "sed -nr 's/(a)+/b/p' f"],
  ["date -d", 'date -d "$when" +%s'],
  ["date -d", 'date -u --date=@1 +%s'],
  ["stat -c", "stat -c %s f"],
  ["readlink -f", 'dir=$(readlink -f "$0")'],
  ["grep -P", "grep -oP '\\d+' f"],
  ["xargs -r", "ls | xargs -r rm"],
  ["find -printf", "find . -type f -printf '%s\\n'"],
  ["du -b", "du -sb dir"],
  ["base64 -w", "base64 -w0 f"],
  ["bare timeout", "timeout 5 make"],
  ["bare timeout", "out=$(timeout 5 make)"],
  ["bare timeout", "make && timeout 5 make check"],
  ["bare timeout", "if timeout 5 make; then echo ok; fi"],
  ["bare timeout", "while timeout 1 read -r line; do :; done"],
  ["bare timeout", "! timeout 5 make"],
  ["bare timeout", "{ timeout 5 make; }"],
  ["bare timeout", "LC_ALL=C timeout 5 make"],
  ["bare timeout", "env LC_ALL=C timeout 5 make"],
];

test("each bash 4 construct and GNU-only flag is caught, one rule per case", () => {
  for (const [rule, line] of CASES) assert.deepEqual(lint("fixture.sh", `#!/usr/bin/env bash\n${line}\n`), [`fixture.sh:2 ${rule}`], line);
});

test("the 3.2-safe and portable forms pass", () => {
  const fine = [
    'echo "${#name} ${name:-x} ${name:=y} ${name: -1} ${name:1:2} $#"',
    "local -a list=() n=0",
    "declare -r KIT=/x",
    "sed -i.bak 's/a/b/' f && rm f.bak",
    "sed -E 's/(a)+/b/' f",
    "sed -n 's/a/b/p' f | grep -c x -r",
    'date -r 1 +%s 2>/dev/null || date -d @1 +%s',
    'date -d @1 +%s 2>/dev/null || date -r 1 +%s',
    "stat -f %z f 2>/dev/null || stat -c %s f",
    "readlink \"$src\"",
    "grep -E '[0-9]+' f",
    "find . -name x -print",
    "du -sk dir",
    "base64 < f | tr -d '\\n'",
    "timeout=5",
    "local timeout=5",
    "x=1 timeout=5",
    'echo "${timeout}" "$!"',
    'echo "$timeout"',
    'case $x in a) echo a ;; esac',
    "echo hi 2>&1 | cat",
    "# timeout 5 make, sed -i, declare -A: a comment is not read",
    "echo ok # date -d is in a comment here",
    "timeout 5 make # portability-ok: run only where coreutils is installed",
  ];
  assert.deepEqual(lint("fine.sh", fine.join("\n")), []);
});

test("an allow comment exempts its line only when it gives a reason", () => {
  assert.deepEqual(lint("f.sh", "timeout 5 make # portability-ok:"), ["f.sh:1 bare timeout"]);
});

// Parsing is not running: a 3.2 that runs the launcher is the check that bin/sandcastle starts on
// a Mac without Homebrew's bash. Only this repository's sandbox image builds that bash.
test("bin/sandcastle starts the kit under bash 3.2", { skip: !existsSync(BASH32) && "no bash32 here (this repository's sandbox image builds it)" }, () => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-bash32-launcher-"));
  // node from the test's own process, ahead of PATH: a version manager's shim may not resolve outside a project.
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, GIT_CEILING_DIRECTORIES: tmpdir() };
  const r = spawnSync(BASH32, [join(KIT, "bin/sandcastle"), "help"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGKILL" });
  assert.equal(r.status, 0, `status ${r.status} signal ${r.signal}: ${r.stderr}`);
  assert.match(r.stdout, /sandcastle/);
});

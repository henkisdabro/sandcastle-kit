// What the Herdr plugin's pagers (herdr/entry.sh) tell a person about closing them: the prompt
// handed to less says plainly which key closes the popup, never "interrupt", and no lesskey
// file or LESSSECURE change is involved. The popup itself cannot be gated, so a person presses
// the keys in a real popup. A fake `less` records its arguments; no Herdr, no terminal.
//
//   node --test test/herdr-entry.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const KIT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = readFileSync(join(KIT, "herdr/entry.sh"), "utf8");
const MANIFEST = readFileSync(join(KIT, "herdr/herdr-plugin.toml"), "utf8");

// A kit of its own (entry.sh beside a fake bin/sandcastle), so the report branch runs no real report.
const root = mkdtempSync(join(tmpdir(), "sandcastle-entry-"));
mkdirSync(join(root, "herdr"));
mkdirSync(join(root, "bin"));
copyFileSync(join(KIT, "herdr/entry.sh"), join(root, "herdr/entry.sh"));
writeFileSync(join(root, "bin/sandcastle"), "#!/bin/sh\necho report text\n");
chmodSync(join(root, "bin/sandcastle"), 0o755);
const fakeBin = join(root, "fake-bin");
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, "less"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_LESS_OUT"\ncat >/dev/null 2>&1 </dev/null\n`);
chmodSync(join(fakeBin, "less"), 0o755);

const pagerArgs = (verb: string, lines = 0) => {
  const log = join(root, `log-${verb}-${lines}.log`);
  writeFileSync(log, Array.from({ length: lines }, (_, i) => `line ${i + 1}\n`).join(""));
  const out = join(root, `out-${verb}-${lines}`);
  const r = spawnSync("sh", [join(root, "herdr/entry.sh"), verb], {
    env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, SANDCASTLE_LOG: log, FAKE_LESS_OUT: out },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(out, "utf8").trimEnd().split("\n");
};

// The prompt (-Ps) and, for a log, the message drawn while following (-Pw).
const promptOf = (args: string[], kind: "s" | "w") => {
  const p = args.filter((a) => a.startsWith(`-P${kind}`));
  assert.equal(p.length, 1, `one -P${kind} in ${args.join(" ")}`);
  return p[0];
};
const prompt = (args: string[]) => promptOf(args, "s");

test("a finished or short log's prompt says q closes and F follows", () => {
  const p = prompt(pagerArgs("log", 5));
  assert.match(p, /^-Ps/, "the short prompt, explicitly");
  assert.match(p, /-Psq closes this popup/);
  assert.match(p, /\bF follows new lines\b/);
});

test("a followed log keeps the same prompt, and Ctrl-C still closes it (-K)", () => {
  const args = pagerArgs("log", 100);
  assert.ok(args.includes("-K") && args.includes("+F"));
  assert.equal(prompt(args), prompt(pagerArgs("log", 5)));
  assert.match(prompt(args), /Ctrl-C/);
});

test("while following, less's waiting message names Ctrl-C in place of 'Waiting for data'", () => {
  for (const args of [pagerArgs("log", 100), pagerArgs("log", 5)]) {
    assert.match(promptOf(args, "w"), /^-PwFollowing new lines - Ctrl-C closes this popup$/);
  }
});

test("a short log, once F follows it, closes on Ctrl-C too, as its prompt says (-K)", () => {
  const args = pagerArgs("log", 5);
  assert.ok(args.includes("-K"), args.join(" "));
  assert.ok(!args.includes("+F"));
});

test("the report popup's prompt says q closes", () => {
  assert.match(prompt(pagerArgs("report")), /-Psq closes this popup/);
});

test("no prompt says interrupt, and none uses less's prompt metacharacters", () => {
  for (const args of [pagerArgs("log", 5), pagerArgs("log", 100), pagerArgs("report")]) {
    for (const p of args.filter((a) => a.startsWith("-P"))) {
      assert.doesNotMatch(p, /interrupt/i);
      assert.doesNotMatch(p, /[%?:.\\]/, "a metacharacter would change what less draws");
    }
  }
});

test("the pager stays the restricted one, with no lesskey file", () => {
  assert.match(ENTRY, /^export LESSSECURE=1$/m);
  assert.doesNotMatch(ENTRY, /LESSSECURE_ALLOW|lesskey|LESSKEY|\s-k\s/);
});

test("the manifest's popup titles say how each closes", () => {
  assert.match(MANIFEST, /^title = "Sandcastle report - q closes"$/m);
  assert.match(MANIFEST, /^title = "Sandcastle ticket - q or Esc closes"$/m);
});

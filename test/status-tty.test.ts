// The live status view and the terminal's input side: typed keys and the
// mouse wheel (arrow keys on the alternate screen) were echoed onto the frame
// and left queued for the shell after exit. Run on a pty from `script`, with a
// `sleep` that reports the tty's flags mid-loop and a wrapper that reports them
// again once the view has exited. No Docker, no network, no model calls.
//
//   node --test test/status-tty.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-tty-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const REPO = join(TMP, "repo");
const FAKE = join(TMP, "bin");
mkdirSync(join(REPO, ".sandcastle"), { recursive: true });
mkdirSync(FAKE);
const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};
script(join(FAKE, "sandcastle"), "#!/bin/sh\necho '[]'\n");
script(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");
const git = (...a: string[]) => spawnSync("git", ["-C", REPO, "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");

// The view's own `sleep` is the loop's only pause: with this one it records the
// terminal's flags while the view is live, as its second frame is about to start.
const DURING = join(TMP, "during");
script(join(FAKE, "sleep"), `#!/bin/sh\nstty -a </dev/tty >"${DURING}" 2>&1\nexit 0\n`);

const AFTER = join(TMP, "after");
const BEFORE = join(TMP, "before");
const wrapper = join(TMP, "wrapper.sh");
script(
  wrapper,
  `#!/bin/sh
stty -g </dev/tty >"${BEFORE}"
bash "${join(KIT, "status.sh")}" 1
stty -g </dev/tty >"${AFTER}"
`,
);

// util-linux and BSD `script` differ in syntax; no stdin, as BSD refuses Node's socket.
const onPty = () => {
  const args = process.platform === "linux" ? ["-qec", `sh '${wrapper}'`, "/dev/null"] : ["-q", "/dev/null", "sh", wrapper];
  return spawnSync("script", args, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FAKE}:${process.env.PATH}`, SANDCASTLE_PROJECT: REPO, SANDCASTLE_BASE: "main", STATUS_FRAMES: "2" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
};
// BSD sets PENDIN (0x20000000) in lflag whenever a tty goes back to canonical mode, so a
// restored state reads one bit apart on macOS though nothing is left changed. Linux never reports it.
const settled = (stty: string) =>
  stty.replace(/\blflag=([0-9a-f]+)/, (_, hex: string) => `lflag=${(parseInt(hex, 16) & ~0x20000000).toString(16)}`);
const hasScript = spawnSync("script", ["--version"], { stdio: "ignore" }).error === undefined;

test("live view turns echo and alternate scroll off, and puts both back", { skip: hasScript ? false : "script(1) is not installed" }, () => {
  const r = onPty();
  assert.ok(r.stdout.includes("\x1b[?1049h"), `no frame drawn: ${r.stderr}`);
  const during = readFileSync(DURING, "utf8");
  assert.match(during, /-echo\b/, "echo left on while the view is live");
  assert.match(during, /-icanon\b/, "input left line-buffered while the view is live");
  assert.match(during, /(^|\s)isig\b/, "isig turned off: Ctrl-C would no longer stop the view");
  const out = r.stdout;
  const off = out.indexOf("\x1b[?1007l");
  const on = out.indexOf("\x1b[?1007h");
  assert.ok(off >= 0 && off < out.indexOf("\x1b[2J"), "alternate scroll not turned off on entry");
  assert.ok(on > off && on < out.lastIndexOf("\x1b[?1049l"), "alternate scroll not put back on exit");
  assert.equal(settled(readFileSync(AFTER, "utf8")), settled(readFileSync(BEFORE, "utf8")), "tty state not restored on exit");
});

test("without a terminal the view still runs and leaves no stty error", () => {
  const r = spawnSync("bash", [join(KIT, "status.sh"), "1"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FAKE}:${process.env.PATH}`, SANDCASTLE_PROJECT: REPO, SANDCASTLE_BASE: "main", STATUS_FRAMES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/stty|tty/i.test(r.stderr), r.stderr);
});

// Ctrl-C runs `restore` twice: from the INT trap, then from the EXIT trap its
// `exit` fires. The second one found the tty back in canonical mode, and its
// drain then blocked reading /dev/tty until lines were typed - the view hung
// on Ctrl-C and ate what came next. The view's `sleep` here interrupts it the
// way Ctrl-C does, and a reader on the pty's other side never types a line.
test("Ctrl-C stops the live view at once and puts the tty back", { skip: hasScript ? false : "script(1) is not installed" }, () => {
  const fake = join(TMP, "bin-int");
  mkdirSync(fake);
  for (const f of ["sandcastle", "docker"]) script(join(fake, f), readFileSync(join(FAKE, f), "utf8"));
  script(join(fake, "sleep"), "#!/bin/sh\nkill -INT $PPID\nexec /bin/sleep 30\n");
  const before = join(TMP, "int-before");
  const afterF = join(TMP, "int-after");
  const wrap = join(TMP, "wrapper-int.sh");
  script(
    wrap,
    `#!/bin/sh
stty -g </dev/tty >"${before}"
bash "${join(KIT, "status.sh")}" 1
echo "status=$?" >"${afterF}"
stty -g </dev/tty >>"${afterF}"
`,
  );
  const args = process.platform === "linux" ? ["-qec", `sh '${wrap}'`, "/dev/null"] : ["-q", "/dev/null", "sh", wrap];
  const r = spawnSync("script", args, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, SANDCASTLE_PROJECT: REPO, SANDCASTLE_BASE: "main" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
  });
  assert.equal(r.error, undefined, `the view hung after Ctrl-C: ${r.error}`);
  assert.equal(settled(readFileSync(afterF, "utf8")), `status=130\n${settled(readFileSync(before, "utf8"))}`, "view did not exit 130 with the tty restored");
});

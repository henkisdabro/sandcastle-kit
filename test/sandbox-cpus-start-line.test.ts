// A run's start line names both CPU limits: a ticket's sandbox gets the VM's CPUs divided by the
// run's concurrency, and the landing, base and verify gates (one at a time, setting the run's end)
// get them divided by `maxGates`. The kit runs as a child process (`run --dry`, which stops after
// the start lines) against a fake `docker` that answers `info` with a made-up VM; no Docker, no
// model, no network.
//
//   pnpm exec tsx --test test/sandbox-cpus-start-line.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-cpus-start-")));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Linux checks the runtime before a run starts, and a run as root is refused on every system.
const linux = process.platform === "linux";
const normalUser = process.getuid?.() !== 0;

let n = 0;
/** A committed project with one queued ticket, on a made-up VM of `ncpu` CPUs; `machine` is the personal config.json, if any. */
const start = (o: { ncpu: number; config?: string; machine?: string; args?: string[] }) => {
  const dir = join(TMP, `case-${n++}`);
  const bin = join(dir, "bin");
  const repo = join(dir, "project");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, "xdg/sandcastle-kit"), { recursive: true });
  if (o.machine) writeFileSync(join(dir, "xdg/sandcastle-kit/config.json"), o.machine);
  const info = `{"NCPU":${o.ncpu},"MemTotal":34359738368,"OperatingSystem":"Ubuntu 24.04","SecurityOptions":["name=seccomp,profile=builtin","name=cgroupns"]}`;
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
case "$*" in
  "info --format {{json .}}") echo '${info}' ;;
  --version) echo 'Docker version 29.4.0, build 9d7ad9f' ;;
  "version --format {{json .Server}}") echo '{"Platform":{"Name":"Docker Engine - Community"},"Components":[{"Name":"Engine"}],"Version":"29.4.0"}' ;;
  ps*) ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  for (const name of ["gh", "jq"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  mkdirSync(join(repo, ".sandcastle"), { recursive: true });
  mkdirSync(join(repo, ".scratch/demo/issues"), { recursive: true });
  writeFileSync(join(repo, ".sandcastle/config.ts"), `export default { name: "demo", tracker: "files", gates: [{ name: "t", command: "true" }]${o.config ?? ""} };\n`);
  writeFileSync(join(repo, ".scratch/demo/issues/01-first.md"), "# First ticket\n\nStatus: ready-for-agent\n\nDo the first thing.\n");
  writeFileSync(join(repo, ".gitignore"), ".sandcastle/logs/\n.sandcastle/.env\n.sandcastle/.run/\n.sandcastle/worktrees/\n");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const r = runKit(["run", "--dry", ...(o.args ?? [])], {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "xdg"),
      XDG_CACHE_HOME: join(dir, "cache"),
      GIT_CEILING_DIRECTORIES: tmpdir(),
      // Versions given, so the run asks the release channel nothing.
      CLAUDE_CODE_VERSION: "2.1.285",
      CODEX_VERSION: "0.159.2",
    },
  });
  return r.stdout + r.stderr;
};

test("12 CPUs, concurrency 5 and 2 gates: the start line gives a ticket's sandbox 2 and the landing and base gates 6", { skip: !linux || !normalUser }, () => {
  const out = start({ ncpu: 12, args: ["--concurrency", "5"] });
  assert.match(out, /^Sandbox CPUs: 2 each, 6 for landing and base gates$/m, out);
});

test("the gates' share follows the machine's maxGates", { skip: !linux || !normalUser }, () => {
  const out = start({ ncpu: 12, machine: '{"maxGates": 3}', args: ["--concurrency", "5"] });
  assert.match(out, /^Sandbox CPUs: 2 each, 4 for landing and base gates$/m, out);
});

test("a project's cpus is the one limit of both, cut to the VM's CPUs", { skip: !linux || !normalUser }, () => {
  const out = start({ ncpu: 8, config: ", cpus: 16" });
  assert.match(out, /^Sandbox CPUs: 8 each \(cpus 16 in the project config, but the VM has 8\)$/m, out);
});

// A run's sandboxes are opened inside `burndown()`, which no test drives past the start lines (the
// agents and the landings need Docker); that each gate-only open takes the gate project is held here instead.
test("burndown opens the landing, base, mid-run base and verify gates' sandboxes with the gate project, and a ticket's with the ticket's", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /requireGreenBase\(gateProject, /);
  assert.match(src, /sandboxOpener\(gateProject, /);
  const gateBases = [...src.matchAll(/\bgateBase\((\w+), /g)].map((m) => m[1]);
  assert.deepEqual(gateBases, ["gateProject", "gateProject"], "the mid-run base check and the verify");
  assert.match(src, /createSandbox\(\{ branch, baseBranch: base, \.\.\.sandboxConfig\(project, /);
});

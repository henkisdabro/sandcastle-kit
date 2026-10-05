// How a test starts the kit as a child process: node itself (`process.execPath`, never `bin/sandcastle`
// or `.bin/tsx`, which find `node` on PATH - a mise or asdf shim on a Mac) with the V8 flags the
// launcher passes and a time limit. Without the flags a child can hit the Node 24 exit deadlock
// (nodejs/node#66171) and sit at 0% CPU in `process.exit` for ever; without the limit one such
// child hangs `pnpm test`, every gate run in a sandbox and `full-check.sh`. A test file that
// names a tsx entry itself is refused by test/cli-spawn.test.ts.
//
// A child also dies with the test process: `startNode` kills it when the test process exits, and
// test/parent-watch.ts (preloaded into every child) ends it when the test process was killed and
// could run no handler.
//
// The flags are read from bin/sandcastle, so dropping them there (its comment says when) is the
// one edit. One node process with tsx's loader, as the launcher runs the CLI: tsx's own binary
// forks a child that these flags would not reach.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT = fileURLToPath(new URL("..", import.meta.url));
export const LOADER = join(KIT, "node_modules/tsx/dist/loader.mjs");
const PARENT_WATCH = join(KIT, "test/parent-watch.ts");

/** The kit's entries: the CLI, and the Herdr plugin's own module (`sandcastle herdr ...`). */
export const CLI = join(KIT, "src/cli.ts");
export const HERDR_PLUGIN = join(KIT, "src/herdr-plugin.ts");

/** The launcher's `exec node` lines: the Herdr plugin's, then the CLI's. */
export const launcherLines = readFileSync(join(KIT, "bin/sandcastle"), "utf8").split("\n").filter((l) => /^(if .*; then )?exec node /.test(l));
export const flagsOf = (line: string) => line.slice(line.indexOf("exec node ") + "exec node ".length).split(" --import ")[0]!.split(" ");

/** The node flags the launcher passes (`exec node <flags> --import ...`). */
export const NODE_FLAGS = flagsOf(launcherLines.at(-1)!);

/** Long enough for a slow machine to start tsx and run a command; short enough to fail a deadlock. */
export const TIMEOUT_MS = 60_000;

/** node's arguments to run `rest` (a script and its arguments, `-e` and code, or `--test` and a file) under the kit's loader. */
export const kitArgs = (...rest: string[]) => [...NODE_FLAGS, "--import", LOADER, "--import", PARENT_WATCH, ...rest];

/** `options.env` (the test process's own by default) saying whose child this is, for test/parent-watch.ts. */
const withParent = <T extends { env?: NodeJS.ProcessEnv }>(options: T): T => ({ ...options, env: { ...(options.env ?? process.env), SANDCASTLE_TEST_PARENT: String(process.pid) } });

/** What a failure says ran: the entry by its file name, arguments as given, long ones cut. */
const named = (rest: string[]) => `node ${rest.map((a, i) => (i === 0 && a.includes("/") ? basename(a) : a)).join(" ")}`.slice(0, 160);

/**
 * Runs node under the kit's loader and flags (`rest`: a script and its arguments, `-e` and code, or
 * `--test` and a file) to its end, and returns what spawnSync does. One that has not ended by
 * `timeoutMs` is killed with SIGKILL (a handler for a catchable signal could be what hangs) and the
 * test fails with the command named.
 */
export const runNode = (rest: string[], options: SpawnSyncOptionsWithStringEncoding & { timeoutMs?: number } = { encoding: "utf8" }): SpawnSyncReturns<string> => {
  const { timeoutMs = TIMEOUT_MS, ...spawnOptions } = options;
  const r = spawnSync(process.execPath, kitArgs(...rest), { stdio: ["ignore", "pipe", "pipe"], ...withParent(spawnOptions), timeout: timeoutMs, killSignal: "SIGKILL" });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(`${named(rest)} did not end in ${timeoutMs / 1000}s (the Node 24 exit deadlock, nodejs/node#66171, if it sat at 0% CPU): stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr)}`);
  }
  return r;
};

/** `runNode` for the CLI, or another kit script (`script`), with `args`. */
export const runKit = (args: string[], { script = CLI, ...options }: SpawnSyncOptionsWithStringEncoding & { script?: string; timeoutMs?: number } = { encoding: "utf8" }) =>
  runNode([script, ...args], options);

/** The children `startNode` has started that are still running: all killed when the test process exits, by the one listener. */
const started = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of started) child.kill("SIGKILL");
});

/** Starts node as `runNode` does, without waiting; it is killed after `timeoutMs`, with a line on stderr naming it, and when the test process exits. */
export const startNode = (rest: string[], options: SpawnOptions & { timeoutMs?: number } = {}): ChildProcess => {
  const { timeoutMs = TIMEOUT_MS, ...spawnOptions } = options;
  const child = spawn(process.execPath, kitArgs(...rest), withParent(spawnOptions));
  started.add(child);
  const timer = setTimeout(() => {
    process.stderr.write(`${named(rest)} did not end in ${timeoutMs / 1000}s; killed\n`);
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();
  child.once("exit", () => {
    clearTimeout(timer);
    started.delete(child);
  });
  return child;
};

/** `startNode` for the CLI, or another kit script (`script`), with `args`. */
export const startKit = (args: string[], { script = CLI, ...options }: SpawnOptions & { script?: string; timeoutMs?: number } = {}) => startNode([script, ...args], options);

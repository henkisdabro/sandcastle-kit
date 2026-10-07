// Preloaded into every test file's process, beside test/no-stray.ts (`--import ./test/hermetic-env.ts` in
// package.json's `test`, `test:shard` and `test:weights`, and test/run-shards.sh): every test starts from the
// same environment, whatever shell the developer runs it in. Four things in a developer's shell change what
// the code under test does, and a Linux sandbox with a clean environment passes them all:
//
//  - `TMPDIR` is the realpath of `os.tmpdir()`: on macOS it is a `/var/...` path that git and `process.cwd()`
//    report as `/private/var/...`, and a test comparing the two fails.
//  - The running node's directory leads `PATH`: a version-manager shim (mise, asdf) found first fails in a temp
//    cwd ("No version is set for shim: node") when a child runs `bin/sandcastle` or `herdr/entry.sh`, which find
//    node through the inherited `PATH`, and a test that prepends fakes to `PATH` keeps it.
//  - No git identity is inherited: `GIT_CONFIG_GLOBAL` is an empty file, `GIT_CONFIG_NOSYSTEM` is 1, the author and
//    committer variables are removed and `user.useConfigOnly=true` is appended to the `GIT_CONFIG_*` pairs (any pair
//    already set, such as the gate's `commit.gpgsign=false`, stays). A fixture repo that never sets its own identity
//    passes on macOS (git guesses `user@host.local`) and in a ticket's sandbox (the agent's `~/.gitconfig`), and
//    fails only in a gate-only sandbox, the base check or the end-of-run verify: here it fails everywhere.
//  - Names the code reads as a setting or a credential are removed: HERDR_*, TMUX*, SANDCASTLE_* (but not
//    SANDCASTLE_TEST_*, which test/run-shards.sh sets for the tests) and the names in `SCRUBBED` below. A test that
//    needs one sets it itself. test/hermetic-env.test.ts fails when `src/` reads a name that is neither
//    scrubbed nor on its short keep list, so a new setting cannot leak in later.
//
// Only a test file's own process is changed (node:test's child sets NODE_TEST_CONTEXT, the runner process
// that prints the reporter lines does not), as in test/no-stray.ts.

import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** The settings and credential names `src/` reads from the environment that no prefix below covers. */
export const SCRUBBED = [
  "AUTONOMY_LEVEL", "CONCURRENCY", "DRY_RUN", "TICKETS", "ISSUES", "KEEP_AWAKE", "SKIP_PREFLIGHT", "SKIP_BASE_GATES", "SANDBOX_PANES",
  "IMPL_MODEL", "IMPL_EFFORT", "REVIEW_MODEL", "REVIEW_EFFORT", "CROSS_REVIEW", "CROSS_REVIEW_MODEL", "CROSS_REVIEW_EFFORT",
  "USAGE_CHECK", "USAGE_PAUSE", "USAGE_STOP", "CLAUDE_CODE_VERSION", "CODEX_VERSION",
  "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "LINEAR_API_KEY", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID",
  // The terminal the click hint senses (src/click-hint.ts), and the colour switch.
  "TERM_PROGRAM", "LC_TERMINAL", "VTE_VERSION", "KITTY_WINDOW_ID", "WEZTERM_EXECUTABLE", "NO_COLOR",
];

/** Whether the preload removes this name from a test's environment. */
export const scrubs = (name: string): boolean =>
  SCRUBBED.includes(name) || name.startsWith("HERDR_") || name.startsWith("TMUX") || (name.startsWith("SANDCASTLE_") && !name.startsWith("SANDCASTLE_TEST_"));

/**
 * The author identity variables: any one of them lets a commit through in a repo with no identity of its own. The
 * committer's stay: alone they let no commit through (git still asks for the author, `user.useConfigOnly`), and
 * `test/full-check.sh`'s agent-committer leg sets them to run the suite as an agent's sandbox does.
 */
const GIT_IDENTITY = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "EMAIL"];

/** One more `GIT_CONFIG_*` pair, after any already set, and not twice (a child that loads this preload again keeps one). */
const addGitConfig = (key: string, value: string): void => {
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
  for (let i = 0; i < n; i++) if (process.env[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === key.toLowerCase()) return;
  process.env[`GIT_CONFIG_KEY_${n}`] = key;
  process.env[`GIT_CONFIG_VALUE_${n}`] = value;
  process.env.GIT_CONFIG_COUNT = String(n + 1);
};

if (process.env.NODE_TEST_CONTEXT) {
  process.env.TMPDIR = realpathSync(tmpdir());
  const node = dirname(process.execPath);
  const path = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (path[0] !== node) process.env.PATH = [node, ...path].join(delimiter);
  for (const name of Object.keys(process.env)) if (scrubs(name)) delete process.env[name];
  // An empty file, not /dev/null: a test that runs `git config --global` can write to it.
  const globalConfig = join(process.env.TMPDIR, `hermetic-gitconfig-${process.pid}`);
  writeFileSync(globalConfig, "");
  process.on("exit", () => rmSync(globalConfig, { force: true }));
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const name of GIT_IDENTITY) delete process.env[name];
  addGitConfig("user.useConfigOnly", "true");
}

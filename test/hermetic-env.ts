// Preloaded into every test file's process, beside test/no-stray.ts (`--import ./test/hermetic-env.ts` in
// package.json's `test`, `test:shard` and `test:weights`, and test/run-shards.sh): every test starts from the
// same environment, whatever shell the developer runs it in. Three things in a developer's shell change what
// the code under test does, and a Linux sandbox with a clean environment passes them all:
//
//  - `TMPDIR` is the realpath of `os.tmpdir()`: on macOS it is a `/var/...` path that git and `process.cwd()`
//    report as `/private/var/...`, and a test comparing the two fails.
//  - The running node's directory leads `PATH`: a version-manager shim (mise, asdf) found first fails in a temp
//    cwd ("No version is set for shim: node") when a child runs `bin/sandcastle` or `herdr/entry.sh`, which find
//    node through the inherited `PATH`, and a test that prepends fakes to `PATH` keeps it.
//  - Names the code reads as a setting or a credential are removed: HERDR_*, TMUX*, SANDCASTLE_* (but not
//    SANDCASTLE_TEST_*, which test/run-shards.sh sets for the tests) and the names in `SCRUBBED` below. A test that
//    needs one sets it itself. test/hermetic-env.test.ts fails when `src/` reads a name that is neither
//    scrubbed nor on its short keep list, so a new setting cannot leak in later.
//
// Only a test file's own process is changed (node:test's child sets NODE_TEST_CONTEXT, the runner process
// that prints the reporter lines does not), as in test/no-stray.ts.

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname } from "node:path";

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

if (process.env.NODE_TEST_CONTEXT) {
  process.env.TMPDIR = realpathSync(tmpdir());
  const node = dirname(process.execPath);
  const path = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (path[0] !== node) process.env.PATH = [node, ...path].join(delimiter);
  for (const name of Object.keys(process.env)) if (scrubs(name)) delete process.env[name];
}

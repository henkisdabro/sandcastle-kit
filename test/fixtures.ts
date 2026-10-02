// Shared test fixtures. Import this the way the test imports src/: where a test sets
// XDG_CONFIG_HOME first and loads src/ with `await import(...)`, load this the same way,
// after the assignment (it pulls in src/tracker.ts, and so sandbox.ts).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTracker, type Resolved } from "../src/tracker.ts";

// A root with no docs/agents/ and no config: resolveTracker then gives the defaults a project
// that never ran the triage setup gets, so the fixture follows the loader instead of copying it.
// A fresh directory, so a docs/agents/ left under a fixed path cannot change the defaults.
const NO_DOCS_ROOT = mkdtempSync(join(tmpdir(), "sandcastle-no-docs-"));

/**
 * A project's resolved `tracker`: GitHub with the loader's defaults (`resolveTracker`, nothing
 * configured), and any field of `Resolved` overridden. `fakeTracker({ kind: "files" })` is a
 * Markdown-files tracker in `.scratch`. A test whose point is one particular shape keeps its own
 * literal and says why.
 */
export const fakeTracker = (overrides: Partial<Resolved> = {}): Resolved => ({ ...resolveTracker(NO_DOCS_ROOT), ...overrides });

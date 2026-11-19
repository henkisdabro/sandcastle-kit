# Guards fail closed: what a guard cannot establish as safe does not cross

A guard lets a thing cross from a sandbox to the host - a branch, a file, a command, a credential -
only after it has positively established, on a normalised reading of that thing, that the thing is
in a known-safe class.
Anything the guard cannot read, parse, normalise or classify is refused (held, stopped or denied),
and the refusal names what could not be established and the one operator-side way past it.

In practice:

- **Normalise, then match.** A guard matches the form the host resolves (case-folded,
  Unicode-normalised, a directory as itself and as its contents, objects read without replace refs),
  never git's raw bytes.
- **Allowlist where the safe set is small**: the environment a sandbox gets, git's global options,
  a token's permissions. Where the dangerous set is open-ended (host-run config files), the list
  names each entry's runner, and the root dot-namespace is held by default.
- **Three answers.** Every decision is `allow`, `refuse` or `unknown` (`Verdict`, `src/verdict.ts`),
  and every caller treats `unknown` as `refuse`. A `catch` in a guard answers `unknown`, never
  `allow` and never an empty result.
- **Overrides stay on the operator's side and narrow**: a host environment variable or a key in
  `.sandcastle/` config, which is itself held, so an agent cannot widen it unheld. The refusal names
  it, and every run it is active in prints a line saying so.

## Considered Options

- **Block a list of known-bad shapes on the raw input.** Rejected: that was the shape of every
  bypass in the guard audit (#991 - #998). A list matched on raw bytes misses `.Husky/`, a bare
  symlinked `.codex` and `git "gc"`, and a reader that threw and returned nothing let a branch land
  unread.
- **Make the in-sandbox git guard a boundary.** Still rejected (ADR 0004): it is fail-closed where
  it parses, so an unknown git option refuses, but a script file gets past any reading of a command
  line. A parse refusal is fixed by adding the option to the table, not by an override.

## Consequences

- Some legitimate work is held that used to land (an oddly cased path, all of `.claude/`, a root
  dotfile not on the inert list); the way past is a merge by hand or `unheldPaths`.
- Every refusal code is covered by a row of the bypass corpus
  (`test/guard-refusal-coverage.test.ts`), and every reader's failure is driven by `injectGuardFault`
  (`test/guard-faults.test.ts`), so a refusal branch cannot be added untested or removed unnoticed.
- The detail of each guard lives in `docs/safety.md` and `docs/architecture.md`, and changes there
  without a new ADR; relaxing the rule itself takes one.

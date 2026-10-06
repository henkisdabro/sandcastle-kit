# The toolchain stays on Node and pnpm; Bun is not adopted

The kit keeps pnpm as its package manager, `node --test` as its test runner and Node as the
runtime of the CLI and every script. Bun was weighed as three separate choices - package manager,
test runner, runtime - and none of them pays here. The kit runs on Linux and macOS machines that
already need Node for the kit itself; Bun would add a second runtime that every user and every CI
job installs, for a speed-up that the measurements below put in the wrong place.

## Measurements

Bun 1.4.2, Node 22.22, a 4-core Linux container. The sample is 40 test files that start no child
process (166 tests): the files where Bun's fast start could matter most.

| Runner | Wall time | Pass / fail |
|---|---|---|
| `node --test` with tsx (today) | 15.1 s | 166 / 0 |
| `node --test` with tsx, `--experimental-test-isolation=none` | 5.1 s | 161 / 5 |
| `bun test` (one shared process) | 2.3 s | 159 / 7 |
| `bun test --parallel` | 30.3 s | 159 / 7 |

Most of the gain is the absence of isolation, and Node has that too: Node without isolation and Bun
without isolation fail the same kind of test, ones that pass in a process of their own.
`--parallel`, Bun's way back to isolation, was twice as slow as today's runner.

## Considered Options

- **`bun install` for pnpm.** There are four dependencies; installing is not where CI spends its
  time. The lockfile conversion drops `allowBuilds` (Bun's `trustedDependencies`), and Corepack,
  which reads `packageManager`, does not manage Bun.
- **`bun test` for `node --test`.** 71 test files start the kit through `test/cli-spawn.ts`, which
  runs `process.execPath` with the launcher's V8 flags and tsx's loader: under `bun test` that path
  is Bun, which takes neither. The suite would then prove a runtime no user runs, and the guards
  built for Node (the exit-deadlock flags, `test/no-stray.ts`, `test/parent-watch.ts`) would go
  with it while the suite stayed green.
- **Bun as the CLI's runtime.** Every user would need Bun as well as Node, on both platforms, and
  the sandbox image would need it too.

## Consequences

The cheaper speed-up is Node's own: its type stripping (on by default from Node 22.18) runs the
kit's `.ts` files without tsx, since every import already names its `.ts` extension. Measured on
the same machine, `sandcastle help` and `sandcastle herdr line` (which Herdr runs every 10
seconds) started in about 0.4 s against 0.8-1.2 s with tsx's loader. One constructor parameter
property (`BaseRedError` in `src/gates.ts`) is the only syntax that stripping refuses. Taking it
means raising `engines` to Node 22.18 or keeping tsx as the fallback for older Node 22 releases.

Revisit Bun only if the kit stops needing Node: `@ai-hero/sandcastle`, the sandbox image
(`node:24-trixie`) and the Codex install in it all assume it today.

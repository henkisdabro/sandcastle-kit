# The status view is TypeScript in the kit's own Node, not bash or a compiled binary

The live status view moves from `status.sh` (about 1,830 lines of bash 3.2) to TypeScript, run by
the same Node the kit already needs. It keeps a snapshot that collectors refresh in the
background, and draws every frame from it. C, Rust and Go were weighed and none pays here.

## Measurements

20261010, macOS, kit v0.13.0, one frame at 240 columns with no sandbox running: 5.2 s in all.
`sandcastle queue --json` took 3.7 s, almost all of it the tracker's network call (bare Node
starts in 0.05 s, `sandcastle help` in 0.26 s). `docker ps` took 1.0 s, and `docker stats
--no-stream` adds 1-2 s once sandboxes run. Layout and drawing took about 0.2 s. A pane resize
ran the whole frame again, so a drag trailed the window by seconds.

The time is in the sources, not the language. What a resize needs is to draw from data already
held and to wait on no source while drawing, and that is the part bash 3.2 does worst: no
fractional timeouts, no event loop, and background jobs whose children outlive a killed shell.

## Considered Options

- **Keep bash and add a background sampler, debounce and a tick.** The smallest change, but the
  deadlines, single-flight refreshes and process-tree clean-up it needs are machinery bash 3.2
  makes fragile, and #695's column and lane maths would be written in bash and then again later.
- **C, Rust or Go.** Fast to start, but the gain is nil where the time goes (Docker, the tracker).
  Each adds a second language and a binary per platform (macOS arm64 and x64, Linux), with
  checksums and version matching, or a toolchain every user installs; and the view's run-record
  and ticket-state rules would be written twice.
- **TypeScript in the kit's Node.** No new dependency: Node is already required. Timers, resize
  events, async child processes and JSON are native, and the view shares the kit's types.

## Consequences

- The tracker and blocker code is synchronous, so the view runs `sandcastle queue --json` as an
  async child rather than importing it: an import would block the event loop for seconds.
- Ctrl-C reaches a raw-mode Node process as a byte, not a signal; the view treats it as the
  interrupt the Herdr pane reuse and the quit mark rely on.
- The switch ships in one release, behind no public setting, and `jq` stops being a prerequisite
  once `status.sh` is a wrapper.
- Calling the Docker Engine or GitHub APIs directly, instead of their command-line tools, waits
  until a measurement shows it is needed.

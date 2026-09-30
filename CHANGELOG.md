# Changelog

All notable changes to sandcastle-kit are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

Each release's **Upgrading** notes say what an existing project may act on. `/sandcastle update`
reads them; by hand, pull the kit and follow [Updating](docs/INSTALL.md#-updating).

## [Unreleased]

### Upgrading

- Nothing in a project has to change: every new config field is optional and prompts come from
  the kit. Run `sandcastle build` and `sandcastle lean` once.
- **A red gate now gets one repair pass** by the implementer's model, which spends allowance.
  Set `repair: { attempts: 0 }` in `.sandcastle/config.ts` to keep the old behaviour.
- **Blocked issues are read from the issue body.** Issues triaged earlier as unlabelled with a
  "blocked by #N" comment can move the line into the body and take the queue label.

### Added

- Repair pass on a red gate, fed the gate's output (`repair` in the config).
- `Blocked by #N` / `Depends on #N` in an issue body holds the issue back while #N is open.
- Opt-in plan usage guard: `USAGE_CHECK=1` starts no new issue past `USAGE_STOP` percent.
- Phase timings in `.sandcastle/logs/timings.jsonl`, per-issue wall time in the report, a
  heartbeat line every five minutes, and a `quiet Nm` hint in the status view. An issue held
  back by a dependency shows as `◌ blocked` there, not queued.
- `sandcastle init` detects the stack (Node, Python with uv, Go, Rust) and writes gates, setup
  and, where needed, a project Dockerfile.
- `/sandcastle update` skill action.

### Changed

- Landing re-reads each issue first and skips one closed or labelled `needs-human` during the
  run, and merges the exact commit the gates passed on.

### Fixed

- A run that died between merging and closing left the issue open for good; the next run now
  closes it.
- A closed Herdr status pane printed a `pane_not_found` error into the run's output.
- A project's first run crashed with ENOENT on `.sandcastle/logs/run.lock`.

## [0.1.0] - 2026-09-30

Initial public release.

[Unreleased]: https://github.com/henkisdabro/sandcastle-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/henkisdabro/sandcastle-kit/releases/tag/v0.1.0

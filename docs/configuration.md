# 🔧 Configuration

Every key of `.sandcastle/config.ts`, the personal settings, the environment variables, and the
image's agent versions.


`.sandcastle/config.ts` in each project exports a plain object:

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Names the project image (`sandcastle-<name>`) and the status view; `base` and `agents` (any case) are refused, as the kit's own images use those repositories |
| `gates` | required | `[{ name, command, rerun? }]`, run in order, stopping at the first red. `rerun` is opt-in: what the red gate's one re-run in its gates slot (and a landing gate's, and the third run after a re-run red on different tests) runs instead of `command`, and what a repair pass is told to run after a commit (with the typecheck gate; the orchestrator runs every gate as the pass exits), so a deterministic failure does not cost a whole suite twice. It must name `{tests}` (the failing test ids as the kit read them) or `{files}` (their files, each once), both shell-quoted: `{ name: "test", command: "pytest", rerun: "pytest {tests}" }`. The full `command` runs instead when the gate has no `rerun`, when the failing tests cannot be read (output that may be cut, a lint or type gate), or when `{files}` is used and a test id names no file. A red `rerun` run still counts as the first full run's failure: the repair is fed that run's output and command |
| `baseBranch` | `"main"` | Branch agents start from and green work merges into |
| `tracker` | detected, else `"github"` | `"github"`, `"files"` or `{ type: "files", dir, done }` - see [Trackers](queue.md#-trackers-github-or-ticket-files) |
| `label` | `"ready-for-agent"` | The queue label (GitHub) or `Status:` value (files). Read from `docs/agents/triage-labels.md` when unset and that file exists |
| `concurrency` | `4` | Parallel sandboxes for this project (inside the machine-wide limit) |
| `cpus` | the VM's CPUs ÷ concurrency, ÷ `maxGates` for gate-only sandboxes | CPUs each sandbox container may use (`docker run --cpus`), so agents' own test runs - which `maxGates` does not limit - cannot starve each other and the gates beside them. Unset, from the container runtime's CPUs (`docker info`'s NCPU), each at least 2 and never more than the VM has: a **ticket's sandbox** (an agent works in it, and its gates run in it) gets them divided by the run's effective concurrency, raised to the gate share (below) while its gates hold a gates slot and set back after; a **gate-only sandbox** - a landing, the base and verify gates, `sandcastle gates` and `sandcastle land` - gets them divided by `maxGates`, since landings go one at a time and set the run's end (6 on a 12-CPU VM with `maxGates` 2, where a ticket's gets 2 at concurrency 5). A number sets the limit for both kinds (cut to the VM's CPUs, which `docker run` would otherwise refuse; at least 0.01, which `docker run` accepts), `false` sets none. The limit is a CPU time quota, not pinned cores: Node 24's `os.availableParallelism()` returns it, but `nproc`, `os.cpus()` and Python's `os.cpu_count()` still count the VM's CPUs, so give a runner sized from them a worker count in its gate command (`pytest -n <N>`, `make -j<N>`; see [Concurrency](concurrency.md#-concurrency)). The run's start lines say which applies (`Sandbox CPUs: 2 each, 6 while gates run`) |
| `memory` | 1.5 x the project's measured anonymous memory, once measured; else none | The memory each sandbox container may use, swap included: bytes, or a size such as `"6g"` or `"512m"` (at least 6 MiB, the least docker takes), cut to the VM's memory; `false` sets none. On a Docker Desktop or OrbStack VM every sandbox shares one ceiling, so without a limit one suite that balloons pushes the others into the VM's OOM killer, which picks a victim the kit did not choose; inside a limit the kernel kills inside that sandbox only, and the gate or agent pass names it (`exit 137, out of memory: ...`), telling the sandbox's own limit from the VM running out (see [Troubleshooting](troubleshooting.md)). Unset, the limit is 1.5 x the higher of the project's gate and agent anonymous memory (each the 90th percentile of at least 10 samples in `peaks.jsonl`, over its last 5 measured runs and older ones until there are 10; the agent's only when it has 10), at least 2 GiB, rounded up to 256 MiB; with fewer than 10 gate samples there is none, and the start line counts them: `Sandbox memory: no limit (4 of the 10 gate samples a measured limit needs; memory in the project config sets one)`. One limit for both kinds of sandbox (a gate runs in a ticket's sandbox too). Set with `docker update` once the sandbox is open, so `setup` runs before it applies. The run's start lines and `sandcastle gates` say which applies (`Sandbox memory: 5.3 GiB each (1.5 x the 3.42 GiB of anonymous memory measured; ...)`) |
| `herdr` | `{ panes: "none" }` | Inside Herdr, `{ panes: "none" \| "all" }`: whether a run opens a pane per sandbox. `"none"`: the run's tab holds the status view alone and the run is one agent on it (in a herdr-core terminal, each sandbox is still a terminal of its own, listed under the run's agent with no pane). `"all"`: a pane per concurrent sandbox. `SANDBOX_PANES` overrides it for one run. See [Works best in Herdr](herdr.md#-works-best-in-herdr) |
| `usagePause` | unset | Plan usage in percent (1 to 100) at which a run pauses itself and resumes after the window's reset; `USAGE_PAUSE` overrides it for one run. Unset: no pause, and a limit an agent hits stops the queue as before. See [Pausing a run](running.md#-pausing-a-run) |
| `loadPause` | `60` | Machine-wide CPU pressure in percent (1 to 100, PSI `some` `avg60`) at or over which a run holds each gate pass, before it takes its gates slot, until the pressure has stayed under it for 2 minutes; at most 30 minutes per run, then it holds nothing again. `false` turns it off; `LOAD_PAUSE` overrides it for one run (`LOAD_PAUSE=0` is off). Agent passes go on. See [Concurrency](concurrency.md#-concurrency) |
| `keepWarm` | `true` | Whether the session that started the run keeps its prompt cache warm while the run is live. `false` turns it off for this project; `"keepWarm": false` in your [personal settings](#personal-settings) turns it off everywhere, and beats a project's `true`. Keeping warm costs a little allowance: a refresh request reads the cached conversation at about 0.1x the input price, and it saves the cold restart that re-reads the whole conversation at the full price. The run record's `settings.keepWarm` carries the value (a record from an older kit reads as `true`) |
| `autonomy` | `0` | Turns one `sandcastle run` may take. `0`: one. `1`: after each turn, list the re-runnable tickets and ask before running again - no cap, since every turn needs your yes (with no terminal, nothing re-runs). `2`: one automatic re-run. `3`: up to two. Re-runnable: tickets that ended in a merge conflict, tickets whose blockers have now landed, tickets that merged partly done and are still queued (unless the agent's note says the remainder needs a person), and green branches whose landing did not happen (a sandbox that would not open, a branch that moved); a re-run takes only those, never the rest of the queue. `"drain"`: as many turns as it takes until the queue is drained or a stop condition holds (no progress, the same ticket conflicting, left partly done or failing to land twice running, a red base, a usage limit), at most 20. See [After a run](running.md#-after-a-run) |
| `claudeCode` | `"stable"` | Which Claude Code the sandbox image installs: `"stable"` or `"latest"` (Claude Code's release channels, resolved on the host) or an exact version such as `"2.1.285"` to pin. `CLAUDE_CODE_VERSION` overrides it for one command. See [The image's agent versions](#-the-images-agent-versions) |
| `dockerfile` | none | Project layer on the base image; starts `ARG BASE=sandcastle-base:latest` / `FROM ${BASE}`. Claude Code and Codex are copied in after it, so a step of the layer cannot run `claude` or `codex` (the base has neither) |
| `mounts` | `[]` | Extra bind mounts `{ hostPath, sandboxPath, readonly? }`. A `hostPath` that equals or contains the project root, `.sandcastle/` or the shared `.git` (after `~` and symlinks are resolved), or lies inside `.sandcastle/` or `.git`, is refused when the config loads, naming the entry, and `sandcastle doctor` reports it as a FIX: a sandbox that could write there could rewrite the run's own state (the start baseline, the branch backup, the run lock). A cache directory elsewhere, or under the project, is fine. Mount a build cache as well as the dependency caches (Go's `/home/agent/.cache/go-build`, a Rust project's `target/` under `/home/agent/workspace`, the worktree's fixed path): without one every fresh sandbox and landing gate recompiles the tree, and a project's warm and cold gates runs differ several times over |
| `setup` | `[]` | Commands run in each sandbox before the agents (dependency install), in order. Each runs in a shell of its own (a `cd` or `export` does not reach the next). A step that exits non-zero stops the rest and is named with its exit status and last output: at the base gates it is a red `setup` gate, which stops the run; for a ticket it costs the attempt, and the ticket is tried once more in the run. When the base check is skipped (a green record of the same base, image and config, or `SKIP_BASE_GATES=1`), the same step failing for two tickets stops the run starting tickets. A hook installer (husky, `pre-commit install`, `lefthook install`) does not belong here: a sandbox cannot write its `.git/config` or `.git/hooks` (see [Troubleshooting](troubleshooting.md)) |
| `pnpmStore` | `false` | `true`: the kit runs `pnpm store path` on the host before each command, mounts that store's parent (the store-dir, without the `vN` segment pnpm adds) into every sandbox and points the sandbox's pnpm at it before `setup`. With the same pnpm major the sandbox's `<mount>/vN` is the host's own store, so installs hardlink instead of downloading; a different major keeps its own `vN` beside it. `sandcastle init` writes it for a pnpm project; the config holds no host path, so it works for a teammate on another OS. Without pnpm on the host the mount is skipped, with a note. A store that is the project root, `.sandcastle/` or `.git` (or holds one) is refused like any other mount |
| `autoCompactWindow` | unset | Context size in tokens at which a Claude agent in a sandbox compacts its conversation, passed to it as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: a whole number from 100,000 to 1,000,000 (Claude Code's own range), refused outside it. Unset: nothing is passed and Claude Code's own default applies, so a long pass's context grows until Claude Code's own limit. Codex agents are unchanged. There is no turn cap |
| `blockers` | none | `{ linear?: string[], files?: { dir, done? } }` - what a ticket may wait for besides a ticket on its own tracker; see [Blockers](queue.md#-blockers-github-linear-ticket-files) |
| `rules` | none | Markdown file added to the implement, review and repair prompts under "Project rules" |
| `changelog` | `false` | For a project whose rules keep agents out of its changelog: the implement and review prompts ask for each changelog line in a `<changelog>...</changelog>` tag (starting `Added:`, `Changed:` or `Fixed:`, or `Upgrading:` for what an existing project must act on), and the closing summary lists the lines of the tickets that merged under Done, grouped by those words, with the `Upgrading:` lines in a block of their own, for you to write the entries from. A full review is shown the implementer's lines, and one that changes something user-facing restates the branch's whole set (the lines that still hold copied as they are), which replaces the implementer's, so a rewording shows once, while a narrow review (after a repair, a base merge or a conflict resolution) gives lines only for what it changed itself and they are added; and a tag that is no changelog line (over 500 characters, a list, a commit sha) is dropped with a note. A change nobody outside the code would notice is answered `<changelog>none</changelog>` (`n/a` too, any case): it is no line, a pass that gives only that leaves the earlier lines standing, and the ticket is recorded as needing no entry |
| `lean.keep` | `[]` | Items sandboxes keep: `skill:<name>`, `agent:<name>`, `command:<name>`, `mcp:<server>`, `codex-skill:<name>`, `codex-config`, `tool:<Name>` (a built-in Claude Code tool for the passes, checked against `src/claude-tools.ts`) |
| `lean.dropHooks` | `[]` | Substrings of hook commands to drop - host-only conveniences only |
| `hookTests` | `[]` | `[{ name, tool, input, expect: "block" \| "allow" }]` - proof that the kept PreToolUse guards fire (see [Hook tests](setup.md#hook-tests)) |
| `protectedPaths` | `[]` | Extra paths a branch may not change and still merge automatically |
| `land` | `"merge"` | How green work lands: `"merge"` (a merge commit; the branch's commits kept) or `"squash"` (one commit per ticket, subject `Merge agent/issue-N (closes #N)`). Either way the agent branch is deleted once landed. A landing resolved by regenerating `generated` paths and `sandcastle land` follow it too. Held branches are never landed either way |
| `generated` | `[]` | `[{ paths, regen }]` - committed files a command writes. A merge that conflicts only in these paths - a re-run's base merge, or a landing - takes either side, reruns `setup`, runs `regen` in a sandbox and commits; any other conflict is left for the implementer (at landing, as a conflict). See [A gate for generated files](setup.md#-a-gate-for-generated-files) |
| `implement` / `review` | kit models, `high` effort, 8 / 3 iterations, 2400 s idle | `{ model, effort, maxIterations, idleTimeoutSeconds }` per agent. The `IMPL_*` / `REVIEW_*` env vars override `model` and `effort` for one run |
| `repair` | 1 attempt, 4 iterations, 2400 s idle | `{ attempts, maxIterations, idleTimeoutSeconds }` - passes the implementer's model gets to fix a red gate from its output; up to two more while each pass commits and turns up a different failure, never the same one twice. `attempts: 0` turns it off. A gate that timed out is never repaired. A repair that commits and turns the gates green is followed by a second review pass (the review model, on the repair commits) and, if that commits, one more gate run. `maxIterations` and `idleTimeoutSeconds` also bound the resolver that finishes a re-run's conflicted base merge (see [Re-runs](running.md#-re-runs)) |

Examples: [`examples/`](../examples/).

**A setting for your clone alone: `.sandcastle/config.local.json`.** For a clone of a repo whose
committed config is not yours to change (a public repo you dogfood on, a team's shared one), an
optional, untracked `.sandcastle/config.local.json` holds your own run settings, merged over
`config.ts`:

```json
{ "autonomy": "drain", "implement": { "model": "claude-opus-5-5" } }
```

- **Plain JSON, run settings only.** The keys are `autonomy`, `concurrency`, `cpus`, `memory`,
  `herdr`, `usagePause`, `keepWarm`, `autoCompactWindow`, `implement` and `review` (`model`, `effort`,
  `maxIterations`, `idleTimeoutSeconds`) and `repair` (`attempts`, `maxIterations`,
  `idleTimeoutSeconds`). Any other key - `gates`, `setup`, `mounts`, `generated` - is refused with
  the key named, as it changes what a landed branch is checked against, and two clones of one repo
  would land against different gates. A typo is refused with the nearest key, a wrong type with the
  dotted key (`implement.maxIterations`), a file that is not a JSON object by name.
- **Precedence.** The environment (`AUTONOMY_LEVEL`, `CONCURRENCY`, `IMPL_MODEL`) beats the file,
  the file beats `config.ts`, `config.ts` beats the default. Your [personal
  settings](#personal-settings) still clamp last (`maxSandboxes`, `"keepWarm": false`).
- **Merging.** A nested object merges key by key: `{ "implement": { "model": "x" } }` keeps
  `implement.effort` from `config.ts`.
  A JSON `null` unsets a key: `config.ts`'s value is dropped and the kit default applies
  (`{ "autonomy": null }` runs at the default level).
- **Keep it out of the clean-tree check.** A run refuses to start on a dirty tree, untracked files
  included.
  `sandcastle init` writes `config.local.json` to `.sandcastle/.gitignore`, and `sandcastle doctor`
  adds it to an older project's.
  For a clone that cannot commit that file, ignore it in `.git/info/exclude`, by the path git
  resolves so it works in a linked worktree too (there `.git` is a file):
  `echo .sandcastle/config.local.json >> "$(git rev-parse --git-path info/exclude)"`.
- **Where a value came from.** `sandcastle doctor` names the file and its keys (and flags it when
  git would show it as untracked), and a run's start lines print
  `Local config (.sandcastle/config.local.json): autonomy, implement.model`.

<details>
<summary><b>Environment variables</b></summary>

| Variable | Default | |
|---|---|---|
| `IMPL_MODEL`, `IMPL_EFFORT` | `claude-sonnet-5-5`, `high` | The implementer. The order, first wins: a ticket's `model:` / `effort:` label, then these, then `implement` in the config, then the kit's default. To override a label for one run, remove the label; `sandcastle queue` shows each ticket's label as `[implement <model>/<effort>]` |
| `REVIEW_MODEL`, `REVIEW_EFFORT` | `claude-opus-5-5`, `high` | The reviewer |
| `CROSS_REVIEW=1`, `CROSS_REVIEW_MODEL`, `CROSS_REVIEW_EFFORT` | off, `gpt-6-astra`, `high` | Codex review, signed in with a read-only copy of `~/.codex/auth.json` that has the refresh token blanked (the access token is all a sandbox gets, so nothing in a sandbox can refresh or rotate your login; [what reaches a sandbox](safety.md)). Its effort goes up to `xhigh` (Codex has no `max`). With a ChatGPT sign-in, the status view's usage row also shows Codex's 5-hour and weekly usage. With `REPORT_SCHEMA=1` its pass also returns the schema-validated report (see that row) |
| `TICKETS`, `CONCURRENCY`, `DRY_RUN` | queue label, config, off | Per run; `ISSUES` is the older name for `TICKETS` (if both are set, `TICKETS` wins). The same as `sandcastle run 12 15`, `--concurrency N` and `--dry` |
| `AUTONOMY_LEVEL` | config, else `0` | Overrides `autonomy` for one run (`0` turns a configured level off, `drain` runs until the queue is drained) |
| `CLAUDE_CODE_VERSION`, `CODEX_VERSION` | `claudeCode`, else `stable`; the newest plain Codex release at least 72 hours old | The Claude Code channel or version, and the Codex version, the image installs ([The image's agent versions](#-the-images-agent-versions)) |
| `REPORT_SCHEMA=1` | off | Claude passes (implement, review, repair, resolve) and the Codex cross-review also return a report checked against `container/report.schema.json` - the signal, the unmet criteria, the changelog lines, the follow-ups and the check-by-hand notes - which the kit reads in place of those tags when a valid one came, and falls back to the tags when none did. Each pass's line in `logs/timings.jsonl` then records whether it came. The cross-review's report is the last message of `codex exec --output-schema`; a schema Codex refuses is a recorded missing report (`failed: invalid_json_schema`) and a line saying so, and while the switch is on every cross-review then fails, though it never stops the run. The cross-reviewer's `<report>` hand-back is not in its JSON, so for a tracker where agents do not write it, it is not posted. Off, a run is exactly as without it. The cost of the schema and the wait for the report are for a person to read off real runs before it is ever a default |
| `SKIP_PREFLIGHT=1` | off | Skip the model check |
| `SKIP_BASE_GATES=1` | off | Start agents even though the gates were not checked on the base commit - for a known flaky gate, say |
| `SANDBOX_PANES=none` or `all` | `herdr.panes`, else `none` | Whether a run in Herdr opens a pane per sandbox; over the config key |
| `SANDCASTLE_DETACH=1` | off | The same as `sandcastle run --detach` |
| `SANDCASTLE_API_KEY=1` | off | The same as `--api-key`: the yes to billing API credits, for a run (or `preflight`, `lean --measure`) whose sandboxes would spend `ANTHROPIC_API_KEY`. Without it, such a run asks on a terminal and refuses without one ([Run](running.md#-run)) |
| `SANDCASTLE_HERDR_VIEW=0` | on inside Herdr | Skip the run's Herdr view - its tab, panes and sidebar reports, and in a herdr-core terminal its sandbox terminals (the status pane still opens; inside Herdr a run that cannot open any status view does not start) |
| `SANDCASTLE_LINKS=0` or `1` | on inside Herdr with the plugin | The status view's links from each ticket to its latest log (through the [Herdr plugin](herdr.md#the-herdr-plugin), a click on one opens that ticket's card), and its click hint, which names the key for the terminal Herdr runs in (`SANDCASTLE_CLICK_HINT` below); on inside Herdr TUI once `sandcastle herdr configure` has linked the plugin, off outside Herdr TUI (a herdr-core terminal too), into a pipe and without the plugin |
| `SANDCASTLE_CLICK_HINT=auto`, `ctrl` or `cmd` | `herdr.clickHint`, else `auto` | Which key the status view's hint names for a click on a ticket: `auto` senses the terminal the Herdr client runs in ([The Herdr plugin](herdr.md#the-herdr-plugin)); over the personal setting. A value it does not know gives the hint that names both |
| `SANDCASTLE_TEST_RED_GATE=1` | off | Test the repair path: each ticket's first gate run counts as red, so a repair pass runs and the gates are re-run. Costs a repair pass per ticket; ignored when `repair.attempts` is 0 |
| `USAGE_CHECK=1`, `USAGE_STOP` | off, `90` | Read the Claude plan's usage windows before each ticket starts, and start no new ticket once one reaches `USAGE_STOP` percent. Separate from the status view's plan lane, which shows the plan's usage from the agents' own readings (see [Run](running.md#-run)) whether or not this is on, with no request and no credential. Before each ticket it prefers the agents' own readings to the endpoint: while the newest reading of the run's Claude agents is under 10 minutes old it decides from that and makes no request (a window whose reset has passed counts as spent no more), and it asks the endpoint only before the first reading and once the newest is older. Applies only when the sandboxes spend a subscription token (`CLAUDE_CODE_OAUTH_TOKEN`): with `ANTHROPIC_API_KEY`, alone or beside the token (Claude Code spends it first), they spend API credits, no plan's usage describes that, and the start line says the guard does not apply instead of reading the host login's unrelated plan. Reads usage with the host's Claude Code login when there is one (macOS: the keychain entry `Claude Code-credentials`, or `Claude Code-credentials-<h>` when `CLAUDE_CONFIG_DIR` is set, with `<h>` the first 8 hex characters of the SHA-256 of its value, a trailing slash removed; Linux: `~/.claude/.credentials.json`, under `CLAUDE_CONFIG_DIR` when that is set), else with `CLAUDE_CODE_OAUTH_TOKEN`. The kit cannot tell whether the login and the token are one account, so the start line and `doctor --verify` say whose plan is read (the login's account, or the token's); a token from another account than the login is guarded by the login's plan, so keep them the same account, or leave the guard off. A `claude setup-token` token is inference-only and the endpoint answers it HTTP 403, so the login is the one that works. The login is read-only, on the host: the kit never refreshes it (a refresh could sign Claude Code out), never writes it anywhere, never puts it in a sandbox's environment or mounts and never prints it. Its access token lasts about 8 hours and Claude Code refreshes it; an expired one is no reading until then. The endpoint is undocumented and rate-limited, so an unknown reading never blocks a run; the start line then says why, and it is asked again before the next ticket. A token the endpoint answers with HTTP 403 cannot use the guard: the start line says it is off for the run, and the endpoint is not asked again. `sandcastle doctor --verify` shows beforehand which credential the guard would use, where it looks for the login (the keychain service's name or the credentials file's path), whose plan that is and the HTTP status the endpoint answers it (never the token), an `info` line that the guard does not apply under an API key, and a `warn` line under a setup token the endpoint refuses with 403 |
| `USAGE_PAUSE=<percent>` | off, or `usagePause` in the project config | Pause the run when the 5-hour or the weekly window of a provider it uses (Claude's, and Codex's with cross-review on a ChatGPT plan) reaches this percent (1 to 100; anything else is refused at the start, as `USAGE_STOP` is), and resume by itself a minute after that window's reset: the same soft pause as `sandcastle pause` ([Pausing a run](running.md#-pausing-a-run)). An agent that hits the limit anyway pauses the run until the reset in place of stopping it, and its pass runs again on the resume. Reads the agents' own readings (the status view's usage row), so it needs no request and no credential, and does nothing for a run that shows no plan usage (an API key). The environment beats the config. Independent of `USAGE_CHECK`, which stops the queue instead: with both on, a `USAGE_STOP` below `USAGE_PAUSE` still stops the queue first |
| `LOAD_PAUSE=<percent>` | `60`, or `loadPause` in the project config | Hold each gate pass while the machine-wide CPU pressure (PSI `some` `avg60`; on macOS an estimate from the load average) is at or over this percent (1 to 100; anything else is refused at the start), releasing once it has stayed under for 2 minutes, for at most 30 minutes in all per run. `LOAD_PAUSE=0` turns it off. [Concurrency](concurrency.md#-concurrency) |
| `SANDCASTLE_MAX_SANDBOXES`, `SANDCASTLE_MAX_GATES` | 6, 2 | Machine-wide limits, over `maxSandboxes` / `maxGates` in your personal settings |
| `KEEP_AWAKE=0` | on | Let the machine sleep during a run, as its energy settings say. [Sleep](running.md#-sleep) |
| `SANDCASTLE_ALLOW_BROAD_TOKEN=1` | off | Accept a `GH_TOKEN` that is not fine-grained. Not advised: unattended agents could then push and edit workflows with it. For a throwaway repo, or a GitHub host without fine-grained tokens |
| `NO_COLOR` | unset | Set to anything: the status view drops colour (as it does when piped) and `sandcastle report` prints plain headings without emoji |
| `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` | `~/.config`, `~/.cache` | Where `sandcastle-kit/` keeps your personal settings, and the version cache and slot locks |

A project that always wants different models or effort sets them in `.sandcastle/config.ts`
(`review: { effort: "medium" }`); the env vars are for one run. Effort levels are `low`,
`medium`, `high`, `xhigh`, `max`. Anthropic suggests `medium` as a
starting point for agentic coding on both 5.5 models; the kit defaults to `high` for quality.
Measure before changing it. Billed through an API key, Claude Haiku 5.5 costs five times its
price for a prompt over 100K tokens, which most requests of an implement pass at `high` or `max`
are, and the default effort is `high` for any model: run Haiku at `medium` or below and set its
effort with the model (`IMPL_MODEL` and `IMPL_EFFORT`, or both under `implement` in the config).
One ticket can ask for its own implementer with a `model:` or `effort:` label - see
[Queue](queue.md#-queue-what-agents-work-on).

</details>

## Personal settings

What belongs to your machine, not to a project, lives in `~/.config/sandcastle-kit/`, never in the
kit or a repository.
`.env` holds every token (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, `GH_TOKEN`,
`LINEAR_API_KEY`); a project's `.sandcastle/.env` overrides it key by key, except `LINEAR_API_KEY`,
which stays on the host and is refused there.
Key by key means an `ANTHROPIC_API_KEY` in either file reaches the sandboxes beside an OAuth token
in the other, and Claude Code spends the API key first: `sandcastle doctor` then prints a red
`warn API credits` line naming the file, and every run asks before it bills API credits
([Run](running.md#-run)).
`config.json` is optional:

| Key | Default | |
|---|---|---|
| `maxSandboxes`, `maxGates` | `6`, `2` | Machine-wide limits across all projects ([Concurrency](concurrency.md#-concurrency)); `SANDCASTLE_MAX_*` overrides them |
| `keepAwake` | `true` | `false` lets the machine sleep during runs ([Sleep](running.md#-sleep)) |
| `herdr.clickHint` | `"auto"` | `"ctrl"` or `"cmd"`: the key the status view's hint names for a click on a ticket, in place of the one sensed from your terminal (`"auto"`); `SANDCASTLE_CLICK_HINT` overrides it ([The Herdr plugin](herdr.md#the-herdr-plugin)). `herdr` holds no other key |
| `updateCheck` | `true` | `false` stops `sandcastle doctor` and the idle mark looking up the kit's newest release (`git ls-remote --tags` on the kit checkout's `origin`, at most once in six hours; nothing is fetched) |
| `idleMark` | `true` | `false` turns off the idle mark the Claude Code mod draws between runs, in every project ([The Claude Code mod](claude-mod.md#-the-claude-code-mod)) |
| `keepWarm` | `true` | `false` stops the session that started a run keeping its prompt cache warm while the run is live, in every project, and beats a project's `keepWarm: true`. A refresh request reads the cached conversation at about 0.1x the input price; a cold restart re-reads it at the full price, so leave it on unless you would rather not spend the allowance |
| `notify` | none | A command run when a run ends, Ctrl-C and a closed pane included, as a list of arguments, not a shell string: `["notify-send", "Sandcastle"]`, or `["sh", "-c", "notify-send Sandcastle \"$SANDCASTLE_SUMMARY\""]` for a shell. It gets `SANDCASTLE_NAME`, `SANDCASTLE_SUMMARY` (for example `run finished - 3 merged, 1 need you, 2 need fixing, of 6`) and `SANDCASTLE_EXIT`, and ten seconds; if it fails, the run's result stands. A malformed value stops a run before it starts |

A key not in this table is refused, naming the nearest real one, as the project config does.
`sandcastle doctor` reports a `config.json` that is not valid JSON, holds an unknown key, holds a
bad limit, has an `idleMark`, a `keepWarm` or an `updateCheck` that is not `true` or `false`, or a
`herdr` that is not `{"clickHint": "auto" | "ctrl" | "cmd"}`; the status view then shows the hint
that names both keys.

## 🐳 The image's agent versions

Claude Code ships almost daily, so the sandbox image follows a release channel instead of a version
written into the Dockerfile: by default Claude Code's `stable` channel (`"latest"` or an exact
version can be set), and for Codex the newest plain release on npm that is at least 72 hours old
(pre-releases, deprecated or unpublished releases and any above npm's `latest` tag are skipped, and
a fresh release waits out the cooldown, as the kit's own pnpm config does).
The kit resolves both versions on the host when it ensures the image (`sandcastle build`, and the
start of every run) and makes them part of the tag of a shared `sandcastle-agents` image, built
`FROM` the base (`docker/agents.Dockerfile`).
The base and the project's own layer do not carry them, so a release leaves their tags, and Docker's
cache for the layer's steps (browsers, a toolchain), where they were.
It rebuilds the agents image once, about a minute, and a copy layer per project that takes seconds:
each project's image is its layer (or the base) plus Claude Code and Codex copied in from the agents
image, which is the image a sandbox starts from.
Every sandbox of a run has the same version.
Each project's image carries its own copy of the two CLIs.
A run's start lines and `sandcastle build` print
`Claude Code <version> (<channel>) · Codex <version>`, and `run.json` records them.

- **Choose or pin** in `.sandcastle/config.ts`: `claudeCode: "latest"` follows the faster channel,
  `claudeCode: "2.1.285"` pins a version if a release misbehaves.
  `CLAUDE_CODE_VERSION` does the same for one command, and `CODEX_VERSION=0.159.2` pins Codex.
- **Offline**: the resolved pair is cached for six hours in `~/.cache/sandcastle-kit/versions.json`
  (`$XDG_CACHE_HOME` when set).
  If the channel cannot be reached, the cached value is used whatever its age, and with no cache the
  defaults in `docker/agents.Dockerfile`, with one line saying so.
  A run never fails for a network error here.
- **Operating system updates**: the base's tag follows its Dockerfile, not the Debian and Node image
  it is built from, and no release moves it.
  `sandcastle build --force` pulls that base afresh and rebuilds every image on it;
  `sandcastle doctor` warns once a project's base image is more than 30 days old.
- **In a project's layer**: Claude Code and Codex are copied in after the layer, so a `RUN` step of
  the layer that calls `claude` or `codex` finds neither. Move that work to a `setup` command, which
  runs in the finished image. `~/.local/bin` is on `PATH` only in that finished image too: a layer
  step that runs a tool an earlier step installed there names its full path.

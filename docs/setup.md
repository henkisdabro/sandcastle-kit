# Setting up a project

`sandcastle init` and what it writes, the gates, the Dockerfile, and what a sandbox keeps of the
project's agent tooling.

## 🧱 Set up a project

From the project's root, on its base branch:

```bash
sandcastle init      # writes .sandcastle/config.ts, rules.md, .gitignore; prints the lean check
```

`init` reads the stack from the repo root - `package.json` (with its lockfile and scripts),
`pyproject.toml` + `uv.lock`, `go.mod` or `Cargo.toml` - and fills in the gates and setup from it.
Where the base image lacks the toolchain (uv, Go, Rust, Bun) it also writes
`.sandcastle/Dockerfile`. Treat what it writes as a starting point. Anything else, poetry and pipenv
included, gets a placeholder gate that fails until you copy in what CI runs.

Then edit, in this order:

0. **Where do your tickets live?** Nothing to do for GitHub Issues.
   For Markdown tickets set `tracker: "files"` in `config.ts` (or let the kit read
   `docs/agents/issue-tracker.md` if you ran [Matt Pocock's setup
   skill](https://github.com/mattpocock/skills), recommended but optional).
   `sandcastle queue` shows which tracker the kit chose and why; see
   [Trackers](queue.md#-trackers-github-or-ticket-files).
1. **`.sandcastle/config.ts`** - `gates` (the commands CI runs: lint, typecheck, build, test),
   `setup` (dependency install in the sandbox), `mounts` (e.g. a host cache; `pnpmStore: true`
   mounts the host's pnpm store), `lean`.
   See [Configuration](configuration.md#-configuration).
   Gates run in the Linux sandbox, so green proves Linux only: if the project ships to macOS or
   Windows, add a CI job on that OS or run the gates on the host before pushing (see [How it
   works](../README.md#-how-it-works)).
2. **`.sandcastle/rules.md`** - what an agent in *this* repo must read first, must never do
   (deploys, production databases), and how a visual or data change is proven.
   It is added to the implement, review and repair prompts, and reaches only those agents: the
   landing merge is the kit's own `git merge`, so rules do not reach it (see [a branch conflicts at
   landing](troubleshooting.md#-troubleshooting)).
   `init` leaves four questions there for you to answer - which committed files a command writes
   (also `generated` in `config.ts`), which paths an agent must never touch, which gate catches
   drift in generated files (see [A gate for generated files](#-a-gate-for-generated-files)), and
   which command runs the tests that cover changed files, with the repo-wide tests a new file can
   trip - and the `/sandcastle` skill's init action asks them for you.
3. **`.sandcastle/Dockerfile`** - only if the gates need something the base image lacks (browsers,
   Python tooling, a pinned package manager).
   Start from `templates/Dockerfile` in the kit, then name it in `.sandcastle/config.ts` with
   `dockerfile: ".sandcastle/Dockerfile"`: without the key the file is never built, and
   `sandcastle build` skips it with a "Not built" line (`init` adds the key itself when it writes
   the Dockerfile).
   A project that tests in Chromium (Playwright, Puppeteer) should launch it with
   `--disable-dev-shm-usage`: a sandbox gets the runtime's default `/dev/shm`, 64 MB on Docker (some
   runtimes give more), and a heavy page can crash there (`Navigation failed because page crashed!`)
   on the branch and on the base alike.
   The kit passes no `--shm-size`, since the `docker run` builder of `@ai-hero/sandcastle` has no
   such option.
4. **Lean and hooks** - `sandcastle lean` lists what the repo would load into each sandbox and
   checks every kept hook.
   Keep nothing unless a run needs it; drop only host-only hooks.
   It also lists the project's `permissions.ask` rules (in the tracked `.claude/settings.json`),
   which sandboxes refuse - nobody there can answer - so a command matching one fails;
   `sandcastle doctor` warns of them too.
   After the repo's items it lists the built-in tools each pass gets (`keep  tool  Bash` and the
   rest of the allow-list, no token count): every other built-in tool is hidden from every pass.
   Beside the "Always loaded: CLAUDE.md and its imports" line it lists each tracked
   `.claude/rules/**/*.md` file with no `paths:` frontmatter, which Claude Code loads into every
   pass, with its token estimate and a total; scope such a rule with `paths:` and it loads only when
   the agent reads a matching file.
   `sandcastle lean --measure` probes with the same `--tools` list and
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` as a pass, so its two numbers differ only by the repo's
   items.

```bash
sandcastle build             # base image, then the project layer
sandcastle lean              # lean table + hook check (no model calls)
sandcastle gates             # every gate on the base commit in the image (no model calls)
sandcastle preflight         # one reply per model (spends a little allowance)
```

Commit `config.ts`, `rules.md`, the Dockerfile and `.sandcastle/.gitignore` in the project.

### 🧪 A gate for generated files

When the repo commits files that a build generates (minified CSS, a data file built from JSON, a
sitemap), a gate should prove they match the sources.
Otherwise a branch can land sources and generated output that disagree.
A reviewer that finds a change no gate exercises says so, and the closing summary lists the ticket
under Needs you as `merged - check by hand`, with what to check (on its `merged, partly done` bullet
instead, when it has one).

Gates run under `sh -c` in the sandbox (dash on Debian), so write the recipe in POSIX sh. This one
names the build's outputs in `OUT`, runs the build, records which of those paths changed, restores
only those paths and fails, listing them, if any differed:

```ts
gates: [
  {
    name: "generated-in-sync",
    command:
      "OUT='dist/site.css data/index.json dist/sitemap.xml'; pnpm run build || exit 1; diff=$(git status --porcelain -- $OUT ':!dist/sitemap.xml'); git checkout -- $(git ls-files -- $OUT); git clean -fdq -- $OUT; if [ -n \"$diff\" ]; then echo \"$diff\"; echo 'Generated files differ from the commit: run the build and commit them.' >&2; exit 1; fi",
  },
],
```

- Never restore with `git checkout -- .`. The gate runs in the agent's branch worktree, and that
  would discard any other uncommitted file there. `git checkout` also stops without restoring
  anything if a path it is given is not tracked yet, so the recipe hands it only
  `git ls-files -- $OUT`; `git clean` removes new, untracked output.
- The `:!path` exclusion is for output that changes on every build (a sitemap `lastmod`). Making
  the build deterministic, for example by dating `lastmod` from the last commit, is better than
  excluding it.
- `OUT` is split on spaces, so paths with spaces need listing differently.

Declare the same files under `generated` in `.sandcastle/config.ts`, with the command that writes
them: `generated: [{ paths: ["dist/"], regen: "pnpm build" }]`.
A merge that conflicts only in those paths is then resolved by taking either side, re-running
`setup` and running `regen`, with no agent - both when a re-run merges the base into a branch from
an earlier run, and at landing.
A landing resolved this way happens in a throwaway sandbox (the host never runs project code), as a
merge with the usual `Merge agent/issue-N (closes #N)` message.
Before the base moves, the host checks that the commit merges exactly the base tip and the gated
head and changes nothing beyond a plain merge outside `generated` paths; otherwise nothing lands and
the ticket is left as a conflict.
Before a landing takes a sandbox at all, the host asks `git merge-tree` (git 2.38+) whether the
branch still merges, and only a conflict confined to `generated` paths goes on to the sandbox's
merge.
A file a merge driver would resolve inside the sandbox (an npm lockfile driver, say) is therefore a
conflict unless it is listed under `generated`.
With `land: "squash"` the checked merge's tree then lands as one commit, as any other squash does.
The drift gate still proves the result matches the sources: the landing's gates run on that commit,
and the merged base is gated again at the end of the run unless those gates already ran on its tip.

### 🧩 A criterion left undone

Every acceptance criterion a ticket lists is in scope, and so is a regression the branch causes.
An agent that knowingly leaves a criterion undone says so in an `<unmet>` line of its final message.
The branch still lands if its gates are green, but the ticket stays open with a comment naming the
criterion (its merge says `part of` the ticket, not `closes` it, so the next run does not take it
for finished), and the closing summary lists it under Needs you as `merged, partly done`.
While the ticket is still queued, the summary lists it under Runnable now and the next run picks up
the remainder (an autonomy level 2 or above, or `drain`, re-runs it too, and `drain` stops if the
same ticket is left partly done twice running).
When the agent's `<unmet>` line says the remainder needs a person (a decision, a deploy, access), no
run is promised: the summary and the ticket comment suggest moving the ticket to the hold label.
The status view shows such a ticket as merged and counts it under merged, not needs you; it says so
in its note.
A held branch's criterion is on its Needs you line, and `sandcastle land <n>` lands such a branch
the same way: `part of` the ticket, left open with the criterion commented.

### 🧩 A problem outside the ticket

An agent that finds a problem outside its ticket - implementer, reviewer or repair - fixes nothing
for it and files nothing itself: it ends its final message with a
`<followup>title - one line of evidence</followup>` line.
Once the run has landed, the kit files each as a new ticket through the project's tracker, with the
triage label (or ticket-file status) of the `needs-triage` role, and a body naming the source ticket
and the phase; a title already filed in the run is filed once, and a follow-up that names the same
`path:line` in its title as one already filed for the same source ticket is a comment on that issue,
not a second one (so is one whose place is only in its evidence, or a file with no line, or a bare
file name that is the base tree's only file of that name, when the titles also share two significant
words; every file a finding names counts, not only the first; so is one that names no file at all,
or that names one when the other does not, when the titles share three), and so is one a later
`sandcastle run` of the same ticket names again: the kit reads what earlier runs filed from
`logs/history.jsonl` (an issue the tracker says is closed is left out, so a new problem in its file
is filed, not a comment on it), matches by the same title or the same place rules, and shows an
agent the list as "Follow-ups already named from this ticket" (the issues earlier runs filed from it
and the lines its earlier passes named, the review's implementer's among them), so the review does
not restate the implementer's lines.
Every agent is also shown the run's other tickets (ref and title) and the follow-ups other tickets'
agents have named so far this run, as "Other tickets in this run" and "Named by other tickets this
run" (each left out when empty): a problem one of them covers is that ticket's work or filed
already, so it gets no line.
The kit compares nothing across tickets itself; the agent judges.
A ticket file goes beside its source ticket's.
The closing summary lists each under Needs you, in its `To triage` group, as `filed for triage`.
A dry run files none and lists them instead.
A run that stops before its end (a crash, or a safety stop) keeps what its agents named in the run
record as they arrive, and files them as it stops, so the summary lists them; after a safety stop
(the shared `.git` changed) the kit writes nothing more to the tracker, and the summary lists each
as one to file by hand.

A reviewer that names a known gap in prose ("left alone", "remains", "a gap", "not fixed") and ends
its message with neither a `<followup>` nor an `<unmet>` line has lost it, so the kit reads each
review's message for such a sentence (not one that says nothing is left, such as "nothing remains",
and not text in double quotes or backticks) and, for a merged ticket, gives the sentence a line of
its own: `Worth a glance - the reviewer's prose may name a gap`.
It is a guess at a person's wording, so it is not under Needs you, not in the headline's `need you`
and adds no Next step.

## 🪶 Lean sandboxes and hooks

A sandbox has no user-level `~/.claude` (the kit's managed git guard, see [Safety
model](safety.md#-safety-model), adds a hook and no context), so the project's own Claude Code config is
everything an agent loads - and each skill description and MCP tool schema is paid on every turn.
Before the agent starts, each worktree loses `.claude/skills`, `.claude/agents`, `.claude/commands`,
`.agents/skills` (read by Codex), `.mcp.json`, `.codex/config.toml`, and the plugin, marketplace,
MCP-enable and status-line keys of `.claude/settings.json`.
Permissions and `env` stay.
The changes are marked skip-worktree, so an agent can never commit them.
`lean.keep` brings items back.
`sandcastle lean` (and every run) warns when a hidden item is named by a file the sandbox keeps - a
test that reads a skill file, say, would fail on every branch until the item is kept.
Rule files are reported, never hidden: `sandcastle lean` lists each tracked `.claude/rules/**/*.md`
file with no `paths:` frontmatter and its tokens (they load into every pass), and a run's `Lean:`
line gives their count and total (`; 3 always-loaded rule file(s), ~12000 tokens`).
Scoping a rule with `paths:` frontmatter loads it only when the agent reads a matching file.
On a real project this saved ~2,500 input tokens per agent turn.

**Tools and memory.** Each Claude pass is also started with an allow-list of Claude Code's built-in
tools (`--tools`): Bash, Read, Edit, Write and TaskStop, plus Skill when `lean.keep` keeps a skill
or command and ToolSearch when it keeps an MCP server (MCP tools load through it).
Every tool's schema is paid on every turn, and passes were never seen to need the others; together
with auto memory, which is off in sandboxes (a sandbox's memory directory dies with its container),
it about halves the fixed prompt prefix of a pass.
A project whose tickets need another built-in tool keeps it with `tool:<Name>` in `lean.keep`
(`tool:WebSearch` for research tickets): the name is checked against the known tools in
`src/claude-tools.ts` and the managed deny list when the config loads, since Claude Code ignores an
unknown name in `--tools` without a word.

**Hooks are the opposite: kept.** They cost no context and are how a repo enforces its rules -
guards, linters, test gates, audit logs.
`lean.dropHooks` removes host-only conveniences (a token compressor, a preview server, a
notification), never a guard.
Before any sandbox starts, every kept hook is checked in the image: executable on PATH, scripts
present, Python compiles, top-level imports resolve.
A failing hook stops the run; fix it in the project's Dockerfile.
An import the check cannot find (one a hook reaches through a `sys.path.insert` of its own) is only
a warning, and none for a hook that ran cleanly in a passing hook test of the base check at this
base.
Hooks in the untracked `.claude/settings.local.json` never reach a sandbox, and the check warns
about them.
Git hooks run on agent commits inside the sandbox as usual, so `sandcastle gates` and every run's
base check also run the repo's `pre-commit` and `commit-msg` hooks there (`git hook run`, nothing
committed, git 2.36 or newer): a hook the image cannot satisfy stops the run before any agent
starts, and the fix is in the project's Dockerfile.
A `core.hooksPath` that is an absolute host path (or climbs out of the project) names a directory no
sandbox has, so git finds no hooks and agent commits run none: `sandcastle doctor`,
`sandcastle lean` and the base check flag it, naming the value, and the fix is
`git config core.hooksPath <relative path>`.
The Codex review does not run Claude Code hooks.

### Hook tests

The check above proves a hook *can* run, not that it blocks anything. A guard that never fires
and a guard that allowed a harmless call look the same in an agent's log, and a guard whose
Python module is missing exits 1 - which Claude Code treats as a non-blocking error, so the guard
fails open. `hookTests` closes that gap without a model call. Each test is a made-up tool call:

```ts
hookTests: [
  { name: "brand guard refuses an unapproved claim", tool: "Write",
    input: { file_path: "specs/example.json", content: "{\"headline\": \"Guaranteed #1 results\"}" },
    expect: "block" },
  { name: "ordinary edit is allowed", tool: "Edit",
    input: { file_path: "README.md", old_string: "a", new_string: "b" }, expect: "allow" },
],
```

`sandcastle gates` and every run's base check hand it, on stdin and exactly as Claude Code would,
to each kept `PreToolUse` hook whose matcher takes that tool - in the base-gate sandbox, after
`setup` has installed what the hooks import. `block` passes when at least one of them blocks
(exit 2, or a JSON `deny`); `allow` passes when none does. The call itself never happens. A failed
test is a red base gate: the run stops before any agent starts. `sandcastle lean` warns when
guards are kept and no test exists.

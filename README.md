<div align="center">

# 🏰 sandcastle-kit

**Turn your GitHub issues into a software factory.**<br>
Unattended coding agents burn down your issue queue in Docker sandboxes - implemented, reviewed,
gated and merged while you are away from the keyboard.

[![Built on Sandcastle](https://img.shields.io/badge/built%20on-Sandcastle%20by%20Matt%20Pocock-f59e0b?style=flat-square)](https://github.com/mattpocock/sandcastle)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-22c55e?style=flat-square)](LICENSE)
[![Secret scan](https://img.shields.io/github/actions/workflow/status/henkisdabro/sandcastle-kit/secret-scan.yml?branch=main&label=secret%20scan&style=flat-square)](.github/workflows/secret-scan.yml)
[![Release](https://img.shields.io/github/v/release/henkisdabro/sandcastle-kit?style=flat-square&color=8b5cf6)](https://github.com/henkisdabro/sandcastle-kit/releases)

[![Claude Code](https://img.shields.io/badge/Claude%20Code-implement%20%2B%20review-d97757?style=flat-square&logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![Codex](https://img.shields.io/badge/Codex-cross--review-10a37f?style=flat-square&logo=openai&logoColor=white)](https://github.com/openai/codex)
[![Docker](https://img.shields.io/badge/sandbox-Docker%20%7C%20OrbStack%20%7C%20Podman-2496ed?style=flat-square&logo=docker&logoColor=white)](docs/INSTALL.md#-requirements)
[![Node](https://img.shields.io/badge/node-22%2B-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![pnpm](https://img.shields.io/badge/pnpm-f69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io)

[Quick start](#-quick-start) · [Why](#-why-sandcastle-kit) · [Install details](docs/INSTALL.md) · [Set up a project](#-set-up-a-project) · [Run](#-run) · [Updating](#-updating) · [Safety](#-safety-model) · [Troubleshooting](#-troubleshooting)

</div>

> [!NOTE]
> sandcastle-kit is an opinionated issue-burndown kit built on
> **[Sandcastle](https://github.com/mattpocock/sandcastle) by [Matt Pocock](https://github.com/mattpocock)**.
> Sandcastle does the heavy lifting - sandboxing, worktrees and agent orchestration. This kit is
> one way to put it to work, learned from and improved on with gratitude.

Sandcastle runs coding agents in Docker sandboxes. This kit turns it into a ready-made loop for
any GitHub repository: it picks up issues labelled `ready-for-agent`, has one agent implement
each issue and a stronger one review it, runs your project's own lint/build/test gates itself
(an agent never gets to say "tests pass"), merges what is green and closes the issue. One install
serves all your projects; each project adds a small config file.

> [!TIP]
> **AI coding agent?** Read [the section written for you](#-if-you-are-an-ai-coding-agent-reading-this) first.

## ⚡ Quick start

**You need:** macOS or Linux, Node 22+, pnpm, git, the GitHub CLI signed in (`gh auth login`),
and a container runtime - [OrbStack](https://orbstack.dev) or [Podman](https://podman.io) on
macOS, [Docker Engine](https://docs.docker.com/engine/install/) on Linux.
[Full requirements](docs/INSTALL.md#-requirements).

**1. Install the kit** (once per machine) - one line, paste it into your terminal:

```bash
git clone https://github.com/henkisdabro/sandcastle-kit.git ~/sandcastle-kit && cd ~/sandcastle-kit && pnpm install && ./bin/sandcastle setup
```

`setup` puts the `sandcastle` command on your PATH, installs the agent skill, walks you through
your Claude and GitHub tokens, and finishes with a health check. Re-run it any time.
([What it does, and doing it by hand](docs/INSTALL.md).)

**2. Point it at a project:**

```bash
cd ~/code/your-project
sandcastle init              # or ask your agent: /sandcastle init
sandcastle build
```

`init` fills in the gate commands (`lint`, `test`, ...) from your stack; check them against CI in
`.sandcastle/config.ts` - see [Set up a project](#-set-up-a-project).

**3. Label some issues `ready-for-agent` and try a dry run:**

```bash
DRY_RUN=1 sandcastle run     # implement, review, gate - never merge or close
```

---

## 💡 Why sandcastle-kit?

You already drive Claude Code or Codex every day - maybe with subagents, maybe several sessions
side by side. That still needs **you** in the loop: approving prompts, watching terminals, copying
context between chats. sandcastle-kit is the next step up.

- 🎫 **GitHub Issues become the universal ticket system.** Write an issue an agent could finish
  with no chat context, add a label, and it joins the queue. No new tool to learn.
- 🏭 **A software factory per repository.** Each queued issue gets its own git worktree and its
  own Docker sandbox, several at once, across several projects.
- 🧪 **Proof, not promises.** The orchestrator - not the agent - runs your gates. Only green
  branches merge, and the merged branch is gated again.
- 🔒 **Safe to leave unattended.** Agents run with permission prompts off, but inside a container
  with a token that cannot push, and risky changes wait for a human.
- ☕ **You come back to a report**: what merged, what is red, what needs you. Nothing is pushed
  until you push it.

```mermaid
flowchart LR
    A["📝 You write issues<br/>on GitHub"] --> B["🏷️ Label<br/>ready-for-agent"]
    B --> C["🚀 sandcastle run"]
    C --> D1["🐳 Sandbox<br/>issue #12"]
    C --> D2["🐳 Sandbox<br/>issue #15"]
    C --> D3["🐳 Sandbox<br/>issue #18"]
    D1 --> E{"🚦 Your gates<br/>green?"}
    D2 --> E
    D3 --> E
    E -- "yes" --> F["✅ Merged locally<br/>issue closed"]
    E -- "no" --> G["🔴 Left red<br/>for you"]
    E -- "risky paths" --> H["🙋 needs-human"]
    F --> I["📊 Report<br/>you review and push"]
    G --> I
    H --> I

    classDef you fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    classDef kit fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef ok fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef bad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    class A,B,I you
    class C,D1,D2,D3,E kit
    class F ok
    class G,H bad
```

## ✨ What it adds to Sandcastle

| | Feature | What you get |
|---|---|---|
| 🚦 | **Gates run by the orchestrator** | Your lint/build/test, run after the agents, in the sandbox. Only green branches merge, and the merged base branch is gated once more. |
| 🩹 | **Repair on red** | A red gate gets one repair pass on the same warm sandbox, fed the gate's own output, then the gates run again. |
| 🔗 | **Issue dependencies** | `Blocked by #12` in an issue body holds it back until #12 is closed. |
| 🧑‍💻 | **Implement, then review** | Claude Sonnet 5.5 implements, Claude Opus 5.5 reviews, on the same warm sandbox; a failed review falls back to the implementer's model. Optional third review by an OpenAI model through Codex (`CROSS_REVIEW=1`). |
| 🪶 | **Lean sandboxes** | The project's skills, subagents, commands, MCP servers and plugins are hidden from sandbox agents unless you keep them, because each one costs context on every turn. |
| 🪝 | **Hooks enforced** | The project's Claude Code hooks are kept, and checked to be runnable in the image before any sandbox starts. |
| 🐳 | **One base image, a layer per project** | Rebuilt only when a Dockerfile changes. |
| 🛫 | **Preflight** | One short reply from every model before any sandbox starts, so an exhausted plan or a too-old CLI stops the run up front instead of halfway through. |
| 🔒 | **Host safety** | Fine-grained tokens only, host git hooks off during a run, the shared `.git` fingerprinted, risky branches held for a human merge (see [Safety model](#-safety-model)). |
| ⚖️ | **Machine-wide limits** | Several projects can run at once without starving each other. |
| 📺 | **A live status view** | Opened automatically in a sibling pane if you use the Herdr terminal multiplexer; flags a sandbox gone quiet. Phase timings are logged per issue. |
| 🧩 | **An agent skill** | `/sandcastle` in Claude Code, `$sandcastle` in Codex, also read by OpenCode - for setup, issue triage, starting runs and updating. |

## 🔄 How it works

A run starts in a project, on its base branch, with a clean tree. It checks everything first,
then fans out one sandbox per issue, up to `CONCURRENCY` at once and within the machine-wide limit.

```mermaid
flowchart TD
    S(["🚀 sandcastle run"]) --> P["🔍 Checks<br/>token type · images (build if stale) · preflight<br/>prompts · hook check · git fingerprint"]
    P --> Q["📋 Queue: open issues labelled ready-for-agent"]
    Q --> W

    subgraph W ["🐳 Per issue - git worktree + Docker sandbox on branch agent/issue-N"]
        direction TB
        L["🪶 Lean strip · lock worktree · setup install"] --> I["🧑‍💻 Implement agent<br/>commits on the branch"]
        I --> R["🔎 Review agent<br/>fixes on the branch<br/>(fallback model if it fails)"]
        R -.-> X["🤖 Codex review<br/>optional, non-blocking"]
        R --> G{"🚦 Gates<br/>run by the orchestrator"}
        X -.-> G
        G -- "red" --> FX["🩹 Repair agent<br/>fed the gate output<br/>(bounded)"]
        FX --> G
    end

    G -- "green" --> PP{"🛡️ Touches hooks, CI,<br/>install scripts?"}
    G -- "still red" --> RED["🔴 Reported red"]
    PP -- "no" --> M["✅ Merge --no-ff into base<br/>close issue with a comment"]
    PP -- "yes" --> NH["🙋 Labelled needs-human<br/>not merged"]
    M --> V["🔁 Verify: gates once more<br/>on the merged base branch"]
    V --> REP(["📊 Report: merged · red · held back<br/>Nothing is pushed"])
    RED --> REP
    NH --> REP

    classDef ok fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef bad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    classDef agent fill:#ede9fe,stroke:#7c3aed,color:#3b0764
    classDef gate fill:#fef3c7,stroke:#d97706,color:#78350f
    class M,V ok
    class RED,NH bad
    class I,R,X,FX agent
    class G,PP,P gate
```

## 🧱 Set up a project

From the project's root, on its base branch:

```bash
sandcastle init      # writes .sandcastle/config.ts, rules.md, .gitignore; prints the lean check
```

`init` reads the stack from the repo root - `package.json` (with its lockfile and scripts),
`pyproject.toml` + `uv.lock`, `go.mod` or `Cargo.toml` - and fills in the gates and setup from it.
Where the base image lacks the toolchain (uv, Go, Rust, Bun) it also writes
`.sandcastle/Dockerfile`. Treat what it writes as a starting point.

Then edit, in this order:

1. **`.sandcastle/config.ts`** - `gates` (the commands CI runs: lint, typecheck, build, test),
   `setup` (dependency install in the sandbox), `mounts` (e.g. the host package store), `lean`.
   See [Configuration](#-configuration).
2. **`.sandcastle/rules.md`** - what an agent in *this* repo must read first, must never do
   (deploys, production databases), and how a visual or data change is proven. It is added to
   both prompts.
3. **`.sandcastle/Dockerfile`** - only if the gates need something the base image lacks (browsers,
   Python tooling, a pinned package manager). Start from `templates/Dockerfile` in the kit.
4. **Lean and hooks** - `sandcastle lean` lists what the repo would load into each sandbox and
   checks every kept hook. Keep nothing unless a run needs it; drop only host-only hooks.

```bash
sandcastle build             # base image, then the project layer
sandcastle lean              # lean table + hook check (no model calls)
sandcastle preflight         # one reply per model (spends a little allowance)
```

Commit `config.ts`, `rules.md`, the Dockerfile and `.sandcastle/.gitignore` in the project.

## 📋 Queue: what agents work on

The queue is every open issue with the label from `config.ts` (default `ready-for-agent`). Label
an issue only when an agent with no chat context could finish it from the issue and its comments,
and your gates could prove it. The `/sandcastle queue` skill action walks every open issue,
gathers the facts, asks you the open decisions in batches, writes each decision on its issue, then
labels it.

An issue that has to wait for another says so in its body: `Blocked by #12` or `Depends on #12`.
A run skips it while #12 is open - even when #12 is in the same run, because the dependent
would branch before #12 lands - and the next run picks it up.

```mermaid
flowchart LR
    O["📥 Open issues"] --> T{"🧐 Could an agent finish it<br/>with no chat context,<br/>and could the gates prove it?"}
    T -- "yes" --> L["🏷️ ready-for-agent"]
    T -- "open decisions" --> D["💬 You decide<br/>decision written on the issue"]
    D --> L
    T -- "no" --> K["🧑 Keep for a human"]

    classDef ok fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef ask fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    class L ok
    class D,K ask
```

## 🚀 Run

```bash
sandcastle run                        # every queued issue
ISSUES=12,15 sandcastle run           # just these
DRY_RUN=1 sandcastle run              # implement, review, gate - never merge or close
CONCURRENCY=2 sandcastle run          # parallel sandboxes for this run
CROSS_REVIEW=1 sandcastle run         # add the Codex review
```

A run refuses to start on a dirty tree, off the base branch, while another run of the same
project is live, or while any check fails. Inside Herdr it opens `sandcastle status` in a sibling
pane; elsewhere run `sandcastle status` in a second terminal. While agents work, the run prints a
heartbeat line every five minutes, and the status view flags a sandbox whose log has been quiet
for ten. Every agent pass and gate run is timed into `.sandcastle/logs/timings.jsonl`, and the
report gives each issue's wall time. Afterwards, push the base branch yourself when you are happy
with it.

> [!TIP]
> Start with `DRY_RUN=1` on a couple of issues to see the whole loop - implement, review, gates -
> without anything being merged or closed.

## 📥 Updating

In each project, ask your agent for `/sandcastle update`. It pulls the kit, rebuilds the images,
re-runs the hook check, and walks you through anything in [`CHANGELOG.md`](CHANGELOG.md)'s
**Upgrading** notes that affects that project. Existing configs keep working: a new field is
always optional. [By hand](docs/INSTALL.md#-updating).

## 🧰 Commands

| Command | What it does | Calls the model? |
|---|---|---|
| `sandcastle setup` | Interactive install: links the command and skill, writes the credentials file, runs doctor | ➖ no |
| `sandcastle doctor` | Checks machine and project setup; prints the fix for each problem | ➖ no |
| `sandcastle init` | Scaffolds `.sandcastle/` in the current project with gates guessed from its stack, then the lean check | ➖ no |
| `sandcastle build [--force]` | Builds `sandcastle-base:<hash>` and `sandcastle-<name>:<hash>`; prunes superseded tags | ➖ no |
| `sandcastle lean [--measure]` | Lists skills/agents/commands/MCP/plugins (hidden or kept) and hooks (kept or dropped); checks kept hooks in the image. `--measure` runs one real turn with and without the extras | 💸 only with `--measure` |
| `sandcastle preflight` | One "Reply OK" from every model, in the project image | 💸 yes, briefly |
| `sandcastle run` | The burndown (above) | 💸 yes |
| `sandcastle status [secs] [collapse]` | Live view; `0` prints once | ➖ no |

## 🔧 Configuration

`.sandcastle/config.ts` in each project exports a plain object:

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Names the project image (`sandcastle-<name>`) and the status view |
| `gates` | required | `[{ name, command }]`, run in order, stopping at the first red |
| `baseBranch` | `"main"` | Branch agents start from and green work merges into |
| `label` | `"ready-for-agent"` | The queue label |
| `concurrency` | `4` | Parallel sandboxes for this project (inside the machine-wide limit) |
| `dockerfile` | none | Project layer on the base image; starts `ARG BASE=sandcastle-base:latest` / `FROM ${BASE}` |
| `mounts` | `[]` | Extra bind mounts `{ hostPath, sandboxPath, readonly? }` |
| `setup` | `[]` | Commands run in each sandbox before the agents (dependency install) |
| `rules` | none | Markdown file added to both prompts under "Project rules" |
| `lean.keep` | `[]` | Items sandboxes keep: `skill:<name>`, `agent:<name>`, `command:<name>`, `mcp:<server>`, `codex-skill:<name>`, `codex-config` |
| `lean.dropHooks` | `[]` | Substrings of hook commands to drop - host-only conveniences only |
| `protectedPaths` | `[]` | Extra paths a branch may not change and still merge automatically |
| `implement` / `review` | 8 / 3 iterations, 2400 s idle | `{ maxIterations, idleTimeoutSeconds }` per agent |
| `repair` | 1 attempt, 4 iterations, 2400 s idle | `{ attempts, maxIterations, idleTimeoutSeconds }` - passes the implementer's model gets to fix a red gate from its output; `attempts: 0` turns it off. A gate that timed out is never repaired |

Examples: [`examples/`](examples/).

<details>
<summary><b>Environment variables</b></summary>

| Variable | Default | |
|---|---|---|
| `IMPL_MODEL`, `IMPL_EFFORT` | `claude-sonnet-5-5`, `high` | The implementer |
| `REVIEW_MODEL`, `REVIEW_EFFORT` | `claude-opus-5-5`, `high` | The reviewer |
| `CROSS_REVIEW=1`, `CROSS_REVIEW_MODEL`, `CROSS_REVIEW_EFFORT` | off, `gpt-6-astra`, `high` | Codex review, signed in with a read-only copy of `~/.codex/auth.json` |
| `ISSUES`, `CONCURRENCY`, `DRY_RUN` | queue label, config, off | Per run |
| `SKIP_PREFLIGHT=1` | off | Skip the model check |
| `USAGE_CHECK=1`, `USAGE_STOP` | off, `90` | Read the Claude plan's usage windows before each issue starts, and start no new issue once one reaches `USAGE_STOP` percent. Needs `CLAUDE_CODE_OAUTH_TOKEN`. The endpoint is undocumented and rate-limited, so an unknown reading never blocks a run |
| `SANDCASTLE_MAX_SANDBOXES`, `SANDCASTLE_MAX_GATES` | 6, 2 | Machine-wide limits (also `~/.config/sandcastle-kit/config.json`: `{"maxSandboxes": 6, "maxGates": 2}`) |

Effort levels are `low`, `medium`, `high`, `xhigh`, `max`. Anthropic suggests `medium` as a
starting point for agentic coding on both 5.5 models; the kit defaults to `high` for quality.
Measure before changing it.

</details>

## 🪶 Lean sandboxes and hooks

A sandbox has no user-level `~/.claude`, so the project's own Claude Code config is everything an
agent loads - and each skill description and MCP tool schema is paid on every turn. Before the
agent starts, each worktree loses `.claude/skills`, `.claude/agents`, `.claude/commands`,
`.agents/skills` (read by Codex), `.mcp.json`, `.codex/config.toml`, and the plugin, marketplace,
MCP-enable and status-line keys of `.claude/settings.json`. Permissions and `env` stay. The
changes are marked skip-worktree, so an agent can never commit them. `lean.keep` brings items
back. On a real project this saved ~2,500 input tokens per agent turn.

**Hooks are the opposite: kept.** They cost no context and are how a repo enforces its rules -
guards, linters, test gates, audit logs. `lean.dropHooks` removes host-only conveniences (a token
compressor, a preview server, a notification), never a guard. Before any sandbox starts, every
kept hook is checked in the image: executable on PATH, scripts present, Python compiles, top-level
imports resolve. A failing hook stops the run; fix it in the project's Dockerfile. Hooks in the
untracked `.claude/settings.local.json` never reach a sandbox, and the check warns about them. Git
hooks run on agent commits inside the sandbox as usual. The Codex review does not run Claude Code
hooks.

## 🔒 Safety model

Agents run unattended with permission prompts off, inside Docker. The container is the boundary,
and the kit narrows what can cross it:

- 🔑 **Tokens.** Only a fine-grained GitHub token (issues and metadata on chosen repos) enters the
  sandbox. It cannot push, edit workflows or change settings. Empty values are refused so a host
  `ANTHROPIC_API_KEY` cannot leak in.
- 🪝 **Host git hooks off.** Sandcastle mounts the project's `.git` into every container. During a
  run the host's own git calls ignore hooks, so a branch that adds `.husky/post-merge` does not
  run it on your machine when it lands.
- 🧬 **`.git` fingerprint.** `.git/config`, `.git/info/` and the base branch are fingerprinted; if a
  sandbox changes them, the run stops before the host runs another git command there.
- 🎯 **Landing checks.** Before a green branch merges, its issue is read again - closed or
  labelled `needs-human` during the run means no merge - and the merge takes the exact commit
  the gates passed on. A run that dies between merging and closing is finished by the next one.
- 🛡️ **Protected paths.** A green branch that changes hooks, CI, `.claude/` settings, `.sandcastle/`,
  package-manager config or install scripts is labelled `needs-human` and left for you to merge.
- 🚫 **Nothing is pushed or deployed** by the kit. Prompts forbid deploys and production commands;
  put the project's own prohibitions in `rules.md`.
- 📁 **Sandbox transcripts** stay in the project's `.sandcastle/logs/`, not in `~/.claude/projects`.

> [!WARNING]
> Do not weaken these rules to make a run start. If a check fails, fix the cause.

## 🚦 Concurrency

Several projects can run at once; one project runs once at a time (`run.lock`). A machine-wide
pool caps live sandboxes (default 6) and gate runs (default 2) across all projects. Agents mostly
wait on the model, so the sandbox cap mainly limits memory and plan usage; gates are the
CPU-heavy part, and running too many at once produces false test failures. The status header
shows the pool (`machine: sandboxes 3/6 · gates 1/2`). All runs share one plan allowance; the
first issue that hits the usage limit stops that run's queue. With `USAGE_CHECK=1` a run stops
starting issues before that, once a usage window passes `USAGE_STOP` percent.

## 🩺 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Docker running` shows `FIX` | Start OrbStack, the Podman machine (`podman machine start`), Docker Desktop or the Docker daemon, and check `docker info` works in that shell. |
| `GH_TOKEN is not a fine-grained token` | Create a `github_pat_` token with `sandcastle setup` (or as in [docs/INSTALL.md](docs/INSTALL.md#-installing-by-hand)). A project's `.sandcastle/.env` overrides the shared one - check both. |
| `Preflight failed` naming a model | Plan limit reached, token expired, or the image's Claude Code is older than the model needs: bump `CLAUDE_CODE_VERSION` in `docker/base.Dockerfile`; the next run rebuilds. |
| `A kept hook cannot run in the image` | Install what the hook calls in the project's Dockerfile, or - only for host-only conveniences - add it to `lean.dropHooks`. |
| `placeholders Sandcastle cannot fill` | `rules.md` contains `{{SOMETHING}}`; reword it. |
| `Another sandcastle run of this project is live` | One run per project. Wait; if that process is gone, the lock clears itself on the next run. |
| `STOPPED ... .git/config ... changed` | Inspect `git config --local --list`, `.git/info/` and `git reflog <base>` before any other git command in that repo. |
| An issue `CRASHED` with "trust dialog" or exit code 1 | Read the last lines of `.sandcastle/logs/agent-issue-<n>-*.log`; usually a usage limit. |
| Status view shows nothing | Run it from inside the project; `sandcastle status 0` prints once. |
| `waits for #N to close` / `waiting, not started` | The issue body says `Blocked by #N` (or `Depends on #N`) and #N is open. Close #N, or remove the line. This also applies to issues named in `ISSUES=`. |
| `gated green but not merged` | The issue was closed or labelled `needs-human` during the run, or its branch gained a commit after the gates passed. The branch is left standing. |
| `quiet 14m` in the status view | That sandbox's log has been silent for 14 minutes. Often a long think or a slow test; read the log's last lines before assuming it hung. |

## 🤖 If you are an AI coding agent reading this

You are probably helping a user who cloned this repository. Read this section first; it is the
whole mental model.

**There are three places. Never mix them up.**

| Place | What lives there | Who edits it |
|---|---|---|
| **The kit** - this repository, cloned once per machine (anywhere) | Orchestrator code, prompts, base Docker image, status view, the `/sandcastle` agent skill | Nobody, for normal use. It is shared by every project and may be public: **never write credentials, names, client or project details into it.** |
| **User config** - `~/.config/sandcastle-kit/` | `.env` (tokens), optional `config.json` (machine-wide limits), optional `denylist` | The user, once. Never committed anywhere. |
| **Each project** - the repository the agents will work on | `.sandcastle/config.ts`, `.sandcastle/rules.md`, optional `.sandcastle/Dockerfile`; generated `logs/`, `worktrees/`, `.run/` (gitignored) | You and the user, when setting that project up. |

The `sandcastle` command is run **from inside a project**, never from inside the kit (except
`sandcastle doctor`, which works anywhere).

**Map the user's request to an action:**

| The user says | Do this |
|---|---|
| "set this up", "install sandcastle-kit", anything on a fresh clone | Ask the user to run `./bin/sandcastle setup` from the kit clone in their own terminal - it asks for tokens, which only they can create. Then run `sandcastle doctor` and fix each `FIX` line in order until none remain. [docs/INSTALL.md](docs/INSTALL.md) has the manual steps. |
| "use sandcastle in this project", "set up this repo" | Follow [Set up a project](#-set-up-a-project). If the `/sandcastle` skill is installed, `/sandcastle init` does this with the user. |
| "which issues can the agents do?", "triage for sandcastle" | `/sandcastle queue`, or [Queue](#-queue-what-agents-work-on) by hand. |
| "start a run", "burn down the queue" | [Run](#-run). A run takes hours: start it in a separate terminal or pane, not in your own shell. |
| "is it working?", "what is it doing?" | `sandcastle status 0` for a snapshot; logs are in the project's `.sandcastle/logs/`. |
| "update sandcastle", "get the latest kit" | `/sandcastle update`, or [Updating](docs/INSTALL.md#-updating) by hand. It pulls the kit and brings the current project up to date; `CHANGELOG.md` says what changed. |
| Anything fails | `sandcastle doctor`, then [Troubleshooting](#-troubleshooting). |

**Rules for you:**

- Run `sandcastle doctor` before anything else. It prints `ok`, `opt` or `FIX` per requirement,
  each `FIX` with the exact command to run.
- Tokens go only in `~/.config/sandcastle-kit/.env` (or a project's gitignored `.sandcastle/.env`).
  Never into the kit, never into a committed file.
- `sandcastle run`, `sandcastle preflight` and `sandcastle lean --measure` call the model and spend
  the user's plan allowance or API credits. Ask before running them.
- A run merges into the project's base branch locally and comments on and closes GitHub issues.
  Confirm with the user before starting one. It never pushes.
- Do not weaken the safety rules below (token type, protected paths, hook checks) to make a run
  start. Fix the cause, or ask the user.

## 🤝 Contributing to the kit

`AGENTS.md` has the layout and conventions. This repository is public and used daily by its
maintainer, so nothing personal, client-specific or secret may be committed: enable the guard with
`git config core.hooksPath .githooks` (requires `gitleaks`; add your own denylist at
`~/.config/sandcastle-kit/denylist`). CI scans every push for secrets.

## 🙏 Credits and licence

Built on **[Sandcastle](https://github.com/mattpocock/sandcastle)** by
**[Matt Pocock](https://github.com/mattpocock)**, which does all the sandboxing, worktree and agent
orchestration underneath; this kit is one opinionated way to use it. Sandcastle's own templates
are the place to start if you want to build your own workflow. If this kit helps you, go and star
the original.

MIT - see [`LICENSE`](LICENSE). Sandcastle's licence is reproduced in [`NOTICE`](NOTICE).

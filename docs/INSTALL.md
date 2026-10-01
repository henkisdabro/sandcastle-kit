# 📦 Installing sandcastle-kit

The short version is one line, from the [README's quick start](../README.md#-quick-start):

```bash
git clone https://github.com/henkisdabro/sandcastle-kit.git ~/sandcastle-kit && cd ~/sandcastle-kit && pnpm install && ./bin/sandcastle setup
```

The kit can live anywhere; `~/sandcastle-kit` is only a default. This page covers what you need first, what `setup` does, and how to do
the same by hand.

## ✅ Requirements

| | Requirement | Notes |
|---|---|---|
| 💻 | **macOS or Linux** | Windows is not supported natively. WSL 2 with Docker Engine may work but is untested. |
| 🐳 | **A Docker-compatible container runtime** | The kit calls the `docker` command, so any runtime that provides it works - see the table below. |
| 🟩 | **Node.js 22+** | 24 LTS recommended. |
| 📦 | **pnpm** | Installs the kit's dependencies. |
| 🌿 | **git 2.31+** | Worktrees are the backbone of every run. |
| 🔎 | **jq** | The status view reads run records with it; preinstalled on macOS 15+, not on most Linux. `apt install jq`, `dnf install jq` or `brew install jq`. |
| 🐙 | **GitHub CLI**, signed in | `gh auth login`. Only needed when tickets are GitHub Issues; a project that keeps them as files in the repo can skip it. |
| 🧠 | **A Claude subscription or Anthropic API key** | For the implement and review agents. A subscription token comes from `claude setup-token`, so Claude Code must be installed somewhere. |
| 🔑 | **A fine-grained GitHub token** | Issues read/write and metadata read, on chosen repos only. `setup` walks you through it. |

**Container runtime by operating system**

| OS | Recommended | Also works |
|---|---|---|
| 🍎 **macOS** | **[OrbStack](https://orbstack.dev)** - light, fast, and provides `docker` out of the box | **[Podman](https://podman.io)** with Docker compatibility turned on (Podman Desktop -> Settings -> Docker Compatibility, so `docker` talks to the Podman machine), or Docker Desktop |
| 🐧 **Linux** | **[Docker Engine](https://docs.docker.com/engine/install/)** | **Podman** with the `podman-docker` package, which installs a `docker` command |
| 🪟 **Windows** | Not supported | Try WSL 2 with Docker Engine inside it, at your own risk |

> [!TIP]
> Whichever runtime you choose, `docker info` must succeed in the same shell you run `sandcastle`
> from. `sandcastle doctor` checks this for you.

**Optional:** [Codex CLI](https://github.com/openai/codex) (cross-review), [Herdr](https://herdr.dev) (status pane and a pane per
sandbox, opened automatically), [gitleaks](https://github.com/gitleaks/gitleaks) (only to contribute to the kit).

## 🧙 What `sandcastle setup` does

Run it from the kit clone, in your own terminal - it asks for tokens with echo off. The one-line
install ends with it; to run it again later: `sandcastle setup`.

1. **Links the command** into `~/.local/bin` and tells you the line to add if that folder is not
   on your `PATH`. It never edits your shell files.
2. **Links the skill** for Claude Code (`~/.claude/skills`, which OpenCode also reads), and for
   Codex (`~/.agents/skills`) if Codex is installed and you say yes.
3. **Claude credential** - offers to run `claude setup-token` for your subscription, or takes an
   Anthropic API key.
4. **GitHub token** - opens GitHub's token page pre-filled with the right permissions, then checks
   the token you paste is fine-grained and that GitHub accepts it.
5. **Writes** `~/.config/sandcastle-kit/.env` with owner-only permissions (600), keeping anything
   already in it.
6. **Runs `sandcastle doctor`**, which checks the rest (Docker, `gh`, git) and prints the fix for
   anything missing.

It installs no software. Re-run it any time: finished steps show `ok` and are skipped.

## 🔧 Installing by hand

The same steps without the wizard:

```bash
git clone https://github.com/henkisdabro/sandcastle-kit.git
cd sandcastle-kit && pnpm install

# The command, on your PATH (add ~/.local/bin to PATH if it is not)
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/sandcastle" ~/.local/bin/sandcastle

# The sandcastle skill (optional, recommended) - one file for every agent
mkdir -p ~/.claude/skills && ln -sfn "$PWD/skill" ~/.claude/skills/sandcastle   # Claude Code, OpenCode
mkdir -p ~/.agents/skills && ln -sfn "$PWD/skill" ~/.agents/skills/sandcastle   # Codex only

# Credentials, outside the repo
mkdir -p ~/.config/sandcastle-kit
cp .env.example ~/.config/sandcastle-kit/.env && chmod 600 ~/.config/sandcastle-kit/.env
```

Then uncomment and fill in `~/.config/sandcastle-kit/.env`:

- `CLAUDE_CODE_OAUTH_TOKEN` - run `claude setup-token` (uses your Claude subscription), **or**
  `ANTHROPIC_API_KEY` (billed per token).
- `GH_TOKEN` - a **fine-grained** token (`github_pat_...`) from
  <https://github.com/settings/personal-access-tokens/new>: repository access limited to the
  repos you will run, permissions **Issues: Read and write** and **Metadata: Read**.

Leave unused keys commented out: an empty value stops a run.

> [!IMPORTANT]
> Classic (`ghp_`) and OAuth (`gho_`, e.g. `gh auth token`) tokens are refused, because sandbox
> agents run with permission prompts off and such a token could push or edit workflows.

Run `sandcastle doctor` until it reports no `FIX` lines.

## 🔄 Updating

In a project, ask your agent for `/sandcastle update`: it pulls the kit, rebuilds the images,
re-runs the hook check, and walks you through anything in [`CHANGELOG.md`](../CHANGELOG.md)'s
**Upgrading** notes that affects that project. By hand:

```bash
cd ~/sandcastle-kit && git pull --ff-only && pnpm install && sandcastle doctor
cd ~/code/your-project && sandcastle build && sandcastle lean
```

Then read the Upgrading notes in `CHANGELOG.md`. Existing `.sandcastle/config.ts` files keep
working - a new field is always optional, with a default - but a new default can change what a
run does or spends. The skill updates with the pull, since it is a link into the kit.

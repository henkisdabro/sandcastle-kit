# sandcastle-base: what every project's sandbox needs. A project adds its own
# toolchain in a layer (`ARG BASE` / `FROM ${BASE}`); the kit tags the base and the layer by a
# hash of their Dockerfiles (and the base by the user ids it passes in), so a change here
# rebuilds every project's layer on its next run and nothing else does.
#
# Claude Code and Codex are not here: a release would move this image's tag and so rebuild every
# project's layer from scratch. docker/agents.Dockerfile builds them into an image of their own
# (src/versions.ts resolves the versions), and the kit copies them in on top of the project's layer.
#
# Node 24 LTS on Debian 13 (trixie). Debian packages - git, python3, jq, curl - come
# from the release this names, so an oldstable base keeps them years behind.
#
# Full `node:24-trixie`, not `-slim`: the toolchain it carries is load-bearing.
# - `src/lean.ts` runs python3 in the container for the hook check.
# - node-gyp and Python sdist builds need gcc, make and the -dev libraries.
# - `sandcastle init`'s Rust scaffold needs a linker.
# - glibc, which Claude Code's native binary and Playwright both need.
# Alpine (musl) is out too: Playwright does not support it, and Claude Code needs
# workarounds there. Switching to `-slim` to save space breaks projects' gates.
FROM node:24-trixie

RUN apt-get update && apt-get install -y git curl jq less tini \
  && rm -rf /var/lib/apt/lists/*

# `sandcastle preview` needs git 2.47 (`git merge-tree --write-tree`). Fail the
# build here, not a run later. POSIX sh: the major and minor of `git --version`.
RUN v=$(git --version | sed 's/^git version //') \
  && major=${v%%.*} && rest=${v#*.} && minor=${rest%%.*} \
  && { [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 47 ]; }; } \
  || { echo "git $v is older than 2.47 (git merge-tree --write-tree): sandcastle preview needs it" >&2; exit 1; }

# GitHub CLI - agents read, comment on and label issues with it.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# pnpm and yarn through corepack, at whatever version each project's
# package.json#packageManager pins. Must run as root: it writes shims into
# /usr/local/bin.
RUN corepack enable

# Align the agent user with the host user, so files written in the bind-mounted
# worktree belong to the host user without a runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Writable by the agent, so corepack can fetch a project's package manager.
ENV COREPACK_HOME=/home/agent/.cache/node/corepack

WORKDIR /home/agent
# Sandcastle bind-mounts the worktree at /home/agent/workspace and works there.
# tini as PID 1: when an exec'd shell exits, its children are reparented to PID 1, and `sleep` never
# reaps them, so a killed process stays a zombie that `kill -0` still finds - a test that checks a
# process is gone behaves differently in the sandbox than on a Mac. Sandcastle's `docker run` has no
# `--init`, so the image carries its own. The split form keeps the library's command-less run at
# `tini -- sleep infinity` and gives a hand-run `docker run -it <image> bash` a shell under tini. A
# project layer that sets its own ENTRYPOINT loses tini.
# The sleep has no SIGTERM handler, so every `docker stop` of a sandbox waited out Docker's 10 s
# before its SIGKILL, inside a slot or on the landing worker. Nothing in the container keeps state of its
# own (the work is in the bind-mounted worktree), so the kill comes first.
STOPSIGNAL SIGKILL
ENTRYPOINT ["tini", "--"]
CMD ["sleep", "infinity"]

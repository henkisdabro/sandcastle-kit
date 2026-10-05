# sandcastle-base: what every project's sandbox needs. A project adds its own
# toolchain in a layer (`ARG BASE` / `FROM ${BASE}`); the kit tags both by a
# hash of their Dockerfiles and of the agent versions the kit passes in (src/versions.ts),
# so a new Claude Code or Codex release, or a change here, rebuilds every project's
# image on its next run and nothing else does.
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

RUN apt-get update && apt-get install -y git curl jq less \
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

# Codex CLI, for the opt-in cross-family review (CROSS_REVIEW=1). It
# signs in with a copy of the host's ~/.codex/auth.json. The cache clean drops
# about 164 MB of /root/.npm that `npm install -g` leaves in the layer.
# The kit passes the version it resolved (npm's `latest`, or CODEX_VERSION); this default is
# the offline fallback, used only when there is no network and no cached value.
ARG CODEX_VERSION=0.160.0
RUN npm install -g @openai/codex@$CODEX_VERSION && npm cache clean --force

# Align the agent user with the host user, so files written in the bind-mounted
# worktree belong to the host user without a runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Claude Code. The kit passes the version it resolved on the host (the `stable` channel
# unless the project's `claudeCode` or CLAUDE_CODE_VERSION says otherwise) and tags the image
# by it. An install left to float is cached as a layer at whatever version was current when
# the image was built, and a model newer than that CLI is refused at the first call ("Claude
# Code 2.1.272 does not support this model; version 2.1.280 or newer is required"). This
# default is the offline fallback, used only when there is no network and no cached value.
ARG CLAUDE_CODE_VERSION=2.1.285
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "$CLAUDE_CODE_VERSION"
ENV PATH="/home/agent/.local/bin:$PATH"

# Writable by the agent, so corepack can fetch a project's package manager.
ENV COREPACK_HOME=/home/agent/.cache/node/corepack

WORKDIR /home/agent
# Sandcastle bind-mounts the worktree at /home/agent/workspace and works there.
# sleep as PID 1 has no SIGTERM handler, so every `docker stop` of a sandbox waited out Docker's 10 s
# before its SIGKILL, inside a slot or on the landing worker. Nothing in the container keeps state of its
# own (the work is in the bind-mounted worktree), so the kill comes first.
STOPSIGNAL SIGKILL
ENTRYPOINT ["sleep", "infinity"]

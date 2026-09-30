# sandcastle-base: what every project's sandbox needs. A project adds its own
# toolchain in a layer (`ARG BASE` / `FROM ${BASE}`); the kit tags both by a
# hash of their Dockerfiles, so bumping a pin here rebuilds every project's
# image on its next run and nothing else does.
#
# Node 24 LTS on Debian 13 (trixie). Debian packages - git, python3, jq, curl - come
# from the release this names, so an oldstable base keeps them years behind.
FROM node:24-trixie

RUN apt-get update && apt-get install -y git curl jq \
  && rm -rf /var/lib/apt/lists/*

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

# Codex CLI, pinned, for the opt-in cross-family review (CROSS_REVIEW=1). It
# signs in with a copy of the host's ~/.codex/auth.json.
ARG CODEX_VERSION=0.159.2
RUN npm install -g @openai/codex@$CODEX_VERSION

# Align the agent user with the host user, so files written in the bind-mounted
# worktree belong to the host user without a runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Claude Code, pinned. An unpinned install is cached as a layer at whatever
# version was current when the image was built, and a model newer than that
# CLI is refused at the first call ("Claude Code 2.1.272 does not support this
# model; version 2.1.280 or newer is required" - claude-opus-5-5, 20260923).
ARG CLAUDE_CODE_VERSION=2.1.285
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "$CLAUDE_CODE_VERSION"
ENV PATH="/home/agent/.local/bin:$PATH"

# Writable by the agent, so corepack can fetch a project's package manager.
ENV COREPACK_HOME=/home/agent/.cache/node/corepack

WORKDIR /home/agent
# Sandcastle bind-mounts the worktree at /home/agent/workspace and works there.
ENTRYPOINT ["sleep", "infinity"]

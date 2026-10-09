# sandcastle-agents: Claude Code and Codex, built once per release FROM the base and shared by every
# project. The kit never runs this image. It copies the two CLIs out of it into the image of each
# project (src/sandbox.ts, `ensureImage`), on top of the project's own layer, so a release rebuilds
# this file's two steps and a copy layer per project and not the project's own toolchain.
#
# The kit tags this image by a hash of this file, the user ids and both versions, and passes the
# versions it resolved (src/versions.ts). Where a CLI lands is what the copy takes, so a change to a
# path here is a change to `ensureImage`'s final image too.

ARG BASE=sandcastle-base:latest
FROM ${BASE}

# Codex CLI, for the opt-in cross-family review (CROSS_REVIEW=1). It signs in with a copy of the
# host's ~/.codex/auth.json. Installed as root into a prefix of its own, so the copy takes the
# package and its `bin` link and nothing of the base's npm tree (/usr/local/lib/node_modules). The
# cache clean drops about 164 MB of /root/.npm that `npm install -g` leaves in the layer.
# The kit passes the version it resolved (the newest plain release at least 72 hours old, or
# CODEX_VERSION); this default is the offline fallback, used only when there is no network and
# no cached value.
USER root
ARG CODEX_VERSION=0.160.0
RUN npm install -g --prefix /opt/codex @openai/codex@$CODEX_VERSION && npm cache clean --force

# Claude Code, as the agent user: it installs under the user's home (~/.local), which is what the
# copy takes. The kit passes the version it resolved on the host (the `stable` channel unless the
# project's `claudeCode` or CLAUDE_CODE_VERSION says otherwise) and tags the image by it. An
# install left to float is cached as a layer at whatever version was current when the image was
# built, and a model newer than that CLI is refused at the first call ("Claude Code 2.1.272 does
# not support this model; version 2.1.280 or newer is required"). This default is the offline
# fallback, used only when there is no network and no cached value.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
USER ${AGENT_UID}:${AGENT_GID}
ARG CLAUDE_CODE_VERSION=2.1.285
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "$CLAUDE_CODE_VERSION"

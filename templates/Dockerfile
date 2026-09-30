# Project layer on sandcastle-base. Built with no context, so no COPY.
ARG BASE=sandcastle-base:latest
FROM ${BASE}

# Root for system packages, then back to the agent user.
# USER root
# RUN apt-get update && apt-get install -y <packages> && rm -rf /var/lib/apt/lists/*
# USER agent

# Pre-fetch the project's pinned package manager.
# RUN corepack prepare pnpm@<version> --activate

# Project layer on sandcastle-base. Built with no context, so no COPY.
ARG BASE=sandcastle-base:latest
FROM ${BASE}

# uv, for the agent user. The base image already has python3 for hooks.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

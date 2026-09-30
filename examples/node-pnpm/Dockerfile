# Project layer on sandcastle-base. Built with no context, so no COPY.
ARG BASE=sandcastle-base:latest
FROM ${BASE}

# Playwright's Chromium, pinned to the repo's @playwright/test version, readable by the agent.
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@1.62.1 install --with-deps chromium && chmod -R a+rX /ms-playwright
USER agent

# The package manager version from package.json#packageManager.
RUN corepack prepare pnpm@12.3.4 --activate

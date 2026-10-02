# Project layer on sandcastle-base. Built with no context, so no COPY.
ARG BASE=sandcastle-base:latest
FROM ${BASE}

# The repo's pre-commit hook (.githooks/pre-commit, on when core.hooksPath is set) refuses every
# commit without gitleaks. Without it here, every agent finished its ticket and could not commit.
ARG GITLEAKS_VERSION=8.30.1
USER root
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64; sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;; \
      arm64) arch=arm64; sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;; \
      *) echo "no gitleaks build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    f="gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSL -o "/tmp/$f" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/$f"; \
    echo "$sum  /tmp/$f" | sha256sum -c -; \
    tar -xzf "/tmp/$f" -C /usr/local/bin gitleaks; \
    rm "/tmp/$f"; \
    gitleaks version
USER agent

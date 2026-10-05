# Project layer on sandcastle-base. Built with no context, so no COPY but from a stage.
ARG BASE=sandcastle-base:latest

# macOS ships bash 3.2 and status.sh must run on it, but the sandbox's bash is 5: without this,
# 3.2 breakage showed only in test/full-check.sh on the host, after the branch had landed.
# Built in a stage of its own (the base already has gcc and make) so the toolchain stays out of
# the image. 3.2.57 is the version macOS has frozen at.
FROM ${BASE} AS bash32
ARG BASH32_VERSION=3.2.57
ARG BASH32_SHA256=3fa9daf85ebf35068f090ce51283ddeeb3c75eb5bc70b1a4a7cb05868bfe06a4
USER root
WORKDIR /tmp/bash32
RUN set -eu; \
    # bison: the tarball's generated parser predates its own patched parse.y, so it is rebuilt.
    apt-get update && apt-get install -y --no-install-recommends bison; \
    f="bash-${BASH32_VERSION}.tar.gz"; \
    curl -fsSL -o "$f" "https://ftp.gnu.org/gnu/bash/$f"; \
    echo "$BASH32_SHA256  $f" | sha256sum -c -; \
    tar -xzf "$f" --strip-components=1; \
    # Its 2006 config.guess knows no aarch64, and gcc 14 refuses its K&R-era C by default.
    cp /usr/share/misc/config.guess /usr/share/misc/config.sub support/; \
    CC="gcc -std=gnu89 -fpermissive -w" ./configure --without-bash-malloc --disable-nls >/dev/null; \
    make -j"$(nproc)" >/dev/null; \
    ./bash -c 'echo "built bash $BASH_VERSION"'; \
    install -m 755 bash /usr/local/bin/bash32

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

# shellcheck, so an agent can lint the shell scripts (status.sh, container/git-guard.sh, test/*.sh)
# before they reach a host check.
RUN apt-get update && apt-get install -y --no-install-recommends shellcheck \
  && rm -rf /var/lib/apt/lists/* && shellcheck --version | head -2
COPY --from=bash32 /usr/local/bin/bash32 /usr/local/bin/bash32
USER agent

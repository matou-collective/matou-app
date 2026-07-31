FROM node:22-bookworm

# System deps. make for backend/Makefile targets.
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  make \
  && rm -rf /var/lib/apt/lists/*

# Go toolchain matching backend/go.mod (go 1.25.5). bookworm's apt Go is far
# too old — install the official tarball.
RUN curl -sL https://go.dev/dl/go1.25.5.linux-amd64.tar.gz | tar -xz -C /usr/local
ENV PATH="/usr/local/go/bin:$PATH"

# Issue tracker: Forgejo (git.matou.nz/Matou/matou-app) — spoken to with
# plain curl + jq; no tracker CLI to install.

# Build-args for UID/GID alignment: sandcastle docker build-image defaults
# these to the host user's UID/GID so image-built files and bind-mounted
# files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

# Go env for the agent user: module cache on the mounted volume.
ENV GOMODCACHE=/home/agent/go/pkg/mod
ENV GOPATH=/home/agent/go

WORKDIR /home/agent

# Sandcastle bind-mounts the worktree at /home/agent/workspace and overrides
# the working directory at container start.
ENTRYPOINT ["sleep", "infinity"]

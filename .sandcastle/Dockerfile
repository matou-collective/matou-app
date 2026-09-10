FROM node:22-bookworm

# System deps. make for backend/Makefile targets.
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  make \
  openssh-client \
  && rm -rf /var/lib/apt/lists/*

# Go toolchain matching backend/go.mod (go 1.25.5). bookworm's apt Go is far
# too old — install the official tarball.
RUN curl -sL https://go.dev/dl/go1.25.5.linux-amd64.tar.gz | tar -xz -C /usr/local
ENV PATH="/usr/local/go/bin:$PATH"
# The ENV above only covers non-login shells. Debian's /etc/profile
# unconditionally overwrites PATH for login shells (used by ci.yml's
# `docker run --entrypoint bash ... -lc`) before sourcing profile.d, dropping
# /usr/local/go/bin. Re-add it there so login shells keep `go` on PATH too.
RUN echo 'export PATH="/usr/local/go/bin:$PATH"' > /etc/profile.d/00-go.sh
# golangci-lint pinned by version + sha256 (#346). v2.x is required for Go 1.25.
# The same binary runs the pre-push gate (go-gate.sh) and ci.yml's lint stage.
RUN curl -sSfL -o /tmp/gl.tgz https://github.com/golangci/golangci-lint/releases/download/v2.13.2/golangci-lint-2.13.2-linux-amd64.tar.gz \
  && echo "2277d43b98ec0054280f2ac26b53268bae97682444678a59a657dd565da021d6  /tmp/gl.tgz" | sha256sum -c - \
  && tar -xzf /tmp/gl.tgz -C /usr/local/bin --strip-components=1 golangci-lint-2.13.2-linux-amd64/golangci-lint \
  && rm /tmp/gl.tgz
# The factory pre-push gate (.sandcastle/gate-lib.sh, vendored) runs
# `nix develop .#go-ci` by default — this repo has no flake and its Go module is
# backend/, so point the gate at the repo-local stage script instead (#346).
ENV GATE_GO_CMD="bash .sandcastle/go-gate.sh"

# Issue tracker: Forgejo (git.matou.nz/Matou/matou-app) — spoken to with
# plain curl + jq; no tracker CLI to install.

# git-worktree admin fence (factory-vendored, #572/ADR 0180). Every worker
# bind-mounts the SAME parent .git/worktrees/ admin, so a mutating
# `git worktree` op from inside one worker's container can corrupt a
# parallel worker's worktree (ourcloud run 1649/1654). Install the shim as
# /usr/local/bin/git — ahead of apt's /usr/bin/git on PATH — so those
# mutating operations are refused inside the sandbox; everything else passes
# through. The build context is .sandcastle/ (sandcastle docker build-image),
# so the source path is bare `git-fence`.
COPY git-fence /usr/local/bin/git
RUN chmod 0755 /usr/local/bin/git

# pnpm, for the swarm harness's own root install (main.mts's sandbox setup
# step runs `pnpm install --frozen-lockfile` at /home/agent/workspace before
# the agent starts — the root package.json is sandcastle+tsx only, separate
# from frontend's npm and backend's go). Pinned to the version this host's
# lockfile was generated with (factory onboarding, #572).
RUN npm install -g pnpm@11.6.0

# Build-args for UID/GID alignment: sandcastle docker build-image defaults
# these to the host user's UID/GID so image-built files and bind-mounted
# files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Marks this as the Sandcastle sandbox: align-worktree.sh and the pre-push
# protected-paths gate (both factory-vendored, #572) only run when this is
# set, so a human's or the swarm harness's own host push is never gated.
ENV FACTORY_SANDBOX=1

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

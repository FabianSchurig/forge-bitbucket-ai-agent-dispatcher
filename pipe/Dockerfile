# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# ai-agent-pipe runtime image (Image A).
#
# This image is intentionally small.  Its only job is to orchestrate the
# devcontainer build and launch the selected agent profile; the heavy lifting happens
# inside the dynamically built agent image (Image B), see scripts/run-agent.sh.
#
# Layers:
#   - debian trixie-slim base for glibc compatibility with devcontainer CLI
#   - git, openssh-client, curl, jq, ca-certificates  -> clone + REST calls
#   - tini                                             -> signal forwarding as PID 1
#   - docker-cli + buildx                              -> talks to host docker daemon
#   - nodejs 24 + @devcontainers/cli                   -> devcontainer build
#
# The base image is pinned by digest and kept current by Dependabot.
# ---------------------------------------------------------------------------
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

ARG NODE_MAJOR=24
ARG DEVCONTAINERS_CLI_VERSION=0.90.0

# ---------------------------------------------------------------------------
# OS packages.
# We install everything in a single RUN to keep the image small and to make
# the resulting layer reproducible.  `--no-install-recommends` avoids
# pulling in optional packages we don't need at runtime.
#
# Docker and NodeSource are added as signed apt repositories rather than by
# piping an installer script into bash, so every package is verified against
# the repository's key.
# ---------------------------------------------------------------------------
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        openssh-client \
        tini \
    ; \
    install -m 0755 -d /etc/apt/keyrings; \
    # --- Docker CLI (no daemon – we use the host's via /var/run/docker.sock) ---
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
        > /etc/apt/sources.list.d/docker.list; \
    # --- NodeSource Node.js (@devcontainers/cli needs Node >= 20) ---
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    chmod a+r /etc/apt/keyrings/*.asc; \
    apt-get update; \
    # buildx: the docker CLI refuses `DOCKER_BUILDKIT=1 docker build` without it.
    apt-get install -y --no-install-recommends \
        docker-buildx-plugin \
        docker-ce-cli \
        nodejs \
    ; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# @devcontainers/cli – pinned exactly, because its flags and its build
# behaviour are part of what this image promises. Bump it deliberately.
# ---------------------------------------------------------------------------
RUN npm install -g --no-audit --no-fund "@devcontainers/cli@${DEVCONTAINERS_CLI_VERSION}" \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# Pipe payload: orchestration scripts and templated config.
# Copying these last keeps the heavier OS layers cacheable across builds.
#
# provision.sh and execute.sh are not run by this image; they are copied out
# of it (by run-agent.sh here, by COPY --from on the Jenkins path) and run
# inside the agent image. They still need the executable bit set here, because
# that is the only place either caller sets it.
# ---------------------------------------------------------------------------
COPY --chmod=0755 scripts/   /usr/local/bin/scripts/
COPY              config/    /usr/local/share/ai-agent-pipe/config/
COPY --chmod=0755 entrypoint.sh /entrypoint.sh

# Bitbucket Pipes convention: entrypoint reads PIPE_* env vars and exits with
# the agent's exit code so Pipelines marks the step accordingly. tini runs as
# PID 1 so a cancelled step's SIGTERM reaches the running build.
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

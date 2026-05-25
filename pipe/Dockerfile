# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# ai-agent-pipe runtime image (Image A).
#
# This image is intentionally small.  Its only job is to orchestrate the
# devcontainer build and launch the selected agent profile; the heavy lifting happens
# inside the dynamically built agent image (Image B), see scripts/run-agent.sh.
#
# Layers:
#   - debian:bookworm-slim base for glibc compatibility with devcontainer CLI
#   - git, openssh-client, curl, jq, ca-certificates  -> clone + REST calls
#   - docker-cli                                       -> talks to host docker daemon
#   - nodejs 22 + @devcontainers/cli                   -> devcontainer build
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim

# ---------------------------------------------------------------------------
# OS packages.
# We install everything in a single RUN to keep the image small and to make
# the resulting layer reproducible.  `--no-install-recommends` avoids
# pulling in optional packages we don't need at runtime.
# ---------------------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        gnupg \
        jq \
        openssh-client \
    ; \
    # --- Docker CLI (no daemon – we use the host's via /var/run/docker.sock) ---
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg; \
    chmod a+r /etc/apt/keyrings/docker.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
        https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list; \
    # --- NodeSource Node.js 22 (required by @devcontainers/cli >= 0.65) ---
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        docker-ce-cli \
        nodejs \
    ; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# @devcontainers/cli – pinned to a known-good major to avoid surprise
# breaking changes from upstream.  Updated by Dependabot.
# ---------------------------------------------------------------------------
RUN npm install -g --no-audit --no-fund @devcontainers/cli@^0.65.0

# ---------------------------------------------------------------------------
# Pipe payload: orchestration scripts and templated config.
# Copying these last keeps the heavier OS layers cacheable across builds.
# ---------------------------------------------------------------------------
COPY scripts/   /usr/local/bin/scripts/
COPY config/    /usr/local/share/ai-agent-pipe/config/
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
             /usr/local/bin/scripts/run-agent.sh \
             /usr/local/bin/scripts/validate-config.sh

# Bitbucket Pipes convention: entrypoint reads PIPE_* env vars and exits with
# the agent's exit code so Pipelines marks the step accordingly.
ENTRYPOINT ["/entrypoint.sh"]

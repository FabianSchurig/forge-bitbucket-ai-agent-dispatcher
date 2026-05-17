# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# Wrapper devcontainer Dockerfile.
#
# Layers the GitHub Copilot CLI on top of an arbitrary target devcontainer
# image.  BASE_IMAGE is supplied by ai-agent-pipe at runtime; do not bake
# any project-specific assumptions here.
# ---------------------------------------------------------------------------
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Install GitHub Copilot CLI globally.  We use npm here rather than `gh
# extension install` because the base image is not guaranteed to ship `gh`,
# and we want the Copilot binary to live on $PATH for non-interactive use.
#
# `set -eux` keeps the build log readable while still failing fast.
USER root
RUN set -eux; \
    if command -v apt-get >/dev/null 2>&1; then \
        apt-get update; \
        apt-get install -y --no-install-recommends nodejs npm ca-certificates; \
        rm -rf /var/lib/apt/lists/*; \
    elif command -v apk >/dev/null 2>&1; then \
        apk add --no-cache nodejs npm ca-certificates; \
    fi; \
    npm install -g --no-audit --no-fund @githubnext/github-copilot-cli || \
        npm install -g --no-audit --no-fund @github/copilot

# Copy the shared MCP config so any downstream Copilot invocations can pick
# it up via the standard XDG location.
COPY mcp-config.json /etc/ai-agent-pipe/mcp-config.json
ENV COPILOT_MCP_CONFIG=/etc/ai-agent-pipe/mcp-config.json

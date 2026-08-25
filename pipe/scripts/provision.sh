#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# provision.sh
#
# Root-side preparation of the agent image. Runs as the FIRST build stage RUN
# of whatever Dockerfile is assembling the agent image, before any secret is
# available.
#
# Two callers execute this identically:
#   - Bitbucket: scripts/run-agent.sh generates Dockerfile.runner, which COPYs
#     this repo's config/ + scripts/ into $AGENT_ROOT and calls us.
#   - Jenkins:   a Dockerfile resource held by the shared library, which
#     COPY --from=<pipe image>s the same two trees into $AGENT_ROOT and calls us.
#
# Keeping the logic here rather than inlining it in either Dockerfile is what
# stops the two runtimes from drifting; see ADR 0002.
#
# Usage: provision.sh <AGENT_TYPE> [CONTAINER_USER]
#
# Everything here must be cacheable: no secrets, no PR-specific inputs. The
# secret-bearing, always-rerun half lives in execute.sh.
# ---------------------------------------------------------------------------
set -euo pipefail

AGENT_TYPE="${1:-copilot}"
CONTAINER_USER="${2:-root}"

AGENT_ROOT="${AGENT_ROOT:-/opt/ai-agent}"
AGENT_CONFIG_DIR="$AGENT_ROOT/config/agents/$AGENT_TYPE"

# Pinned by commit so a rebuild of an old agent image installs the same
# bb-mcp. Overridable for local testing of an unreleased bitbucket-cli.
BB_CLI_REF="${BB_CLI_REF:-f46771ef34da3b9b9a10d59341d3c5f640e97536}"

if [ ! -d "$AGENT_CONFIG_DIR" ]; then
    echo "ERROR: no agent profile at $AGENT_CONFIG_DIR (AGENT_TYPE='$AGENT_TYPE')." >&2
    echo "Available profiles:" >&2
    ls -1 "$AGENT_ROOT/config/agents" 2>/dev/null | sed 's/^/  - /' >&2 || echo "  (none)" >&2
    exit 2
fi

echo "==> provision.sh: profile '$AGENT_TYPE', container user '$CONTAINER_USER'"

# ---------------------------------------------------------------------------
# OS packages.
#
# The base image is the source repository's devcontainer, so we cannot assume
# a distro. jq and gettext-base are needed by execute.sh to render the MCP
# config; curl fetches the bb-mcp installer. Anything already present is left
# alone so we do not disturb a carefully pinned toolchain (these images carry
# cross-compile SDKs).
# ---------------------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl gettext-base jq
    rm -rf /var/lib/apt/lists/*
elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache ca-certificates curl gettext jq
else
    echo "WARN: neither apt-get nor apk found; assuming ca-certificates/curl/jq are present." >&2
fi

# ---------------------------------------------------------------------------
# bb-mcp: the Bitbucket MCP server the agent uses to read the pull request and
# post its results back. This is the agent's only channel to Bitbucket, so a
# failure here is fatal rather than a warning.
# ---------------------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
    echo "ERROR: curl is required to install bb-mcp." >&2
    exit 1
fi

echo "==> Installing bb-mcp (bitbucket-cli @ ${BB_CLI_REF})"
curl -fsSL "https://raw.githubusercontent.com/FabianSchurig/bitbucket-cli/${BB_CLI_REF}/install.sh" \
    | sh -s -- --binary bb-mcp

# ---------------------------------------------------------------------------
# Replay devcontainer lifecycle commands.
#
# `devcontainer build` does not run onCreateCommand / postCreateCommand and
# friends - only `devcontainer up` does. Both callers build rather than up, so
# the commands are extracted from the image's devcontainer.metadata label by
# generate-lifecycle.js and dropped here.
#
# Optional: the Jenkins path may legitimately have nothing to replay, and a
# source repo whose lifecycle commands assume a running container (mounted
# sockets, a live display) must not be able to fail the whole agent run.
# ---------------------------------------------------------------------------
if [ -f "$AGENT_ROOT/lifecycle.sh" ]; then
    echo "==> Replaying devcontainer lifecycle commands"
    chmod +x "$AGENT_ROOT/lifecycle.sh"
    if ! "$AGENT_ROOT/lifecycle.sh"; then
        echo "WARN: a lifecycle command failed; continuing. The agent may be missing" >&2
        echo "      dependencies that a normal 'devcontainer up' would have installed." >&2
    fi
else
    echo "==> No lifecycle.sh supplied; skipping lifecycle replay."
fi

# ---------------------------------------------------------------------------
# Baseline skills.
#
# Copilot merges personal skills (~/.copilot/skills/) with project skills
# (.agents/skills/ in the workspace). We install the profile's baseline set as
# personal skills so the source repository's own .agents/skills/ overlays and
# can override them by name.
# ---------------------------------------------------------------------------
resolve_home() {
    local user="$1"
    if [ "$user" = "root" ] || [ "$user" = "0" ]; then
        echo "/root"
        return
    fi
    local home
    home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)"
    if [ -n "$home" ]; then
        echo "$home"
    else
        echo "/home/$user"
    fi
}

CONTAINER_HOME="$(resolve_home "$CONTAINER_USER")"
echo "==> Container user home: $CONTAINER_HOME"

if [ -d "$AGENT_CONFIG_DIR/skills" ]; then
    mkdir -p "$CONTAINER_HOME/.copilot/skills"
    skill_count=0
    # Only directories that actually contain a SKILL.md. Copying the tree
    # wholesale would also install this directory's own README as though it
    # were a skill.
    for skill_dir in "$AGENT_CONFIG_DIR"/skills/*/; do
        [ -f "${skill_dir}SKILL.md" ] || continue
        cp -R "$skill_dir" "$CONTAINER_HOME/.copilot/skills/"
        skill_count=$((skill_count + 1))
        echo "    + $(basename "$skill_dir")"
    done
    echo "==> Installed ${skill_count} baseline skill(s) into $CONTAINER_HOME/.copilot/skills"
else
    echo "==> Profile ships no baseline skills."
fi

# ---------------------------------------------------------------------------
# Ownership. execute.sh runs as $CONTAINER_USER and writes into ~/.copilot,
# and the agent edits the workspace, so both must be writable by that user.
# ---------------------------------------------------------------------------
mkdir -p "$CONTAINER_HOME/.copilot"
chown -R "$CONTAINER_USER" "$CONTAINER_HOME/.copilot"
chown -R "$CONTAINER_USER" "$AGENT_ROOT"
if [ -d /workspaces ]; then
    chown -R "$CONTAINER_USER" /workspaces
fi

echo "==> provision.sh: done."

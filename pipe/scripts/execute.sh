#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# execute.sh
#
# Secret-bearing half of the agent image build. Runs as the container user in
# the FINAL build stage, with BuildKit secrets mounted under /run/secrets/.
#
# Both callers execute this identically (see provision.sh for why).
#
# Usage: execute.sh <AGENT_TYPE>
#
# Because secrets are --mount=type=secret they exist only for the duration of
# this RUN and never reach an image layer. The stage that calls us must be
# excluded from the cache (--no-cache-filter on Jenkins, --no-cache on
# Bitbucket) or a second run would replay the first run's output instead of
# invoking the agent.
# ---------------------------------------------------------------------------
set -euo pipefail

AGENT_TYPE="${1:-copilot}"

AGENT_ROOT="${AGENT_ROOT:-/opt/ai-agent}"
AGENT_CONFIG_DIR="$AGENT_ROOT/config/agents/$AGENT_TYPE"
SECRETS_DIR="${SECRETS_DIR:-/run/secrets}"

if [ ! -d "$AGENT_CONFIG_DIR" ]; then
    echo "ERROR: no agent profile at $AGENT_CONFIG_DIR (AGENT_TYPE='$AGENT_TYPE')." >&2
    exit 2
fi

# AGENT_COMMAND / AGENT_FLAGS / AGENT_MODEL.
# shellcheck source=/dev/null
source "$AGENT_CONFIG_DIR/agent.env"

# ---------------------------------------------------------------------------
# Secrets. Read from the mount rather than the environment so they are never
# visible in `ps` and never become part of a build arg (which would be
# recorded in `docker history`).
#
# BITBUCKET_USERNAME is optional: with it, bb-mcp uses username/token auth;
# without it, Bearer auth. The Jenkins path does not supply one.
# ---------------------------------------------------------------------------
read_secret() {
    local name="$1"
    if [ -r "$SECRETS_DIR/$name" ]; then
        cat "$SECRETS_DIR/$name"
    else
        printf ''
    fi
}

COPILOT_GITHUB_TOKEN="$(read_secret COPILOT_GITHUB_TOKEN)"
BITBUCKET_TOKEN="$(read_secret BITBUCKET_TOKEN)"
BITBUCKET_USERNAME="$(read_secret BITBUCKET_USERNAME)"
export COPILOT_GITHUB_TOKEN BITBUCKET_TOKEN BITBUCKET_USERNAME

if [ -z "$COPILOT_GITHUB_TOKEN" ]; then
    echo "ERROR: COPILOT_GITHUB_TOKEN secret is missing or empty at $SECRETS_DIR." >&2
    exit 1
fi
if [ -z "$BITBUCKET_TOKEN" ]; then
    echo "ERROR: BITBUCKET_TOKEN secret is missing or empty at $SECRETS_DIR." >&2
    echo "       The agent reads the pull request and posts its result through bb-mcp;" >&2
    echo "       without a token it can neither see the change nor report on it." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Render the MCP configuration.
# ---------------------------------------------------------------------------
COPILOT_HOME="$HOME/.copilot"
mkdir -p "$COPILOT_HOME"

RENDERED="$(mktemp)"
CONTEXT_FILE="$(mktemp)"

# The rendered config necessarily contains the Bitbucket token, and this RUN's
# filesystem changes become an image layer. Shred all three the moment the
# agent exits rather than relying on the image being discarded.
cleanup() {
    rm -f "$RENDERED" "$CONTEXT_FILE" "$COPILOT_HOME/mcp-config.json"
}
trap cleanup EXIT

if command -v envsubst >/dev/null 2>&1; then
    envsubst '${BITBUCKET_TOKEN} ${BITBUCKET_USERNAME}' \
        < "$AGENT_CONFIG_DIR/mcp-config.json" > "$RENDERED"
else
    cp "$AGENT_CONFIG_DIR/mcp-config.json" "$RENDERED"
fi

# An empty BITBUCKET_USERNAME must be removed rather than passed as "", or
# bb-mcp attempts username/token auth with a blank username instead of Bearer.
if [ -z "$BITBUCKET_USERNAME" ] && command -v jq >/dev/null 2>&1; then
    jq 'del(.mcpServers.bitbucket.env.BITBUCKET_USERNAME)' "$RENDERED" > "$COPILOT_HOME/mcp-config.json"
else
    cp "$RENDERED" "$COPILOT_HOME/mcp-config.json"
fi
chmod 600 "$COPILOT_HOME/mcp-config.json"

if [ -f "$AGENT_CONFIG_DIR/copilot-instructions.md" ]; then
    cp "$AGENT_CONFIG_DIR/copilot-instructions.md" "$COPILOT_HOME/copilot-instructions.md"
fi

# ---------------------------------------------------------------------------
# Compose the prompt.
#
# The agent self-serves its context through bb-mcp, so it has to be told which
# pull request it is looking at. Environment variables are not in the model's
# context, so the coordinates are prepended to the prompt as text rather than
# left for the agent to discover by running shell commands.
# ---------------------------------------------------------------------------
PROMPT_FILE="$AGENT_ROOT/prompt.txt"
if [ ! -f "$PROMPT_FILE" ]; then
    echo "ERROR: no prompt at $PROMPT_FILE." >&2
    exit 2
fi

{
    if [ -n "${SOURCE_WORKSPACE:-}" ] && [ -n "${SOURCE_REPO:-}" ]; then
        echo "Repository: ${SOURCE_WORKSPACE}/${SOURCE_REPO}"
    fi
    if [ -n "${SOURCE_BRANCH:-}" ]; then
        echo "Branch: ${SOURCE_BRANCH}"
    fi
    if [ -n "${PR_ID:-}" ]; then
        echo "Pull request ID: ${PR_ID}"
        echo
        echo "Use the Bitbucket MCP tools to read this pull request and post any"
        echo "result back to it. The working tree at $(pwd) is checked out at the"
        echo "pull request's source branch."
    fi
    echo
    cat "$PROMPT_FILE"
} > "$CONTEXT_FILE"

# ---------------------------------------------------------------------------
# Run the agent. AGENT_FLAGS is deliberately unquoted so it word-splits into
# separate arguments.
#
# Not `exec`: the EXIT trap has to fire so the token-bearing MCP config is
# removed before this RUN is committed as a layer. The agent's exit code is
# propagated so a failed run fails the build.
# ---------------------------------------------------------------------------
MODEL_FLAG=""
if [ -n "${AGENT_MODEL:-}" ]; then
    MODEL_FLAG="--model=$AGENT_MODEL"
fi

echo "==> Running '$AGENT_COMMAND' (profile: $AGENT_TYPE, model: ${AGENT_MODEL:-default})"

set +e
# shellcheck disable=SC2086
"$AGENT_COMMAND" -p "$(cat "$CONTEXT_FILE")" $AGENT_FLAGS $MODEL_FLAG
agent_status=$?
set -e

echo "==> Agent exited with status ${agent_status}."
exit "$agent_status"

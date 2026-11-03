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
#
# Environment (all optional unless noted):
#   SOURCE_WORKSPACE, SOURCE_REPO  required - identify the repository
#   SOURCE_BRANCH, PR_ID           the branch checked out / the pull request
#   AGENT_MODEL                    model override
#   READ_ONLY                      "true" restricts bb-mcp to GET operations
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

# AGENT_COMMAND / AGENT_FLAGS / AGENT_MODEL / AGENT_SECRET_NAME and paths.
# shellcheck source=/dev/null
source "$AGENT_CONFIG_DIR/agent.env"
AGENT_SECRET_NAME="${AGENT_SECRET_NAME:-COPILOT_GITHUB_TOKEN}"
AGENT_MCP_CONFIG_PATH="${AGENT_MCP_CONFIG_PATH:-.copilot/mcp-config.json}"

case "${READ_ONLY:-false}" in
    true|TRUE|True|1|yes) READ_ONLY=true ;;
    *)                    READ_ONLY=false ;;
esac

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

AGENT_SECRET_VALUE="$(read_secret "$AGENT_SECRET_NAME")"
BITBUCKET_TOKEN="$(read_secret BITBUCKET_TOKEN)"
BITBUCKET_USERNAME="$(read_secret BITBUCKET_USERNAME)"

if [ -z "$AGENT_SECRET_VALUE" ]; then
    echo "ERROR: ${AGENT_SECRET_NAME} secret is missing or empty at $SECRETS_DIR." >&2
    exit 1
fi
if [ -z "$BITBUCKET_TOKEN" ]; then
    echo "ERROR: BITBUCKET_TOKEN secret is missing or empty at $SECRETS_DIR." >&2
    echo "       The agent reads the pull request and posts its result through bb-mcp;" >&2
    echo "       without a token it can neither see the change nor report on it." >&2
    exit 1
fi

export "${AGENT_SECRET_NAME}=${AGENT_SECRET_VALUE}"
unset AGENT_SECRET_VALUE
export BITBUCKET_TOKEN BITBUCKET_USERNAME

# ---------------------------------------------------------------------------
# Render the MCP configuration.
# ---------------------------------------------------------------------------
MCP_CONFIG="$HOME/$AGENT_MCP_CONFIG_PATH"
BB_MCP_CONFIG="$HOME/.config/ai-agent/bb-mcp.yaml"
mkdir -p "$(dirname "$MCP_CONFIG")" "$(dirname "$BB_MCP_CONFIG")"

RENDERED="$(mktemp)"
CONTEXT_FILE="$(mktemp)"

# The rendered config necessarily contains the Bitbucket token, and this RUN's
# filesystem changes become an image layer. Remove it the moment the agent
# exits rather than relying on the image being discarded.
cleanup() {
    rm -f "$RENDERED" "$RENDERED.tmp" "$CONTEXT_FILE" "$MCP_CONFIG" "$BB_MCP_CONFIG"
}
trap cleanup EXIT

for tool in envsubst jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: $tool is required to render the MCP config." >&2
        exit 2
    fi
done
envsubst '${BITBUCKET_TOKEN} ${BITBUCKET_USERNAME}' \
    < "$AGENT_CONFIG_DIR/mcp-config.json" > "$RENDERED"

# An empty BITBUCKET_USERNAME must be removed rather than passed as "", or
# bb-mcp attempts username/token auth with a blank username instead of Bearer.
if [ -z "$BITBUCKET_USERNAME" ]; then
    jq 'del(.mcpServers.bitbucket.env.BITBUCKET_USERNAME)' "$RENDERED" > "$RENDERED.tmp"
    mv "$RENDERED.tmp" "$RENDERED"
fi

# Read-only: the restriction lives in bb-mcp itself, which then does not expose
# any write operation to the agent at all. A prompt asking the agent not to
# post would only be as reliable as the model.
if [ "$READ_ONLY" = true ]; then
    cat > "$BB_MCP_CONFIG" <<'YAML'
server:
  allowed_methods: ["GET"]
  ignored_tools:
    - bitbucket_addon
    - bitbucket_properties
YAML
    jq --arg cfg "$BB_MCP_CONFIG" '.mcpServers.bitbucket.args += ["-config", $cfg]' \
        "$RENDERED" > "$RENDERED.tmp"
    mv "$RENDERED.tmp" "$RENDERED"
fi

cp "$RENDERED" "$MCP_CONFIG"
chmod 600 "$MCP_CONFIG"

INSTRUCTIONS_SRC=""
if [ -n "${AGENT_INSTRUCTIONS_FILE:-}" ] && [ -f "$AGENT_CONFIG_DIR/$AGENT_INSTRUCTIONS_FILE" ]; then
    INSTRUCTIONS_SRC="$AGENT_CONFIG_DIR/$AGENT_INSTRUCTIONS_FILE"
fi
if [ -n "$INSTRUCTIONS_SRC" ] && [ -n "${AGENT_INSTRUCTIONS_PATH:-}" ]; then
    mkdir -p "$(dirname "$HOME/$AGENT_INSTRUCTIONS_PATH")"
    cp "$INSTRUCTIONS_SRC" "$HOME/$AGENT_INSTRUCTIONS_PATH"
fi

# ---------------------------------------------------------------------------
# Compose the prompt.
#
# The agent self-serves its context through bb-mcp, so it has to be told where
# it is. Environment variables are not in the model's context, so the
# coordinates are prepended to the prompt as text rather than left for the
# agent to discover by running shell commands.
# ---------------------------------------------------------------------------
PROMPT_FILE="$AGENT_ROOT/prompt.txt"
if [ ! -f "$PROMPT_FILE" ]; then
    echo "ERROR: no prompt at $PROMPT_FILE." >&2
    exit 2
fi
if [ -z "${SOURCE_WORKSPACE:-}" ] || [ -z "${SOURCE_REPO:-}" ]; then
    echo "ERROR: SOURCE_WORKSPACE and SOURCE_REPO are required to identify the repository." >&2
    exit 2
fi

{
    if [ -n "$INSTRUCTIONS_SRC" ] && [ -z "${AGENT_INSTRUCTIONS_PATH:-}" ]; then
        cat "$INSTRUCTIONS_SRC"
        echo
    fi
    echo "Repository: ${SOURCE_WORKSPACE}/${SOURCE_REPO}"
    if [ -n "${SOURCE_BRANCH:-}" ]; then
        echo "Branch: ${SOURCE_BRANCH}"
    fi
    if [ -n "${PR_ID:-}" ]; then
        echo "Pull request ID: ${PR_ID}"
        echo
        echo "Use the Bitbucket MCP tools to read this pull request. The working"
        echo "tree at $(pwd) is checked out at the pull request's source branch."
    else
        echo "Pull request: none"
        echo
        echo "This run is not about a pull request. The working tree at $(pwd) is"
        echo "checked out at the branch above."
    fi
    echo
    if [ "$READ_ONLY" = true ]; then
        echo "Mode: READ-ONLY. Bitbucket write operations are not available in"
        echo "this run. Do not try to post anything; print your result to"
        echo "standard output instead, in the form your skill prescribes for a"
        echo "read-only run."
    else
        echo "Mode: normal. Post your result back to Bitbucket through the MCP tools."
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
if [ -n "${AGENT_LIST_MODELS_COMMAND:-}" ]; then
    echo "==> Available models:"
    # shellcheck disable=SC2086
    $AGENT_LIST_MODELS_COMMAND || echo "WARN: could not list models." >&2
fi

MODEL_FLAG=""
if [ -n "${AGENT_MODEL:-}" ]; then
    MODEL_FLAG="--model=$AGENT_MODEL"
fi

echo "==> Running '$AGENT_COMMAND' (profile: $AGENT_TYPE, model: ${AGENT_MODEL:-default}, read-only: $READ_ONLY)"

set +e
# shellcheck disable=SC2086
"$AGENT_COMMAND" -p "$(cat "$CONTEXT_FILE")" $AGENT_FLAGS $MODEL_FLAG
agent_status=$?
set -e

echo "==> Agent exited with status ${agent_status}."
exit "$agent_status"

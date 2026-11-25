#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ai-agent-pipe entrypoint.
#
# Responsibilities (kept intentionally small):
#   1. Map the pipe's inputs onto the bare variable names run-agent.sh reads.
#   2. Validate them up-front, so a misconfigured pipeline fails in seconds
#      with a clear message instead of after a long devcontainer build.
#   3. Hand the secrets to run-agent.sh under internal names only, so nothing
#      run-agent.sh starts - devcontainer build, docker build - inherits them.
#
# Inputs are read from environment variables.  The pipe accepts both the
# Bitbucket Pipes convention (`PIPE_INPUT_FOO`) and the bare variable name
# (`FOO`) – the dispatcher emits the bare form (see src/pipelinePayload.ts),
# whereas a human invoking the pipe via `bitbucket-pipelines.yml` `pipe:`
# syntax will get `PIPE_INPUT_*` prefixes.  We normalise both into bare
# names so the downstream script does not need to care.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPTS_DIR=/usr/local/bin/scripts
PIPE_CONFIG_DIR="${PIPE_CONFIG_DIR:-/usr/local/share/ai-agent-pipe/config}"

# ---------------------------------------------------------------------------
# Helper: pick the first non-empty value from a list of env-var names.
# Usage: pick FOO PIPE_INPUT_FOO  ->  echoes the first non-empty value, or ""
#
# A value that is nothing but a reference such as "$CURSOR_API_KEY" is a
# pipeline variable that was never defined, passed through unexpanded, and
# counts as empty.
# ---------------------------------------------------------------------------
pick() {
    local name value
    for name in "$@"; do
        value="${!name:-}"
        if [ -n "$value" ] && ! [[ "$value" =~ ^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$ ]]; then
            printf '%s' "$value"
            return 0
        fi
    done
    printf ''
}

# Helper: pick an input by name, trying PIPE_INPUT_<NAME>, PIPE_SECRET_<NAME>
# and <NAME> for the name and then for each legacy alias.
# Usage: pick_input COPILOT_GITHUB_TOKEN COPILOT_TOKEN
input_names() {
    local name
    for name in "$@"; do
        printf '%s\n' "PIPE_INPUT_$name" "PIPE_SECRET_$name" "$name"
    done
}
pick_input() {
    local -a names
    mapfile -t names < <(input_names "$@")
    pick "${names[@]}"
}

die() {
    local status="$1"
    shift
    printf 'ERROR: %s\n' "$@" >&2
    exit "$status"
}

# ---------------------------------------------------------------------------
# Non-secret inputs.  Exported so run-agent.sh sees them.
# ---------------------------------------------------------------------------
for name in SOURCE_WORKSPACE SOURCE_REPO SOURCE_BRANCH PR_ID COMMENT_TEXT COMMENT_AUTHOR \
            AGENT_TYPE AGENT_MODEL READ_ONLY AGENT_FEATURE AGENT_PLUGINS \
            DEVCONTAINER_CONFIG SOURCE_CLONE_URL SSH_KNOWN_HOSTS \
            OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_TRACES_ENDPOINT \
            OTEL_EXPORTER_OTLP_PROTOCOL OTEL_SERVICE_NAME OTEL_RESOURCE_ATTRIBUTES TRACEPARENT; do
    value="$(pick_input "$name")"
    export "$name=$value"
done
export AGENT_TYPE="${AGENT_TYPE:-copilot}"
# The werfen-ai-agent devcontainer feature supplies the agent's skills and MCP
# servers from the Werfen marketplace. "none" builds without it.
export AGENT_FEATURE="${AGENT_FEATURE:-artifactory-munich.werfen.global:6556/werfen/devcontainer-features/werfen-ai-agent:1}"
export AGENT_PLUGINS="${AGENT_PLUGINS:-bitbucket}"
export SOURCE_CLONE_URL="${SOURCE_CLONE_URL:-git@bitbucket.org:${SOURCE_WORKSPACE}/${SOURCE_REPO}.git}"

# ---------------------------------------------------------------------------
# Agent profile.  Any directory under config/agents/ with an agent.env is a
# profile; the profile names the secret its agent authenticates with.
# ---------------------------------------------------------------------------
[[ "$AGENT_TYPE" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
    || die 2 "AGENT_TYPE '$AGENT_TYPE' is not a valid profile name."
PROFILE_ENV="$PIPE_CONFIG_DIR/agents/$AGENT_TYPE/agent.env"
if [ ! -f "$PROFILE_ENV" ]; then
    profiles="$(find "$PIPE_CONFIG_DIR/agents" -mindepth 2 -maxdepth 2 -name agent.env -printf '%h\n' 2>/dev/null \
        | xargs -r -n1 basename | sort | paste -sd, - | sed 's/,/, /g')"
    die 2 "unsupported AGENT_TYPE '$AGENT_TYPE'. Supported values: ${profiles:-none}."
fi

# shellcheck source=/dev/null
AGENT_SECRET_NAME="$(source "$PROFILE_ENV" && printf '%s' "${AGENT_SECRET_NAME:-COPILOT_GITHUB_TOKEN}")"
# shellcheck source=/dev/null
AGENT_SECRET_ALIASES="$(source "$PROFILE_ENV" && printf '%s' "${AGENT_SECRET_ALIASES:-}")"
[[ "$AGENT_SECRET_NAME" =~ ^[A-Z][A-Z0-9_]*$ ]] \
    || die 2 "profile '$AGENT_TYPE' names an invalid AGENT_SECRET_NAME '$AGENT_SECRET_NAME'."
export AGENT_SECRET_NAME

# ---------------------------------------------------------------------------
# Secrets – never logged, never exported under their own names.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2086 # AGENT_SECRET_ALIASES is a word list.
agent_secret="$(pick_input "$AGENT_SECRET_NAME" $AGENT_SECRET_ALIASES)"
bitbucket_token="$(pick_input BITBUCKET_TOKEN BB_TOKEN)"
bitbucket_username="$(pick_input BITBUCKET_USERNAME BB_USERNAME)"
ssh_key="$(pick_input SSH_KEY)"
otel_headers="$(pick_input OTEL_EXPORTER_OTLP_HEADERS)"
otel_traces_headers="$(pick_input OTEL_EXPORTER_OTLP_TRACES_HEADERS)"
atlassian_mcp_api_key="$(pick_input ATLASSIAN_MCP_API_KEY)"

# ---------------------------------------------------------------------------
# Validate required inputs / secrets up-front and fail fast with a clear
# message.  validate-config.sh receives only the names of variables, and the
# secrets are exported only into the subshell that runs it, so no secret value
# is passed on a command line.
# ---------------------------------------------------------------------------
required=(SOURCE_WORKSPACE SOURCE_REPO SOURCE_BRANCH COMMENT_TEXT "$AGENT_SECRET_NAME" BITBUCKET_TOKEN)
case "$SOURCE_CLONE_URL" in
    git@*|ssh://*) required+=(SSH_KEY) ;;
esac
(
    export "$AGENT_SECRET_NAME=$agent_secret" BITBUCKET_TOKEN="$bitbucket_token" SSH_KEY="$ssh_key"
    "$SCRIPTS_DIR/validate-config.sh" "${required[@]}"
)

# Slugs end up in a clone URL and an image tag; Bitbucket allows only these.
for name in SOURCE_WORKSPACE SOURCE_REPO; do
    [[ "${!name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
        || die 2 "$name '${!name}' is not a valid Bitbucket slug."
done
[ -z "$PR_ID" ] || [[ "$PR_ID" =~ ^[0-9]+$ ]] \
    || die 2 "PR_ID '$PR_ID' is not a pull request number."

# ---------------------------------------------------------------------------
# Hand off.  The raw secret inputs are removed from the environment and the
# values travel under internal names, which run-agent.sh moves into shell
# variables and unsets before it starts anything.  exec replaces this
# process so the agent's exit code is what the Pipelines step sees.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2046,SC2086
unset $(input_names "$AGENT_SECRET_NAME" $AGENT_SECRET_ALIASES BITBUCKET_TOKEN BB_TOKEN \
            BITBUCKET_USERNAME BB_USERNAME SSH_KEY \
            OTEL_EXPORTER_OTLP_HEADERS OTEL_EXPORTER_OTLP_TRACES_HEADERS ATLASSIAN_MCP_API_KEY)

export AI_AGENT_PIPE_SECRET_AGENT="$agent_secret" \
       AI_AGENT_PIPE_SECRET_BITBUCKET_TOKEN="$bitbucket_token" \
       AI_AGENT_PIPE_SECRET_BITBUCKET_USERNAME="$bitbucket_username" \
       AI_AGENT_PIPE_SECRET_SSH_KEY="$ssh_key" \
       AI_AGENT_PIPE_SECRET_OTEL_HEADERS="$otel_headers" \
       AI_AGENT_PIPE_SECRET_OTEL_TRACES_HEADERS="$otel_traces_headers" \
       AI_AGENT_PIPE_SECRET_ATLASSIAN_MCP_API_KEY="$atlassian_mcp_api_key"
unset agent_secret bitbucket_token bitbucket_username ssh_key otel_headers otel_traces_headers \
      atlassian_mcp_api_key

exec "$SCRIPTS_DIR/run-agent.sh"

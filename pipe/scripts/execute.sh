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
#   OTEL_EXPORTER_OTLP_ENDPOINT,   standard OpenTelemetry settings. When an
#   OTEL_EXPORTER_OTLP_*,          endpoint is set, a profile with
#   OTEL_SERVICE_NAME,             AGENT_OTEL_NATIVE=true (Copilot) exports
#   OTEL_RESOURCE_ATTRIBUTES,      them itself, and a profile with
#   TRACEPARENT                    AGENT_TRACE_FORMAT has its output turned
#                                  into a trace by otlp-trace.sh. The two
#                                  *_HEADERS settings may instead be mounted
#                                  as secrets of the same name.
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

OTEL_VARS=(OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
           OTEL_EXPORTER_OTLP_PROTOCOL OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
           OTEL_EXPORTER_OTLP_HEADERS OTEL_EXPORTER_OTLP_TRACES_HEADERS
           OTEL_SERVICE_NAME OTEL_RESOURCE_ATTRIBUTES TRACEPARENT)

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

# OTLP headers usually carry a collector credential, so a caller may mount
# them as secrets rather than pass them as build args.
for otel_var in OTEL_EXPORTER_OTLP_HEADERS OTEL_EXPORTER_OTLP_TRACES_HEADERS; do
    if [ -z "${!otel_var:-}" ]; then
        printf -v "$otel_var" '%s' "$(read_secret "$otel_var")"
        export "${otel_var?}"
    fi
done

# Callers pass these as build args, which arrive as empty variables when
# unused. Some exporters treat a set-but-empty endpoint as enabled.
for otel_var in "${OTEL_VARS[@]}"; do
    [ -n "${!otel_var:-}" ] || unset "$otel_var"
done

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

# Merge into the config the werfen-ai-agent feature installed, so its servers
# stay available; the profile's bitbucket entry (token, read-only) wins.
if [ -s "$MCP_CONFIG" ]; then
    jq -s '.[0] * {mcpServers: ((.[0].mcpServers // {}) + .[1].mcpServers)}' \
        "$MCP_CONFIG" "$RENDERED" > "$RENDERED.tmp"
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
if [ -n "${AGENT_PREFLIGHT_COMMAND:-}" ]; then
    echo "==> ${AGENT_PREFLIGHT_COMMAND}:"
    # shellcheck disable=SC2086
    $AGENT_PREFLIGHT_COMMAND || echo "WARN: preflight command failed." >&2
fi

MODEL_FLAG=""
if [ -n "${AGENT_MODEL:-}" ]; then
    MODEL_FLAG="--model=$AGENT_MODEL"
fi

# ---------------------------------------------------------------------------
# Telemetry: off unless an OTLP endpoint is configured.
# ---------------------------------------------------------------------------
TRACES_ENDPOINT="${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-}"
if [ -z "$TRACES_ENDPOINT" ] && [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
    TRACES_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT%/}/v1/traces"
fi
TRACE_OUTPUT=false
TELEMETRY="off"
if [ -z "$TRACES_ENDPOINT" ]; then
    :
elif [ -n "${AGENT_TRACE_FORMAT:-}" ]; then
    TRACE_OUTPUT=true
    TELEMETRY="$TRACES_ENDPOINT via otlp-trace.sh"
elif [ "${AGENT_OTEL_NATIVE:-false}" = true ]; then
    # Copilot switches export on only for the generic endpoint, and reads only
    # the generic headers, so a traces-only configuration is mapped onto them.
    # https://docs.github.com/en/copilot/reference/enterprise-administrators/opentelemetry-reference
    if [ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
        case "$TRACES_ENDPOINT" in
            */v1/traces) export OTEL_EXPORTER_OTLP_ENDPOINT="${TRACES_ENDPOINT%/v1/traces}" ;;
        esac
    fi
    if [ -z "${OTEL_EXPORTER_OTLP_HEADERS:-}" ] && [ -n "${OTEL_EXPORTER_OTLP_TRACES_HEADERS:-}" ]; then
        export OTEL_EXPORTER_OTLP_HEADERS="$OTEL_EXPORTER_OTLP_TRACES_HEADERS"
    fi
    if [ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
        echo "WARN: $AGENT_COMMAND exports only to OTEL_EXPORTER_OTLP_ENDPOINT, and" >&2
        echo "      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT does not end in /v1/traces; telemetry is off." >&2
    elif [[ "$OTEL_EXPORTER_OTLP_ENDPOINT" == http://* ]]; then
        echo "WARN: $AGENT_COMMAND does not export to http:// endpoints; telemetry is off." >&2
    else
        TELEMETRY="$OTEL_EXPORTER_OTLP_ENDPOINT (native)"
    fi
else
    echo "WARN: profile '$AGENT_TYPE' has no way to export traces; telemetry is off." >&2
fi

echo "==> Running '$AGENT_COMMAND' (profile: $AGENT_TYPE, model: ${AGENT_MODEL:-default}, read-only: $READ_ONLY, telemetry: $TELEMETRY)"

# The agent's raw output, traced when the profile names its format and an
# OTLP endpoint is configured; otherwise unchanged.
trace_stream() {
    if [ "$TRACE_OUTPUT" = true ]; then
        bash "$(dirname "${BASH_SOURCE[0]}")/otlp-trace.sh" "$AGENT_TRACE_FORMAT"
    else
        cat
    fi
}

# Lines that are not JSON objects pass through unchanged, so a CLI error
# message is never swallowed. An event the filter cannot handle is printed
# as-is too: a jq error here would end the pipe and, with it, the agent.
output_filter() {
    if [ -n "${AGENT_OUTPUT_FILTER:-}" ]; then
        jq -rR --unbuffered ". as \$line | try (fromjson | if type == \"object\" then ($AGENT_OUTPUT_FILTER) else \$line end) catch \$line"
    else
        cat
    fi
}

PROMPT="$(cat "$CONTEXT_FILE")"
set +e
# shellcheck disable=SC2086
"$AGENT_COMMAND" -p "$PROMPT" $AGENT_FLAGS $MODEL_FLAG | trace_stream | output_filter
agent_status=${PIPESTATUS[0]}
set -e

echo "==> Agent exited with status ${agent_status}."
exit "$agent_status"

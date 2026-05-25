#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run-agent.sh
#
# Core orchestration adapted from ai-agent-hub for the Pipe runtime image.
# Responsibilities:
#   1. Clone the target spoke repository over SSH at $SOURCE_BRANCH.
#   2. Build the target repo's devcontainer, or a minimal generated base when
#      the repo does not ship one.
#   3. Layer the selected agent profile on top of that image.
#   4. Execute the profile command in a final BuildKit build with secrets
#      mounted only for the RUN instruction that needs them.
#
# The script is intentionally idempotent and self-contained – it can be
# re-run locally with `docker run` for debugging (see pipe/README.md).
# ---------------------------------------------------------------------------
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration / defaults.
# ---------------------------------------------------------------------------
: "${SOURCE_WORKSPACE:?SOURCE_WORKSPACE is required}"
: "${SOURCE_REPO:?SOURCE_REPO is required}"
: "${SOURCE_BRANCH:?SOURCE_BRANCH is required}"
: "${COMMENT_TEXT:?COMMENT_TEXT is required}"

SECRETS_DIR="${SECRETS_DIR:-/tmp/ai-agent-pipe.secrets}"
PIPE_CONFIG_DIR="${PIPE_CONFIG_DIR:-/usr/local/share/ai-agent-pipe/config}"
AGENT_TYPE="${AGENT_TYPE:-copilot}"
AGENT_CONFIG_DIR="$PIPE_CONFIG_DIR/agents/$AGENT_TYPE"

if [ ! -d "$AGENT_CONFIG_DIR" ]; then
    echo "ERROR: unsupported AGENT_TYPE '$AGENT_TYPE'. No profile exists at $AGENT_CONFIG_DIR." >&2
    exit 2
fi

# shellcheck source=/dev/null
source "$AGENT_CONFIG_DIR/agent.env"

if [ -n "${BITBUCKET_CLONE_DIR:-}" ]; then
    WORKDIR="${WORKDIR:-$BITBUCKET_CLONE_DIR/.ai-agent-pipe}"
else
    WORKDIR="${WORKDIR:-/tmp/ai-agent-pipe.workspace}"
fi

WORKSPACE_DIR="repo"

# Image tags used during the two-image layering process.
TARGET_IMAGE="ai-agent-pipe/target:${SOURCE_REPO}-${SOURCE_BRANCH}"
AGENT_IMAGE="ai-agent-pipe/agent:${SOURCE_REPO}-${SOURCE_BRANCH}"

# Sanitise the tag – docker image tags only allow [a-zA-Z0-9._-].
# We keep the name portion (before the colon) intact since it may contain '/'.
sanitize_tag() {
    local ref="$1"
    local name="${ref%%:*}"
    local tag="${ref#*:}"
    # Lowercase and replace invalid chars in the tag only.
    tag="$(echo "$tag" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-')"
    echo "${name}:${tag}"
}
TARGET_IMAGE="$(sanitize_tag "$TARGET_IMAGE")"
AGENT_IMAGE="$(sanitize_tag "$AGENT_IMAGE")"

# ---------------------------------------------------------------------------
# Step 1 – clone the spoke repository.
# ---------------------------------------------------------------------------
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

CLONE_URL="git@bitbucket.org:${SOURCE_WORKSPACE}/${SOURCE_REPO}.git"
echo "==> Cloning $CLONE_URL (branch: $SOURCE_BRANCH)"
git clone --depth 1 --branch "$SOURCE_BRANCH" "$CLONE_URL" "$WORKDIR/repo"

# ---------------------------------------------------------------------------
# Step 2 – build the target base image.
# ---------------------------------------------------------------------------
if [ -d "$WORKDIR/repo/.devcontainer" ]; then
    echo "==> .devcontainer detected – building target image with devcontainer CLI."
    devcontainer build \
        --workspace-folder "$WORKDIR/repo" \
        --image-name "$TARGET_IMAGE"
else
    echo "==> No .devcontainer detected – building generated base image."
    BASE_DIR="$WORKDIR/generated-base"
    mkdir -p "$BASE_DIR"
    cat > "$BASE_DIR/Dockerfile" <<'DOCKERFILE'
FROM mcr.microsoft.com/devcontainers/base:1-ubuntu-24.04
DOCKERFILE

    DOCKER_BUILDKIT=1 docker build \
        --progress=plain \
        -t "$TARGET_IMAGE" \
        "$BASE_DIR"
fi

# ---------------------------------------------------------------------------
# Step 3 – layer the selected agent profile onto the target base image.
# ---------------------------------------------------------------------------
WRAPPER_DIR="$WORKDIR/wrapper"
mkdir -p "$WRAPPER_DIR/.devcontainer"
cp -R "$AGENT_CONFIG_DIR/wrapper-devcontainer/." "$WRAPPER_DIR/.devcontainer/"

echo "==> Building agent image ($AGENT_TYPE layered on $TARGET_IMAGE)."
devcontainer build \
    --workspace-folder "$WRAPPER_DIR" \
    --image-name "$AGENT_IMAGE" \
    --build-arg "BASE_IMAGE=$TARGET_IMAGE"

# ---------------------------------------------------------------------------
# Step 4 – extract devcontainer metadata for lifecycle replay and user choice.
# ---------------------------------------------------------------------------
metadata="$(docker image inspect "$AGENT_IMAGE" \
    --format '{{ index .Config.Labels "devcontainer.metadata" }}' \
    2>/dev/null || echo '[]')"
if [ -z "$metadata" ] || [ "$metadata" = "<no value>" ]; then
    metadata='[]'
fi

LIFECYCLE_SCRIPT="$WORKDIR/lifecycle.sh"
node /usr/local/bin/scripts/generate-lifecycle.js \
    --metadata "$metadata" \
    --out "$LIFECYCLE_SCRIPT"

CONTAINER_USER="$(METADATA_JSON="$metadata" node -e '
const raw = process.env.METADATA_JSON || "[]";
let parsed;
try { parsed = JSON.parse(raw); } catch { parsed = []; }
const entries = Array.isArray(parsed) ? parsed : [parsed];
const found = [...entries].reverse().find((entry) => entry && entry.remoteUser);
process.stdout.write(found ? String(found.remoteUser) : "root");
')"

# Validate CONTAINER_USER against a strict pattern to prevent command injection
# from a malicious devcontainer.json remoteUser value.  Only allow typical
# Unix usernames (lowercase alphanum, dash, underscore) or numeric UIDs.
if ! echo "$CONTAINER_USER" | grep -qE '^[a-z_][a-z0-9_-]*$|^[0-9]+$'; then
    echo "WARNING: CONTAINER_USER '$CONTAINER_USER' contains invalid characters. Falling back to 'root'." >&2
    CONTAINER_USER="root"
fi
echo "==> Container user: $CONTAINER_USER"

# ---------------------------------------------------------------------------
# Step 5 – final docker build executes the agent with BuildKit secrets.
# ---------------------------------------------------------------------------
RUNNER_DIR="$WORKDIR/runner"
rm -rf "$RUNNER_DIR"
mkdir -p "$RUNNER_DIR"
cp "$LIFECYCLE_SCRIPT" "$RUNNER_DIR/lifecycle.sh"
cp -R "$WORKDIR/repo" "$RUNNER_DIR/$WORKSPACE_DIR"
cp "$AGENT_CONFIG_DIR/mcp-config.json" "$RUNNER_DIR/mcp-config.json"
if [ -f "$AGENT_CONFIG_DIR/copilot-instructions.md" ]; then
    cp "$AGENT_CONFIG_DIR/copilot-instructions.md" "$RUNNER_DIR/copilot-instructions.md"
else
    : > "$RUNNER_DIR/copilot-instructions.md"
fi
printf '%s' "$COMMENT_TEXT" > "$RUNNER_DIR/prompt.txt"

cat > "$RUNNER_DIR/Dockerfile.runner" <<'DOCKERFILE'
# syntax=docker/dockerfile:1.6
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG WORKSPACE_DIR=repo
ARG AGENT_COMMAND=copilot
ARG AGENT_FLAGS="--allow-all-tools --output-format json --no-ask-user"
ARG AGENT_MODEL=""
ARG CONTAINER_USER=root

COPY ${WORKSPACE_DIR} /workspaces/${WORKSPACE_DIR}
COPY lifecycle.sh /tmp/lifecycle.sh
COPY prompt.txt /tmp/prompt.txt
COPY mcp-config.json /tmp/mcp-template.json
COPY copilot-instructions.md /tmp/copilot-instructions.md
WORKDIR /workspaces/${WORKSPACE_DIR}

USER root
RUN set -eu; \
    if command -v apt-get >/dev/null 2>&1; then \
        apt-get update; \
        apt-get install -y --no-install-recommends ca-certificates curl gettext-base; \
        rm -rf /var/lib/apt/lists/*; \
    elif command -v apk >/dev/null 2>&1; then \
        apk add --no-cache ca-certificates curl gettext; \
    fi; \
    if command -v curl >/dev/null 2>&1; then \
        curl -fsSL https://raw.githubusercontent.com/FabianSchurig/bitbucket-cli/f46771ef34da3b9b9a10d59341d3c5f640e97536/install.sh \
            | sh -s -- --binary bb-mcp; \
    fi; \
    chmod +x /tmp/lifecycle.sh; \
    /tmp/lifecycle.sh; \
    chown -R ${CONTAINER_USER} /workspaces /tmp/mcp-template.json /tmp/copilot-instructions.md /tmp/prompt.txt

USER ${CONTAINER_USER}

# --mount=type=secret keeps tokens out of the final image; they exist only
# during the RUN that mounts them.
RUN --mount=type=secret,id=COPILOT_GITHUB_TOKEN,mode=0444 \
    --mount=type=secret,id=BITBUCKET_TOKEN,mode=0444 \
    --mount=type=secret,id=BITBUCKET_USERNAME,mode=0444 \
    set -eu; \
    export COPILOT_GITHUB_TOKEN="$(cat /run/secrets/COPILOT_GITHUB_TOKEN)"; \
    export BITBUCKET_TOKEN="$(cat /run/secrets/BITBUCKET_TOKEN)"; \
    export BITBUCKET_USERNAME="$(cat /run/secrets/BITBUCKET_USERNAME)"; \
    mkdir -p "$HOME/.copilot"; \
    if command -v envsubst >/dev/null 2>&1; then \
        envsubst '${BITBUCKET_TOKEN} ${BITBUCKET_USERNAME}' < /tmp/mcp-template.json > "$HOME/.copilot/mcp-config.json"; \
    else \
        cp /tmp/mcp-template.json "$HOME/.copilot/mcp-config.json"; \
    fi; \
    cp /tmp/copilot-instructions.md "$HOME/.copilot/copilot-instructions.md"; \
    MODEL_FLAG=""; \
    if [ -n "$AGENT_MODEL" ]; then MODEL_FLAG="--model=$AGENT_MODEL"; fi; \
    $AGENT_COMMAND -p "$(cat /tmp/prompt.txt)" $AGENT_FLAGS $MODEL_FLAG
DOCKERFILE

echo "==> Executing $AGENT_TYPE inside agent image."
DOCKER_BUILDKIT=1 docker build \
    --progress=plain \
    --no-cache \
    --build-arg "BASE_IMAGE=$AGENT_IMAGE" \
    --build-arg "WORKSPACE_DIR=$WORKSPACE_DIR" \
    --build-arg "AGENT_COMMAND=$AGENT_COMMAND" \
    --build-arg "AGENT_FLAGS=$AGENT_FLAGS" \
    --build-arg "AGENT_MODEL=${AGENT_MODEL:-}" \
    --build-arg "CONTAINER_USER=$CONTAINER_USER" \
    --secret "id=COPILOT_GITHUB_TOKEN,src=$SECRETS_DIR/COPILOT_GITHUB_TOKEN" \
    --secret "id=BITBUCKET_TOKEN,src=$SECRETS_DIR/BITBUCKET_TOKEN" \
    --secret "id=BITBUCKET_USERNAME,src=$SECRETS_DIR/BITBUCKET_USERNAME" \
    -f "$RUNNER_DIR/Dockerfile.runner" \
    -t "${AGENT_IMAGE}-run" \
    "$RUNNER_DIR"

echo "==> ai-agent-pipe finished successfully."

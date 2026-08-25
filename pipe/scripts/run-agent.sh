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
# The devcontainer CLI does NOT accept --build-arg; instead the wrapper
# devcontainer.json references ${localEnv:BASE_IMAGE} under build.args, so we
# export it for the CLI process to interpolate.
BASE_IMAGE="$TARGET_IMAGE" devcontainer build \
    --workspace-folder "$WRAPPER_DIR" \
    --image-name "$AGENT_IMAGE"

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
# The runner image is assembled from the same two scripts and the same agent
# profile tree that Jenkins uses (see ADR 0002). Everything specific to a
# runtime lives in this Dockerfile; everything about *what the agent does*
# lives in provision.sh / execute.sh, so the two cannot drift.
RUNNER_DIR="$WORKDIR/runner"
rm -rf "$RUNNER_DIR"
mkdir -p "$RUNNER_DIR"
cp "$LIFECYCLE_SCRIPT" "$RUNNER_DIR/lifecycle.sh"
cp -R "$WORKDIR/repo" "$RUNNER_DIR/$WORKSPACE_DIR"
cp -R "$PIPE_CONFIG_DIR/." "$RUNNER_DIR/agent-config/"
cp -R /usr/local/bin/scripts/. "$RUNNER_DIR/agent-scripts/"
printf '%s' "$COMMENT_TEXT" > "$RUNNER_DIR/prompt.txt"

cat > "$RUNNER_DIR/Dockerfile.runner" <<'DOCKERFILE'
# syntax=docker/dockerfile:1.6
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG WORKSPACE_DIR=repo
ARG AGENT_TYPE=copilot
ARG AGENT_MODEL=""
ARG CONTAINER_USER=root
ARG SOURCE_WORKSPACE=""
ARG SOURCE_REPO=""
ARG SOURCE_BRANCH=""
ARG PR_ID=""

ENV AGENT_ROOT=/opt/ai-agent \
    AGENT_MODEL=${AGENT_MODEL} \
    SOURCE_WORKSPACE=${SOURCE_WORKSPACE} \
    SOURCE_REPO=${SOURCE_REPO} \
    SOURCE_BRANCH=${SOURCE_BRANCH} \
    PR_ID=${PR_ID}

COPY agent-config  /opt/ai-agent/config
COPY agent-scripts /opt/ai-agent/scripts
COPY lifecycle.sh  /opt/ai-agent/lifecycle.sh
COPY prompt.txt    /opt/ai-agent/prompt.txt
COPY ${WORKSPACE_DIR} /workspaces/${WORKSPACE_DIR}
WORKDIR /workspaces/${WORKSPACE_DIR}

USER root
RUN chmod +x /opt/ai-agent/scripts/*.sh \
 && /opt/ai-agent/scripts/provision.sh "${AGENT_TYPE}" "${CONTAINER_USER}"

USER ${CONTAINER_USER}

# --mount=type=secret keeps tokens out of the final image; they exist only
# during the RUN that mounts them.
RUN --mount=type=secret,id=COPILOT_GITHUB_TOKEN,mode=0444 \
    --mount=type=secret,id=BITBUCKET_TOKEN,mode=0444 \
    --mount=type=secret,id=BITBUCKET_USERNAME,mode=0444 \
    /opt/ai-agent/scripts/execute.sh "${AGENT_TYPE}"
DOCKERFILE

echo "==> Executing $AGENT_TYPE inside agent image."
DOCKER_BUILDKIT=1 docker build \
    --progress=plain \
    --no-cache \
    --build-arg "BASE_IMAGE=$AGENT_IMAGE" \
    --build-arg "WORKSPACE_DIR=$WORKSPACE_DIR" \
    --build-arg "AGENT_TYPE=$AGENT_TYPE" \
    --build-arg "AGENT_MODEL=${AGENT_MODEL:-}" \
    --build-arg "CONTAINER_USER=$CONTAINER_USER" \
    --build-arg "SOURCE_WORKSPACE=$SOURCE_WORKSPACE" \
    --build-arg "SOURCE_REPO=$SOURCE_REPO" \
    --build-arg "SOURCE_BRANCH=$SOURCE_BRANCH" \
    --build-arg "PR_ID=${PR_ID:-}" \
    --secret "id=COPILOT_GITHUB_TOKEN,src=$SECRETS_DIR/COPILOT_GITHUB_TOKEN" \
    --secret "id=BITBUCKET_TOKEN,src=$SECRETS_DIR/BITBUCKET_TOKEN" \
    --secret "id=BITBUCKET_USERNAME,src=$SECRETS_DIR/BITBUCKET_USERNAME" \
    -f "$RUNNER_DIR/Dockerfile.runner" \
    -t "${AGENT_IMAGE}-run" \
    "$RUNNER_DIR"

echo "==> ai-agent-pipe finished successfully."

#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run-agent.sh
#
# Core orchestration adapted from ai-agent-hub for the Pipe runtime image.
# Responsibilities:
#   1. Clone the target spoke repository over SSH at $SOURCE_BRANCH.
#   2. If the target repo contains a .devcontainer, build it with the
#      devcontainer CLI, layer a Copilot wrapper devcontainer on top, then
#      use `docker build --secret` to execute the Copilot CLI inside the
#      resulting agent image (Image B).
#   3. Otherwise, fall back to a simplified flow that runs Copilot directly
#      inside the wrapper image.
#   4. Stream all output; exit with the agent's exit code.
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
WORKDIR="${WORKDIR:-/tmp/ai-agent-pipe.workspace}"
PIPE_CONFIG_DIR="${PIPE_CONFIG_DIR:-/usr/local/share/ai-agent-pipe/config}"

# Image tags used during the two-image layering process.
TARGET_IMAGE="ai-agent-pipe/target:${SOURCE_REPO}-${SOURCE_BRANCH}"
AGENT_IMAGE="ai-agent-pipe/agent:${SOURCE_REPO}-${SOURCE_BRANCH}"

# Sanitise the tag – docker image references only allow [a-z0-9._-].
sanitize() { echo "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-' ; }
TARGET_IMAGE="$(sanitize "$TARGET_IMAGE")"
AGENT_IMAGE="$(sanitize "$AGENT_IMAGE")"

# ---------------------------------------------------------------------------
# Step 1 – clone the spoke repository.
# ---------------------------------------------------------------------------
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

CLONE_URL="git@bitbucket.org:${SOURCE_WORKSPACE}/${SOURCE_REPO}.git"
echo "==> Cloning $CLONE_URL (branch: $SOURCE_BRANCH)"
git clone --depth 1 --branch "$SOURCE_BRANCH" "$CLONE_URL" "$WORKDIR/repo"

# ---------------------------------------------------------------------------
# Step 2 – branch on devcontainer presence.
# ---------------------------------------------------------------------------
if [ -d "$WORKDIR/repo/.devcontainer" ]; then
    echo "==> .devcontainer detected – building target image with devcontainer CLI."
    devcontainer build \
        --workspace-folder "$WORKDIR/repo" \
        --image-name "$TARGET_IMAGE"

    # -----------------------------------------------------------------
    # Layer the Copilot wrapper devcontainer.  The wrapper inherits FROM
    # $TARGET_IMAGE at runtime via a build arg, which keeps the wrapper
    # image generic and re-usable across spoke repos.
    # -----------------------------------------------------------------
    WRAPPER_DIR="$WORKDIR/wrapper"
    mkdir -p "$WRAPPER_DIR/.devcontainer"
    cp -R "$PIPE_CONFIG_DIR/wrapper-devcontainer/." "$WRAPPER_DIR/.devcontainer/"

    echo "==> Building agent image (Copilot CLI layered on $TARGET_IMAGE)."
    devcontainer build \
        --workspace-folder "$WRAPPER_DIR" \
        --image-name "$AGENT_IMAGE" \
        --build-arg "BASE_IMAGE=$TARGET_IMAGE"

    # -----------------------------------------------------------------
    # Extract devcontainer.metadata so we can replay lifecycle commands
    # (onCreate / postCreate / postStart) – the devcontainer CLI only
    # runs these during `devcontainer up`, not during `build`.
    # -----------------------------------------------------------------
    LIFECYCLE_SCRIPT="$WORKDIR/lifecycle.sh"
    metadata="$(docker image inspect "$AGENT_IMAGE" \
        --format '{{ index .Config.Labels "devcontainer.metadata" }}' \
        2>/dev/null || echo '[]')"
    node /usr/local/bin/scripts/generate-lifecycle.js \
        --metadata "$metadata" \
        --out "$LIFECYCLE_SCRIPT"

    # -----------------------------------------------------------------
    # Final docker build executes Copilot inside the layered agent image,
    # with secrets mounted via BuildKit so they never end up in any layer.
    # -----------------------------------------------------------------
    RUNNER_DIR="$WORKDIR/runner"
    mkdir -p "$RUNNER_DIR"
    cp "$LIFECYCLE_SCRIPT" "$RUNNER_DIR/lifecycle.sh"
    # COMMENT_TEXT is written to a file so we don't expand it into the
    # Dockerfile (avoids quoting issues and shell-injection risk).
    printf '%s' "$COMMENT_TEXT" > "$RUNNER_DIR/prompt.txt"

    cat > "$RUNNER_DIR/Dockerfile.runner" <<'DOCKERFILE'
# syntax=docker/dockerfile:1.6
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY lifecycle.sh /tmp/lifecycle.sh
COPY prompt.txt   /tmp/prompt.txt

# --mount=type=secret keeps tokens out of the final image; they exist only
# during the RUN that mounts them.
RUN --mount=type=secret,id=copilot_token,target=/run/secrets/copilot_token \
    --mount=type=secret,id=bb_token,target=/run/secrets/bb_token \
    set -eu; \
    export GH_COPILOT_TOKEN="$(cat /run/secrets/copilot_token)"; \
    export BITBUCKET_TOKEN="$(cat /run/secrets/bb_token)"; \
    bash /tmp/lifecycle.sh; \
    copilot -p "$(cat /tmp/prompt.txt)"
DOCKERFILE

    echo "==> Executing Copilot inside agent image."
    DOCKER_BUILDKIT=1 docker build \
        --progress=plain \
        --build-arg "BASE_IMAGE=$AGENT_IMAGE" \
        --secret "id=copilot_token,src=$SECRETS_DIR/copilot_token" \
        --secret "id=bb_token,src=$SECRETS_DIR/bb_token" \
        -f "$RUNNER_DIR/Dockerfile.runner" \
        -t "${AGENT_IMAGE}-run" \
        "$RUNNER_DIR"
else
    echo "==> No .devcontainer – using simplified flow."
    # Run Copilot directly inside the wrapper image, mounting the cloned
    # workspace.  This path does not require BuildKit secrets because
    # nothing is committed back to an image.
    docker run --rm \
        -e "GH_COPILOT_TOKEN=$(cat "$SECRETS_DIR/copilot_token")" \
        -e "BITBUCKET_TOKEN=$(cat "$SECRETS_DIR/bb_token")" \
        -v "$WORKDIR/repo:/workspace" \
        -w /workspace \
        "ghcr.io/github/copilot-cli:latest" \
        copilot -p "$COMMENT_TEXT"
fi

echo "==> ai-agent-pipe finished successfully."

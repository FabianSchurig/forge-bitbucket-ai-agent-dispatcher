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
#
# Secrets arrive from entrypoint.sh as AI_AGENT_PIPE_SECRET_* variables and
# are moved into unexported shell variables before anything else runs. The
# devcontainer configuration comes from the branch under review, so neither
# its ${localEnv:...} references nor a build context pointing outside the
# repository may be able to reach a secret: none is in the environment of a
# child process, and none is on disk while the source repository's images
# build. The SSH key exists only for the clone; the tokens are written to
# tmpfs for the final build alone.
# ---------------------------------------------------------------------------
set -euo pipefail

take_secret() {
    local name="AI_AGENT_PIPE_SECRET_$1"
    printf '%s' "${!name:-}"
}
SECRET_AGENT="$(take_secret AGENT)"
SECRET_BITBUCKET_TOKEN="$(take_secret BITBUCKET_TOKEN)"
SECRET_BITBUCKET_USERNAME="$(take_secret BITBUCKET_USERNAME)"
SECRET_SSH_KEY="$(take_secret SSH_KEY)"
SECRET_OTEL_HEADERS="$(take_secret OTEL_HEADERS)"
SECRET_OTEL_TRACES_HEADERS="$(take_secret OTEL_TRACES_HEADERS)"
SECRET_ATLASSIAN_MCP_API_KEY="$(take_secret ATLASSIAN_MCP_API_KEY)"
unset AI_AGENT_PIPE_SECRET_AGENT AI_AGENT_PIPE_SECRET_BITBUCKET_TOKEN \
      AI_AGENT_PIPE_SECRET_BITBUCKET_USERNAME AI_AGENT_PIPE_SECRET_SSH_KEY \
      AI_AGENT_PIPE_SECRET_OTEL_HEADERS AI_AGENT_PIPE_SECRET_OTEL_TRACES_HEADERS \
      AI_AGENT_PIPE_SECRET_ATLASSIAN_MCP_API_KEY

# ---------------------------------------------------------------------------
# Configuration / defaults.
# ---------------------------------------------------------------------------
: "${SOURCE_WORKSPACE:?SOURCE_WORKSPACE is required}"
: "${SOURCE_REPO:?SOURCE_REPO is required}"
: "${SOURCE_BRANCH:?SOURCE_BRANCH is required}"
: "${COMMENT_TEXT:?COMMENT_TEXT is required}"

SCRIPTS_DIR=/usr/local/bin/scripts
PIPE_CONFIG_DIR="${PIPE_CONFIG_DIR:-/usr/local/share/ai-agent-pipe/config}"
AGENT_TYPE="${AGENT_TYPE:-copilot}"
AGENT_CONFIG_DIR="$PIPE_CONFIG_DIR/agents/$AGENT_TYPE"
SOURCE_CLONE_URL="${SOURCE_CLONE_URL:-git@bitbucket.org:${SOURCE_WORKSPACE}/${SOURCE_REPO}.git}"

if [ ! -d "$AGENT_CONFIG_DIR" ]; then
    echo "ERROR: unsupported AGENT_TYPE '$AGENT_TYPE'. No profile exists at $AGENT_CONFIG_DIR." >&2
    exit 2
fi

# shellcheck source=/dev/null
source "$AGENT_CONFIG_DIR/agent.env"
AGENT_SECRET_NAME="${AGENT_SECRET_NAME:-COPILOT_GITHUB_TOKEN}"

if [ -n "${BITBUCKET_CLONE_DIR:-}" ]; then
    WORKDIR="${WORKDIR:-$BITBUCKET_CLONE_DIR/.ai-agent-pipe}"
else
    WORKDIR="${WORKDIR:-/tmp/ai-agent-pipe.workspace}"
fi

WORKSPACE_DIR="repo"

# Private, short-lived state outside $WORKDIR: the SSH material for the clone
# and the token files for the final build. Removed however this script exits.
PRIVATE_DIR="$(mktemp -d /tmp/ai-agent-pipe.XXXXXX)"
chmod 700 "$PRIVATE_DIR"
trap 'rm -rf "$PRIVATE_DIR"' EXIT

# Image tags used during the two-image layering process. A tag allows
# [a-z0-9._-] (lowercased here), must not start with '.' or '-', and is at most
# 128 characters; long branch names are cut, leaving room for the "-run"
# suffix of the final image.
image_tag() {
    local tag
    tag="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-')"
    case "$tag" in [.-]*) tag="x$tag" ;; esac
    printf '%s' "${tag:0:120}"
}
IMAGE_TAG="$(image_tag "${SOURCE_REPO}-${SOURCE_BRANCH}")"
TARGET_IMAGE="ai-agent-pipe/target:${IMAGE_TAG}"
AGENT_IMAGE="ai-agent-pipe/agent:${IMAGE_TAG}"

# ---------------------------------------------------------------------------
# Step 1 – clone the spoke repository.
# ---------------------------------------------------------------------------
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

# Bitbucket's published host keys
# (https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/),
# embedded rather than fetched with ssh-keyscan at runtime, which would be
# vulnerable to MITM during the scan. SSH_KNOWN_HOSTS adds entries for any
# other host SOURCE_CLONE_URL points at.
write_known_hosts() {
    cat <<'KNOWN_HOSTS'
bitbucket.org ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e5POber2cZ5F5PVstBEE0GbCOphq2Bm0RB/gEEhGOlSkaKNDWKKWmqtWvWBNXvHTCmG4pCl4gvYVhqsXj/pxEX9GrGdJmxZP0gSKi3BDpFPiVBLLI6M4Xl5jAFhlcNM0zmzX30RbJMJPH6+b3c1Elu2VJEJmqJwWGEG8Qc6PFKfFpKkHJhBZ/cPMD+W4c50v2IkRXgMHIJx0Mx+xNkMWNB90K0SmFNeTLmPIbOQZndOJMGU+Ql3Q48XH9JiDLbhJIl+V/k8N+8r3eMfTjmPRjsm+M2PiWtfi6YSRBI/qlNE/zrdKaBTMqrRxQ1gKVRHVDR1LIGGpYVZOZyJBkS8xtEzW7gSH3NxEPlFEE7p06Ba/R5zF/RF/3ISVtFbOvzBbkx+SV3V/a2vlZVYzzPL9n/B+5hkB7nVbNSynIaOSGqEm/Fy6MZ2lGISoGMIX5E49L7mMZT1FdaVLfjSQmc2YYAP0Ia4j0mm0=
bitbucket.org ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=
bitbucket.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO
KNOWN_HOSTS
    if [ -n "${SSH_KNOWN_HOSTS:-}" ]; then
        printf '%s\n' "$SSH_KNOWN_HOSTS"
    fi
}

# Writes SSH_KEY to $1. Bitbucket recommends storing a key base64-encoded in a
# variable, so a value without a PEM header is decoded first. Keys pasted
# through a UI often lose their trailing newline or gain CRs, and OpenSSH
# refuses either.
write_ssh_key() {
    local key="$SECRET_SSH_KEY"
    if [[ "$key" != *"PRIVATE KEY"* ]]; then
        local decoded
        if decoded="$(printf '%s' "$key" | base64 -d 2>/dev/null)" && [[ "$decoded" == *"PRIVATE KEY"* ]]; then
            key="$decoded"
        fi
    fi
    ( umask 077; printf '%s\n' "${key//$'\r'/}" > "$1" )
    if ! ssh-keygen -y -f "$1" >/dev/null 2>&1; then
        echo "ERROR: SSH_KEY is not a usable private key (it must be unencrypted, in PEM/OpenSSH format or base64 of it)." >&2
        exit 2
    fi
}

clone_source() {
    local dest="$1" attempt
    local -a git_env=()
    case "$SOURCE_CLONE_URL" in
        git@*|ssh://*)
            write_ssh_key "$PRIVATE_DIR/id_key"
            write_known_hosts > "$PRIVATE_DIR/known_hosts"
            git_env=(GIT_SSH_COMMAND="ssh -F /dev/null -i $PRIVATE_DIR/id_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$PRIVATE_DIR/known_hosts")
            ;;
    esac
    # A network blip should not cost a whole run; a missing branch fails all
    # three attempts quickly.
    for attempt in 1 2 3; do
        rm -rf "$dest"
        if env "${git_env[@]}" GIT_TERMINAL_PROMPT=0 \
               git clone --quiet --depth 1 --no-tags --branch "$SOURCE_BRANCH" -- "$SOURCE_CLONE_URL" "$dest"; then
            rm -f "$PRIVATE_DIR/id_key"
            return 0
        fi
        [ "$attempt" -eq 3 ] || { echo "WARN: clone attempt $attempt failed; retrying." >&2; sleep $((attempt * 5)); }
    done
    rm -f "$PRIVATE_DIR/id_key"
    echo "ERROR: could not clone $SOURCE_CLONE_URL at branch '$SOURCE_BRANCH'." >&2
    exit 1
}

echo "==> Cloning $SOURCE_CLONE_URL (branch: $SOURCE_BRANCH)"
clone_source "$WORKDIR/repo"
unset SECRET_SSH_KEY

# ---------------------------------------------------------------------------
# Step 2 – build the target base image.
#
# The devcontainer spec allows .devcontainer/devcontainer.json,
# .devcontainer.json, and .devcontainer/<name>/devcontainer.json, which the
# CLI does not discover on its own. DEVCONTAINER_CONFIG picks one explicitly,
# relative to the repository root.
# ---------------------------------------------------------------------------
find_devcontainer_config() {
    local repo="$1" candidate
    if [ -n "${DEVCONTAINER_CONFIG:-}" ]; then
        case "$DEVCONTAINER_CONFIG" in
            /*|*..*) echo "ERROR: DEVCONTAINER_CONFIG must be a path inside the repository." >&2; exit 2 ;;
        esac
        if [ ! -f "$repo/$DEVCONTAINER_CONFIG" ]; then
            echo "ERROR: DEVCONTAINER_CONFIG '$DEVCONTAINER_CONFIG' does not exist on branch '$SOURCE_BRANCH'." >&2
            exit 2
        fi
        printf '%s' "$repo/$DEVCONTAINER_CONFIG"
        return
    fi
    for candidate in .devcontainer/devcontainer.json .devcontainer.json; do
        if [ -f "$repo/$candidate" ]; then
            printf '%s' "$repo/$candidate"
            return
        fi
    done
    local -a named=()
    for candidate in "$repo"/.devcontainer/*/devcontainer.json; do
        [ -f "$candidate" ] && named+=("$candidate")
    done
    if [ "${#named[@]}" -gt 1 ]; then
        echo "ERROR: the repository has several devcontainer configurations; set DEVCONTAINER_CONFIG to one of:" >&2
        printf '  - %s\n' "${named[@]#"$repo/"}" >&2
        exit 2
    fi
    printf '%s' "${named[0]:-}"
}

DEVCONTAINER_JSON="$(find_devcontainer_config "$WORKDIR/repo")"
if [ -n "$DEVCONTAINER_JSON" ]; then
    echo "==> ${DEVCONTAINER_JSON#"$WORKDIR/repo/"} detected – building target image with devcontainer CLI."
    devcontainer build \
        --workspace-folder "$WORKDIR/repo" \
        --config "$DEVCONTAINER_JSON" \
        --image-name "$TARGET_IMAGE"
else
    echo "==> No devcontainer configuration detected – building generated base image."
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
#
# A profile's wrapper-devcontainer adds devcontainer features its agent needs
# (copilot-cli for copilot). A profile without one, such as cursor, which
# installs its CLI from install.sh instead, gets a plain wrapper so the
# marketplace feature can still be added.
# ---------------------------------------------------------------------------
WRAPPER_DIR="$WORKDIR/wrapper"
mkdir -p "$WRAPPER_DIR/.devcontainer"
if [ -d "$AGENT_CONFIG_DIR/wrapper-devcontainer" ]; then
    cp -R "$AGENT_CONFIG_DIR/wrapper-devcontainer/." "$WRAPPER_DIR/.devcontainer/"
else
    # shellcheck disable=SC2016 # ${BASE_IMAGE} is for the Dockerfile, not this shell.
    printf 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n' > "$WRAPPER_DIR/.devcontainer/Dockerfile"
    jq -n --arg name "ai-agent-pipe-${AGENT_TYPE}-wrapper" \
        '{name: $name, build: {dockerfile: "Dockerfile", args: {BASE_IMAGE: "${localEnv:BASE_IMAGE}"}}}' \
        > "$WRAPPER_DIR/.devcontainer/devcontainer.json"
fi

echo "==> Building agent image ($AGENT_TYPE layered on $TARGET_IMAGE)."
# The skills and MCP servers come from the werfen-ai-agent feature, the same
# one a developer's devcontainer lists.
FEATURE_ARGS=()
if [ -n "${AGENT_FEATURE:-}" ] && [ "$AGENT_FEATURE" != "none" ]; then
    echo "==> Adding $AGENT_FEATURE (plugins: ${AGENT_PLUGINS:-bitbucket})"
    FEATURE_ARGS=(--additional-features "$(jq -cn --arg ref "$AGENT_FEATURE" --arg plugins "${AGENT_PLUGINS:-bitbucket}" \
        '{($ref): {plugins: $plugins}}')")
fi
# The devcontainer CLI does NOT accept --build-arg; instead the wrapper
# devcontainer.json references ${localEnv:BASE_IMAGE} under build.args, so we
# export it for the CLI process to interpolate.
BASE_IMAGE="$TARGET_IMAGE" devcontainer build \
    --workspace-folder "$WRAPPER_DIR" \
    --image-name "$AGENT_IMAGE" \
    ${FEATURE_ARGS[@]+"${FEATURE_ARGS[@]}"}

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
node "$SCRIPTS_DIR/generate-lifecycle.js" \
    --metadata "$metadata" \
    --out "$LIFECYCLE_SCRIPT"

# The user the agent runs as: the last remoteUser across the metadata entries,
# which per the spec defaults to containerUser.
CONTAINER_USER="$(jq -r '(if type == "array" then . else [.] end) | map(objects) as $e
    | ([$e[].remoteUser | strings] | last) // ([$e[].containerUser | strings] | last) // "root"' \
    <<<"$metadata" 2>/dev/null || echo root)"

# Validate CONTAINER_USER against a strict pattern to prevent command injection
# from a malicious devcontainer.json remoteUser value.  Only allow typical
# Unix usernames (lowercase alphanum, dash, underscore) or numeric UIDs.
if ! [[ "$CONTAINER_USER" =~ ^[a-z_][a-z0-9_-]*$|^[0-9]+$ ]]; then
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
cp -R "$SCRIPTS_DIR/." "$RUNNER_DIR/agent-scripts/"
printf '%s' "$COMMENT_TEXT" > "$RUNNER_DIR/prompt.txt"

# Telemetry settings that are not secret travel as build args; headers carry
# credentials and are mounted as secrets instead (execute.sh reads both).
OTEL_ARGS=(OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
           OTEL_EXPORTER_OTLP_PROTOCOL OTEL_SERVICE_NAME OTEL_RESOURCE_ATTRIBUTES TRACEPARENT)

{
    cat <<'DOCKERFILE'
# syntax=docker/dockerfile:1.6
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG WORKSPACE_DIR=repo
ARG AGENT_TYPE=copilot
ARG AGENT_MODEL=""
ARG READ_ONLY=false
ARG CONTAINER_USER=root
ARG SOURCE_WORKSPACE=""
ARG SOURCE_REPO=""
ARG SOURCE_BRANCH=""
ARG PR_ID=""
ARG OTEL_EXPORTER_OTLP_ENDPOINT=""
ARG OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=""
ARG OTEL_EXPORTER_OTLP_PROTOCOL=""
ARG OTEL_SERVICE_NAME=""
ARG OTEL_RESOURCE_ATTRIBUTES=""
ARG TRACEPARENT=""

ENV AGENT_ROOT=/opt/ai-agent \
    AGENT_MODEL=${AGENT_MODEL} \
    READ_ONLY=${READ_ONLY} \
    SOURCE_WORKSPACE=${SOURCE_WORKSPACE} \
    SOURCE_REPO=${SOURCE_REPO} \
    SOURCE_BRANCH=${SOURCE_BRANCH} \
    PR_ID=${PR_ID} \
    OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT} \
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT} \
    OTEL_EXPORTER_OTLP_PROTOCOL=${OTEL_EXPORTER_OTLP_PROTOCOL} \
    OTEL_SERVICE_NAME=${OTEL_SERVICE_NAME} \
    OTEL_RESOURCE_ATTRIBUTES=${OTEL_RESOURCE_ATTRIBUTES} \
    TRACEPARENT=${TRACEPARENT}

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
# during the RUN that mounts them. A secret that is not supplied is simply
# not mounted.
DOCKERFILE
    # The agent's secret is named by its profile, so this line is generated;
    # entrypoint.sh has already checked the name is [A-Z][A-Z0-9_]*.
    printf 'RUN --mount=type=secret,id=%s,mode=0444 \\\n' "$AGENT_SECRET_NAME"
    cat <<'DOCKERFILE'
    --mount=type=secret,id=BITBUCKET_TOKEN,mode=0444 \
    --mount=type=secret,id=BITBUCKET_USERNAME,mode=0444 \
    --mount=type=secret,id=OTEL_EXPORTER_OTLP_HEADERS,mode=0444 \
    --mount=type=secret,id=OTEL_EXPORTER_OTLP_TRACES_HEADERS,mode=0444 \
    --mount=type=secret,id=ATLASSIAN_MCP_API_KEY,mode=0444 \
    /opt/ai-agent/scripts/execute.sh "${AGENT_TYPE}"
DOCKERFILE
} > "$RUNNER_DIR/Dockerfile.runner"

# Token files exist on tmpfs for exactly as long as the build that mounts
# them; the EXIT trap removes them should the build be interrupted.
SECRETS_DIR="$PRIVATE_DIR/secrets"
mkdir -m 700 "$SECRETS_DIR"
SECRET_ARGS=()
add_secret() {
    local id="$1" value="$2"
    [ -n "$value" ] || return 0
    ( umask 077; printf '%s' "$value" > "$SECRETS_DIR/$id" )
    SECRET_ARGS+=(--secret "id=$id,src=$SECRETS_DIR/$id")
}
add_secret "$AGENT_SECRET_NAME" "$SECRET_AGENT"
add_secret BITBUCKET_TOKEN "$SECRET_BITBUCKET_TOKEN"
add_secret BITBUCKET_USERNAME "$SECRET_BITBUCKET_USERNAME"
add_secret OTEL_EXPORTER_OTLP_HEADERS "$SECRET_OTEL_HEADERS"
add_secret OTEL_EXPORTER_OTLP_TRACES_HEADERS "$SECRET_OTEL_TRACES_HEADERS"
add_secret ATLASSIAN_MCP_API_KEY "$SECRET_ATLASSIAN_MCP_API_KEY"
unset SECRET_AGENT SECRET_BITBUCKET_TOKEN SECRET_BITBUCKET_USERNAME SECRET_OTEL_HEADERS SECRET_OTEL_TRACES_HEADERS \
      SECRET_ATLASSIAN_MCP_API_KEY

BUILD_ARGS=()
for name in "${OTEL_ARGS[@]}"; do
    BUILD_ARGS+=(--build-arg "$name=${!name:-}")
done

echo "==> Executing $AGENT_TYPE inside agent image."
set +e
DOCKER_BUILDKIT=1 docker build \
    --progress=plain \
    --no-cache \
    --build-arg "BASE_IMAGE=$AGENT_IMAGE" \
    --build-arg "WORKSPACE_DIR=$WORKSPACE_DIR" \
    --build-arg "AGENT_TYPE=$AGENT_TYPE" \
    --build-arg "AGENT_MODEL=${AGENT_MODEL:-}" \
    --build-arg "READ_ONLY=${READ_ONLY:-false}" \
    --build-arg "CONTAINER_USER=$CONTAINER_USER" \
    --build-arg "SOURCE_WORKSPACE=$SOURCE_WORKSPACE" \
    --build-arg "SOURCE_REPO=$SOURCE_REPO" \
    --build-arg "SOURCE_BRANCH=$SOURCE_BRANCH" \
    --build-arg "PR_ID=${PR_ID:-}" \
    "${BUILD_ARGS[@]}" \
    ${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"} \
    -f "$RUNNER_DIR/Dockerfile.runner" \
    -t "${AGENT_IMAGE}-run" \
    "$RUNNER_DIR"
status=$?
set -e
rm -rf "$SECRETS_DIR"

if [ "$status" -ne 0 ]; then
    echo "ERROR: the agent run failed (docker build exited with status $status)." >&2
    exit "$status"
fi
echo "==> ai-agent-pipe finished successfully."

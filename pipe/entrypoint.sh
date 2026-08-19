#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ai-agent-pipe entrypoint.
#
# Responsibilities (kept intentionally small):
#   1. Validate required inputs are present (delegated to validate-config.sh).
#   2. Materialise secrets to short-lived files on tmpfs (/tmp) so:
#         - docker build --secret can mount them, and
#         - they never appear in `ps` output or image layers.
#   3. Configure ssh-agent with the supplied deploy key.
#   4. Hand off to scripts/run-agent.sh, which does the actual clone +
#      devcontainer build + agent invocation.
#
# Inputs are read from environment variables.  The pipe accepts both the
# Bitbucket Pipes convention (`PIPE_INPUT_FOO`) and the bare variable name
# (`FOO`) – the dispatcher emits the bare form (see src/pipelinePayload.ts),
# whereas a human invoking the pipe via `bitbucket-pipelines.yml` `pipe:`
# syntax will get `PIPE_INPUT_*` prefixes.  We normalise both into bare
# names so the downstream script does not need to care.
# ---------------------------------------------------------------------------
set -euo pipefail

# ---------------------------------------------------------------------------
# Helper: pick the first non-empty value from a list of env-var names.
# Usage: pick FOO PIPE_INPUT_FOO  ->  echoes the first non-empty value, or ""
# ---------------------------------------------------------------------------
pick() {
    local name value
    for name in "$@"; do
        value="${!name:-}"
        if [ -n "$value" ]; then
            printf '%s' "$value"
            return 0
        fi
    done
    printf ''
}

# ---------------------------------------------------------------------------
# Map inputs.  We export so child processes (run-agent.sh, docker build) see
# them.  Secrets are deliberately NOT echoed – the `set -x` trace is left
# off by default.
# ---------------------------------------------------------------------------
export SOURCE_WORKSPACE="$(pick PIPE_INPUT_SOURCE_WORKSPACE SOURCE_WORKSPACE)"
export SOURCE_REPO="$(pick PIPE_INPUT_SOURCE_REPO SOURCE_REPO)"
export SOURCE_BRANCH="$(pick PIPE_INPUT_SOURCE_BRANCH SOURCE_BRANCH)"
export PR_ID="$(pick PIPE_INPUT_PR_ID PR_ID)"
export COMMENT_TEXT="$(pick PIPE_INPUT_COMMENT_TEXT COMMENT_TEXT)"
export COMMENT_AUTHOR="$(pick PIPE_INPUT_COMMENT_AUTHOR COMMENT_AUTHOR)"
export AGENT_TYPE="$(pick PIPE_INPUT_AGENT_TYPE AGENT_TYPE)"
export AGENT_TYPE="${AGENT_TYPE:-copilot}"

# Secrets – never logged.  Exported so validate-config.sh (a child process)
# can see them during validation.
export COPILOT_TOKEN_VALUE="$(pick PIPE_INPUT_COPILOT_GITHUB_TOKEN PIPE_SECRET_COPILOT_GITHUB_TOKEN COPILOT_GITHUB_TOKEN PIPE_INPUT_COPILOT_TOKEN PIPE_SECRET_COPILOT_TOKEN COPILOT_TOKEN)"
export CURSOR_API_KEY_VALUE="$(pick PIPE_INPUT_CURSOR_API_KEY PIPE_SECRET_CURSOR_API_KEY CURSOR_API_KEY)"
export BB_TOKEN_VALUE="$(pick PIPE_INPUT_BITBUCKET_TOKEN PIPE_SECRET_BITBUCKET_TOKEN BITBUCKET_TOKEN PIPE_INPUT_BB_TOKEN PIPE_SECRET_BB_TOKEN BB_TOKEN)"
export BB_USERNAME_VALUE="$(pick PIPE_INPUT_BITBUCKET_USERNAME PIPE_SECRET_BITBUCKET_USERNAME BITBUCKET_USERNAME PIPE_INPUT_BB_USERNAME PIPE_SECRET_BB_USERNAME BB_USERNAME)"
export SSH_KEY_VALUE="$(pick PIPE_INPUT_SSH_KEY PIPE_SECRET_SSH_KEY SSH_KEY)"

if [ "$AGENT_TYPE" != "copilot" ] && [ "$AGENT_TYPE" != "cursor" ]; then
    echo "ERROR: unsupported AGENT_TYPE '$AGENT_TYPE'. Supported values: copilot, cursor." >&2
    exit 2
fi

# ---------------------------------------------------------------------------
# Validate required inputs / secrets up-front and fail fast with a clear
# message.  validate-config.sh receives only the names of variables so no
# secret value is passed on the command line.
# ---------------------------------------------------------------------------
/usr/local/bin/scripts/validate-config.sh \
    SOURCE_WORKSPACE \
    SOURCE_REPO \
    SOURCE_BRANCH \
    COMMENT_TEXT \
    AGENT_TYPE \
    BB_TOKEN_VALUE \
    SSH_KEY_VALUE

if [ "$AGENT_TYPE" = "copilot" ]; then
    /usr/local/bin/scripts/validate-config.sh COPILOT_TOKEN_VALUE
else
    /usr/local/bin/scripts/validate-config.sh CURSOR_API_KEY_VALUE
fi

# ---------------------------------------------------------------------------
# Materialise secrets onto tmpfs.  Bitbucket Pipelines runners use tmpfs for
# /tmp, so these files vanish when the step ends and are never written to
# any persistent layer.  Mode 600 to keep them readable only by root inside
# the container.
# ---------------------------------------------------------------------------
SECRETS_DIR="${SECRETS_DIR:-/tmp/ai-agent-pipe.secrets}"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

umask 077
printf '%s' "$COPILOT_TOKEN_VALUE" > "$SECRETS_DIR/COPILOT_GITHUB_TOKEN"
printf '%s' "$CURSOR_API_KEY_VALUE"  > "$SECRETS_DIR/CURSOR_API_KEY"
printf '%s' "$BB_TOKEN_VALUE"      > "$SECRETS_DIR/BITBUCKET_TOKEN"
printf '%s' "$BB_USERNAME_VALUE"   > "$SECRETS_DIR/BITBUCKET_USERNAME"

# SSH key handling.  We always normalise to ~/.ssh/id_ed25519 so run-agent.sh
# can rely on a fixed path.  A trailing newline is added because some keys
# (notably those copied from the UI) lose it and OpenSSH refuses them.
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
{
    printf '%s' "$SSH_KEY_VALUE"
    # Append a newline only if the key did not already end with one.
    case "$SSH_KEY_VALUE" in
        *$'\n') ;;
        *) printf '\n' ;;
    esac
} > "$HOME/.ssh/id_ed25519"
chmod 600 "$HOME/.ssh/id_ed25519"

# Trust bitbucket.org's host keys out-of-the-box so the clone does not
# prompt.  We embed the published keys from Bitbucket's documentation
# (https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/)
# rather than running ssh-keyscan at runtime, which would be vulnerable to
# MITM during the scan.
cat >> "$HOME/.ssh/known_hosts" <<'KNOWN_HOSTS'
bitbucket.org ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e5POber2cZ5F5PVstBEE0GbCOphq2Bm0RB/gEEhGOlSkaKNDWKKWmqtWvWBNXvHTCmG4pCl4gvYVhqsXj/pxEX9GrGdJmxZP0gSKi3BDpFPiVBLLI6M4Xl5jAFhlcNM0zmzX30RbJMJPH6+b3c1Elu2VJEJmqJwWGEG8Qc6PFKfFpKkHJhBZ/cPMD+W4c50v2IkRXgMHIJx0Mx+xNkMWNB90K0SmFNeTLmPIbOQZndOJMGU+Ql3Q48XH9JiDLbhJIl+V/k8N+8r3eMfTjmPRjsm+M2PiWtfi6YSRBI/qlNE/zrdKaBTMqrRxQ1gKVRHVDR1LIGGpYVZOZyJBkS8xtEzW7gSH3NxEPlFEE7p06Ba/R5zF/RF/3ISVtFbOvzBbkx+SV3V/a2vlZVYzzPL9n/B+5hkB7nVbNSynIaOSGqEm/Fy6MZ2lGISoGMIX5E49L7mMZT1FdaVLfjSQmc2YYAP0Ia4j0mm0=
bitbucket.org ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=
bitbucket.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO
KNOWN_HOSTS
chmod 644 "$HOME/.ssh/known_hosts"

# Start an ssh-agent for this step and load the key.
eval "$(ssh-agent -s)" >/dev/null
ssh-add "$HOME/.ssh/id_ed25519" >/dev/null 2>&1 || {
    echo "ERROR: failed to add SSH key to ssh-agent." >&2
    exit 2
}

# ---------------------------------------------------------------------------
# Hand off.  exec replaces this process so the agent's exit code is what the
# Pipelines step sees.
# ---------------------------------------------------------------------------
exec /usr/local/bin/scripts/run-agent.sh

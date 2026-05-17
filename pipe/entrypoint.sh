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
#      devcontainer build + Copilot invocation.
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

# Secrets – never logged.
COPILOT_TOKEN_VALUE="$(pick PIPE_SECRET_COPILOT_TOKEN COPILOT_TOKEN)"
BB_TOKEN_VALUE="$(pick PIPE_SECRET_BB_TOKEN BB_TOKEN)"
SSH_KEY_VALUE="$(pick PIPE_SECRET_SSH_KEY SSH_KEY)"

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
    COPILOT_TOKEN_VALUE \
    BB_TOKEN_VALUE \
    SSH_KEY_VALUE

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
printf '%s' "$COPILOT_TOKEN_VALUE" > "$SECRETS_DIR/copilot_token"
printf '%s' "$BB_TOKEN_VALUE"      > "$SECRETS_DIR/bb_token"

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

# Trust bitbucket.org's host key out-of-the-box so the clone does not
# prompt.  We use the published fingerprints from Bitbucket's docs rather
# than `StrictHostKeyChecking=no` so we still get MITM protection.
ssh-keyscan -t rsa,ecdsa,ed25519 bitbucket.org >> "$HOME/.ssh/known_hosts" 2>/dev/null
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

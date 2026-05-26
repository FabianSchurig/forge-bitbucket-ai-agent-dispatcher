#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# validate-config.sh
#
# Verifies that each named environment variable is set and non-empty.
# Called by entrypoint.sh with the *names* of the variables to check; this
# keeps secret values out of the process argv (which would show up in `ps`).
#
# Usage: validate-config.sh VAR1 VAR2 VAR3 …
# Exits 1 with a list of missing variables if any are unset/empty.
# ---------------------------------------------------------------------------
set -euo pipefail

if [ "$#" -eq 0 ]; then
    echo "ERROR: validate-config.sh requires at least one variable name." >&2
    exit 2
fi

missing=()
for name in "$@"; do
    if [ -z "${!name:-}" ]; then
        missing+=("$name")
    fi
done

if [ "${#missing[@]}" -gt 0 ]; then
    echo "ERROR: the following required inputs are missing or empty:" >&2
    for name in "${missing[@]}"; do
        echo "  - $name" >&2
    done
    echo "Hint: non-secret variables (SOURCE_WORKSPACE, SOURCE_REPO, etc.) are" >&2
    echo "dispatched by the Forge app via pipeline variables (see" >&2
    echo "src/ondemandPipelinePayload.ts).  Secret variables (COPILOT_GITHUB_TOKEN," >&2
    echo "BITBUCKET_TOKEN, SSH_KEY, and optionally BITBUCKET_USERNAME) must be" >&2
    echo "configured as secured variables in the Bitbucket repository or workspace settings." >&2
    exit 1
fi

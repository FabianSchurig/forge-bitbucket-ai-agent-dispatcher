#!/usr/bin/env bash

require_env() {
    local name
    for name in "$@"; do
        if [ -z "${!name:-}" ]; then
            echo "ERROR: $name is required." >&2
            exit 1
        fi
    done
}

bitbucket_curl() {
    if [ -n "${BB_USERNAME:-}" ]; then
        curl -fsSL -u "${BB_USERNAME}:${BB_APP_PASSWORD}" "$@"
    else
        curl -fsSL -H "Authorization: Bearer ${BB_APP_PASSWORD}" "$@"
    fi
}

urlencode() {
    jq -nr --arg value "$1" '$value|@uri'
}

default_image_repo() {
    require_env GITHUB_REPOSITORY
    printf 'ghcr.io/%s/ai-agent-pipe' "$(printf '%s' "$GITHUB_REPOSITORY" | tr '[:upper:]' '[:lower:]')"
}
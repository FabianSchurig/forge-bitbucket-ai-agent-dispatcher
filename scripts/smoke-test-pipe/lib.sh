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

# Prints the names of the given variables that are unset or empty.
missing_env() {
    local name
    for name in "$@"; do
        [ -n "${!name:-}" ] || printf '%s\n' "$name"
    done
}

# Calls the Bitbucket API and prints the response body. On an HTTP error it
# reports Bitbucket's own error message as a GitHub annotation, which a bare
# `curl -f` would discard, and fails.
bitbucket_curl() {
    local body status
    local -a auth
    if [ -n "${BB_USERNAME:-}" ]; then
        auth=(-u "${BB_USERNAME}:${BB_APP_PASSWORD}")
    else
        auth=(-H "Authorization: Bearer ${BB_APP_PASSWORD}")
    fi
    body="$(mktemp)"
    if ! status="$(curl -sSL -o "$body" -w '%{http_code}' "${auth[@]}" "$@")"; then
        rm -f "$body"
        echo "::error::Bitbucket API request failed before an HTTP response." >&2
        return 1
    fi
    if [[ "$status" != 2* ]]; then
        echo "::error::Bitbucket API returned HTTP $status: $(jq -r '.error.message // .error // .' "$body" 2>/dev/null | tr '\n' ' ' | head -c 300)" >&2
        if [ "$status" = 401 ] || [ "$status" = 403 ]; then
            echo "::error::BB_APP_PASSWORD was rejected. Bitbucket has retired app passwords: use an Atlassian API token with BB_USERNAME set to the account's email, or a repository/workspace access token (Bearer, BB_USERNAME unset) with the pipelines:write scope." >&2
        fi
        rm -f "$body"
        return 1
    fi
    cat "$body"
    rm -f "$body"
}

urlencode() {
    jq -nr --arg value "$1" '$value|@uri'
}

default_image_repo() {
    require_env GITHUB_REPOSITORY
    printf 'ghcr.io/%s/ai-agent-pipe' "$(printf '%s' "$GITHUB_REPOSITORY" | tr '[:upper:]' '[:lower:]')"
}

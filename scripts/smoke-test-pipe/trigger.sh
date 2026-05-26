#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

require_env BB_APP_PASSWORD BB_TEST_WORKSPACE BB_TEST_REPO

BRANCH="${BB_TEST_BRANCH:-main}"
IMAGE_TAG="${IMAGE_TAG:-main}"
IMAGE_REPO="${IMAGE_REPO:-$(default_image_repo)}"

read -r -d '' YAML <<YAML || true
image: atlassian/default-image:5
pipelines:
  default:
    - step:
        name: ai-agent-pipe smoke test
        size: 2x
        services: [ docker ]
        script:
          - export DOCKER_BUILDKIT=1
          - pipe: docker://${IMAGE_REPO}:${IMAGE_TAG}
            variables:
              AGENT_TYPE: "copilot"
              SOURCE_WORKSPACE: "${BB_TEST_WORKSPACE}"
              SOURCE_REPO: "${BB_TEST_REPO}"
              SOURCE_BRANCH: "${BRANCH}"
              COMMENT_TEXT: "smoke test: respond with 'pong'"
              COPILOT_GITHUB_TOKEN: \$COPILOT_GITHUB_TOKEN
              BITBUCKET_TOKEN: \$BITBUCKET_TOKEN
              SSH_KEY: \$SSH_KEY

definitions:
  services:
    docker:
      memory: 4096
YAML

API="https://api.bitbucket.org/2.0/repositories/${BB_TEST_WORKSPACE}/${BB_TEST_REPO}/pipelines?target.type=pipeline_ref_target&target.ref_type=branch&target.ref_name=$(urlencode "$BRANCH")"
RESPONSE=$(bitbucket_curl \
    -H 'Content-Type: application/yaml' \
    -X POST "$API" \
    --data-binary "$YAML")

PIPELINE_UUID=$(printf '%s' "$RESPONSE" | jq -r .uuid)
if [ -z "$PIPELINE_UUID" ] || [ "$PIPELINE_UUID" = "null" ]; then
    echo "ERROR: Bitbucket did not return a pipeline uuid." >&2
    exit 1
fi

echo "Triggered pipeline: $PIPELINE_UUID"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "pipeline_uuid=$PIPELINE_UUID" >> "$GITHUB_OUTPUT"
else
    echo "PIPELINE_UUID=$PIPELINE_UUID"
fi
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

require_env BB_APP_PASSWORD BB_TEST_WORKSPACE BB_TEST_REPO PIPELINE_UUID

API="https://api.bitbucket.org/2.0/repositories/${BB_TEST_WORKSPACE}/${BB_TEST_REPO}/pipelines/${PIPELINE_UUID}"
POLL_ATTEMPTS="${SMOKE_POLL_ATTEMPTS:-120}"
POLL_INTERVAL_SECONDS="${SMOKE_POLL_INTERVAL_SECONDS:-10}"
STATE="UNKNOWN"

for i in $(seq 1 "$POLL_ATTEMPTS"); do
    STATE=$(bitbucket_curl "$API" | jq -r '.state.name // "UNKNOWN"')
    echo "[$i] pipeline state: $STATE"
    case "$STATE" in
        COMPLETED) break ;;
        *) sleep "$POLL_INTERVAL_SECONDS" ;;
    esac
done

if [ "$STATE" != "COMPLETED" ]; then
    echo "FAIL: pipeline did not complete within polling timeout (last state: $STATE)." >&2
    exit 1
fi

RESULT=$(bitbucket_curl "$API" | jq -r '.state.result.name // "UNKNOWN"')
echo "Pipeline result: $RESULT"

STEPS=$(bitbucket_curl "${API}/steps/" | jq -r '.values[].uuid')
for step_uuid in $STEPS; do
    bitbucket_curl "${API}/steps/${step_uuid}/log" > "/tmp/step-${step_uuid}.log"
done

if ! grep -q 'copilot' /tmp/step-*.log; then
    echo "FAIL: no 'copilot' invocation found in pipeline logs." >&2
    exit 1
fi

if [ "$RESULT" != "SUCCESSFUL" ]; then
    echo "FAIL: pipeline ended with $RESULT." >&2
    exit 1
fi

echo "Smoke test passed."
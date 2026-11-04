#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Offline smoke test for provision.sh + execute.sh, exercised through the thin
# Dockerfile shim that a Jenkins shared library uses to drive them.
#
# This covers the contract the two runtimes share, without Jenkins, without a
# registry and without real tokens. It is the cheapest way to catch the failure
# that actually bites: a path or user mismatch between the pipe image and the
# shim, discovered only after a long Dev Container build.
#
# What it asserts:
#   1. provision.sh installs bb-mcp, replays lifecycle commands, and keeps the
#      skills the werfen-ai-agent feature installed in the base image.
#   2. execute.sh runs as the container user, merges its bitbucket server into
#      the feature's MCP config, and composes a prompt carrying the pull
#      request coordinates.
#   3. The provisioning stage stays cached while the agent stage re-runs.
#   4. No secret survives into the final image.
#
# Usage:
#   scripts/smoke-test-agent-image/run.sh path/to/agent.Dockerfile
#
# The shim lives with whichever CI system consumes this image, so its path has
# to be supplied; see "Reuse from other CI systems" in pipe/README.md for what
# it has to contain. Requires Docker with BuildKit and network access for apt
# and the bb-mcp installer.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHIM="${1:-}"

PIPE_IMAGE="ai-agent-pipe:smoke"
BASE_IMAGE="agent-smoke-base:local"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

if [ -z "$SHIM" ] || [ ! -f "$SHIM" ]; then
    echo "ERROR: pass the path to the agent.Dockerfile shim under test." >&2
    echo "Usage: $0 path/to/agent.Dockerfile" >&2
    exit 2
fi

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1" >&2; exit 1; }

echo "==> Building pipe image"
docker build -q -t "$PIPE_IMAGE" "$REPO_ROOT/pipe" >/dev/null

echo "==> Building stand-in base image"
# Stands in for a source repository's Dev Container built with the
# werfen-ai-agent feature: a non-root user, a marketplace skill and MCP server
# in its home, and a fake `copilot` so the run stage completes without a real
# agent or real token.
cat > "$WORKDIR/base.Dockerfile" <<'EOF'
FROM debian:bookworm-slim
RUN useradd -m -s /bin/bash vscode
RUN mkdir -p /usr/local/share/werfen-ai-agent /home/vscode/.copilot/skills/bitbucket-pr-review \
 && echo '{"marketplaceRef":"smoke","plugins":["bitbucket","jama"]}' > /usr/local/share/werfen-ai-agent/installed.json \
 && printf -- '---\nname: bitbucket-pr-review\ndescription: smoke\n---\n' > /home/vscode/.copilot/skills/bitbucket-pr-review/SKILL.md \
 && echo '{"mcpServers":{"werfen-jama":{"command":"npx"},"bitbucket":{"command":"bb-mcp"}}}' > /home/vscode/.copilot/mcp-config.json \
 && chown -R vscode /home/vscode
COPY --chmod=0755 copilot /usr/local/bin/copilot
EOF
cat > "$WORKDIR/copilot" <<'EOF'
#!/bin/sh
MCP="$HOME/.copilot/mcp-config.json"
echo "SMOKE_USER=$(id -un)"
echo "SMOKE_MCP=$(test -f "$MCP" && echo yes || echo no)"
echo "SMOKE_MCP_SERVERS=$(jq -r '.mcpServers | keys | join(",")' "$MCP")"
echo "SMOKE_BB_TOKEN=$(jq -r '.mcpServers.bitbucket.env.BITBUCKET_TOKEN // "missing"' "$MCP" | cut -c1-5)"
echo "SMOKE_SKILLS=$(ls "$HOME/.copilot/skills" 2>/dev/null | tr '\n' ',')"
shift
echo "SMOKE_PROMPT_START"; echo "$1"; echo "SMOKE_PROMPT_END"
EOF
docker build -q -t "$BASE_IMAGE" -f "$WORKDIR/base.Dockerfile" "$WORKDIR" >/dev/null

echo "==> Staging build context"
CTX="$WORKDIR/ctx"
mkdir -p "$CTX/repo/src" "$CTX/secrets"
echo 'int main(void){return 0;}' > "$CTX/repo/src/main.c"
echo 'Review this pull request.' > "$CTX/prompt.txt"
printf '#!/usr/bin/env bash\necho SMOKE_LIFECYCLE_RAN\nexit 0\n' > "$CTX/lifecycle.sh"
cp "$SHIM" "$CTX/agent.Dockerfile"
echo 'smoke-copilot-token-a1b2c3'  > "$CTX/secrets/COPILOT_GITHUB_TOKEN"
echo 'smoke-bitbucket-token-d4e5f6' > "$CTX/secrets/BITBUCKET_TOKEN"

build() {
    docker buildx build --progress=plain --target agent-run --no-cache-filter agent-run \
        --build-arg "BASE_IMAGE=$BASE_IMAGE" \
        --build-arg "PIPE_IMAGE=$PIPE_IMAGE" \
        --build-arg AGENT_TYPE=copilot \
        --build-arg CONTAINER_USER=vscode \
        --build-arg SOURCE_WORKSPACE=example-workspace \
        --build-arg SOURCE_REPO=example-repo \
        --build-arg SOURCE_BRANCH=feature/smoke \
        --build-arg PR_ID=123 \
        --build-arg "CACHE_BUST=$(date +%s%N)" \
        --secret "id=COPILOT_GITHUB_TOKEN,src=$CTX/secrets/COPILOT_GITHUB_TOKEN" \
        --secret "id=BITBUCKET_TOKEN,src=$CTX/secrets/BITBUCKET_TOKEN" \
        -f "$CTX/agent.Dockerfile" "$@" "$CTX" 2>&1
}

echo "==> First build"
FIRST="$(build)" || { echo "$FIRST" | tail -40; exit 1; }

echo "==> Assertions"
grep -q 'SMOKE_LIFECYCLE_RAN'                 <<<"$FIRST" || fail "lifecycle.sh was not replayed"
pass "lifecycle commands replayed"

grep -q 'bb-mcp .* installed successfully'    <<<"$FIRST" || fail "bb-mcp was not installed"
pass "bb-mcp installed"

grep -q 'Installed 0 profile skill'           <<<"$FIRST" || fail "expected no profile skills"
grep -q 'werfen-ai-agent: {'                  <<<"$FIRST" || fail "the feature's installed.json was not reported"
grep -q 'SMOKE_SKILLS=bitbucket-pr-review,'   <<<"$FIRST" || fail "the feature's skill did not survive provisioning"
pass "marketplace skills from the feature kept, nothing extra"

grep -q 'SMOKE_USER=vscode'                   <<<"$FIRST" || fail "agent did not run as the container user"
pass "agent runs as the container user"

grep -q 'SMOKE_MCP=yes'                       <<<"$FIRST" || fail "MCP config was not rendered"
grep -q 'SMOKE_MCP_SERVERS=bitbucket,werfen-jama' <<<"$FIRST" || fail "the feature's MCP servers were not kept"
grep -q 'SMOKE_BB_TOKEN=smoke'                <<<"$FIRST" || fail "the profile's bitbucket server did not override the feature's"
pass "MCP config merged into the feature's"

grep -q 'Pull request ID: 123'                <<<"$FIRST" || fail "prompt is missing the pull request coordinates"
grep -q 'Repository: example-workspace/example-repo' <<<"$FIRST" || fail "prompt is missing the repository coordinates"
pass "prompt carries pull request context"

echo "==> Second build (cache behaviour)"
SECOND="$(build --load -t agent-smoke:run)"
grep -qE '\[agent-provisioned .*\].*provision\.sh' <<<"$SECOND" \
    && grep -A1 'provision\.sh' <<<"$SECOND" | grep -q CACHED \
    || fail "provisioning stage was not cached on rebuild"
pass "provisioning stage cached across runs"

grep -q 'SMOKE_USER=vscode' <<<"$SECOND" || fail "agent stage was cached and did not re-run"
pass "agent stage re-runs despite cache"

echo "==> Secret hygiene"
CID="$(docker create agent-smoke:run)"
docker export "$CID" -o "$WORKDIR/fs.tar"
docker rm "$CID" >/dev/null
if grep -a -q 'smoke-copilot-token-a1b2c3\|smoke-bitbucket-token-d4e5f6' "$WORKDIR/fs.tar"; then
    fail "a secret survived into the final image"
fi
pass "no secret in the final image"

docker run --rm --entrypoint sh agent-smoke:run \
    -c 'test ! -f "$HOME/.copilot/mcp-config.json"' \
    || fail "the rendered MCP config was left behind"
pass "rendered MCP config cleaned up"

echo
echo "All assertions passed."

#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# End-to-end test of the ai-agent-pipe image: entrypoint.sh -> run-agent.sh ->
# devcontainer build -> provision.sh -> execute.sh, exactly as Bitbucket runs
# it, but against a local source repository and a stand-in agent profile so
# it needs no Bitbucket, no registry login and no real tokens.
#
# What it asserts:
#   1. Bad inputs fail fast, before any build, with a message naming them.
#   2. The source repository's devcontainer builds, its lifecycle commands
#      replay, and the agent runs as its remoteUser with its secret, the
#      Bitbucket token in the MCP config, read-only mode and a prompt carrying
#      the repository coordinates.
#   3. The devcontainer configuration of the branch under review cannot read
#      a secret through ${localEnv:...}.
#   4. No secret survives into the final image, and the agent's exit status
#      becomes the pipe's.
#
# Usage: pipe/test/pipe-e2e/run.sh
#   PIPE_IMAGE=<ref> tests an existing image instead of building pipe/.
# Requires Docker with BuildKit and network access for the base images.
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPE_DIR="$HERE/../.."
PIPE_IMAGE="${PIPE_IMAGE:-}"
SOURCE_IMAGE_TAG="source-feature-e2e"

WORK="$(mktemp -d)"
cleanup() {
    rm -rf "$WORK"
    docker image rm -f "ai-agent-pipe/target:$SOURCE_IMAGE_TAG" "ai-agent-pipe/agent:$SOURCE_IMAGE_TAG" \
        "ai-agent-pipe/agent:$SOURCE_IMAGE_TAG-run" >/dev/null 2>&1 || true
}
trap cleanup EXIT

failures=0
pass() { echo "ok   - $*"; }
fail() { echo "FAIL - $*"; failures=$((failures + 1)); }

if [ -z "$PIPE_IMAGE" ]; then
    PIPE_IMAGE="ai-agent-pipe:e2e"
    echo "==> Building $PIPE_IMAGE"
    docker build -q -t "$PIPE_IMAGE" "$PIPE_DIR" >/dev/null
fi

AGENT_TOKEN="e2e-agent-token-a1b2c3"
BB_TOKEN="e2e-bitbucket-token-d4e5f6"
OTEL_HEADERS="authorization=Bearer%20e2e-otel-token-g7h8i9"
ssh-keygen -q -t ed25519 -N '' -C e2e -f "$WORK/id_e2e"
SSH_KEY_B64="$(base64 -w0 "$WORK/id_e2e")"
SSH_KEY_MARKER="$(sed -n 2p "$WORK/id_e2e" | cut -c1-24)"

# ---------------------------------------------------------------------------
# A stand-in agent profile: same contract as copilot/cursor, with an
# install.sh that puts a fake CLI on the image.
# ---------------------------------------------------------------------------
PROFILE="$WORK/profile"
mkdir -p "$PROFILE"
cp "$PIPE_DIR/config/agents/cursor/mcp-config.json" "$PROFILE/mcp-config.json"
cat > "$PROFILE/agent.env" <<'EOF'
AGENT_COMMAND="e2e-agent"
AGENT_FLAGS="--stream"
AGENT_SECRET_NAME="E2E_AGENT_TOKEN"
AGENT_HOME_DIR=".e2e"
AGENT_SKILLS_DIR=".e2e/skills"
AGENT_MCP_CONFIG_PATH=".e2e/mcp.json"
AGENT_OUTPUT_FILTER='if .type == "result" then "E2E_RESULT=" + .result else empty end'
EOF
cat > "$PROFILE/install.sh" <<'INSTALL'
#!/usr/bin/env bash
set -euo pipefail
cat > /usr/local/bin/e2e-agent <<'AGENT'
#!/usr/bin/env bash
mcp="$HOME/.e2e/mcp.json"
echo "E2E_USER=$(id -un)"
echo "E2E_SECRET=${E2E_AGENT_TOKEN:0:9}"
echo "E2E_MCP_TOKEN=$(jq -r '.mcpServers.bitbucket.env.BITBUCKET_TOKEN // "missing"' "$mcp" | cut -c1-13)"
echo "E2E_MCP_READONLY=$(jq -r '.mcpServers.bitbucket.args | index("-config") != null' "$mcp")"
echo "E2E_OTEL_HEADERS=${OTEL_EXPORTER_OTLP_HEADERS:0:13}"
# Not JSON, a JSON array and a JSON event: the output filter must survive all three.
echo '[1, 2]'
echo '{"type":"result","result":"done"}'
echo "E2E_PROMPT_START"; echo "$2"; echo "E2E_PROMPT_END"
exit_code="$(sed -n 's/.*E2E_EXIT=\([0-9]*\).*/\1/p' <<<"$2" | head -1)"
exit "${exit_code:-0}"
AGENT
chmod 0755 /usr/local/bin/e2e-agent
INSTALL

# ---------------------------------------------------------------------------
# The source repository. Its devcontainer probes for secrets through
# ${localEnv:...}, as a hostile branch could, and ships a fake bb-mcp so
# provision.sh does not download the real one.
# ---------------------------------------------------------------------------
SOURCE="$WORK/source"
mkdir -p "$SOURCE/.devcontainer"
# E2E_CANARY is an ordinary variable: it shows the probe does read the environment.
probe=""
for name in E2E_CANARY E2E_AGENT_TOKEN PIPE_INPUT_E2E_AGENT_TOKEN BITBUCKET_TOKEN SSH_KEY OTEL_EXPORTER_OTLP_HEADERS \
            AI_AGENT_PIPE_SECRET_AGENT AI_AGENT_PIPE_SECRET_BITBUCKET_TOKEN AI_AGENT_PIPE_SECRET_SSH_KEY \
            AI_AGENT_PIPE_SECRET_OTEL_HEADERS; do
    probe+="\${localEnv:$name}"
done
jq -n --arg probe "$probe" '{
    name: "e2e-source",
    build: {dockerfile: "Dockerfile", args: {PROBE: $probe}},
    remoteUser: "vscode",
    postCreateCommand: "echo E2E_LIFECYCLE_RAN"
}' > "$SOURCE/.devcontainer/devcontainer.json"
cat > "$SOURCE/.devcontainer/Dockerfile" <<'EOF'
FROM debian:trixie-slim
ARG PROBE
RUN echo "E2E_PROBE=[${PROBE}]"
RUN useradd -m -s /bin/bash vscode \
 && printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/bb-mcp && chmod 0755 /usr/local/bin/bb-mcp
EOF
echo 'int main(void){return 0;}' > "$SOURCE/main.c"
git -C "$SOURCE" init -q -b feature/E2E
git -C "$SOURCE" -c user.name=e2e -c user.email=e2e@example.invalid add -A
git -C "$SOURCE" -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m e2e
git clone -q --bare "$SOURCE" "$WORK/source.git"
# The pipe runs as root and the mounted repository belongs to this user.
printf '[safe]\n\tdirectory = *\n' > "$WORK/gitconfig"

run_pipe() {
    docker run --rm \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$WORK/source.git:/source.git:ro" \
        -v "$WORK/gitconfig:/root/.gitconfig:ro" \
        -v "$PROFILE:/usr/local/share/ai-agent-pipe/config/agents/e2e:ro" \
        -e AGENT_TYPE=e2e -e AGENT_FEATURE=none -e E2E_CANARY=canary \
        -e SOURCE_CLONE_URL=file:///source.git \
        -e SOURCE_WORKSPACE=e2e-workspace -e SOURCE_REPO=source -e SOURCE_BRANCH=feature/E2E \
        -e PR_ID=42 -e READ_ONLY=true \
        -e PIPE_INPUT_E2E_AGENT_TOKEN="$AGENT_TOKEN" -e BITBUCKET_TOKEN="$BB_TOKEN" \
        -e OTEL_EXPORTER_OTLP_HEADERS="$OTEL_HEADERS" -e SSH_KEY="$SSH_KEY_B64" \
        "$@" "$PIPE_IMAGE" 2>&1
}

# --- 1. Input validation -------------------------------------------------------
out="$(docker run --rm -e AGENT_TYPE=nope "$PIPE_IMAGE" 2>&1)" && status=0 || status=$?
if [ "$status" -eq 2 ] && grep -q "Supported values: copilot, cursor" <<<"$out"; then
    pass "an unknown AGENT_TYPE fails and lists the profiles"
else
    fail "unknown AGENT_TYPE: status $status: $out"
fi

out="$(docker run --rm -e AGENT_TYPE=cursor -e SOURCE_WORKSPACE=w -e SOURCE_REPO=r -e SOURCE_BRANCH=b \
        -e COMMENT_TEXT=hi -e COPILOT_GITHUB_TOKEN=x -e 'CURSOR_API_KEY=$CURSOR_API_KEY' "$PIPE_IMAGE" 2>&1)" \
    && status=0 || status=$?
if [ "$status" -eq 1 ] && grep -q -- "- CURSOR_API_KEY" <<<"$out" && grep -q -- "- BITBUCKET_TOKEN" <<<"$out" \
   && grep -q -- "- SSH_KEY" <<<"$out"; then
    pass "missing secrets are named, an unexpanded \$VARIABLE counts as missing"
else
    fail "missing secrets: status $status: $out"
fi

out="$(run_pipe -e SOURCE_REPO='../evil' -e COMMENT_TEXT=hi)" && status=0 || status=$?
if [ "$status" -eq 2 ] && grep -q "not a valid Bitbucket slug" <<<"$out"; then
    pass "a malformed repository slug is rejected"
else
    fail "malformed slug: status $status: $out"
fi

out="$(run_pipe -e SOURCE_CLONE_URL=ssh://git@127.0.0.1:1/x.git -e SSH_KEY=not-a-key -e COMMENT_TEXT=hi)" \
    && status=0 || status=$?
if [ "$status" -eq 2 ] && grep -q "SSH_KEY is not a usable private key" <<<"$out"; then
    pass "an unusable SSH key is rejected before cloning"
else
    fail "unusable SSH key: status $status: $out"
fi

# --- 2. A full run ---------------------------------------------------------------
echo "==> Full pipe run (devcontainer build, provision, agent)"
out="$(run_pipe -e COMMENT_TEXT='Review this pull request.')" && status=0 || status=$?
printf '%s\n' "$out" > "$WORK/run.log"

if [ "$status" -eq 0 ]; then pass "the pipe exits 0 when the agent does"; else fail "pipe exited $status"; fi

check() {
    local description="$1" pattern="$2"
    if grep -qE -- "$pattern" "$WORK/run.log"; then pass "$description"; else fail "$description (no match for: $pattern)"; fi
}
check "the devcontainer lifecycle commands are replayed" 'E2E_LIFECYCLE_RAN'
check "the agent runs as the devcontainer's remoteUser" 'E2E_USER=vscode'
check "the agent receives its profile's secret" 'E2E_SECRET=e2e-agent'
check "the MCP config carries the Bitbucket token" 'E2E_MCP_TOKEN=e2e-bitbucket'
check "READ_ONLY reaches bb-mcp" 'E2E_MCP_READONLY=true'
check "OTLP headers reach the agent as a secret" 'E2E_OTEL_HEADERS=authorization'
check "the output filter survives non-object JSON" 'E2E_RESULT=done'
check "the prompt names the repository" 'Repository: e2e-workspace/source'
check "the prompt names the pull request" 'Pull request ID: 42'
check "the prompt states read-only mode" 'Mode: READ-ONLY'
check "the user's comment ends the prompt" 'Review this pull request\.'

if grep -q 'E2E_PROBE=\[canary\]' "$WORK/run.log"; then
    pass "the devcontainer build cannot read a secret through \${localEnv:...}"
else
    fail "a secret reached the devcontainer build: $(grep E2E_PROBE "$WORK/run.log")"
fi

for secret in "$AGENT_TOKEN" "$BB_TOKEN" "e2e-otel-token" "$SSH_KEY_MARKER"; do
    if grep -qF -- "$secret" "$WORK/run.log"; then fail "a secret was printed to the log"; fi
done

# --- 3. Secret hygiene of the final image ---------------------------------------------
if docker image inspect "ai-agent-pipe/agent:$SOURCE_IMAGE_TAG-run" >/dev/null 2>&1; then
    cid="$(docker create "ai-agent-pipe/agent:$SOURCE_IMAGE_TAG-run")"
    docker export "$cid" -o "$WORK/fs.tar"
    docker rm "$cid" >/dev/null
    docker image inspect "ai-agent-pipe/agent:$SOURCE_IMAGE_TAG-run" > "$WORK/inspect.json"
    if grep -a -q -e "$AGENT_TOKEN" -e "$BB_TOKEN" -e "e2e-otel-token" "$WORK/fs.tar" "$WORK/inspect.json"; then
        fail "a secret survived into the final image"
    else
        pass "no secret in the final image's filesystem or config"
    fi
else
    fail "the final image ai-agent-pipe/agent:$SOURCE_IMAGE_TAG-run was not built"
fi

# --- 4. The agent's failure is the pipe's failure -------------------------------------
echo "==> Pipe run with a failing agent"
out="$(run_pipe -e COMMENT_TEXT='E2E_EXIT=3')" && status=0 || status=$?
if [ "$status" -ne 0 ] && grep -q "Agent exited with status 3" <<<"$out"; then
    pass "a failing agent fails the pipe"
else
    fail "failing agent: pipe exited $status"
fi

if [ "$failures" -gt 0 ]; then
    echo "$failures test(s) failed. Log of the full run: (last 60 lines)"
    tail -n 60 "$WORK/run.log"
    exit 1
fi
echo "All pipe e2e tests passed."

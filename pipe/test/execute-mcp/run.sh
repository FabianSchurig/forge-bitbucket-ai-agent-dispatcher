#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Tests how execute.sh renders the agent's MCP config, without Docker: it runs
# the real script against a stand-in profile whose agent only saves the config
# it was given.
#
# What it asserts:
#   1. The profile's bitbucket server is merged into the config the feature
#      installed, and the feature's other servers stay.
#   2. With ATLASSIAN_MCP_API_KEY mounted, the HTTP server named atlassian gets
#      an Authorization Bearer header, other headers stay, and the key is
#      never printed.
#   3. Without the secret, or without such an HTTP server, the config is left
#      as it was.
#   4. With JAMA_MCP_GATEWAY_TOKEN mounted and JAMA_MCP_GATEWAY_URL set, the
#      server named werfen-jama (or JAMA_MCP_SERVER) is replaced by the
#      gateway's HTTP endpoint with the token as a Bearer header, and the token
#      is never printed.
#   5. Without the gateway secret, the config is left as it was; without the
#      URL or the server, it is too, with a warning.
#   6. The token-bearing config is removed when the agent exits.
#
# Usage: pipe/test/execute-mcp/run.sh
# Requires bash, jq and envsubst.
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTE="$HERE/../../scripts/execute.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok   - $*"; }
fail() { echo "FAIL - $*"; failures=$((failures + 1)); }

API_KEY="test-mcp-api-key-j1k2l3"
BB_TOKEN="test-bitbucket-token-m4n5o6"
GATEWAY_TOKEN="test-gateway-token-q7r8s9"
GATEWAY_URL="https://gateway.example.invalid/mcp"

ROOT="$WORK/agent-root"
PROFILE="$ROOT/config/agents/stub"
mkdir -p "$PROFILE" "$WORK/bin"
cp "$HERE/../../config/agents/cursor/mcp-config.json" "$PROFILE/mcp-config.json"
cat > "$PROFILE/agent.env" <<'EOF'
AGENT_COMMAND="stub-agent"
AGENT_FLAGS=""
AGENT_SECRET_NAME="STUB_AGENT_TOKEN"
AGENT_MCP_CONFIG_PATH=".stub/mcp.json"
EOF
echo "Do nothing." > "$ROOT/prompt.txt"
cat > "$WORK/bin/stub-agent" <<'EOF'
#!/usr/bin/env bash
cp "$HOME/.stub/mcp.json" "$CAPTURE"
EOF
chmod 0755 "$WORK/bin/stub-agent"

# The config the feature installed: an HTTP server with an extra header, and a
# stdio server that must not be touched.
FEATURE_CONFIG='{
    "mcpServers": {
        "atlassian": {"type": "http", "url": "https://mcp.example.invalid/mcp", "headers": {"X-Client": "pipe"}},
        "local": {"command": "local-mcp", "args": []}
    }
}'

# Runs execute.sh in a fresh home. $1 is the feature's config, $2 the API key
# secret's content (empty: not mounted), $3 the gateway token's (likewise);
# further arguments are VAR=value settings. Sets OUT (output) and CONFIG (the
# config the agent saw).
run_execute() {
    local feature_config="$1" api_key="$2" gateway_token="${3:-}" case_dir
    shift "$(($# < 3 ? $# : 3))"
    case_dir="$(mktemp -d "$WORK/case.XXXX")"
    mkdir -p "$case_dir/home/.stub" "$case_dir/secrets"
    printf '%s' "$feature_config" > "$case_dir/home/.stub/mcp.json"
    printf '%s' "stub-agent-token" > "$case_dir/secrets/STUB_AGENT_TOKEN"
    printf '%s' "$BB_TOKEN" > "$case_dir/secrets/BITBUCKET_TOKEN"
    if [ -n "$api_key" ]; then
        printf '%s' "$api_key" > "$case_dir/secrets/ATLASSIAN_MCP_API_KEY"
    fi
    if [ -n "$gateway_token" ]; then
        printf '%s' "$gateway_token" > "$case_dir/secrets/JAMA_MCP_GATEWAY_TOKEN"
    fi
    CONFIG="$case_dir/captured.json"
    OUT="$(cd "$case_dir" && env -i PATH="$WORK/bin:$PATH" HOME="$case_dir/home" \
        AGENT_ROOT="$ROOT" SECRETS_DIR="$case_dir/secrets" CAPTURE="$CONFIG" \
        SOURCE_WORKSPACE=w SOURCE_REPO=r READ_ONLY=true "$@" \
        bash "$EXECUTE" stub 2>&1)" || { fail "execute.sh failed: $OUT"; return 1; }
    if [ -e "$case_dir/home/.stub/mcp.json" ]; then
        fail "the MCP config survived the agent's exit"
    fi
}

query() { jq -r "$1" "$CONFIG"; }

# --- 1. and 2. With the secret -------------------------------------------------------
# A trailing newline, as an editor or `echo` leaves it, must not reach the header.
run_execute "$FEATURE_CONFIG" "$API_KEY"$'\n'
if [ "$(query '.mcpServers.atlassian.headers.Authorization')" = "Bearer $API_KEY" ]; then
    pass "the atlassian server gets the API key as a Bearer header"
else
    fail "atlassian Authorization header: $(query '.mcpServers.atlassian.headers.Authorization | length')"
fi
if [ "$(query '.mcpServers.atlassian.headers["X-Client"]')" = pipe ] \
   && [ "$(query '.mcpServers.atlassian.url')" = "https://mcp.example.invalid/mcp" ]; then
    pass "the atlassian server's other settings stay"
else
    fail "atlassian server changed: $(query '.mcpServers.atlassian | del(.headers.Authorization)')"
fi
if [ "$(query '.mcpServers.local | tojson')" = '{"command":"local-mcp","args":[]}' ]; then
    pass "a stdio server from the feature stays as it was"
else
    fail "local server changed: $(query '.mcpServers.local')"
fi
if [ "$(query '.mcpServers.bitbucket.env.BITBUCKET_TOKEN')" = "$BB_TOKEN" ] \
   && [ "$(query '.mcpServers.bitbucket.args | index("-config") != null')" = true ]; then
    pass "the profile's bitbucket server is merged with its token and read-only config"
else
    fail "bitbucket server: $(query '.mcpServers.bitbucket.args')"
fi
if grep -q "MCP server 'atlassian' authenticates with ATLASSIAN_MCP_API_KEY" <<<"$OUT"; then
    pass "the log says which server uses the key"
else
    fail "no log line for the atlassian key: $OUT"
fi
if grep -qF -e "$API_KEY" -e "$BB_TOKEN" <<<"$OUT"; then
    fail "a secret was printed"
else
    pass "no secret is printed"
fi

# --- 3. Without the secret, or without an HTTP server --------------------------------
run_execute "$FEATURE_CONFIG" ""
if [ "$(query '.mcpServers.atlassian | tojson')" = "$(jq -c '.mcpServers.atlassian' <<<"$FEATURE_CONFIG")" ] \
   && ! grep -q ATLASSIAN_MCP_API_KEY <<<"$OUT"; then
    pass "without the secret the atlassian server is left as configured"
else
    fail "atlassian server without the secret: $(query '.mcpServers.atlassian')"
fi

run_execute '{"mcpServers": {"atlassian": {"command": "atlassian-mcp"}}}' "$API_KEY"
if [ "$(query '.mcpServers.atlassian | tojson')" = '{"command":"atlassian-mcp"}' ] \
   && grep -q "WARN: ATLASSIAN_MCP_API_KEY is set, but the MCP config has no HTTP server 'atlassian'" <<<"$OUT"; then
    pass "a stdio atlassian server gets no header, with a warning"
else
    fail "stdio atlassian server: $(query '.mcpServers.atlassian'): $OUT"
fi

run_execute '{"mcpServers": {}}' "$API_KEY"
if [ "$(query '.mcpServers | keys | join(",")')" = bitbucket ] && grep -q "WARN: ATLASSIAN_MCP_API_KEY" <<<"$OUT"; then
    pass "without an atlassian server the key is unused, with a warning"
else
    fail "no atlassian server: $(query '.mcpServers | keys'): $OUT"
fi

# --- 4. With the gateway secret and URL ---------------------------------------------
JAMA_CONFIG='{
    "mcpServers": {
        "werfen-jama": {"command": "npx", "args": ["-y", "jama-mcp-local"], "env": {"AUTH_UI": "always"}},
        "local": {"command": "local-mcp", "args": []}
    }
}'
EXPECTED_GATEWAY="$(jq -cn --arg url "$GATEWAY_URL" --arg auth "Bearer $GATEWAY_TOKEN" \
    '{type: "http", url: $url, headers: {Authorization: $auth}}')"
run_execute "$JAMA_CONFIG" "" "$GATEWAY_TOKEN"$'\n' JAMA_MCP_GATEWAY_URL="$GATEWAY_URL"
if [ "$(query '.mcpServers["werfen-jama"] | tojson')" = "$EXPECTED_GATEWAY" ]; then
    pass "the werfen-jama server is replaced by the gateway with the token as a Bearer header"
else
    fail "werfen-jama server: $(query '.mcpServers["werfen-jama"] | del(.headers)')"
fi
if [ "$(query '.mcpServers.local | tojson')" = '{"command":"local-mcp","args":[]}' ] \
   && [ "$(query '.mcpServers.bitbucket.env.BITBUCKET_TOKEN')" = "$BB_TOKEN" ]; then
    pass "the other servers stay as they were with the gateway"
else
    fail "other servers changed: $(query '.mcpServers | keys')"
fi
if grep -q "MCP server 'werfen-jama' uses the gateway at $GATEWAY_URL with JAMA_MCP_GATEWAY_TOKEN" <<<"$OUT"; then
    pass "the log says which server uses the gateway"
else
    fail "no log line for the gateway: $OUT"
fi
if grep -qF -e "$GATEWAY_TOKEN" -e "$BB_TOKEN" <<<"$OUT"; then
    fail "a secret was printed"
else
    pass "the gateway token is not printed"
fi

run_execute '{"mcpServers": {"jama": {"command": "jama-mcp"}}}' "" "$GATEWAY_TOKEN" \
    JAMA_MCP_GATEWAY_URL="$GATEWAY_URL" JAMA_MCP_SERVER=jama
if [ "$(query '.mcpServers.jama | tojson')" = "$EXPECTED_GATEWAY" ]; then
    pass "JAMA_MCP_SERVER names the server the gateway replaces"
else
    fail "jama server with JAMA_MCP_SERVER: $(query '.mcpServers.jama | del(.headers)')"
fi

# --- 5. Without the gateway secret, URL or server ------------------------------------
run_execute "$JAMA_CONFIG" "" "" JAMA_MCP_GATEWAY_URL="$GATEWAY_URL"
if [ "$(query '.mcpServers["werfen-jama"] | tojson')" = "$(jq -c '.mcpServers["werfen-jama"]' <<<"$JAMA_CONFIG")" ] \
   && ! grep -q JAMA_MCP_GATEWAY <<<"$OUT"; then
    pass "without the gateway secret the werfen-jama server is left as configured"
else
    fail "werfen-jama server without the secret: $(query '.mcpServers["werfen-jama"]'): $OUT"
fi

run_execute "$JAMA_CONFIG" "" "$GATEWAY_TOKEN"
if [ "$(query '.mcpServers["werfen-jama"] | tojson')" = "$(jq -c '.mcpServers["werfen-jama"]' <<<"$JAMA_CONFIG")" ] \
   && grep -q "WARN: JAMA_MCP_GATEWAY_TOKEN is set, but JAMA_MCP_GATEWAY_URL is not an http(s) URL" <<<"$OUT"; then
    pass "without the URL the gateway token is unused, with a warning"
else
    fail "werfen-jama server without the URL: $(query '.mcpServers["werfen-jama"]'): $OUT"
fi

run_execute "$FEATURE_CONFIG" "" "$GATEWAY_TOKEN" JAMA_MCP_GATEWAY_URL="$GATEWAY_URL"
if [ "$(query '.mcpServers | keys | join(",")')" = atlassian,bitbucket,local ] \
   && grep -q "WARN: JAMA_MCP_GATEWAY_TOKEN is set, but the MCP config has no server 'werfen-jama'" <<<"$OUT"; then
    pass "without a werfen-jama server the gateway token is unused, with a warning"
else
    fail "no werfen-jama server: $(query '.mcpServers | keys'): $OUT"
fi
if grep -qF "$GATEWAY_TOKEN" "$CONFIG"; then
    fail "the unused gateway token reached the config"
else
    pass "an unused gateway token does not reach the config"
fi

if [ "$failures" -gt 0 ]; then
    echo "$failures test(s) failed."
    exit 1
fi
echo "All execute.sh MCP config tests passed."

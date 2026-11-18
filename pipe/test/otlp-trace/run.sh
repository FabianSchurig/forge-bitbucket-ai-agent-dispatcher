#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Tests for pipe/scripts/otlp-trace.sh.
#
# Usage: pipe/test/otlp-trace/run.sh
#   UPDATE_EXPECTED=1 rewrites expected.json from the current output.
#
# Span and trace ids are random and timestamps are wall-clock, so the payload
# is compared after replacing ids with their position and dropping times.
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../../scripts/otlp-trace.sh"
FIXTURE="$HERE/cursor-stream.jsonl"
EXPECTED="$HERE/expected.json"
TRACEPARENT_VALUE="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failures=0
pass() { echo "ok   - $*"; }
fail() { echo "FAIL - $*"; failures=$((failures + 1)); }

# shellcheck disable=SC2016
NORMALIZE='
.resourceSpans[0] as $rs
| ($rs.scopeSpans[0].spans | map(.spanId)) as $ids
| def position: . as $id | ($ids | index($id)) as $i | if $i == null then $id else "span-\($i)" end;
{
  resource: $rs.resource.attributes,
  scope: $rs.scopeSpans[0].scope,
  spans: [$rs.scopeSpans[0].spans[]
          | .spanId |= position
          | (if has("parentSpanId") then .parentSpanId |= position else . end)
          | del(.startTimeUnixNano, .endTimeUnixNano)
          | (if has("events") then .events |= map(del(.timeUnixNano)) else . end)]
}'

# --- 1. Fixture: pass-through, payload shape, nothing sensitive ---------------
OTLP_TRACE_FILE="$WORK/payload.json" \
TRACEPARENT="$TRACEPARENT_VALUE" \
OTEL_SERVICE_NAME="test-agent" \
OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=test, vcs.repository.name=acme%2Fexample,service.name=ignored" \
    bash "$SCRIPT" <"$FIXTURE" >"$WORK/stdout.txt" 2>"$WORK/stderr.txt"

if cmp -s "$FIXTURE" "$WORK/stdout.txt"; then pass "stream passes through unchanged"; else fail "stream changed in transit"; fi

jq "$NORMALIZE" "$WORK/payload.json" >"$WORK/normalized.json"
if [ "${UPDATE_EXPECTED:-}" = "1" ]; then
    cp "$WORK/normalized.json" "$EXPECTED"
    echo "updated $EXPECTED"
fi
if diff -u "$EXPECTED" "$WORK/normalized.json"; then pass "payload matches expected.json"; else fail "payload differs from expected.json"; fi

if grep -q secret "$WORK/payload.json"; then fail "payload leaks prompt, argument or result text"; else pass "payload carries metadata only"; fi

if jq -e '.resourceSpans[0].scopeSpans[0].spans
          | all(.traceId == "0af7651916cd43dd8448eb211c80319c")
            and all((.endTimeUnixNano | tonumber) >= (.startTimeUnixNano | tonumber))' \
        "$WORK/payload.json" >/dev/null; then
    pass "spans continue TRACEPARENT and end after they start"
else
    fail "trace id or span timing is wrong"
fi

# --- 2. Disabled: no endpoint, no file -> plain cat ----------------------------
env -u OTEL_EXPORTER_OTLP_ENDPOINT -u OTEL_EXPORTER_OTLP_TRACES_ENDPOINT -u OTLP_TRACE_FILE \
    bash "$SCRIPT" <"$FIXTURE" >"$WORK/stdout-disabled.txt" 2>"$WORK/stderr-disabled.txt"
if cmp -s "$FIXTURE" "$WORK/stdout-disabled.txt" && [ ! -s "$WORK/stderr-disabled.txt" ]; then
    pass "without an endpoint it is a silent pass-through"
else
    fail "disabled mode altered the stream or printed something"
fi

# --- 3. A run that dies before its result event --------------------------------
head -n 8 "$FIXTURE" | OTLP_TRACE_FILE="$WORK/truncated.json" bash "$SCRIPT" >/dev/null 2>&1
if jq -e '.resourceSpans[0].scopeSpans[0].spans[0]
          | .status.code == 2 and (.attributes[] | select(.key == "agent.result") | .value.stringValue) == "incomplete"' \
        "$WORK/truncated.json" >/dev/null \
   && jq -e '.resourceSpans[0].scopeSpans[0].spans[0] | has("parentSpanId") | not' "$WORK/truncated.json" >/dev/null; then
    pass "an incomplete run is an error root span without a parent"
else
    fail "incomplete run not reported as an error"
fi

# --- 4. Export over HTTP, with headers ----------------------------------------
if command -v python3 >/dev/null 2>&1; then
    PORT_FILE="$WORK/port"
    python3 - "$WORK" "$PORT_FILE" <<'PY' &
import http.server, sys, pathlib
work, port_file = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
class Sink(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        (work / "received.json").write_bytes(body)
        (work / "received.headers").write_text(f"{self.path}\n{self.headers}")
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *args): pass
server = http.server.HTTPServer(("127.0.0.1", 0), Sink)
port_file.write_text(str(server.server_port))
server.handle_request()
PY
    sink=$!
    for _ in $(seq 50); do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
    OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:$(cat "$PORT_FILE")/" \
    OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20test-token,X-Scope = ci" \
        bash "$SCRIPT" <"$FIXTURE" >/dev/null 2>"$WORK/stderr-export.txt"
    wait "$sink" || true
    if [ -s "$WORK/received.json" ] \
       && head -n 1 "$WORK/received.headers" | grep -qx "/v1/traces" \
       && grep -q "^Authorization: Bearer test-token" "$WORK/received.headers" \
       && grep -q "^X-Scope: ci" "$WORK/received.headers" \
       && grep -q "exported 9 spans" "$WORK/stderr-export.txt"; then
        pass "exports to <endpoint>/v1/traces with decoded headers"
    else
        fail "HTTP export: $(cat "$WORK/stderr-export.txt")"
    fi
else
    echo "skip - HTTP export (python3 not installed)"
fi

# --- 5. An unreachable collector never fails the caller ------------------------
if OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://127.0.0.1:9/v1/traces" OTLP_TRACE_TIMEOUT=2 \
       bash "$SCRIPT" <"$FIXTURE" >"$WORK/stdout-unreachable.txt" 2>"$WORK/stderr-unreachable.txt" \
   && cmp -s "$FIXTURE" "$WORK/stdout-unreachable.txt" \
   && grep -q "WARN: otlp-trace: export" "$WORK/stderr-unreachable.txt"; then
    pass "an unreachable collector is a warning, not a failure"
else
    fail "unreachable collector broke the pipe"
fi

if [ "$failures" -gt 0 ]; then
    echo "$failures test(s) failed."
    exit 1
fi
echo "All otlp-trace tests passed."

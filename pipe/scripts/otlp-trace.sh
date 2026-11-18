#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# otlp-trace.sh
#
# Turns an agent's JSONL event stream into one OpenTelemetry trace and sends
# it to an OTLP/HTTP collector. The stream passes through to stdout unchanged,
# so this sits in a pipe without changing what the caller sees:
#
#   cursor-agent -p "..." --output-format stream-json | otlp-trace.sh | ...
#
# Usage: otlp-trace.sh [FORMAT]
#   FORMAT  cursor-stream-json (default, and the only format so far)
#
# The trace has one `invoke_agent cursor` root span and one
# `execute_tool <name>` child per tool call, named after the OpenTelemetry
# GenAI semantic conventions so it lines up with agents that export natively
# (Copilot CLI). Only metadata is exported: tool and MCP names, the skill a
# SKILL.md read loads, timings, outcomes, model, session and token counts.
# Prompts, responses, tool arguments and results never leave the machine.
#
# Configuration uses the standard OpenTelemetry environment variables:
#   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  full traces URL, or else
#   OTEL_EXPORTER_OTLP_ENDPOINT         base URL; /v1/traces is appended
#   OTEL_EXPORTER_OTLP_TRACES_HEADERS   k=v,k2=v2 request headers, or else
#   OTEL_EXPORTER_OTLP_HEADERS          the same for all signals
#   OTEL_SERVICE_NAME                   default: cursor-agent
#   OTEL_RESOURCE_ATTRIBUTES            k=v,k2=v2 resource attributes
# Values in both k=v lists are percent-decoded, as UTF-8.
#   TRACEPARENT                         W3C parent, e.g. a CI build step
# The payload is OTLP JSON whatever OTEL_EXPORTER_OTLP_PROTOCOL says.
#   OTLP_TRACE_FILE                     also write the payload to this file
#   OTLP_TRACE_TIMEOUT                  export timeout in seconds (default 10)
#
# With neither an endpoint nor OTLP_TRACE_FILE this is a plain `cat`.
# Telemetry must never break the agent run, so every failure is a warning and
# the exit status is always 0.
# ---------------------------------------------------------------------------
set -uo pipefail

FORMAT="${1:-cursor-stream-json}"
SCOPE_VERSION="1"

warn() { echo "WARN: otlp-trace: $*" >&2; }

if [ "$FORMAT" != "cursor-stream-json" ]; then
    warn "unknown format '$FORMAT'; passing the stream through untraced."
    exec cat
fi

TRACES_ENDPOINT="${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-}"
if [ -z "$TRACES_ENDPOINT" ] && [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
    TRACES_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT%/}/v1/traces"
fi
if [ -z "$TRACES_ENDPOINT" ] && [ -z "${OTLP_TRACE_FILE:-}" ]; then
    exec cat
fi
if ! command -v jq >/dev/null 2>&1; then
    warn "jq is not installed; passing the stream through untraced."
    exec cat
fi

now_ms() {
    if [ -n "${EPOCHREALTIME:-}" ]; then
        local t="${EPOCHREALTIME/[.,]/}"
        echo "${t:0:13}"
    else
        date +%s%3N
    fi
}

random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

trim() {
    local s="$1"
    s="${s#"${s%%[![:space:]]*}"}"
    printf '%s' "${s%"${s##*[![:space:]]}"}"
}

# %XX escapes are bytes, so a multi-byte UTF-8 character ("caf%C3%A9") has to
# be decoded as a byte sequence, which printf %b does. Literal backslashes are
# doubled first so they are not taken for escapes themselves.
percent_decode() {
    local s="${1//\\/\\\\}"
    printf '%b' "${s//%/\\x}"
}

# Splits a k=v,k2=v2 list, the format of OTEL_RESOURCE_ATTRIBUTES and
# OTEL_EXPORTER_OTLP_HEADERS, into NUL-separated key and value fields: keys
# trimmed, values trimmed and percent-decoded.
kv_pairs() {
    local pair key
    local -a pairs=()
    IFS=',' read -ra pairs <<<"$1"
    for pair in "${pairs[@]}"; do
        [[ "$pair" == *=* ]] || continue
        key="$(trim "${pair%%=*}")"
        [ -n "$key" ] || continue
        printf '%s\0%s\0' "$key" "$(percent_decode "$(trim "${pair#*=}")")"
    done
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# Stage 1, while the agent runs: reduce each event to the few fields a span
# needs, stamped with its arrival time. Tool results can be megabytes of file
# content; none of it is kept.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2016
REDUCE='
def tool_kind: keys_unsorted | map(select(endswith("ToolCall") or . == "function")) | .[0];
def epoch_ms: if . == null then null else (tonumber? // null) end;

(now * 1000 | floor) as $t
| (fromjson? // null) as $e
| if ($e | type) != "object" then empty
  elif $e.type == "system" and $e.subtype == "init" then
    {t: $t, k: "init", session: $e.session_id, model: $e.model}
  elif $e.type == "tool_call" and ($e.tool_call | type) == "object" then
    $e.tool_call as $tc
    | ($tc | tool_kind) as $kind
    | (if $kind == null then {} else ($tc[$kind] // {}) end) as $p
    | ($p.args // {}) as $a
    | {
        t: $t,
        k: $e.subtype,
        id: ($e.call_id // $tc.toolCallId // $a.toolCallId),
        mcp: ($kind == "mcpToolCall"),
        name: (if $kind == "mcpToolCall" then
                 ($a.name // ([$a.providerIdentifier, $a.toolName] | map(select(. != null)) | join("-")))
               elif $kind == "function" then $p.name
               elif $kind != null then ($kind | sub("ToolCall$"; ""))
               else "unknown" end),
        mcp_server: (if $kind == "mcpToolCall" then ($a.providerIdentifier // $a.serverIdentifier) else null end),
        mcp_tool: (if $kind == "mcpToolCall" then $a.toolName else null end),
        skill: (if $kind == "readToolCall" then
                  ([($a.path // "") | capture("/skills/(?<s>[^/]+)/SKILL\\.md$")? | .s] | .[0])
                else null end),
        started_ms: ($tc.startedAtMs | epoch_ms),
        completed_ms: ($tc.completedAtMs | epoch_ms),
        # An MCP tool that fails reports it inside a "success" envelope.
        outcome: (if ($p.result | type) != "object" then null
                  elif ($p.result.success | type) == "object" and $p.result.success.isError == true then "error"
                  else ($p.result | keys_unsorted | .[0]) end)
      }
  elif $e.type == "result" then
    {t: $t, k: "result", subtype: $e.subtype, is_error: ($e.is_error // false),
     session: $e.session_id, usage: ($e.usage // null)}
  else
    {t: $t, k: "other"}
  end
'

# ---------------------------------------------------------------------------
# Stage 2, at EOF: build the OTLP JSON payload from the reduced events.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2016
BUILD='
def hex8: . as $n | [range(7; -1; -1) as $i | (($n / pow(16; $i)) | floor) % 16]
          | map("0123456789abcdef"[.:(. + 1)]) | join("");
def ns: floor | tostring + "000000";
def attr($k; $v):
  if $v == null then empty
  elif ($v | type) == "boolean" then {key: $k, value: {boolValue: $v}}
  elif ($v | type) == "number" then {key: $k, value: {intValue: ($v | floor | tostring)}}
  else {key: $k, value: {stringValue: ($v | tostring)}} end;
def trim: sub("^\\s+"; "") | sub("\\s+$"; "");
def tokens($u; $names): [$names[] as $n | $u[$n] | select(type == "number")] | .[0];

. as $ev
| ([$ev[] | select(.k == "init")] | .[0]) as $init
| ([$ev[] | select(.k == "result")] | last) as $res
| ([$ev[] | select(.k == "started" or .k == "completed")]
   | reduce .[] as $e ({order: [], by: {}};
       (($e.id // ("call-" + ($e.t | tostring))) | tostring) as $id
       | if .by[$id] then .by[$id] += [$e] else .order += [$id] | .by[$id] = [$e] end)) as $calls
| ($res.t // $end_ms) as $root_end
| [ $calls.order | to_entries[] | .key as $i | .value as $id
    | $calls.by[$id] as $evs
    | ([$evs[] | select(.k == "started")] | .[0]) as $s
    | ([$evs[] | select(.k == "completed")] | .[0]) as $c
    | ($s // $c) as $info
    | ($s.started_ms // $s.t // $c.started_ms // $c.t) as $start
    | ([($c.completed_ms // $c.t // $root_end), $start] | max) as $finish
    | {
        traceId: $trace_id,
        spanId: ($prefix + (($i + 1) | hex8)),
        parentSpanId: $root_id,
        name: ("execute_tool " + $info.name),
        kind: 1,
        startTimeUnixNano: ($start | ns),
        endTimeUnixNano: ($finish | ns),
        attributes: [
          attr("gen_ai.operation.name"; "execute_tool"),
          attr("gen_ai.tool.name"; $info.name),
          attr("gen_ai.tool.type"; (if $info.mcp then "extension" else "function" end)),
          attr("gen_ai.tool.call.id"; $id),
          attr("mcp.method.name"; (if $info.mcp then "tools/call" else null end)),
          attr("mcp.server.name"; $info.mcp_server),
          attr("mcp.tool.name"; $info.mcp_tool),
          attr("agent.skill.name"; $info.skill)
        ],
        events: (if $info.skill then
                   [{timeUnixNano: ($start | ns), name: "agent.skill.invoked",
                     attributes: [attr("agent.skill.name"; $info.skill)]}]
                 else [] end),
        status: (if $c == null then {code: 2, message: "tool call did not complete"}
                 elif $c.outcome == null or $c.outcome == "success" then {code: 0}
                 else {code: 2, message: $c.outcome} end)
      }
  ] as $tools
| ([$start_ms] + [$tools[] | .startTimeUnixNano | .[:-6] | tonumber] | min) as $root_start
| ($res.usage // {}) as $u
| {
    traceId: $trace_id,
    spanId: $root_id,
    parentSpanId: $parent_id,
    name: "invoke_agent cursor",
    kind: 1,
    startTimeUnixNano: ($root_start | ns),
    endTimeUnixNano: ([$root_end, $root_start] | max | ns),
    attributes: [
      attr("gen_ai.operation.name"; "invoke_agent"),
      attr("gen_ai.provider.name"; "cursor"),
      attr("gen_ai.agent.name"; "cursor"),
      attr("gen_ai.request.model"; $init.model),
      attr("gen_ai.conversation.id"; ($init.session // $res.session)),
      attr("gen_ai.usage.input_tokens"; tokens($u; ["inputTokens", "input_tokens"])),
      attr("gen_ai.usage.output_tokens"; tokens($u; ["outputTokens", "output_tokens"])),
      attr("gen_ai.usage.cache_read.input_tokens";
           tokens($u; ["cacheReadTokens", "cacheReadInputTokens", "cache_read_input_tokens"])),
      attr("gen_ai.usage.cache_creation.input_tokens";
           tokens($u; ["cacheWriteTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"])),
      attr("agent.tool_calls"; ($tools | length)),
      attr("agent.result"; ($res.subtype // "incomplete"))
    ],
    status: (if $res == null then {code: 2, message: "the agent ended without a result event"}
             elif $res.is_error then {code: 2, message: ($res.subtype // "error")}
             else {code: 0} end)
  }
| (if $parent_id == "" then del(.parentSpanId) else . end) as $root
| $resource_attrs as $ra
| ((($ENV.OTEL_SERVICE_NAME // "") | trim) as $s
   | if $s != "" then $s
     else ([$ra[] | select(.key == "service.name") | .value] | .[0] // "cursor-agent") end) as $service
| {
    resourceSpans: [{
      resource: {attributes: ([attr("service.name"; $service)]
                              + [$ra[] | select(.key != "service.name") | attr(.key; .value)])},
      scopeSpans: [{
        scope: {name: "otlp-trace.sh", version: $scope_version},
        spans: ([$root] + $tools)
      }]
    }]
  }
'

# GNU tee -p keeps the agent output flowing even if the reducer dies.
TEE_OPTS=()
if tee -p </dev/null >/dev/null 2>&1; then
    TEE_OPTS=(-p)
fi

START_MS="$(now_ms)"
tee "${TEE_OPTS[@]}" >(jq -R -c --unbuffered "$REDUCE" >"$WORK/events.jsonl" 2>"$WORK/reduce.err")
wait "$!" 2>/dev/null
END_MS="$(now_ms)"

if [ -s "$WORK/reduce.err" ]; then
    warn "event reduction failed: $(head -c 300 "$WORK/reduce.err")"
fi

# ---------------------------------------------------------------------------
# Trace context: continue the caller's trace when TRACEPARENT is valid.
# ---------------------------------------------------------------------------
TRACE_ID=""
PARENT_ID=""
if [[ "${TRACEPARENT:-}" =~ ^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$ ]] \
   && [ "${BASH_REMATCH[1]}" != "00000000000000000000000000000000" ] \
   && [ "${BASH_REMATCH[2]}" != "0000000000000000" ]; then
    TRACE_ID="${BASH_REMATCH[1]}"
    PARENT_ID="${BASH_REMATCH[2]}"
fi
[ -n "$TRACE_ID" ] || TRACE_ID="$(random_hex 16)"

RESOURCE_FIELDS=()
while IFS= read -r -d '' field; do
    RESOURCE_FIELDS+=("$field")
done < <(kv_pairs "${OTEL_RESOURCE_ATTRIBUTES:-}")
RESOURCE_ATTRS="$(jq -n -c '$ARGS.positional as $f
    | [range(0; $f | length; 2) as $i | {key: $f[$i], value: $f[$i + 1]}]' \
    --args ${RESOURCE_FIELDS[@]+"${RESOURCE_FIELDS[@]}"})" || RESOURCE_ATTRS='[]'

if ! jq -s -c \
        --argjson resource_attrs "$RESOURCE_ATTRS" \
        --arg trace_id "$TRACE_ID" \
        --arg parent_id "$PARENT_ID" \
        --arg root_id "$(random_hex 8)" \
        --arg prefix "$(random_hex 4)" \
        --arg scope_version "$SCOPE_VERSION" \
        --argjson start_ms "$START_MS" \
        --argjson end_ms "$END_MS" \
        "$BUILD" "$WORK/events.jsonl" >"$WORK/payload.json" 2>"$WORK/build.err"; then
    warn "could not build the trace: $(head -c 300 "$WORK/build.err")"
    exit 0
fi
SPAN_COUNT="$(jq '.resourceSpans[0].scopeSpans[0].spans | length' "$WORK/payload.json")"

if [ -n "${OTLP_TRACE_FILE:-}" ]; then
    cp "$WORK/payload.json" "$OTLP_TRACE_FILE" || warn "could not write $OTLP_TRACE_FILE."
fi
[ -n "$TRACES_ENDPOINT" ] || exit 0

if ! command -v curl >/dev/null 2>&1; then
    warn "curl is not installed; the trace was not exported."
    exit 0
fi

# Headers go through a file, not argv, so a token never shows up in `ps`.
HEADERS_FILE="$WORK/headers"
( umask 077; printf 'Content-Type: application/json\n' >"$HEADERS_FILE" )
# A decoded CR or LF would start a header of its own, so both are dropped.
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    printf '%s: %s\n' "${key//[$'\r\n']/}" "${value//[$'\r\n']/}" >>"$HEADERS_FILE"
done < <(kv_pairs "${OTEL_EXPORTER_OTLP_TRACES_HEADERS:-${OTEL_EXPORTER_OTLP_HEADERS:-}}")

HTTP_CODE="$(curl -sS -o "$WORK/response" -w '%{http_code}' \
    --max-time "${OTLP_TRACE_TIMEOUT:-10}" \
    -X POST -H @"$HEADERS_FILE" \
    --data-binary @"$WORK/payload.json" \
    "$TRACES_ENDPOINT" 2>"$WORK/curl.err")"

if [[ "$HTTP_CODE" == 2* ]]; then
    echo "==> otlp-trace: exported ${SPAN_COUNT} spans to ${TRACES_ENDPOINT} (trace_id ${TRACE_ID})" >&2
else
    warn "export to ${TRACES_ENDPOINT} failed (HTTP ${HTTP_CODE:-none}): $(cat "$WORK/curl.err" "$WORK/response" 2>/dev/null | tr '\n' ' ' | head -c 300)"
fi
exit 0

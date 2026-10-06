#!/usr/bin/env bash
set -u
: "${ROUTER_URL:?}"; : "${ROUTER_TOKEN:?}"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "✅ $1"; pass=$((pass+1)); else echo "❌ $1 expected $2 got $3"; fail=$((fail+1)); fi; }
code() { curl -s -o /tmp/rg_out.json -w "%{http_code}" "$@"; }
OA=(-H "Authorization: Bearer $ROUTER_TOKEN" -H "content-type: application/json")
AN=(-H "x-api-key: $ROUTER_TOKEN" -H "anthropic-version: 2023-06-01" -H "content-type: application/json")

check "openai chat non-stream" 200 "$(code "${OA[@]}" -X POST "$ROUTER_URL/v1/chat/completions" -d '{"model":"auto","messages":[{"role":"user","content":"say pong"}]}')"
check "openai chat stream" 200 "$(code "${OA[@]}" -X POST "$ROUTER_URL/v1/chat/completions" -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"say pong"}]}')"
check "anthropic messages non-stream" 200 "$(code "${AN[@]}" -X POST "$ROUTER_URL/v1/messages" -d '{"model":"auto","max_tokens":64,"messages":[{"role":"user","content":"say pong"}]}')"
check "anthropic messages stream" 200 "$(code "${AN[@]}" -X POST "$ROUTER_URL/v1/messages" -d '{"model":"auto","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"say pong"}]}')"
check "anthropic count_tokens" 200 "$(code "${AN[@]}" -X POST "$ROUTER_URL/v1/messages/count_tokens" -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}')"
check "openai embeddings" 200 "$(code "${OA[@]}" -X POST "$ROUTER_URL/v1/embeddings" -d '{"model":"auto","input":"hello","dimensions":768}')"
check "GET /v1/models (OpenAI)" 200 "$(code "${OA[@]}" "$ROUTER_URL/v1/models")"
echo "   shape: $(head -c 80 /tmp/rg_out.json | tr -d '\n')"
check "GET /v1/models (Anthropic)" 200 "$(code "${AN[@]}" "$ROUTER_URL/v1/models")"
echo "   shape: $(head -c 80 /tmp/rg_out.json | tr -d '\n')"
echo "Passed: $pass / $((pass+fail))"; [ "$fail" -eq 0 ]

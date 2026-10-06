#!/usr/bin/env bash
# Usage: ROUTER_URL=https://google2anthropic.xxx.workers.dev ROUTER_TOKEN=... bash tests/live/google_native_smoke.sh
set -u
: "${ROUTER_URL:?set ROUTER_URL}"
: "${ROUTER_TOKEN:?set ROUTER_TOKEN}"
H=(-H "x-goog-api-key: $ROUTER_TOKEN" -H "content-type: application/json")
B="$ROUTER_URL/v1beta/models"
pass=0; fail=0
check() { # name, expected_status, actual_status
  if [ "$2" = "$3" ]; then echo "✅ $1 ($3)"; pass=$((pass+1)); else echo "❌ $1 expected $2 got $3"; fail=$((fail+1)); fi
}
code() { curl -s -o /tmp/gn_out.json -w "%{http_code}" "$@"; }

SIMPLE='{"contents":[{"role":"user","parts":[{"text":"Reply with the single word: pong"}]}]}'

check "1 generateContent auto" 200 "$(code "${H[@]}" -X POST "$B/auto:generateContent" -d "$SIMPLE")"
head -c 300 /tmp/gn_out.json; echo

check "2 streamGenerateContent alt=sse" 200 "$(code "${H[@]}" -X POST "$B/auto:streamGenerateContent?alt=sse" -d "$SIMPLE")"
echo "   chunks(data:)=$(grep -c '^data:' /tmp/gn_out.json) usage_seen=$(grep -c usageMetadata /tmp/gn_out.json)"

check "3 stream without alt=sse" 200 "$(code "${H[@]}" -X POST "$B/auto:streamGenerateContent" -d "$SIMPLE")"

check "4a auth ?key=" 200 "$(code -H 'content-type: application/json' -X POST "$B/auto:generateContent?key=$ROUTER_TOKEN" -d "$SIMPLE")"
check "4b auth Bearer" 200 "$(code -H "Authorization: Bearer $ROUTER_TOKEN" -H 'content-type: application/json' -X POST "$B/auto:generateContent" -d "$SIMPLE")"
check "4c auth wrong token" 401 "$(code -H 'x-goog-api-key: WRONG' -H 'content-type: application/json' -X POST "$B/auto:generateContent" -d "$SIMPLE")"
grep -o '"status": *"[A-Z_]*"' /tmp/gn_out.json

for m in fast stable gemini-3.6-flash totally-unknown-model; do
  check "5 model=$m" 200 "$(code "${H[@]}" -X POST "$B/$m:generateContent" -d "$SIMPLE")"
done
echo "   -> now check which model served each request: GET /admin/logs?limit=6 (ADMIN_TOKEN)"

TOOLS='{"contents":[{"role":"user","parts":[{"text":"What is the weather in Tehran? Use the tool."}]}],"tools":[{"functionDeclarations":[{"name":"get_weather","description":"get weather","parameters":{"type":"OBJECT","properties":{"city":{"type":"STRING"}},"required":["city"]}}]}]}'
check "6a tool call turn 1" 200 "$(code "${H[@]}" -X POST "$B/auto:generateContent" -d "$TOOLS")"
head -c 400 /tmp/gn_out.json; echo
TURN2='{"contents":[{"role":"user","parts":[{"text":"What is the weather in Tehran?"}]},{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Tehran"}}}]},{"role":"user","parts":[{"functionResponse":{"name":"get_weather","response":{"temp":"25C"}}}]}],"tools":[{"functionDeclarations":[{"name":"get_weather","description":"get weather","parameters":{"type":"OBJECT","properties":{"city":{"type":"STRING"}},"required":["city"]}}]}]}'
check "6b tool turn 2 WITHOUT thoughtSignature (sentinel must prevent 400)" 200 "$(code "${H[@]}" -X POST "$B/auto:generateContent" -d "$TURN2")"

THINK='{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"thinkingLevel":"none"}}}'
check "7 thinkingLevel none on 3.x" 200 "$(code "${H[@]}" -X POST "$B/gemini-3.6-flash:generateContent" -d "$THINK")"

check "8a embedContent 768" 200 "$(code "${H[@]}" -X POST "$B/auto:embedContent" -d '{"content":{"parts":[{"text":"hello"}]},"outputDimensionality":768}')"
echo "   vector length = $(python3 -c 'import json;print(len(json.load(open("/tmp/gn_out.json"))["embedding"]["values"]))' 2>/dev/null)  (expect 768)"
check "8b batchEmbedContents x2" 200 "$(code "${H[@]}" -X POST "$B/auto:batchEmbedContents" -d '{"requests":[{"model":"models/auto","content":{"parts":[{"text":"a"}]},"outputDimensionality":768},{"model":"models/auto","content":{"parts":[{"text":"b"}]},"outputDimensionality":768}]}')"
echo "   embeddings count = $(python3 -c 'import json;print(len(json.load(open("/tmp/gn_out.json"))["embeddings"]))' 2>/dev/null)  (expect 2)"

check "9 TTS AUDIO modality" 200 "$(code "${H[@]}" -X POST "$B/auto:generateContent" -d '{"contents":[{"parts":[{"text":"Say hello"}]}],"generationConfig":{"responseModalities":["AUDIO"],"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Kore"}}}}}')"
echo "   inlineData present = $(grep -c inlineData /tmp/gn_out.json)"

check "10a countTokens simple" 200 "$(code "${H[@]}" -X POST "$B/auto:countTokens" -d "$SIMPLE")"
check "10b countTokens generateContentRequest" 200 "$(code "${H[@]}" -X POST "$B/auto:countTokens" -d '{"generateContentRequest":{"model":"models/auto","contents":[{"role":"user","parts":[{"text":"hi"}]}]}}')"

check "11 malformed body -> raw 400" 400 "$(code "${H[@]}" -X POST "$B/auto:generateContent" -d '{"contents":"oops"}')"

check "13a GET /v1beta/models" 200 "$(code "${H[@]}" "$B")"
check "13b GET /v1beta/models/auto" 200 "$(code "${H[@]}" "$B/auto")"
check "13c GET /v1beta/files -> 501" 501 "$(code "${H[@]}" "$ROUTER_URL/v1beta/files")"

echo; echo "Passed: $pass / $((pass+fail))"
[ "$fail" -eq 0 ]

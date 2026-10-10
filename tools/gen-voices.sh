#!/usr/bin/env bash
# Usage: FISH_API_KEY=... bash tools/gen-voices.sh [reference_id]
set -euo pipefail

: "${FISH_API_KEY:?set FISH_API_KEY}"
REF="${1:-078eaa5208ca42a1909d2e6fac9c93f7}"
OUT="$(dirname "$0")/../frontend/spider-audio"
TMP="$(mktemp -d)"
mkdir -p "$OUT"

TRIM="silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.003,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,atempo=1.5"

for word in duck left right back jump; do
  text="[shouting] ${word^}!"
  curl -sS --fail-with-body -X POST https://api.fish.audio/v1/tts \
    -H "Authorization: Bearer $FISH_API_KEY" \
    -H "Content-Type: application/json" \
    -H "model: s2-pro" \
    -d "{\"text\": \"$text\", \"reference_id\": \"$REF\", \"format\": \"wav\"}" \
    --output "$TMP/$word.wav"
  ffmpeg -loglevel error -y -i "$TMP/$word.wav" -af "$TRIM" -ac 1 -ar 44100 "$OUT/$word.wav"
  printf '%-6s %ss\n' "$word" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$word.wav")"
done

rm -rf "$TMP"

#!/usr/bin/env bash
# Usage: FISH_API_KEY=... bash tools/gen-voices.sh [reference_id]
set -euo pipefail

: "${FISH_API_KEY:?set FISH_API_KEY}"
REF="${1:-078eaa5208ca42a1909d2e6fac9c93f7}"
OUT="$(dirname "$0")/../frontend/spider-audio"
TMP="$(mktemp -d)"
mkdir -p "$OUT"

TRIM="silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.003,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,atempo=1.5"

declare -A TEXT=([duck]="Duck!" [back]="Step back!")
for word in "${!TEXT[@]}"; do
  text="[shouting] ${TEXT[$word]}"
  curl -sS --fail-with-body -X POST https://api.fish.audio/v1/tts \
    -H "Authorization: Bearer $FISH_API_KEY" \
    -H "Content-Type: application/json" \
    -H "model: s2-pro" \
    -d "{\"text\": \"$text\", \"reference_id\": \"$REF\", \"format\": \"wav\"}" \
    --output "$TMP/$word.wav"
  ffmpeg -loglevel error -y -i "$TMP/$word.wav" -af "$TRIM" -ac 1 -ar 44100 "$OUT/$word.wav"
  printf '%-6s %ss\n' "$word" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$word.wav")"
done

# Guided-recording prompts: calm voice, trimmed, not sped up.
PTRIM="silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.003,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse"
declare -A PROMPT=([jab]="Jab." [cross]="Cross." [lead-hook]="Left hook." [rear-hook]="Right hook." [overhand]="Overhand." [guard]="Guard up." [scratch-head]="Scratch your head." [wave]="Wave." [step]="Step around." [still]="Stand still.")
for id in "${!PROMPT[@]}"; do
  curl -sS --fail-with-body -X POST https://api.fish.audio/v1/tts     -H "Authorization: Bearer $FISH_API_KEY"     -H "Content-Type: application/json"     -H "model: s2-pro"     -d "{\"text\": \"${PROMPT[$id]}\", \"reference_id\": \"$REF\", \"format\": \"wav\"}"     --output "$TMP/p-$id.wav"
  ffmpeg -loglevel error -y -i "$TMP/p-$id.wav" -af "$PTRIM" -ac 1 -ar 44100 "$OUT/prompt-$id.wav"
  printf 'prompt-%-13s %ss
' "$id" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/prompt-$id.wav")"
done

rm -rf "$TMP"

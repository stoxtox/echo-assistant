#!/bin/zsh
# Installs local speech recognition for Echo: whisper.cpp (Metal-accelerated on Apple Silicon)
# plus the Whisper large-v3-turbo model (quantized, ~550 MB). Free and fully offline afterwards.
set -e
cd "$(dirname "$0")/.."
command -v whisper-server >/dev/null || brew install whisper-cpp
mkdir -p models
MODEL=models/ggml-large-v3-turbo-q5_0.bin
# --progress-bar shows how far the ~550 MB download is; -C - resumes a broken download.
[ -f "$MODEL" ] || { curl -L --fail --progress-bar -C - -o "$MODEL.part" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin && mv "$MODEL.part" "$MODEL"; }
echo "Local Whisper is ready. Restart Echo and pick 'Auto' or 'Local Whisper' under Voice & vibe."

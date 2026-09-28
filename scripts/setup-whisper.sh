#!/bin/zsh
# Installs local speech recognition for Echo: whisper.cpp (Metal-accelerated on Apple Silicon)
# plus a Whisper model. Free and fully offline afterwards.
#   default     large-v3-turbo (quantized, ~550 MB, ~0.7s a sentence)
#   --accurate  large-v3 as well (quantized, ~1.1 GB, ~1.7s a sentence). Only used when chosen with
#               VOICEOPS_WHISPER_MODEL: on real speech it did worse than turbo (docs/speech-recognition.md).
set -e
cd "$(dirname "$0")/.."
command -v whisper-server >/dev/null || brew install whisper-cpp
mkdir -p models
fetch() {
  # --progress-bar shows how far the download is; -C - resumes a broken download.
  [ -f "models/$1" ] || { curl -L --fail --progress-bar -C - -o "models/$1.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$1" && mv "models/$1.part" "models/$1"; }
}
fetch ggml-large-v3-turbo-q5_0.bin
[ "$1" = "--accurate" ] && fetch ggml-large-v3-q5_0.bin
echo "Local Whisper is ready. Restart Echo and pick 'Auto' or 'Local Whisper' under Voice & vibe."

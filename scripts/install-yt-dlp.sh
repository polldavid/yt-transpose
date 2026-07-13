#!/usr/bin/env bash
# Downloads the standalone yt-dlp binary (self-contained, no Python needed)
# into bin/. Run during deploy builds and CI.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" -o bin/yt-dlp
chmod +x bin/yt-dlp
echo "yt-dlp $(bin/yt-dlp --version) installed"
